// 自作地震計の波形の詳細の窓。地震カードの波形を押すと開く。
//
// - 東西・南北・上下を**段に分けて**描く（縦の物差しは 3 段で共通 —— 大きさを見比べられるように）
// - 時間方向に拡大・縮小・送りができる
// - **開いたときに区間の生のサンプルをまとめて取り、それで描く**（`services/seismoWaveSamples.ts`）。
//   寄せて 1 ピクセルの点が少なくなれば点を時間順に結ぶので、波の形が出る。拡大・送りの最中には
//   取りに行かないので、操作中に絵が粗くならない（2026-10-05 のユーザー判断で、寄せるたびに列を
//   取り直す作りから替えた）。**届くまでと、取れなかったときはカードの列で描く**
// - P/S の到達線、成分ごとの最大加速度とその時刻、震度の推移（ホストが出した 1 秒ごとの値）、震源距離
//
// **向きはカードと共有しない**（2026-10-05 のユーザー判断）。窓の中だけで持ち、既定は 3 成分すべて。
//
// **ノイズの帯を潰す「強調」は持たない**（2026-10-13 ユーザー指示「強調はやめてほしい。実態が見えないので」）。
//
// **S−P 時間は出さない**（同日のユーザー判断）。観測から P 波を自動で読むと、ノイズに
// 埋もれた初動で誤った秒数をもっともらしく出してしまう。距離は震源と観測点の座標から出す。
//
// **地震カードは全体が `<button>` なので、窓は `document.body` へ出す**（ボタンの中に
// 対話的な要素を入れ子にできない）。**ポータルでも React のイベントは木に沿って親へ伝わる**
// ので、根で止める —— 止めないと、窓の中を押すたびにカードの選択が切り替わる。

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'

import type { SeismoQuakeWave } from '../../hooks/useSeismoQuakeWaves'
import { fetchSeismoWaveSamples, SAMPLES_SPAN_MAX_MS } from '../../services/seismoWaveSamples'
import { createLogThrottle, log } from '../../utils/logger'
import { columnsSpan, measureQuietLevel, selectQuakeWindow } from '../../utils/seismoQuakeWindow'
import { trimTrailingGap } from '../../utils/seismoWaveColumns'
import { MEAN_LINE_WINDOW_MS } from '../../utils/waveMeanLines'
import { axisZeroLabel, buildArrivalMarksForRange, formatQuakeIntensityParts, QuakeIntensityLine } from '../EarthquakeTab/QuakeSeismoWave'
import { foldHistoryColumns } from '../SeismoWaveChart/historyColumns'
import {
  AXIS_AVERAGE_COLORS,
  AXIS_COLORS,
  AXIS_LABELS,
  COMPOSITE_COLOR,
  COMPOSITE_SMOOTH_COLOR,
  paintWaveColumns,
  type PaintableColumns,
  type WaveMark,
} from '../SeismoWaveChart/paintWave'
import { buildTimeTicks } from '../SeismoWaveChart/timeTicks'
import { ToggleChip } from '../SeismoWaveChart/WaveAxisToggles'
import { formatGal, formatScale } from '../SeismoWaveChart/waveLabels'
import {
  clampView,
  columnsRange,
  panView,
  peakPerAxis,
  seriesSegments,
  sliceColumns,
  zoomView,
  type AxisPeak,
  type ViewRange,
} from './detailView'
import { paintIntensitySeries } from './paintIntensity'
import { paintSampleLane } from './paintSampleLane'
import {
  buildSampleSeries,
  singleMemberColumns,
  laneGeometry,
  maxAbsInRange,
  movingAverage,
  peakInRange,
  signedMovingAverages,
  seriesRange,
  vectorMagnitude,
  type SampleSeries,
} from './sampleSeries'


/**
 * 合成を均す幅（ms）。**各時刻の前後 0.5 秒ずつ・計 1 秒**（2026-10-05 のユーザー判断）。値は管理コンソールと共有する
 * （`utils/waveMeanLines.ts`）。
 */
const COMPOSITE_SMOOTH_MS = MEAN_LINE_WINDOW_MS

/** 震度の推移で、線を切る刻みの飛び（ms）。刻みは 1 秒なので 1.5 秒。 */
const SERIES_GAP_MS = 1_500

/**
 * 生のサンプルが見えている範囲を「覆っている」と見なす余裕（ms）。**1 秒。**
 *
 * 記録の範囲（カードの列の端）とサンプルの最初・最後の点は、列 1 つぶん（0.2 秒ほど）ずれる。
 * 覆っていなければ（継ぎ足しで記録が伸びた先を見ている）カードの列で描く。
 */
const SAMPLES_COVER_TOLERANCE_MS = 1_000

/** ホイール 1 刻みで変える幅の割合。 */
const WHEEL_ZOOM = 1.25

/**
 * 「最大」の線。**P/S（水色の破線・朱の実線）と見分けられる白。**
 *
 * - 波形の段: その成分の**最大加速度を記録した時刻**（段の見出しの「最大 ○ gal」と同じ瞬間）
 * - 震度の推移の段: **最大リアルタイム震度に達した時刻**。こちらは揺れの山より 2〜3 秒後ろに付く
 *   （0.3 秒ぶん積み上がってから値が出る量のため）ので、波形の段には重ねない（2026-10-05 のユーザー判断）
 */
const PEAK_MARK = { color: 'rgba(255,255,255,0.85)', dashed: false } as const

/** 2D コンテキストを取れなかった記録の間引き（ブラウザ側の事情なので 1 つの枠）。 */
const throttledNoContext = createLogThrottle(300_000)

interface Props {
  readonly wave: SeismoQuakeWave
  /** 窓の見出しに出す地震の名前（時刻と震源）。 */
  readonly quakeLabel: string
  readonly onClose: () => void
}

export function SeismoWaveDetail({ wave, quakeLabel, onClose }: Props) {
  const [axes, setAxes] = useState<readonly boolean[]>([true, true, true])
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // **生のサンプル。** 届くまで・取れなかったときは `null`（カードの列で描く）。
  const [samples, setSamples] = useState<{ series: SampleSeries; range: ViewRange } | null>(null)

  // 持っている記録の範囲（末尾の空は落とす）。**継ぎ足しで伸びればここも伸びる。**
  const bounds = useMemo(() => columnsRange(trimTrailingGap(wave.columns)), [wave.columns])
  // カードと同じ切り出し。**最初に映す範囲と、震度・最大加速度を数える区間に使う。**
  const quakeSpan = useMemo(() => {
    const picked = selectQuakeWindow({ base: wave.columns, zero: wave.axisZero, reach: wave.reach, noiseFloor: wave.unit.onsetNoiseFloor })
    return columnsSpan(picked.columns)
  }, [wave.columns, wave.axisZero, wave.reach, wave.unit])

  const [rawView, setRawView] = useState<ViewRange>(() => quakeSpan ?? bounds)
  // **描くたびに記録の中へ収める。** 継ぎ足しで記録が伸びても、見えている範囲は勝手に動かさない。
  const view = clampView(rawView, bounds)

  // **生のサンプルが見えている範囲を覆っていれば、それで描く。**
  const useSamples =
    samples !== null &&
    samples.range.fromMs <= view.fromMs + SAMPLES_COVER_TOLERANCE_MS &&
    samples.range.toMs >= view.toMs - SAMPLES_COVER_TOLERANCE_MS
  // 覆っていなければカードの列から切り出す。**参照を保つ**（描き直しの依存に入る）。
  const columnsShown = useMemo(() => sliceColumns(wave.columns, view), [wave.columns, view.fromMs, view.toMs]) // eslint-disable-line react-hooks/exhaustive-deps
  // **横位置の物差し。** サンプルなら見えている範囲そのもの、列なら切り出した列の範囲
  // （列は幅いっぱいに並ぶので、列の端で比を取らないと線が列 1 つ分ずれる）。
  const columnsShownRange = columnsRange(columnsShown)
  const displayFromMs = useSamples ? view.fromMs : columnsShownRange.fromMs
  const displayToMs = useSamples ? view.toMs : columnsShownRange.toMs

  const intensityParts = formatQuakeIntensityParts(wave.intensity, quakeSpan)
  // **震度は描く区間と訊いた区間が一致するときだけ使う**（行の文言と同じ条件）。
  const intensity = intensityParts !== null ? wave.intensity : null
  const peaks = useMemo(
    () => (quakeSpan === null ? ([null, null, null] as const) : peakPerAxis(wave.columns, quakeSpan)),
    [wave.columns, quakeSpan],
  )
  // **合成の段はサンプルが届いてから出す**（2026-10-05 のユーザー判断）。カードの列は成分ごとの上下の端
  // しか持たず、合成の大きさは出せない（端どうしを足すと実際より大きくなる）。見出しの最大は成分と同じく
  // カードと同じ切り出した区間で数える。
  const showComposite = useSamples
  // **合成は選んでいる向きだけで出す**（2026-10-05 のユーザー判断）。向きを切り替えたときと届いたときだけ
  // 作り直す（拡大・送りのたびには作らない）。均した線も同じ。
  const composite = useMemo(() => {
    if (samples === null) return null
    const magnitude = vectorMagnitude(samples.series, axes)
    return { magnitude, smooth: movingAverage(samples.series, magnitude, COMPOSITE_SMOOTH_MS) }
  }, [samples, axes])
  // **成分の正側・負側の平均の線**（前後 1 秒。合成の均した線と同じ幅）。届いたサンプルから 1 回だけ作る。
  const axisAverages = useMemo(() => {
    if (samples === null) return null
    return [0, 1, 2].map((a) => signedMovingAverages(samples.series, samples.series.v[a], COMPOSITE_SMOOTH_MS))
  }, [samples])
  const compositePeak = useMemo(
    () => (samples === null || composite === null || quakeSpan === null ? null : peakInRange(samples.series, composite.magnitude, quakeSpan)),
    [samples, composite, quakeSpan],
  )
  const compositeRef = useRef<HTMLCanvasElement | null>(null)
  const [compositeScaleText, setCompositeScaleText] = useState<string | null>(null)

  // ---- 生のサンプルを取る ----
  // **開いたときに 1 回、揺れが収まって伸ばし終えたらもう 1 回**（伸びている最中に取った分は末尾が欠ける）。
  // 拡大・送りでは取りに行かない。
  //
  // **「伸ばし終えた」は一度立ったら戻さない。** `wave.complete` は余震で揺れがぶり返すと偽へ戻り、
  // 収まるとまた真になる —— そのたびに最大 10 分ぶんを取り直すことになる。
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds
  const everCompleteRef = useRef(wave.complete)
  if (wave.complete) everCompleteRef.current = true
  const everComplete = everCompleteRef.current
  // **手元に持っている観測点（公開観測点）は取りに行かない。** 保存庫から取った範囲をまるごと読んであるので、
  // それを並べるだけ（取った範囲が変わる＝取り直したときだけ並べ直す）。
  const heldWindow = wave.samples.kind === 'held' ? wave.samples.window : null
  useEffect(() => {
    if (heldWindow === null) return
    let series: SampleSeries
    try {
      series = buildSampleSeries([heldWindow])
    } catch (error) {
      log.error(`[seismo] 詳細の窓: 手元の生のサンプルを並べられなかった（${wave.stationId}）。カードの列で描く:`, error)
      return
    }
    const range = seriesRange(series)
    if (range === null) {
      log.debug(`[seismo] 詳細の窓: 手元の生のサンプルが 1 点も無い（${wave.stationId}）。カードの列で描く`)
      return
    }
    setSamples({ series, range })
  }, [heldWindow, wave.stationId])

  const hostBaseUrl = wave.samples.kind === 'host' ? wave.samples.baseUrl : null
  useEffect(() => {
    if (hostBaseUrl === null) return
    const b = boundsRef.current
    if (!(b.toMs > b.fromMs)) return
    const ctrl = new AbortController()
    // **ホストの列の上限（10 分）を超える区間は頭から 10 分ぶん**（揺れは頭のほうにある）。
    const toMs = Math.min(b.toMs, b.fromMs + SAMPLES_SPAN_MAX_MS)
    void fetchSeismoWaveSamples({
      baseUrl: hostBaseUrl,
      stationId: wave.stationId,
      fromMs: b.fromMs,
      toMs,
      signal: ctrl.signal,
    }).then((result) => {
      // 失敗は取得層が記録へ残す。**絵はカードの列のまま出ている**ので、ここでは何もしない。
      if (result.kind !== 'ok' || ctrl.signal.aborted) return
      // **ここの例外も境界へ届かない**（約束の続きの中なので）。記録へ残し、カードの列のまま描く。
      let series: SampleSeries
      try {
        series = buildSampleSeries(result.samples.chunks)
      } catch (error) {
        log.error(`[seismo] 詳細の窓: 生のサンプルを並べられなかった（${wave.stationId}）。カードの列で描く:`, error)
        return
      }
      const range = seriesRange(series)
      if (range === null) {
        log.debug(`[seismo] 詳細の窓: 生のサンプルが 1 点も無い（${wave.stationId}）。カードの列で描く`)
        return
      }
      setSamples({ series, range })
    })
    return () => ctrl.abort()
  }, [hostBaseUrl, wave.stationId, everComplete])

  // ---- フォーカス ----
  // **開いたら窓の中へ移し、Tab で外へ出さない。** 出られると、背後のカードの波形へ移って Enter で
  // 二枚目の窓を開ける（キーボード操作・読み上げの利用者が迷子になる）。閉じたら元の場所へ戻す。
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => before?.focus()
  }, [])
  const trapTab = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return
    const root = dialogRef.current
    if (root === null) return
    const focusable = [...root.querySelectorAll<HTMLElement>('button, [role="button"][tabindex]')]
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    } else if (!root.contains(document.activeElement)) {
      e.preventDefault()
      first.focus()
    }
  }

  // ---- 閉じる（Esc） ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // ---- 描く ----
  const laneRefs = useRef<(HTMLCanvasElement | null)[]>([null, null, null])
  const intensityRef = useRef<HTMLCanvasElement | null>(null)
  const plotRef = useRef<HTMLDivElement | null>(null)
  const [scaleText, setScaleText] = useState<string | null>(null)

  const visibleIdx = [0, 1, 2].filter((a) => axes[a] !== false)

  // **縦の下限**。0 の手前の静かさから決める（`utils/seismoQuietScale.ts` の `detail`）。
  // カードより低い倍率にする —— カードは「一覧で見て、揺れたかどうか」を見せるために静かなときの振れを
  // 小さく抑え、こちらは寄せて読むための窓なので小さな揺れも段の高さいっぱいに出す。
  const detailFloorGal = useMemo(
    () => wave.unit.minScale('detail', measureQuietLevel(wave.columns, wave.axisZero.ms)),
    [wave.columns, wave.axisZero.ms, wave.unit],
  )

  useEffect(() => {
    const displayRange = { fromMs: displayFromMs, toMs: displayToMs }
    const span = displayToMs - displayFromMs
    const ratioOf = (atMs: number): number | null => (span > 0 ? (atMs - displayFromMs) / span : null)
    const peakMarkAt = (atMs: number | null | undefined): WaveMark[] => {
      if (atMs === null || atMs === undefined) return []
      const ratio = ratioOf(atMs)
      return ratio === null ? [] : [{ ratio, label: '最大', ...PEAK_MARK }]
    }
    const arrivalMarks = buildArrivalMarksForRange(displayRange, wave.arrival)
    // 段ごとの線: 到達（P/S のラベルは一番上の段だけ。合成の段があればそちら）＋その成分の最大加速度の時刻。
    const laneMarks = (a: number, isTop: boolean): WaveMark[] => [
      ...(isTop ? arrivalMarks : arrivalMarks.map((m) => ({ ...m, label: '' }))),
      ...peakMarkAt(peaks[a]?.atMs),
    ]
    const lastLane = visibleIdx[visibleIdx.length - 1]
    const zeroLabel = axisZeroLabel(wave.axisZero)
    const ticksFor = (a: number) =>
      a === lastLane
        ? (widthPx: number) =>
            buildTimeTicks({ fromMs: displayFromMs, toMs: displayToMs, zeroMs: wave.axisZero.ms, zeroLabel, widthPx })
        : undefined

    const paint = (): void => {
      if (useSamples && samples !== null) {
        // ---- 生のサンプルで描く ----
        const identity = (_a: number, v: number): number => v
        // 成分ごとの振れ。3 段の縦は見えている成分のいちばん大きい振れで揃える。
        const maxes: number[] = maxAbsInRange(samples.series, view, identity)
        let best = -1
        for (const a of visibleIdx) if (Number.isFinite(maxes[a]) && (best < 0 || maxes[a] > maxes[best])) best = a
        const scaleGal = Math.max(detailFloorGal, best < 0 ? 0 : maxes[best])
        // 裏付けが 1 本しか無いピクセル。全段で同じなので幅ごとに 1 回だけ数える。
        const singleCache = new Map<number, Uint8Array>()
        const singleMember = (widthPx: number): Uint8Array => {
          let hit = singleCache.get(widthPx)
          if (hit === undefined) {
            hit = singleMemberColumns(samples.series, view, widthPx)
            singleCache.set(widthPx, hit)
          }
          return hit
        }
        for (const a of visibleIdx) {
          const canvas = laneRefs.current[a]
          if (canvas === null) continue
          const ok = paintSampleLane(canvas, {
            color: AXIS_COLORS[a],
            baseline: 'center',
            geometry: (widthPx) =>
              laneGeometry({ series: samples.series, values: samples.series.v[a], range: view, widthPx, map: (v) => v }),
            overlays:
              axisAverages === null
                ? []
                : (['pos', 'neg'] as const).map((side) => ({
                    color: AXIS_AVERAGE_COLORS[a],
                    geometry: (widthPx: number) =>
                      laneGeometry({ series: samples.series, values: axisAverages[a][side], range: view, widthPx, map: (v) => v }),
                  })),
            singleMember,
            scaleGal,
            stale: wave.interrupted,
            marks: laneMarks(a, a === visibleIdx[0] && !showComposite),
            ticks: ticksFor(a),
          })
          if (!ok) throttledNoContext(() => log.error('[seismo] 詳細の窓の波形を描く 2D コンテキストを取れなかった'))
        }
        // ---- 合成の段（一番上） ----
        // **縦は合成の段だけで持つ**（合成は成分より大きいので、3 段と共有すると成分の段が縮む）。
        // 前後 1 秒で均した線を太く重ね、揺れの強さの増え方・収まり方を読めるようにする。
        const cc = compositeRef.current
        if (cc !== null && composite !== null) {
          const peakInView = peakInRange(samples.series, composite.magnitude, view)
          const compositeScale = Math.max(detailFloorGal, peakInView?.value ?? 0)
          const ok = paintSampleLane(cc, {
            color: COMPOSITE_COLOR,
            baseline: 'bottom',
            geometry: (widthPx) =>
              laneGeometry({ series: samples.series, values: composite.magnitude, range: view, widthPx, map: (v) => v }),
            overlays: [
              {
                color: COMPOSITE_SMOOTH_COLOR,
                geometry: (widthPx: number) =>
                  laneGeometry({ series: samples.series, values: composite.smooth, range: view, widthPx, map: (v) => v }),
              },
            ],
            singleMember,
            scaleGal: compositeScale,
            stale: wave.interrupted,
            marks: [...arrivalMarks, ...peakMarkAt(compositePeak?.atMs)],
          })
          if (!ok) throttledNoContext(() => log.error('[seismo] 詳細の窓の波形を描く 2D コンテキストを取れなかった'))
          setCompositeScaleText(`0〜${formatGal(compositeScale)} ${wave.unit.label}`)
        }
        // 縦の表示はカードと同じ書式。
        setScaleText(formatScale(scaleGal, wave.unit.label))
      } else {
        // ---- カードの列で描く（サンプルが届くまで・取れなかったとき・覆っていない範囲） ----
        const build = (columnCount: number): PaintableColumns =>
          foldHistoryColumns({
            source: columnsShown.columns,
            columnCount,
            minScaleGal: detailFloorGal,
            visibleAxes: axes,
          })
        let text: string | null = null
        for (const a of visibleIdx) {
          const canvas = laneRefs.current[a]
          if (canvas === null) continue
          const got = paintWaveColumns(canvas, build, wave.interrupted, {
            marks: laneMarks(a, a === visibleIdx[0]),
            visibleAxes: [0, 1, 2].map((i) => i === a),
            ticks: ticksFor(a),
            unit: wave.unit.label,
          })
          if (text === null) text = got
        }
        setScaleText(text)
      }
      const ic = intensityRef.current
      if (ic !== null && intensity !== null) {
        // 震度の推移の段: 到達＋最大リアルタイム震度に達した時刻（この段はラベルを描かない）。
        paintIntensitySeries(
          ic,
          displayRange,
          seriesSegments(intensity.realtimeSeries, displayRange, SERIES_GAP_MS),
          [...arrivalMarks, ...peakMarkAt(intensity.maxRealtimeAtMs)],
        )
      }
    }
    paint()
    const plot = plotRef.current
    if (plot === null) return
    // **大きさが変わって描き直すときの例外は境界（`DetailBoundary`）へ届かない**（ブラウザのコールバックの
    // 中なので）。届いたときと同じく、記録へ残して窓を閉じる —— 放っておくと絵がその手前で固まる。
    const observer = new ResizeObserver(() => {
      try {
        paint()
      } catch (error) {
        log.error('[seismo] 詳細の窓を描き直せなかったので閉じる:', error)
        onCloseRef.current()
      }
    })
    observer.observe(plot)
    return () => observer.disconnect()
    // `visibleIdx` は `axes` から作るので `axes` で足りる。`view` は `useSamples` のときだけ使い、
    // そのとき `displayFromMs`/`displayToMs` が `view` と一致する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useSamples, samples, columnsShown, displayFromMs, displayToMs, axes, detailFloorGal, peaks, composite, compositePeak, axisAverages, intensity, wave.arrival, wave.axisZero, wave.interrupted, wave.unit])

  // ---- 操作 ----
  const zoomBy = useCallback(
    (factor: number, anchorRatio = 0.5) => setRawView((v) => zoomView(clampView(v, bounds), bounds, factor, anchorRatio)),
    [bounds],
  )

  // **ホイールは自分で受ける。** React の `onWheel` は受け身（passive）で `preventDefault` が効かず、
  // 窓の後ろのカード一覧まで一緒に流れてしまう。
  useEffect(() => {
    const plot = plotRef.current
    if (plot === null) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = plot.getBoundingClientRect()
      const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5
      zoomBy(e.deltaY > 0 ? WHEEL_ZOOM : 1 / WHEEL_ZOOM, ratio)
    }
    plot.addEventListener('wheel', onWheel, { passive: false })
    return () => plot.removeEventListener('wheel', onWheel)
  }, [zoomBy])

  // ドラッグで送る・2 本指でつまんで拡大縮小。
  const pointersRef = useRef(new Map<number, number>())
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointersRef.current.set(e.pointerId, e.clientX)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const pointers = pointersRef.current
    const prevX = pointers.get(e.pointerId)
    if (prevX === undefined) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (!(rect.width > 0)) return
    if (pointers.size >= 2) {
      const xs = [...pointers.values()]
      const before = Math.abs(xs[0] - xs[1])
      pointers.set(e.pointerId, e.clientX)
      const after = Math.abs([...pointers.values()][0] - [...pointers.values()][1])
      if (before > 4 && after > 4) {
        const mid = (xs[0] + xs[1]) / 2
        zoomBy(before / after, (mid - rect.left) / rect.width)
      }
      return
    }
    pointers.set(e.pointerId, e.clientX)
    const dx = e.clientX - prevX
    setRawView((v) => panView(clampView(v, bounds), bounds, -dx / rect.width))
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    pointersRef.current.delete(e.pointerId)
  }

  // **最後の 1 本は消させない。** 時間の目盛りはいちばん下の成分の段に描くので、全部消すと
  // 合成の段だけが残って目盛りがどこにも無くなる（何も描かない窓にする意味も無い）。
  const toggleAxis = (a: number): void =>
    setAxes((prev) => {
      const next = prev.map((on, i) => (i === a ? !on : on))
      return next.some((on) => on) ? next : prev
    })

  const distanceText = wave.distanceKm === null ? null : `震源距離 約${Math.round(wave.distanceKm)} km`

  const content = (
    <div
      className="fixed inset-0 z-100000 flex items-center justify-center bg-black/60 p-2 sm:p-6"
      // **ここで止める。** ポータルでもイベントはカード（`<button>`）まで伝わる。
      onClick={(e) => {
        e.stopPropagation()
        if (e.target === e.currentTarget) onClose()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        trapTab(e)
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${wave.displayName} の波形の詳細`}
        className="flex max-h-full w-full max-w-5xl flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-panel p-3 text-sm shadow-2xl shadow-black/60"
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-white">{quakeLabel}</div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-secondary">
              <span>{wave.displayName}</span>
              {distanceText !== null && <span>{distanceText}</span>}
            </div>
            {intensityParts !== null && <QuakeIntensityLine parts={intensityParts} className="mt-0.5 text-xs text-white/85" />}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-sm px-2 py-0.5 text-lg leading-none text-secondary hover:bg-white/10 hover:text-white"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {AXIS_LABELS.map((label, i) => (
            <ToggleChip key={label} on={axes[i] !== false} color={AXIS_COLORS[i]} onToggle={() => toggleAxis(i)}>
              {label}
            </ToggleChip>
          ))}
          <span className="ml-auto flex items-center gap-1">
            <ZoomButton label="拡大" onClick={() => zoomBy(1 / 2)}>＋</ZoomButton>
            <ZoomButton label="縮小" onClick={() => zoomBy(2)}>−</ZoomButton>
            <ZoomButton label="全体" onClick={() => setRawView(bounds)}>全体</ZoomButton>
          </span>
        </div>

        <div
          ref={plotRef}
          className="flex cursor-grab touch-none select-none flex-col gap-1 active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {showComposite && (
            <div>
              <div className="flex gap-2 text-[11px] leading-none" style={{ color: COMPOSITE_COLOR }}>
                <span>合成</span>
                {compositePeak !== null && (
                  <span className="tabular-nums text-secondary">最大 {formatGal(compositePeak.value)} {wave.unit.label}</span>
                )}
                <span className="ml-auto font-mono tabular-nums text-secondary">{compositeScaleText ?? '—'}</span>
              </div>
              <canvas ref={compositeRef} className="block h-[96px] w-full" />
            </div>
          )}
          {[0, 1, 2].map((a) =>
            axes[a] === false ? null : (
              <div key={a}>
                <div className="flex gap-2 text-[11px] leading-none" style={{ color: AXIS_COLORS[a] }}>
                  <span>{AXIS_LABELS[a]}</span>
                  {peaks[a] !== null && (
                    <span className="tabular-nums text-secondary">最大 {formatGal((peaks[a] as AxisPeak).gal)} {wave.unit.label}</span>
                  )}
                  {/* 縦の範囲は**段ごとの見出しの右端**（合成の段と同じ位置）。3 成分は縦を共通にしているので、
                      どの段にも同じ値が並ぶ。 */}
                  <span className="ml-auto font-mono tabular-nums text-secondary">{scaleText ?? '—'}</span>
                </div>
                <canvas
                  ref={(el) => {
                    laneRefs.current[a] = el
                  }}
                  // 一番下の段だけ時間軸の帯（15px）ぶん高い。
                  className={`block w-full ${a === visibleIdx[visibleIdx.length - 1] ? 'h-[111px]' : 'h-[96px]'}`}
                />
              </div>
            ),
          )}
          {intensity !== null && intensity.realtimeSeries.length > 0 && (
            <div>
              <div className="text-[11px] leading-none text-secondary">リアルタイム震度の推移</div>
              <canvas ref={intensityRef} className="block h-[80px] w-full" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
  return createPortal(content, document.body)
}

function ZoomButton({ label, onClick, children }: { label: string; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="min-w-8 rounded-sm border border-border px-1.5 py-0.5 text-secondary hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  )
}
