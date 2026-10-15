// 地震カードへ、その区間の自作地震計の合成波形を描く。
//
// **描くだけ。** 読み返しも継ぎ足しも `hooks/useSeismoQuakeWaves` の担当 ——
// 描画側に置くと**カードを開いている間・タブが見えている間しか繋がらない**
// （2026-09-30 のユーザー指摘で作り直した）。
//
// **地図の下端の絵（`SeismoWaveChart`）と描き方を共有する。** 見えているものは同じ
// なので、描画は `paintWave.ts` の 1 つだけ。
//
// **記録が無いときは呼ばれない。** 「揺れを捉えていない」「記録が無い」を画面へ
// 出さないと決めてあるので（2026-09-29 のユーザー判断）、載せるものが無ければ
// 親が丸ごと描かない。

import { Component, lazy, Suspense, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'

import type { SeismoQuakeWave } from '../../hooks/useSeismoQuakeWaves'
import type { SeismoWaveCollapsedView } from '../../hooks/useSettings'
import type { QuakeIntensity } from '../../services/seismoQuakeIntensity'
import { formatTime } from '../../utils/formatters'
import { log } from '../../utils/logger'
import { formatMeasured } from '../../utils/measuredIntensityRounding'
import { columnsSpan, measureQuietLevel, selectQuakeWindow, type WaveAxisZero } from '../../utils/seismoQuakeWindow'
import { compositeCoverage, smoothCompositeWithin, type TimedColumns } from '../../utils/seismoWaveColumns'
import { MEAN_LINE_WINDOW_MS } from '../../utils/waveMeanLines'
import { buildArrivalMarksForRange } from '../SeismoWaveChart/arrivalMarks'
import { foldHistoryColumns, foldHistoryLine } from '../SeismoWaveChart/historyColumns'
import {
  COMPOSITE_SMOOTH_COLOR,
  paintCompositeColumns,
  paintWaveColumns,
  type PaintableColumns,
  type WaveMark,
} from '../SeismoWaveChart/paintWave'
import { buildTimeTicks } from '../SeismoWaveChart/timeTicks'
import type { WaveUnit } from '../SeismoWaveChart/waveUnit'

/**
 * 詳細の窓。**押されてから読む**（開かない人のほうが多いうえ、こちらからも関数を借りるので、
 * 静的に読むと互いを読み合う形になる）。
 */
function loadSeismoWaveDetail() {
  return lazy(() => import('../SeismoWaveDetail').then((m) => ({ default: m.SeismoWaveDetail })))
}
/**
 * **読み込みに失敗したら作り直す**（`DetailBoundary`）。`lazy` は失敗した読み込みを覚え続けるので、
 * 作り直さないと一度の回線断でそのページを開き直すまで二度と開けなくなる。
 */
let SeismoWaveDetail = loadSeismoWaveDetail()

/**
 * いま開いている詳細の窓（観測点の枠ごとの `useId`）。**アプリ全体で 1 つだけ開く。**
 *
 * 枠ごとに開閉を持つと、観測点が 2 つある地震やカードをまたいで窓が重なり、後から開いた窓の暗幕の
 * 下で前の窓が押せなくなる（敵対的レビューの指摘）。新しく開けば前の窓は閉じる。
 */
let openDetailId: string | null = null
const openDetailListeners = new Set<() => void>()
function setOpenDetail(id: string | null): void {
  openDetailId = id
  for (const listener of openDetailListeners) listener()
}
function subscribeOpenDetail(listener: () => void): () => void {
  openDetailListeners.add(listener)
  return () => {
    openDetailListeners.delete(listener)
  }
}
const readOpenDetail = (): string | null => openDetailId

/**
 * 詳細の窓だけを包む境界。**落ちたら記録へ残して窓を閉じる**（何も代わりに描かない）。
 *
 * **タブの境界まで伝えない。** 窓の部品の読み込み失敗（配信直後の古いページが無いチャンクを
 * 要求する・回線断）や窓の中のレンダー例外を素通しにすると、地震情報タブの境界が受けて
 * **カードの一覧ごと**差し替わる —— 拡大して見るという副次の機能が、主の一覧を道連れにする。
 * 既存の `ErrorBoundary`（region）を使わないのは、代わりの表示がタブを覆う作りのため。
 */
class DetailBoundary extends Component<{ stationId: string; onClose: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error): void {
    log.error(`[seismo] 波形の詳細の窓を開けなかった（${this.props.stationId}）`, error)
    // 次に押されたら読み込みからやり直す（描画の例外でも作り直して害は無い。読み直しは控えから返る）。
    SeismoWaveDetail = loadSeismoWaveDetail()
    this.props.onClose()
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}


/**
 * 到達時刻を、絵の横位置（左端 0・右端 1）へ落とす。
 *
 * **落とす相手は末尾を切った後の列。** 切る前の窓で割ると、まだ来ていない時刻ぶんだけ
 * 分母が長くなり、線が左へ寄る。
 */
export function buildArrivalMarks(
  trimmed: TimedColumns,
  arrival: { pMs: number; sMs: number } | null,
): WaveMark[] {
  return buildArrivalMarksForRange(
    { fromMs: trimmed.fromMs, toMs: trimmed.fromMs + trimmed.columns.length * trimmed.columnSpanMs },
    arrival,
  )
}

/** 範囲で受ける版は共通の部品にある（地図の下端の波形も使う）。詳細の窓はここから引く。 */
export { buildArrivalMarksForRange }

/**
 * 時間軸の 0 に書く名前。
 *
 * - 秒まで取れた: 「発生」
 * - 分までしか無い: 地震情報の時刻（`13:26:00`）。**発生を名乗らない** —— 発生はこの分の
 *   0〜59 秒のどこかで、0 に「発生」と書くと最大 59 秒ずれた目盛りになる
 */
export function axisZeroLabel(zero: WaveAxisZero): string {
  if (zero.kind === 'origin') return '発生'
  return formatTime(new Date(zero.ms).toISOString()) ?? ''
}

/**
 * 地震カードの波形を、描く列へ畳む。
 *
 * **潰さない。** 以前はノイズの帯の内側を潰して描いていた（強調）が、実態が見えないのでやめた
 * （2026-10-13 ユーザー指示「強調はやめてほしい」）。
 *
 * **縦の下限は 0 の手前の静かさから決める**（`utils/seismoQuietScale.ts` の `card`。地図の下端の絵を
 * 畳んだときと同じ倍率）。**揃えないと、同じ揺れが場所によって違う大きさに見える。**
 *
 * @param base 読み返し＋継ぎ足しの列。**静かさはこちらで測る**（切り出した後には 0 の手前が残っていない）
 * @param trimmed 揺れに合わせて切り出した列（描くのはこちら）
 * @param unit 列の単位（自作地震計は gal・公開観測点は μm/s）。下限の物差しはこれで決まる
 */
export function foldQuakeWaveColumns(params: {
  readonly base: TimedColumns
  readonly trimmed: TimedColumns
  readonly zeroMs: number
  readonly visibleAxes: readonly boolean[]
  readonly columnCount: number
  readonly unit: WaveUnit
}): PaintableColumns {
  const { base, trimmed, zeroMs, visibleAxes, columnCount, unit } = params
  return foldHistoryColumns({
    source: trimmed.columns,
    columnCount,
    minScaleGal: quakeMinScale(base, zeroMs, unit),
    visibleAxes,
  })
}

/** カードの縦の下限（列の単位で）。3 成分を重ねるときも合成のときも同じ値を使う。 */
function quakeMinScale(base: TimedColumns, zeroMs: number, unit: WaveUnit): number {
  return unit.minScale('card', measureQuietLevel(base, zeroMs))
}

/** 震度の行の 1 項目。**画面には短い名前と値だけ**を出し、正式な名前はホバーで見せる。 */
export interface QuakeIntensityPart {
  /** 画面に出す短い名前（「最大」「計測」）。 */
  readonly label: string
  /** 小数 1 桁の値。 */
  readonly value: string
  /** ホバーで出す正式な名前。 */
  readonly title: string
}

/**
 * 震度の行の項目。**出す値が 1 つも無ければ `null`**（行ごと出さない）。
 *
 * **階級は添えない**（2026-10-05 のユーザー判断。値を見れば分かり、行が長くなるだけ）。
 *
 * @param intensity ホストが返した区間の震度
 * @param span 描いた区間。**`intensity` の区間と一致しなければ出さない** —— 次の地震で末尾が
 *   切り戻されたあと、訊き直すまでの間は古い区間の値が残っている。
 */
export function formatQuakeIntensityParts(
  intensity: QuakeIntensity | null,
  span: { readonly fromMs: number; readonly toMs: number } | null,
): readonly QuakeIntensityPart[] | null {
  if (intensity === null || span === null) return null
  if (intensity.fromMs !== span.fromMs || intensity.toMs !== span.toMs) return null
  const part = (label: string, title: string, value: number | null): QuakeIntensityPart | null =>
    value === null || !Number.isFinite(value) ? null : { label, value: formatMeasured(value), title }
  const parts = [
    part('最大', '最大リアルタイム震度', intensity.maxRealtime),
    part('計測', '計測震度', intensity.measured),
    // **比べる相手**（2026-10-11 ユーザー承認）。計測震度は静かなときも 0 にならず観測点ごとの値に
    // 落ち着くので、「計測」だけでは上がっているのか分からない。
    part('普段', '直前 1 時間の、同じ長さの区間の計測震度の中央値です', intensity.usualMeasured),
  ].filter((p): p is QuakeIntensityPart => p !== null)
  return parts.length === 0 ? null : parts
}

/** 震度の行（カードと詳細の窓で共有）。 */
export function QuakeIntensityLine({ parts, className }: { parts: readonly QuakeIntensityPart[]; className: string }) {
  return (
    <div className={`${className} flex gap-2 tabular-nums`}>
      {parts.map((p) => (
        <span key={p.label} title={p.title}>
          {p.label} {p.value}
        </span>
      ))}
    </div>
  )
}

/**
 * カードの絵は**向きを全部出す。** 切り替えはカードに置かない —— 見出しの行が二段に折れて邪魔になる。
 * 向きを消して見るのは詳細の窓でする（2026-10-05 のユーザー判断）。
 */
const CARD_VISIBLE_AXES: readonly boolean[] = [true, true, true]

interface Props {
  waves: readonly SeismoQuakeWave[]
  /** 詳細の窓の見出しに出す地震の名前（時刻と震源）。 */
  quakeLabel: string
  /**
   * 合成を出すか 3 成分を重ねるか（設定「波形の表示」。地図の下端の波形を畳んだときと共有・2026-10-13 ユーザー承認）。
   * **合成を返さない古いホストから読み返した列では、合成を選んでいても 3 成分を重ねて描く。**
   */
  view: SeismoWaveCollapsedView
}

export function QuakeSeismoWave({ waves, quakeLabel, view }: Props) {
  if (waves.length === 0) return null
  return (
    <div className="mt-2 flex flex-col gap-1">
      {waves.map((wave) => (
        <HistoryWave key={wave.stationId} wave={wave} quakeLabel={quakeLabel} view={view} />
      ))}
    </div>
  )
}

function HistoryWave({ wave, quakeLabel, view }: { wave: SeismoQuakeWave; quakeLabel: string; view: SeismoWaveCollapsedView }) {
  const detailId = useId()
  const detailOpen = useSyncExternalStore(subscribeOpenDetail, readOpenDetail, readOpenDetail) === detailId
  const setDetailOpen = (open: boolean): void => {
    if (open) setOpenDetail(detailId)
    else if (readOpenDetail() === detailId) setOpenDetail(null)
  }
  // **枠が消えたら（カードを畳んだ・地震が一覧から外れた）開いていた窓の印も外す。** 残すと、
  // どの枠も開いていないのに印だけが残り続ける。
  useEffect(() => () => {
    if (readOpenDetail() === detailId) setOpenDetail(null)
  }, [detailId])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [scaleText, setScaleText] = useState<string | null>(null)
  // 「範囲を切れなかった」を記録へ残した組。**同じ理由は 1 回だけ** —— 描き直しは列が伸びるたび
  // （0.3 秒ごと）に走るので、間引かないと同じ行で埋まる。
  const loggedUntrimmedRef = useRef<string | null>(null)
  // 「合成を選んでいるがホストが合成を返さなかった」を記録へ残した観測点。間引きは上と同じ理由。
  const loggedNoMagRef = useRef<string | null>(null)
  // 「均した線の材料が無い」を記録へ残した観測点。間引きは上と同じ理由。
  const loggedNoMeanRef = useRef<string | null>(null)
  // **震度の行。** 描く区間はここでも同じ関数で切り出し、震度を訊いた区間と突き合わせる
  // （訊く側は `useSeismoQuakeWaves`。区間の物差しは `columnsSpan`）。
  const intensityParts = useMemo(() => {
    const picked = selectQuakeWindow({ base: wave.columns, zero: wave.axisZero, reach: wave.reach, noiseFloor: wave.unit.onsetNoiseFloor })
    return formatQuakeIntensityParts(wave.intensity, columnsSpan(picked.columns))
  }, [wave.columns, wave.axisZero, wave.reach, wave.intensity, wave.unit])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const paint = (): void => {
      // **揺れに合わせて範囲を切り出してから描く**（→ `utils/seismoQuakeWindow.ts`）。
      // 取った範囲は分の頭の 60 秒前から 5 分ぶんあり、そのまま描くと揺れが平らな線に埋もれる。
      // 末尾の空（まだ来ていない時刻）もここで落ちる。
      const picked = selectQuakeWindow({ base: wave.columns, zero: wave.axisZero, reach: wave.reach, noiseFloor: wave.unit.onsetNoiseFloor })
      const trimmed = picked.columns
      // **切れなかったことは記録へ残す。** 絵は取った範囲のまま出るので、画面からは「切る必要が
      // 無かった」と見分けが付かない（ノイズの測り方や走時の側が壊れても、黙って広い絵に戻るだけ）。
      if (picked.untrimmedReason !== null) {
        const key = `${wave.stationId}@${wave.axisZero.ms}@${picked.untrimmedReason}`
        if (loggedUntrimmedRef.current !== key) {
          loggedUntrimmedRef.current = key
          log.debug(
            `[seismo] 地震カードの波形を揺れに合わせて切れなかった（${wave.stationId}）: ${picked.untrimmedReason}`,
          )
        }
      }
      const spanMs = trimmed.columns.length * trimmed.columnSpanMs
      const zeroLabel = axisZeroLabel(wave.axisZero)
      const ticks = (widthPx: number) =>
        buildTimeTicks({
          fromMs: trimmed.fromMs,
          toMs: trimmed.fromMs + spanMs,
          zeroMs: wave.axisZero.ms,
          zeroLabel,
          widthPx,
        })
      const marks = buildArrivalMarks(trimmed, wave.arrival)
      const build = (columnCount: number) =>
        foldQuakeWaveColumns({
          base: wave.columns,
          trimmed,
          zeroMs: wave.axisZero.ms,
          visibleAxes: CARD_VISIBLE_AXES,
          columnCount,
          unit: wave.unit,
        })
      // **途切れたら濃さを落とす。** 列は時間で薄れないので、渡さないと
      // 止まった絵が「いま静かに揺れている」ように見え続ける
      // （→ `useSeismoQuakeWaves` の `interrupted`）。**`waveStale` を素通しで
      // 代わりにはできない** —— あちらはライブ接続の生死なので、過去に完結した
      // 7 日ぶんのカードまで薄くなる。
      if (view === 'composite') {
        // **値のある列がすべて合成を持つときだけ合成で描く**（`compositeCoverage`）。1 列でも欠けていれば
        // 3 成分を重ねた絵へ戻し、記録へ残す —— 画面からは「合成を選んだのに 3 本出ている」としか見えない。
        const coverage = compositeCoverage(trimmed.columns)
        if (coverage.complete) {
          // **線が 1 本だけなので、前後 1 秒で均した線を重ねる**（2026-10-13 ユーザー承認。地図の下端の合成の段と
          // 同じ見せ方）。材料（列の和と数）を返さない古いホストの列では引かない ——記録へ残す。
          const smooth = smoothCompositeWithin(wave.columns, trimmed, MEAN_LINE_WINDOW_MS)
          // **鍵は観測点と地震の組**（範囲を切れなかった記録と同じ粒度）。観測点だけにすると、同じ観測点の別の地震で
          // 欠けても残らない。
          const noMeanKey = `${wave.stationId}@${wave.axisZero.ms}`
          if (smooth === null && loggedNoMeanRef.current !== noMeanKey) {
            loggedNoMeanRef.current = noMeanKey
            const withMean = trimmed.columns.filter((c) => c !== null && c.magCount > 0 && Number.isFinite(c.magSum)).length
            log.debug(
              `[seismo] 地震カードの波形に均した線を引けなかった（${wave.stationId}）: 値のある ${coverage.valued} 列のうち材料（合成の和と数）を持つのは ${withMean} 列。合成だけを描く`,
            )
          }
          setScaleText(
            paintCompositeColumns(canvas, build, wave.interrupted, {
              minScale: quakeMinScale(wave.columns, wave.axisZero.ms, wave.unit),
              unit: wave.unit.label,
              marks,
              ticks,
              overlays:
                smooth === null
                  ? undefined
                  : (count) => [{ values: foldHistoryLine(smooth, count), color: COMPOSITE_SMOOTH_COLOR }],
            }),
          )
          return
        }
        const logKey = `${wave.stationId}:${coverage.withComposite === 0 ? 'none' : 'partial'}`
        if (loggedNoMagRef.current !== logKey) {
          loggedNoMagRef.current = logKey
          log.debug(
            `[seismo] 地震カードの波形に合成の無い列がある（${wave.stationId}）: 値のある ${coverage.valued} 列のうち合成は ${coverage.withComposite} 列。3 成分を重ねて描く`,
          )
        }
      }
      setScaleText(paintWaveColumns(canvas, build, wave.interrupted, { marks, visibleAxes: CARD_VISIBLE_AXES, ticks, unit: wave.unit.label }))
    }
    paint()
    // **幅が変わったら描き直す。** カードは畳んだり開いたりするので、最初に描いた
    // ときの幅のまま残ると引き伸ばされてぼける。
    const observer = new ResizeObserver(() => paint())
    observer.observe(canvas)
    return () => observer.disconnect()
    // 列が伸びたら描き直す（繋ぎ足しは `useSeismoQuakeWaves` が新しい参照で渡す）。
    // **到達も依存に入れる** —— 続報で震源が動くと線の位置が変わる。
    //
    // **途切れも入れる。** 途切れているときは列が 1 つも変わらないので、
    // これが無いと濃さを落とす契機がどこにも無い。
    //
    // **時間軸の 0 と時間帯も入れる。** 秒が後から取れると列は変わらないまま 0 だけが動く。
    // 0 が動けば静かさを測る区間も動く。**表示の設定も入れる**（合成と 3 成分の切り替え）。
  }, [wave.columns, wave.arrival, wave.axisZero, wave.reach, wave.interrupted, wave.unit, view])

  return (
    <div className="rounded-sm bg-black/30 px-2 py-1">
      <div className="flex items-center gap-2 text-[10px] roomy:text-xs leading-none mb-1">
        <span className="text-white truncate max-w-32 roomy:max-w-56">
          {wave.displayName}
        </span>
        {/* **震度は観測点名と同じ行へ置く**（行を増やさない。2026-10-05 のユーザー判断）。 */}
        {intensityParts !== null && <QuakeIntensityLine parts={intensityParts} className="text-white/85" />}
        <span className="ml-auto font-mono tabular-nums text-secondary">{scaleText ?? '—'}</span>
      </div>
      {/* 高さは目盛りの帯（`AXIS_BAND_PX` = 15px）を足したもの。
          **押すと詳細の窓を開く。** カードは全体が `<button>` なので `<span role="button">` で包み、
          押した拍子にカードの選択が切り替わらないよう伝わりを止める（カード内の他の押せるものと同じ作法）。 */}
      <span
        role="button"
        tabIndex={0}
        aria-label="波形を大きく表示"
        className="block cursor-zoom-in"
        onClick={(e) => {
          e.stopPropagation()
          setDetailOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.stopPropagation()
          e.preventDefault()
          setDetailOpen(true)
        }}
      >
        <canvas ref={canvasRef} className="block w-full h-[63px] roomy:h-[79px]" />
      </span>
      {detailOpen && (
        <DetailBoundary stationId={wave.stationId} onClose={() => setDetailOpen(false)}>
          <Suspense fallback={null}>
            <SeismoWaveDetail wave={wave} quakeLabel={quakeLabel} onClose={() => setDetailOpen(false)} />
          </Suspense>
        </DetailBoundary>
      )}
    </div>
  )
}
