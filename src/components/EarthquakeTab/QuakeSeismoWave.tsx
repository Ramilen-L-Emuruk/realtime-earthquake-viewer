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
import type { QuakeIntensity } from '../../services/seismoQuakeIntensity'
import { formatTime } from '../../utils/formatters'
import { log } from '../../utils/logger'
import { formatMeasured } from '../../utils/measuredIntensityRounding'
import { columnsSpan, measureNoiseBand, selectQuakeWindow, type WaveAxisZero } from '../../utils/seismoQuakeWindow'
import type { TimedColumns } from '../../utils/seismoWaveColumns'
import { P_WAVE_COLOR, S_WAVE_COLOR } from '../Map/gl/psWaveStyle'
import { emphasizeColumns } from '../SeismoWaveChart/emphasizeColumns'
import { foldHistoryColumns } from '../SeismoWaveChart/historyColumns'
import { paintWaveColumns, type PaintableColumns, type WaveMark } from '../SeismoWaveChart/paintWave'
import { buildTimeTicks } from '../SeismoWaveChart/timeTicks'

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
 * 縦の振れ幅の下限（gal）。**地図の下端の絵と同じ値**（`SeismoWaveChart` の
 * `MIN_SCALE_GAL`）。**揃えないと、同じ揺れが場所によって違う大きさに見える。**
 *
 * **強調して描くときは効かない**（→ `emphasizeColumns.ts`）。潰した後の縦は残った量に合わせ、
 * 下限は別に持つ（`MIN_EMPHASIZED_SCALE_GAL`）。
 */
const MIN_SCALE_GAL = 10

/**
 * 到達の線の見た目。**地図の予報円と同じ配色・同じ線種を使う**（`gl/psWaveStyle.ts`）——
 * 同じ画面で同じものを指すのに色が違うと、別の量に見える。**P が破線・S が実線**なのも
 * あちらに揃えたもの。
 */
const P_MARK = { color: P_WAVE_COLOR, dashed: true } as const
const S_MARK = { color: S_WAVE_COLOR, dashed: false } as const

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

/**
 * 到達時刻を、絵の横位置へ落とす（範囲で受ける版）。**詳細の窓は生のサンプルで描くとき列を持たない**
 * ので、絵の左端と右端の時刻で受ける。`buildArrivalMarks` もこれを通す（線の見た目を 1 箇所で決める）。
 */
export function buildArrivalMarksForRange(
  range: { readonly fromMs: number; readonly toMs: number },
  arrival: { pMs: number; sMs: number } | null,
): WaveMark[] {
  if (arrival === null) return []
  const spanMs = range.toMs - range.fromMs
  if (!(spanMs > 0)) return []
  const ratioOf = (atMs: number): number => (atMs - range.fromMs) / spanMs
  return [
    { ratio: ratioOf(arrival.pMs), label: 'P', ...P_MARK },
    { ratio: ratioOf(arrival.sMs), label: 'S', ...S_MARK },
  ]
}

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
 * 地震カードの波形を、描く列へ畳む（強調するならノイズを潰す）。
 *
 * **強調はノイズを測れたときだけ。** 測れなければ（0 の手前の記録が足りない）潰さずに今までどおり
 * 畳み、`noiseMissing` を立てて返す —— 推測の幅で潰すと揺れまで消えうるうえ、絵は従来の描き方に
 * 戻るだけなので、呼び出し側が記録へ残さないと「強調が効いていない」ことに誰も気づけない。
 *
 * @param base 読み返し＋継ぎ足しの列。**ノイズはこちらで測る**（切り出した後には 0 の手前が残っていない）
 * @param trimmed 揺れに合わせて切り出した列（描くのはこちら）
 */
export function foldQuakeWaveColumns(params: {
  readonly base: TimedColumns
  readonly trimmed: TimedColumns
  readonly zeroMs: number
  readonly emphasized: boolean
  readonly visibleAxes: readonly boolean[]
  readonly columnCount: number
}): { readonly columns: PaintableColumns; readonly noiseMissing: boolean } {
  const { base, trimmed, zeroMs, emphasized, visibleAxes, columnCount } = params
  const folded = foldHistoryColumns({
    source: trimmed.columns,
    columnCount,
    minScaleGal: MIN_SCALE_GAL,
    visibleAxes,
  })
  if (!emphasized) return { columns: folded, noiseMissing: false }
  const noise = measureNoiseBand(base, zeroMs)
  if (noise === null) return { columns: folded, noiseMissing: true }
  return { columns: emphasizeColumns({ folded, noise, visibleAxes }), noiseMissing: false }
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
 * カードの絵は**向きを全部出し、強調して描く**（強調の既定は 2026-10-03 のユーザー判断）。**切り替えは
 * カードに置かない** —— 見出しの行が二段に折れて邪魔になる。向きを消す・潜らせずに見るのは詳細の窓で
 * する（2026-10-05 のユーザー判断）。
 */
const CARD_EMPHASIZED = true
const CARD_VISIBLE_AXES: readonly boolean[] = [true, true, true]

interface Props {
  waves: readonly SeismoQuakeWave[]
  /** 詳細の窓の見出しに出す地震の名前（時刻と震源）。 */
  quakeLabel: string
}

export function QuakeSeismoWave({ waves, quakeLabel }: Props) {
  if (waves.length === 0) return null
  return (
    <div className="mt-2 flex flex-col gap-1">
      {waves.map((wave) => (
        <HistoryWave key={wave.stationId} wave={wave} quakeLabel={quakeLabel} />
      ))}
    </div>
  )
}

function HistoryWave({ wave, quakeLabel }: { wave: SeismoQuakeWave; quakeLabel: string }) {
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
  // 「強調しようとしたがノイズを測れなかった」を記録へ残した組。間引きは上と同じ理由。
  const loggedNoNoiseRef = useRef<string | null>(null)
  // **震度の行。** 描く区間はここでも同じ関数で切り出し、震度を訊いた区間と突き合わせる
  // （訊く側は `useSeismoQuakeWaves`。区間の物差しは `columnsSpan`）。
  const intensityParts = useMemo(() => {
    const picked = selectQuakeWindow({ base: wave.columns, zero: wave.axisZero, reach: wave.reach })
    return formatQuakeIntensityParts(wave.intensity, columnsSpan(picked.columns))
  }, [wave.columns, wave.axisZero, wave.reach, wave.intensity])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const paint = (): void => {
      // **揺れに合わせて範囲を切り出してから描く**（→ `utils/seismoQuakeWindow.ts`）。
      // 取った範囲は発生の 30 秒前から 4 分ぶんあり、そのまま描くと揺れが平らな線に埋もれる。
      // 末尾の空（まだ来ていない時刻）もここで落ちる。
      const picked = selectQuakeWindow({ base: wave.columns, zero: wave.axisZero, reach: wave.reach })
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
      setScaleText(
        paintWaveColumns(
          canvas,
          (columnCount) => {
            const { columns, noiseMissing } = foldQuakeWaveColumns({
              base: wave.columns,
              trimmed,
              zeroMs: wave.axisZero.ms,
              emphasized: CARD_EMPHASIZED,
              visibleAxes: CARD_VISIBLE_AXES,
              columnCount,
            })
            // **測れなかったことは記録へ残す。** 絵は従来の描き方（±N gal）に戻るだけで、
            // 画面からは「強調が効いていない」と見分けが付かない。
            if (noiseMissing) {
              const key = `${wave.stationId}@${wave.axisZero.ms}`
              if (loggedNoNoiseRef.current !== key) {
                loggedNoNoiseRef.current = key
                log.debug(
                  `[seismo] 地震カードの波形を強調できなかった（${wave.stationId}）: 0 の手前の記録が足りずノイズを測れない`,
                )
              }
            }
            return columns
          },
          // **途切れたら濃さを落とす。** 列は時間で薄れないので、渡さないと
          // 止まった絵が「いま静かに揺れている」ように見え続ける
          // （→ `useSeismoQuakeWaves` の `interrupted`）。**`waveStale` を素通しで
          // 代わりにはできない** —— あちらはライブ接続の生死なので、過去に完結した
          // 7 日ぶんのカードまで薄くなる。
          wave.interrupted,
          {
            marks: buildArrivalMarks(trimmed, wave.arrival),
            visibleAxes: CARD_VISIBLE_AXES,
            ticks: (widthPx) =>
              buildTimeTicks({
                fromMs: trimmed.fromMs,
                toMs: trimmed.fromMs + spanMs,
                zeroMs: wave.axisZero.ms,
                zeroLabel,
                widthPx,
              }),
          },
        ),
      )
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
    // 0 が動けばノイズを測る区間も動く。
  }, [wave.columns, wave.arrival, wave.axisZero, wave.reach, wave.interrupted])

  return (
    <div className="rounded bg-black/30 px-2 py-1">
      <div className="flex items-center gap-2 text-[10px] roomy:text-xs leading-none mb-1">
        <span className="text-white truncate max-w-[8rem] roomy:max-w-[14rem]">
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
