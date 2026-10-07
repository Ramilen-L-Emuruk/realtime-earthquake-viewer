// 「波形の記録」タブ（`/api/records/*` の読み返し。当て方は `recordsPlot.ts`）。
// **宛先は運用者。** 画面の作りと文言は 2026-10-07 ユーザー承認。
//
// - **上から**: 記録の選択と期間 → 全体の帯（押すとその時刻へ寄る） → 範囲の操作 → 3 軸の合成 → 軸ごとの段 →
//   リアルタイム震度の推移 → 指した所の値・欠けの凡例・状態の行
// - **取り方**: 範囲が 10 分以内なら軸ごとの生のサンプル（寄せきれば 1 サンプルずつの点を結んだ線）、
//   それより広ければ画面の幅ぶんの列（1 分か 1 秒の要約）。**操作の最中は取り直さず、止まってから取る**
//   （`RELOAD_DEBOUNCE_MS`）。前の取得は打ち切る
// - **取った範囲の外は欠けとして描かない。** 送った直後は、取り直すまで端が空白になるだけ
// - **縦の物差しは軸の段で共通**（大きさを見比べられるように。PWA の詳細の窓と同じ）。中心は段ごとの平均
//
// 時刻はブラウザの時計の地域で出す（ほかのタブと同じ）。
//
// **印の段**（#621 段 f・文言は 2026-10-08 ユーザー承認）: 波形の段の上に受信・気象庁・揺れの記録の 3 列を置き、
// 気象庁の P・S は波形の段も縦に貫く。印は波形と別に取る（気象庁の地震一覧は初めての範囲だと十数秒かかるので、
// 波形の取得を待たせない）。当て方は `recordsMarks.ts`。

import { ApiError, apiFetch, describeAdminAuthFailure, getStoredToken } from './api'
import { escapeHtml, qs } from './dom'
import {
  LANE_QUAKE_TITLE,
  LANE_RECEPTION_TITLE,
  LANE_SHAKE_TITLE,
  MARK_LANE_HEIGHT_PX,
  QUAKES_RANGE_MAX_MS,
  QUAKE_LEGEND,
  QUAKE_LOADING_TEXT,
  QUAKE_OFF_TEXT,
  QUAKE_TOO_WIDE_TEXT,
  QUAKE_UNLOCATED_TEXT,
  RECEPTION_LEGEND,
  RECEPTION_STATION_GONE_TEXT,
  RECEPTION_STATION_NOTE,
  RECEPTION_TRUNCATED_TEXT,
  SHAKE_LEGEND,
  SHAKE_TRUNCATED_TEXT,
  UNDERLINE_HEIGHT_PX,
  UNDERLINE_LEGEND,
  arrivalMark,
  originUnderline,
  quakeFailedDaysText,
  quakeFailureText,
  quakeReadout,
  quakesAt,
  readQuakesData,
  readReceptionData,
  receptionAt,
  receptionLane,
  receptionPendingNote,
  shakeReadout,
  shakesAt,
  spanX,
  type QuakesView,
  type ReceptionLane,
  type Span,
  type UnderlineKind,
} from './recordsMarks'
import {
  FREQ_MAX_HZ,
  FREQ_MIN_HZ,
  NHNM,
  NLNM,
  NOISE_MODEL_LEGEND,
  NOISE_TITLE,
  SPECTRUM_EMPTY_TEXT,
  SPECTRUM_TITLE,
  binAt,
  colorOfDb,
  colorScaleCss,
  dbExtent,
  dbRange,
  dbScaleText,
  formatDb,
  hzOfX,
  hzOfY,
  noiseHeader,
  noiseModelCurve,
  noiseOfEnvelopeColumns,
  noiseRange,
  psdToDb,
  readSpectrogramData,
  readSpectrumData,
  secondRms,
  spectrogramHeader,
  spectrogramReadout,
  spectrogramTitle,
  spectrumHeader,
  spectrumReadout,
  xOfHz,
  yOfHz,
  type NoiseSeries,
  type SpectrogramData,
  type SpectrumData,
} from './recordsSpectrum'
import { EVENTS_PAGE_LIMIT, readShakeRange, type ShakeRecordView, type ShakeVerdictView } from './shakeHistory'
import {
  COLUMNS_MAX,
  COMPOSITE_TITLE,
  COMPOSITE_TOO_WIDE_TEXT,
  EMPTY_RANGE_TEXT,
  GAP_NONE_LEGEND,
  GAP_PENDING_LEGEND,
  INTENSITY_STATION_ONLY_TEXT,
  INTENSITY_TITLE,
  INTENSITY_TOO_WIDE_TEXT,
  OVERVIEW_CAPTION,
  SAMPLES_RANGE_MAX_MS,
  SPAN_CHOICES,
  TOKEN_MISSING_TEXT,
  boundsOf,
  centerAt,
  compositeRuns,
  fetchFailureText,
  groupChannels,
  intensityHeader,
  overviewRange,
  overviewSpread,
  peakLabel,
  periodText,
  pixelPlan,
  planFetch,
  problemsNote,
  readChannelList,
  readEnvelopeData,
  readIntensityData,
  readSamplesData,
  readoutText,
  recordTicks,
  recordsUrl,
  scaleLabel,
  sharedHalfSpan,
  shiftBy,
  sourceNote,
  traceCenter,
  traceGaps,
  traceOfEnvelope,
  traceOfSamples,
  tracePeak,
  traceValueAt,
  unreadableListNote,
  unscaledNote,
  withSpan,
  xOf,
  zoomAt,
  type AxisTrace,
  type EnvelopeData,
  type GapSpan,
  type HourTallyView,
  type IntensityData,
  type IrregularHourView,
  type RecordGroup,
  type TimeRange,
  type ValueUnit,
} from './recordsPlot'

/** 操作が止まってから取り直すまで。 */
const RELOAD_DEBOUNCE_MS = 150
const HOUR_MS = 3_600_000
/** 最初に映す幅（記録の新しい側の 1 時間）。 */
const INITIAL_SPAN_MS = 3_600_000
/** ホイール 1 刻みで寄せる・引く倍率。 */
const WHEEL_ZOOM = 1.25
const AXIS_HEIGHT = 120
const COMPOSITE_HEIGHT = 90
const INTENSITY_HEIGHT = 80
const OVERVIEW_HEIGHT = 48
const TIME_AXIS_HEIGHT = 16
const PLOT_PADDING_Y = 6
const TIME_LABEL_MARGIN = 36
const WAVE_COLOR = 'rgba(37, 99, 168, 0.95)'
const COMPOSITE_COLOR = 'rgba(123, 63, 160, 0.95)'
const INTENSITY_COLOR = 'rgba(179, 38, 30, 0.9)'
/** 欠けの斜線。**凡例（`index.html` の `.records-hatch-*`）と同じ色。** */
const HATCH_NONE = 'rgba(179, 38, 30, 0.35)'
const HATCH_PENDING = 'rgba(128, 128, 128, 0.5)'
/** 印の段の列の間（CSS ピクセル）。 */
const MARK_LANE_GAP_PX = 2
const MARKS_HEIGHT = 3 * MARK_LANE_HEIGHT_PX + 2 * MARK_LANE_GAP_PX
/** 受信の帯と波形の下の線の色。**凡例の文（橙・紫・緑・赤）と合わせる。** */
const MARK_COLORS: Readonly<Record<UnderlineKind, string>> = {
  backlog: 'rgba(230, 126, 34, 0.9)',
  late: 'rgba(142, 68, 173, 0.85)',
  revised: 'rgba(39, 174, 96, 0.9)',
  questionable: 'rgba(192, 57, 43, 0.9)',
}
const P_COLOR = 'rgba(37, 99, 168, 0.9)'
const S_COLOR = 'rgba(179, 38, 30, 0.9)'
const P_BAND = 'rgba(37, 99, 168, 0.12)'
const S_BAND = 'rgba(179, 38, 30, 0.12)'
/** 揺れの記録の帯の色。**揺れの記録タブの判定の色と同じ順**（地震だけ濃く、生活振動らしい・照合できずは灰）。 */
const VERDICT_BAND: Readonly<Record<ShakeVerdictView, string>> = {
  quake: 'rgba(179, 38, 30, 0.45)',
  'quake-like': 'rgba(37, 99, 168, 0.4)',
  pending: 'rgba(128, 128, 128, 0.35)',
  'local-like': 'rgba(128, 128, 128, 0.35)',
  unchecked: 'rgba(128, 128, 128, 0.35)',
}
/** 範囲の頭より前に始まった揺れも拾う幅（揺れの記録は始まりの時刻で引くので）。 */
const SHAKE_LEAD_MS = 10 * 60_000
/** 指した所の読み取りで、印を拾う幅（CSS ピクセル）。 */
const HOVER_TOLERANCE_PX = 4
/** 指した所に掛かる地震・揺れの記録を何件まで並べるか。 */
const READOUT_MAX_ITEMS = 2
const NOISE_HEIGHT = 90
const SPECTROGRAM_HEIGHT = 80
const SPECTRUM_HEIGHT = 220
/** 範囲のスペクトルの下端に周波数の文字を置く高さ。 */
const SPECTRUM_LABEL_HEIGHT = 16
/** 範囲のスペクトルでモデルの線を引く点の数。 */
const NOISE_MODEL_STEPS = 120
/**
 * 軸ごとの線の色（ノイズの段と範囲のスペクトルで重ねるとき）。**軸の並びの順に固定**（消した軸があっても色がずれない）。
 * 色相を離し、白い地でも読める濃さにする。
 */
const AXIS_LINE_COLORS: readonly string[] = ['rgba(37, 99, 168, 0.95)', 'rgba(211, 84, 0, 0.95)', 'rgba(30, 132, 73, 0.95)']
const NOISE_MODEL_COLOR = 'rgba(128, 128, 128, 0.85)'

/** 軸 1 本ぶんの取れた値。 */
interface AxisData {
  readonly trace: AxisTrace
  readonly unit: ValueUnit
  readonly source: 'coarse' | 'fine' | 'samples' | 'raw-samples'
  readonly columnMs: number | null
  readonly hours: HourTallyView | null
  readonly irregular: readonly IrregularHourView[]
  readonly unscaledHours: number
  /** 1 秒より速い揺れの RMS（ノイズ水準の段）。 */
  readonly noise: NoiseSeries
}

/**
 * 周波数の材料（軸の id ごと）。波形と別に取る。**取り直すまで前の材料を描き続ける**
 * （スペクトログラムは時刻で置くので重なる所はそのまま正しく、範囲のスペクトルはすぐ差し替わる）。
 */
interface FreqState {
  readonly groupKey: string
  readonly unit: 'gal' | 'native'
  readonly spectrograms: ReadonlyMap<string, SpectrogramData>
  readonly spectra: ReadonlyMap<string, SpectrumData>
}

interface Loaded {
  readonly groupKey: string
  readonly unit: 'gal' | 'native'
  readonly fetched: TimeRange
  /** 軸の id ごと。 */
  readonly axes: ReadonlyMap<string, AxisData>
  readonly intensity: IntensityData | null
}

/**
 * 印の段の材料。**範囲を動かしても、取り直すまで前の材料を描き続ける**（印は時刻で置くので、重なる所はそのまま正しい）。
 * 3 つの口はそれぞれ届いた順に書き込む。
 */
interface MarksState {
  readonly groupKey: string
  reception: ReceptionLane | null
  receptionPending: number
  receptionTruncated: boolean
  quakes: QuakesView | null
  quakeState: 'too-wide' | 'loading' | 'done' | 'failed'
  quakeFailure: string | null
  shakes: readonly ShakeRecordView[]
  shakesTruncated: boolean
  /** 受信・揺れの記録を取れなかった理由（気象庁は `quakeFailure`）。 */
  failure: string | null
}

interface OverviewLoaded {
  readonly groupKey: string
  readonly range: TimeRange
  readonly firstColumnMs: number
  readonly columnMs: number
  readonly spread: readonly number[]
}

function failureReason(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.body?.error
    if (code !== undefined) return describeAdminAuthFailure(code) ?? code
    return `HTTP ${error.status}`
  }
  return error instanceof Error ? error.message : String(error)
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** `datetime-local` の値（地域の時刻・秒まで）。 */
function toLocalInput(atMs: number): string {
  const d = new Date(atMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function maxTally(list: readonly (HourTallyView | null)[]): HourTallyView | null {
  let out: HourTallyView | null = null
  for (const t of list) {
    if (t === null) continue
    out =
      out === null
        ? t
        : {
            ok: Math.max(out.ok, t.ok),
            stale: Math.max(out.stale, t.stale),
            pending: Math.max(out.pending, t.pending),
            failed: Math.max(out.failed, t.failed),
            absent: Math.max(out.absent, t.absent),
          }
  }
  return out
}

/** Canvas を画素の大きさに合わせ、2D 文脈を返す（取れなければ null —— jsdom など）。 */
function prepareCanvas(canvas: HTMLCanvasElement, height: number): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
  const dpr = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
  const width = Math.max(1, Math.floor(canvas.clientWidth))
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  return { ctx, width, height }
}

function drawHatch(ctx: CanvasRenderingContext2D, gaps: readonly GapSpan[], r: TimeRange, width: number, height: number): void {
  for (const g of gaps) {
    const x0 = Math.max(0, xOf(g.fromMs, r, width))
    const x1 = Math.min(width, xOf(g.toMs, r, width))
    if (!(x1 > x0)) continue
    ctx.save()
    ctx.beginPath()
    ctx.rect(x0, 0, x1 - x0, height)
    ctx.clip()
    ctx.strokeStyle = g.kind === 'pending' ? HATCH_PENDING : HATCH_NONE
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = x0 - height; x < x1; x += 6) {
      ctx.moveTo(x, height)
      ctx.lineTo(x + height, 0)
    }
    ctx.stroke()
    ctx.restore()
  }
}

/** 段の目盛りの線（と、`labels` なら下の文字）。 */
function drawTicks(ctx: CanvasRenderingContext2D, r: TimeRange, width: number, plotHeight: number, labels: boolean, ink: string): void {
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.25)'
  ctx.fillStyle = ink
  ctx.font = '11px system-ui, sans-serif'
  ctx.textBaseline = 'top'
  for (const t of recordTicks(r, Math.max(2, Math.floor(width / 110)))) {
    const x = xOf(t.atMs, r, width)
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, plotHeight)
    ctx.stroke()
    if (!labels) continue
    ctx.textAlign = x < TIME_LABEL_MARGIN ? 'left' : x > width - TIME_LABEL_MARGIN ? 'right' : 'center'
    ctx.fillText(t.label, x, plotHeight + 3)
  }
}

/** なぞりを描く。`yOf` が値を高さへ写す。**値の無い画素で線を切る**（繋ぐと届いていない時間が斜めの線になる）。 */
function drawTrace(ctx: CanvasRenderingContext2D, trace: AxisTrace, r: TimeRange, width: number, yOf: (v: number) => number, color: string): void {
  const plan = pixelPlan(trace, r, width)
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  if (plan.mode === 'line') {
    for (const s of plan.segments) {
      s.xs.forEach((x, i) => {
        if (i === 0) ctx.moveTo(x, yOf(s.vs[i]!))
        else ctx.lineTo(x, yOf(s.vs[i]!))
      })
    }
    ctx.stroke()
    // 1 サンプルずつ見分けられるくらいまで寄せたら、点も打つ。
    const points = plan.segments.reduce((n, s) => n + s.xs.length, 0)
    if (points > 0 && width / points >= 6) {
      ctx.fillStyle = color
      for (const s of plan.segments) s.xs.forEach((x, i) => ctx.fillRect(x - 1.5, yOf(s.vs[i]!) - 1.5, 3, 3))
    }
    return
  }
  let started = false
  for (let x = 0; x < plan.lo.length; x++) {
    const lo = plan.lo[x]!
    const hi = plan.hi[x]!
    if (Number.isNaN(lo) || Number.isNaN(hi)) {
      started = false
      continue
    }
    if (!started) ctx.moveTo(x + 0.5, yOf(lo))
    else ctx.lineTo(x + 0.5, yOf(lo))
    ctx.lineTo(x + 0.5, yOf(hi))
    started = true
  }
  ctx.stroke()
}

/** 気象庁の P・S を段に重ねる。**秒まで分かれば破線、幅があれば薄い帯**（`arrivalMark`）。 */
function drawArrivals(ctx: CanvasRenderingContext2D, quakes: QuakesView | null, r: TimeRange, width: number, height: number): void {
  if (quakes === null) return
  for (const q of quakes.quakes) {
    const phases: readonly (readonly [Span | null, string, string])[] = [
      [q.p, P_COLOR, P_BAND],
      [q.s, S_COLOR, S_BAND],
    ]
    for (const [span, lineColor, bandColor] of phases) {
      if (span === null) continue
      const m = arrivalMark(span, r, width)
      if (m === null) continue
      if (m.kind === 'band') {
        ctx.fillStyle = bandColor
        ctx.fillRect(m.x0, 0, m.x1 - m.x0, height)
        continue
      }
      ctx.save()
      ctx.strokeStyle = lineColor
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(m.x + 0.5, 0)
      ctx.lineTo(m.x + 0.5, height)
      ctx.stroke()
      ctx.restore()
    }
  }
}

/** 波形の下の線（生のサンプルで描くときだけ）。**時刻の疑わしさは届き方の線の 1 段上へ**（重なっても両方見えるように）。 */
function drawUnderline(ctx: CanvasRenderingContext2D, trace: AxisTrace, r: TimeRange, width: number, plotHeight: number): void {
  if (trace.kind !== 'samples') return
  for (const u of originUnderline(trace.runs)) {
    const x = spanX(u, r, width)
    if (x === null) continue
    const y = plotHeight - (u.kind === 'questionable' ? 2 : 1) * UNDERLINE_HEIGHT_PX - 1
    ctx.fillStyle = MARK_COLORS[u.kind]
    ctx.fillRect(x.x0, y, x.x1 - x.x0, UNDERLINE_HEIGHT_PX)
  }
}

/** 下向きの塗った三角（発生時刻の ▼）。 */
function triangleDown(ctx: CanvasRenderingContext2D, x: number, top: number, size: number): void {
  ctx.beginPath()
  ctx.moveTo(x - size / 2, top)
  ctx.lineTo(x + size / 2, top)
  ctx.lineTo(x, top + size)
  ctx.closePath()
  ctx.fill()
}

/** 上向きの白抜きの三角（拾った P・S の △）。 */
function triangleUp(ctx: CanvasRenderingContext2D, x: number, bottom: number, size: number): void {
  ctx.beginPath()
  ctx.moveTo(x - size / 2, bottom)
  ctx.lineTo(x + size / 2, bottom)
  ctx.lineTo(x, bottom - size)
  ctx.closePath()
  ctx.stroke()
}

/** 印の段（受信・気象庁・揺れの記録の 3 列）。 */
function drawMarks(canvas: HTMLCanvasElement, m: MarksState | null, r: TimeRange, ink: string, hoverX: number | null): void {
  const prepared = prepareCanvas(canvas, MARKS_HEIGHT)
  if (prepared === null) return
  const { ctx, width } = prepared
  const laneY = (i: number): number => i * (MARK_LANE_HEIGHT_PX + MARK_LANE_GAP_PX)
  ctx.fillStyle = 'rgba(128, 128, 128, 0.08)'
  for (let i = 0; i < 3; i++) ctx.fillRect(0, laneY(i), width, MARK_LANE_HEIGHT_PX)
  if (m !== null) {
    const y0 = laneY(0)
    if (m.reception !== null) {
      for (const kind of ['backlog', 'late', 'questionable'] as const) {
        ctx.fillStyle = MARK_COLORS[kind]
        for (const s of m.reception[kind]) {
          const x = spanX(s, r, width)
          if (x !== null) ctx.fillRect(x.x0, y0, x.x1 - x.x0, MARK_LANE_HEIGHT_PX)
        }
      }
      ctx.fillStyle = ink
      for (const at of m.reception.unreadableAtMs) {
        if (at >= r.fromMs && at <= r.toMs) ctx.fillRect(Math.floor(xOf(at, r, width)), y0, 1, MARK_LANE_HEIGHT_PX)
      }
    }
    const y1 = laneY(1)
    if (m.quakes !== null) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, y1, width, MARK_LANE_HEIGHT_PX)
      ctx.clip()
      ctx.translate(0, y1)
      drawArrivals(ctx, m.quakes, r, width, MARK_LANE_HEIGHT_PX)
      ctx.restore()
      ctx.fillStyle = ink
      for (const q of m.quakes.quakes) {
        if (q.originMs >= r.fromMs && q.originMs <= r.toMs) triangleDown(ctx, xOf(q.originMs, r, width), y1 + 1, 6)
      }
    }
    const y2 = laneY(2)
    for (const e of m.shakes) {
      const x = spanX({ fromMs: e.startMs, toMs: e.endMs }, r, width)
      if (x === null) continue
      ctx.fillStyle = VERDICT_BAND[e.verdict]
      ctx.fillRect(x.x0, y2, x.x1 - x.x0, MARK_LANE_HEIGHT_PX)
    }
    ctx.strokeStyle = ink
    ctx.lineWidth = 1
    for (const e of m.shakes) {
      for (const at of [e.pMs, e.sMs]) {
        if (at !== null && at >= r.fromMs && at <= r.toMs) triangleUp(ctx, xOf(at, r, width), y2 + MARK_LANE_HEIGHT_PX - 1, 6)
      }
    }
  }
  // 列の名前（印の上に薄く重ねる）。
  ctx.font = '10px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = ink
  ctx.globalAlpha = 0.75
  ;[LANE_RECEPTION_TITLE, LANE_QUAKE_TITLE, LANE_SHAKE_TITLE].forEach((t, i) => ctx.fillText(t, 3, laneY(i) + MARK_LANE_HEIGHT_PX / 2))
  ctx.globalAlpha = 1
  if (hoverX !== null) {
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.8)'
    ctx.beginPath()
    ctx.moveTo(hoverX + 0.5, 0)
    ctx.lineTo(hoverX + 0.5, MARKS_HEIGHT)
    ctx.stroke()
  }
}

/** 指している時刻の縦線。 */
function drawHoverLine(ctx: CanvasRenderingContext2D, hoverX: number | null, height: number): void {
  if (hoverX === null) return
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.8)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(hoverX + 0.5, 0)
  ctx.lineTo(hoverX + 0.5, height)
  ctx.stroke()
}

/** 対数の縦の目盛りの文字（`0.01`・`0.1`・`1`・`10`）。 */
function decadeLabel(v: number): string {
  return v >= 1 ? String(Math.round(v)) : String(Number(v.toPrecision(1)))
}

/** ノイズ水準の線（縦は対数・10 倍ごとに目盛り）。値の無い列で線を切る。 */
function drawNoise(
  ctx: CanvasRenderingContext2D,
  lines: readonly { readonly color: string; readonly series: NoiseSeries }[],
  nr: { readonly min: number; readonly max: number },
  r: TimeRange,
  width: number,
  height: number,
  ink: string,
): void {
  const lo = 10 ** Math.floor(Math.log10(nr.min))
  let hi = 10 ** Math.ceil(Math.log10(nr.max))
  if (hi <= lo) hi = lo * 10
  const span = Math.log10(hi) - Math.log10(lo)
  const yOf = (v: number): number => height - PLOT_PADDING_Y - ((Math.log10(v) - Math.log10(lo)) / span) * (height - 2 * PLOT_PADDING_Y)
  ctx.font = '10px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (let d = lo; d <= hi * 1.0001; d *= 10) {
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.2)'
    ctx.beginPath()
    ctx.moveTo(0, yOf(d))
    ctx.lineTo(width, yOf(d))
    ctx.stroke()
    ctx.fillStyle = ink
    ctx.fillText(decadeLabel(d), 3, yOf(d))
  }
  for (const l of lines) {
    const s = l.series
    ctx.strokeStyle = l.color
    ctx.lineWidth = 1.2
    ctx.beginPath()
    let drawing = false
    for (let j = 0; j < s.values.length; j += 1) {
      const v = s.values[j]!
      const at = s.firstColumnMs + (j + 0.5) * s.columnMs
      if (at < r.fromMs || at >= r.toMs || !Number.isFinite(v) || v <= 0) {
        drawing = false
        continue
      }
      const x = xOf(at, r, width)
      if (drawing) ctx.lineTo(x, yOf(v))
      else ctx.moveTo(x, yOf(v))
      drawing = true
    }
    ctx.stroke()
  }
}

/**
 * スペクトログラムの色を塗った絵の控え。**指した所の値を出すたびに描き直すので、升（1 段に最大 4 万個）を
 * 毎回塗らない** —— 材料・物差し・範囲・大きさが同じなら控えた絵を貼る。
 */
const spectrogramImages = new WeakMap<SpectrogramData, { readonly key: string; readonly image: HTMLCanvasElement }>()

function drawSpectrogram(ctx: CanvasRenderingContext2D, g: SpectrogramData, dbr: { readonly lo: number; readonly hi: number }, r: TimeRange, width: number, height: number): void {
  const dpr = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
  const key = `${dbr.lo}|${dbr.hi}|${r.fromMs}|${r.toMs}|${width}|${height}|${dpr}`
  let cached = spectrogramImages.get(g)
  if (cached === undefined || cached.key !== key) {
    const image = document.createElement('canvas')
    image.width = Math.round(width * dpr)
    image.height = Math.round(height * dpr)
    const ic = image.getContext('2d')
    if (ic === null) return
    ic.setTransform(dpr, 0, 0, dpr, 0, 0)
    for (let j = 0; j < g.power.length; j += 1) {
      const from = g.firstColumnMs + j * g.columnMs
      const to = from + g.columnMs
      if (to <= r.fromMs || from >= r.toMs) continue
      const x0 = xOf(from, r, width)
      const x1 = Math.max(x0 + 1, xOf(to, r, width))
      const row = g.power[j]!
      for (let b = 0; b < row.length; b += 1) {
        const c = colorOfDb(psdToDb(row[b]!, g.unit), dbr)
        if (c === null) continue
        const top = yOfHz(Math.min(g.binEdgesHz[b + 1]!, FREQ_MAX_HZ), height)
        const bottom = yOfHz(Math.max(g.binEdgesHz[b]!, FREQ_MIN_HZ), height)
        ic.fillStyle = `rgb(${c[0]}, ${c[1]}, ${c[2]})`
        // 升の境目に隙間が出ないよう、縦を半画素ぶん重ねる。
        ic.fillRect(x0, top, x1 - x0, bottom - top + 0.5)
      }
    }
    cached = { key, image }
    spectrogramImages.set(g, cached)
  }
  ctx.drawImage(cached.image, 0, 0, width, height)
  // 要約がまだ無い時（作り終えると出る）。
  drawHatch(
    ctx,
    g.irregularHours.filter((h) => h.state === 'pending').map((h) => ({ fromMs: h.hourStartMs, toMs: h.hourStartMs + HOUR_MS, kind: 'pending' as const })),
    r,
    width,
    height,
  )
}

/** スペクトログラムの縦の目盛り（1 Hz・10 Hz）。 */
function drawFrequencyLabels(ctx: CanvasRenderingContext2D, height: number): void {
  ctx.font = '10px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (const hz of [1, 10]) {
    const y = yOfHz(hz, height)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(16, y)
    ctx.stroke()
    // 色の上でも読めるよう、白地に黒の文字。
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)'
    ctx.fillRect(18, y - 6, 32, 12)
    ctx.fillStyle = '#222'
    ctx.fillText(`${hz} Hz`, 20, y)
  }
}

/** 範囲のスペクトル（横は周波数・縦は dB）。Peterson のモデルを破線で重ねる（gal のときだけ）。 */
function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  lines: readonly { readonly color: string; readonly data: SpectrumData }[],
  unit: ValueUnit,
  width: number,
  height: number,
  ink: string,
  hoverX: number | null,
): void {
  const plotHeight = height - SPECTRUM_LABEL_HEIGHT
  const models = unit === 'gal' ? [NLNM, NHNM].map((m) => noiseModelCurve(m, FREQ_MIN_HZ, FREQ_MAX_HZ, NOISE_MODEL_STEPS)) : []
  const values: number[] = []
  for (const l of lines) for (const p of l.data.power) values.push(psdToDb(p, l.data.unit))
  for (const m of models) for (const p of m) values.push(p.db)
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.45)'
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, width - 1, plotHeight - 1)
  // 横の目盛り（0.1・1・10・50 Hz）。
  ctx.font = '11px system-ui, sans-serif'
  ctx.textBaseline = 'top'
  for (const hz of [0.1, 1, 10, 50]) {
    const x = xOfHz(hz, width)
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.25)'
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, plotHeight)
    ctx.stroke()
    ctx.fillStyle = ink
    ctx.textAlign = hz === 0.1 ? 'left' : hz === 50 ? 'right' : 'center'
    ctx.fillText(`${hz} Hz`, x, plotHeight + 2)
  }
  const dbr = dbExtent(values)
  if (dbr === null) return
  const yOf = (db: number): number => PLOT_PADDING_Y + ((dbr.hi - db) / (dbr.hi - dbr.lo)) * (plotHeight - 2 * PLOT_PADDING_Y)
  // 縦の目盛り（20 dB ごと。狭ければ 10 dB ごと）。
  const step = dbr.hi - dbr.lo > 60 ? 20 : 10
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (let db = Math.ceil(dbr.lo / step) * step; db <= dbr.hi; db += step) {
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.2)'
    ctx.beginPath()
    ctx.moveTo(0, yOf(db))
    ctx.lineTo(width, yOf(db))
    ctx.stroke()
    ctx.fillStyle = ink
    ctx.fillText(`${formatDb(db)} dB`, 3, yOf(db))
  }
  // モデルの破線。
  ctx.save()
  ctx.setLineDash([5, 4])
  ctx.strokeStyle = NOISE_MODEL_COLOR
  ctx.lineWidth = 1.2
  for (const m of models) {
    ctx.beginPath()
    m.forEach((p, i) => {
      if (i === 0) ctx.moveTo(xOfHz(p.hz, width), yOf(p.db))
      else ctx.lineTo(xOfHz(p.hz, width), yOf(p.db))
    })
    ctx.stroke()
  }
  ctx.restore()
  // 軸ごとの線（区画の中心＝境目の幾何平均に点を置き、値の無い区画で切る）。
  for (const l of lines) {
    const edges = l.data.binEdgesHz
    ctx.strokeStyle = l.color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    let drawing = false
    for (let b = 0; b + 1 < edges.length; b += 1) {
      const db = psdToDb(l.data.power[b]!, l.data.unit)
      if (!Number.isFinite(db)) {
        drawing = false
        continue
      }
      const x = xOfHz(Math.sqrt(edges[b]! * edges[b + 1]!), width)
      if (drawing) ctx.lineTo(x, yOf(db))
      else ctx.moveTo(x, yOf(db))
      drawing = true
    }
    ctx.stroke()
  }
  drawHoverLine(ctx, hoverX, plotHeight)
}

export async function initRecordsView(container: HTMLElement, signal: AbortSignal): Promise<void> {
  container.innerHTML = `
    <section class="panel">
      <div class="row" style="align-items: center; flex-wrap: wrap; gap: 0.6rem">
        <label class="row" style="align-items: center; gap: 0.4rem; flex: 0 0 auto">
          <span>記録</span>
          <select class="records-group"></select>
        </label>
        <!-- **hidden は外側の素の div に付ける** —— \`.period-buttons\` は display: inline-flex なので、
             そちらに付けると hidden 属性が効かず、合成波形でも切り替えが出たままになる（実際にそうなった）。 -->
        <div class="records-unit" hidden>
          <div class="period-buttons" role="group">
            <button type="button" data-unit="gal" aria-pressed="true">gal</button>
            <button type="button" data-unit="native" aria-pressed="false">生の値（カウント）</button>
          </div>
        </div>
      </div>
      <p class="records-period muted"></p>
      <p class="records-list-note error"></p>
    </section>
    <section class="panel records-body" hidden>
      <p class="muted" style="margin: 0 0 0.3rem">${OVERVIEW_CAPTION}</p>
      <canvas class="wave-canvas records-overview" style="height: ${OVERVIEW_HEIGHT}px; cursor: pointer"></canvas>
      <div class="row" style="align-items: center; flex-wrap: wrap; gap: 0.6rem; margin: 0.6rem 0">
        <div class="period-buttons records-spans" role="group">
          ${SPAN_CHOICES.map((c, i) => `<button type="button" data-span-index="${i}">${c.label}</button>`).join('')}
        </div>
        <div class="row" style="gap: 0.3rem; flex: 0 0 auto">
          <button type="button" class="records-prev">前へ</button>
          <button type="button" class="records-next">次へ</button>
        </div>
        <div class="row" style="align-items: center; gap: 0.3rem; flex: 0 0 auto">
          <span>日時へ移動</span>
          <input type="datetime-local" step="1" class="records-at" />
          <button type="button" class="records-go">移動</button>
        </div>
        <div class="period-buttons records-axes" role="group"></div>
      </div>
      <div class="records-rows"></div>
      <p class="records-readout muted" style="white-space: pre-line"></p>
      <!-- 範囲のスペクトルは横が周波数なので、時刻の段（寄せる・送る操作の対象）の外に置く。 -->
      <div class="records-spectrum-frame" style="margin-top: 0.8rem">
        <div class="row" style="justify-content: space-between; align-items: baseline">
          <strong>${SPECTRUM_TITLE}</strong>
          <span class="muted records-spectrum-header"></span>
        </div>
        <canvas class="wave-canvas records-spectrum" style="height: ${SPECTRUM_HEIGHT}px"></canvas>
        <p class="muted records-spectrum-legend" style="margin: 0.3rem 0 0; white-space: pre-line"></p>
        <p class="muted records-spectrum-readout" style="margin: 0.2rem 0 0"></p>
      </div>
      <p class="muted records-legend">
        <span class="records-hatch records-hatch-none"></span>${GAP_NONE_LEGEND}
        <span class="records-hatch records-hatch-pending" style="margin-left: 1rem"></span>${GAP_PENDING_LEGEND}
      </p>
      <p class="muted records-marks-legend" style="white-space: pre-line"></p>
      <p class="muted records-marks-note" style="white-space: pre-line"></p>
      <p class="records-source muted"></p>
      <p class="records-note error"></p>
    </section>
  `
  const groupEl = qs<HTMLSelectElement>(container, '.records-group')
  const unitEl = qs(container, '.records-unit')
  const periodEl = qs(container, '.records-period')
  const listNoteEl = qs(container, '.records-list-note')
  const bodyEl = qs(container, '.records-body')
  const overviewEl = qs<HTMLCanvasElement>(container, '.records-overview')
  const spansEl = qs(container, '.records-spans')
  const atEl = qs<HTMLInputElement>(container, '.records-at')
  const axesEl = qs(container, '.records-axes')
  const rowsEl = qs(container, '.records-rows')
  const readoutEl = qs(container, '.records-readout')
  const sourceEl = qs(container, '.records-source')
  const noteEl = qs(container, '.records-note')
  const marksLegendEl = qs(container, '.records-marks-legend')
  const marksNoteEl = qs(container, '.records-marks-note')
  const spectrumEl = qs<HTMLCanvasElement>(container, 'canvas.records-spectrum')
  const spectrumHeaderEl = qs(container, '.records-spectrum-header')
  const spectrumLegendEl = qs(container, '.records-spectrum-legend')
  const spectrumReadoutEl = qs(container, '.records-spectrum-readout')

  let groups: RecordGroup[] = []
  let group: RecordGroup | null = null
  let unit: 'gal' | 'native' = 'gal'
  let bounds: TimeRange = { fromMs: 0, toMs: 1 }
  let range: TimeRange = { fromMs: 0, toMs: 1 }
  let hidden = new Set<string>()
  let loaded: Loaded | null = null
  let overview: OverviewLoaded | null = null
  let loadController: AbortController | null = null
  let overviewController: AbortController | null = null
  let marks: MarksState | null = null
  let marksController: AbortController | null = null
  let freq: FreqState | null = null
  let freqController: AbortController | null = null
  let freqFailure: string | null = null
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  let failure: string | null = null
  let hoverX: number | null = null
  /** スペクトログラムの段を指しているときだけ、その段の中の縦の位置（周波数の読み取りに使う）。 */
  let hoverSpectrogramY: number | null = null
  /** 範囲のスペクトルの枠を指しているときの横の位置。 */
  let hoverSpectrumX: number | null = null

  signal.addEventListener('abort', () => {
    loadController?.abort()
    overviewController?.abort()
    marksController?.abort()
    freqController?.abort()
    if (reloadTimer !== null) clearTimeout(reloadTimer)
  })

  const visibleAxes = (): RecordGroup['axes'] => (group === null ? [] : group.axes.filter((a) => !hidden.has(a.id)))
  /** 軸の線の色（軸の並びの順に固定）。 */
  const axisLineColor = (id: string): string => {
    const i = group === null ? 0 : Math.max(0, group.axes.findIndex((a) => a.id === id))
    return AXIS_LINE_COLORS[i % AXIS_LINE_COLORS.length]!
  }
  /** 色の凡例（`■ X　■ Y　■ Z`）。 */
  const axisColorLegend = (): string =>
    visibleAxes()
      .map((a) => `<span style="color: ${axisLineColor(a.id)}">■</span> ${escapeHtml(a.short)}`)
      .join('　')

  // ---- 段の骨組み（記録を選び直したとき・軸を消したとき・範囲が 10 分をまたいだときに作り直す） ----

  const rowsShape = (): string => {
    if (group === null) return ''
    const samples = range.toMs - range.fromMs <= SAMPLES_RANGE_MAX_MS
    const intensity = group.kind !== 'station' ? 'raw' : samples ? 'yes' : 'wide'
    return `${group.key}|${samples}|${intensity}|${visibleAxes().map((a) => a.id).join(',')}`
  }
  let builtShape = ''

  const buildRows = (): void => {
    builtShape = rowsShape()
    if (group === null) {
      rowsEl.innerHTML = ''
      return
    }
    const samples = range.toMs - range.fromMs <= SAMPLES_RANGE_MAX_MS
    const header = (title: string, cls: string): string => `
      <div class="row" style="justify-content: space-between; align-items: baseline; margin-top: 0.5rem">
        <strong>${escapeHtml(title)}</strong>
        <span class="muted ${cls}"></span>
      </div>`
    // 印の段は見出しを持たない（列の名前は段の中に書く）。
    let html = `<canvas class="wave-canvas records-canvas records-marks" style="height: ${MARKS_HEIGHT}px; margin-top: 0.5rem"></canvas>`
    html += samples
      ? `${header(COMPOSITE_TITLE, 'records-composite-peak')}<canvas class="wave-canvas records-canvas records-composite" style="height: ${COMPOSITE_HEIGHT}px"></canvas>`
      : `<p class="muted" style="margin: 0.5rem 0 0">${COMPOSITE_TOO_WIDE_TEXT}</p>`
    for (const a of visibleAxes()) {
      html += `
        <div class="row" style="justify-content: space-between; align-items: baseline; margin-top: 0.5rem">
          <strong>${escapeHtml(a.label)}</strong>
          <span class="muted"><span class="records-peak" data-axis-id="${escapeHtml(a.id)}"></span>　<span class="records-scale"></span></span>
        </div>
        <canvas class="wave-canvas records-canvas records-axis" data-axis-id="${escapeHtml(a.id)}" style="height: ${AXIS_HEIGHT}px"></canvas>`
    }
    if (group.kind !== 'station') html += `<p class="muted" style="margin: 0.5rem 0 0">${INTENSITY_STATION_ONLY_TEXT}</p>`
    else if (!samples) html += `<p class="muted" style="margin: 0.5rem 0 0">${INTENSITY_TOO_WIDE_TEXT}</p>`
    else html += `${header(INTENSITY_TITLE, 'records-intensity-header')}<canvas class="wave-canvas records-canvas records-intensity" style="height: ${INTENSITY_HEIGHT}px"></canvas>`
    // ノイズ水準の推移（見えている軸を 1 枚に重ねる）。
    html += `
      <div class="row" style="justify-content: space-between; align-items: baseline; margin-top: 0.5rem">
        <span><strong>${escapeHtml(NOISE_TITLE)}</strong>　<span class="muted">${axisColorLegend()}</span></span>
        <span class="muted records-noise-header"></span>
      </div>
      <canvas class="wave-canvas records-canvas records-noise" style="height: ${NOISE_HEIGHT}px"></canvas>`
    // スペクトログラム（見えている軸ごと）。色の物差しは最後の段の下に 1 つ。
    for (const a of visibleAxes()) {
      html += `
        <div class="row" style="justify-content: space-between; align-items: baseline; margin-top: 0.5rem">
          <strong>${escapeHtml(spectrogramTitle(a.short))}</strong>
          <span class="muted records-spectrogram-header" data-axis-id="${escapeHtml(a.id)}"></span>
        </div>
        <canvas class="wave-canvas records-canvas records-spectrogram" data-axis-id="${escapeHtml(a.id)}" style="height: ${SPECTROGRAM_HEIGHT}px"></canvas>`
    }
    html += `<p class="muted records-db-scale" style="margin: 0.3rem 0 0"></p>`
    rowsEl.innerHTML = html
  }

  // ---- 描く ----

  const drawOverview = (): void => {
    const prepared = prepareCanvas(overviewEl, OVERVIEW_HEIGHT)
    if (prepared === null || group === null) return
    const { ctx, width, height } = prepared
    const ov = overview !== null && overview.groupKey === group.key ? overview : null
    const r = ov?.range ?? overviewRange(group)
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.45)'
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1)
    if (ov !== null) {
      let peak = 0
      for (const s of ov.spread) if (Number.isFinite(s) && s > peak) peak = s
      const gaps: GapSpan[] = []
      ctx.fillStyle = WAVE_COLOR
      ov.spread.forEach((s, j) => {
        const at = ov.firstColumnMs + j * ov.columnMs
        if (!Number.isFinite(s)) {
          gaps.push({ fromMs: at, toMs: at + ov.columnMs, kind: 'none' })
          return
        }
        const x0 = xOf(at, r, width)
        const x1 = Math.max(x0 + 1, xOf(at + ov.columnMs, r, width))
        const h = peak > 0 ? Math.max(1, (s / peak) * (height - 4)) : 1
        ctx.fillRect(x0, height - 2 - h, x1 - x0, h)
      })
      drawHatch(ctx, gaps, r, width, height)
    }
    // いま見ている範囲の枠。
    const x0 = xOf(range.fromMs, r, width)
    const x1 = Math.max(x0 + 2, xOf(range.toMs, r, width))
    ctx.fillStyle = 'rgba(37, 99, 168, 0.12)'
    ctx.fillRect(x0, 0, x1 - x0, height)
    ctx.strokeStyle = 'rgba(37, 99, 168, 0.9)'
    ctx.lineWidth = 2
    ctx.strokeRect(x0, 1, x1 - x0, height - 2)
  }

  const draw = (): void => {
    if (group === null) return
    if (rowsShape() !== builtShape) buildRows()
    drawOverview()
    const data = loaded !== null && loaded.groupKey === group.key && loaded.unit === unit ? loaded : null
    const axes = visibleAxes()
    const span = range.toMs - range.fromMs
    const traces = axes.map((a) => data?.axes.get(a.id) ?? null)
    const centers = traces.map((t) => (t === null ? Number.NaN : traceCenter(t.trace, range)))
    const peaks = traces.map((t, i) => (t === null ? null : tracePeak(t.trace, range, centers[i]!)))
    const halfSpan = sharedHalfSpan(peaks)
    const valueUnit: ValueUnit = traces.find((t) => t !== null)?.unit ?? 'gal'
    const ink = globalThis.getComputedStyle(rowsEl).color
    const m = marks !== null && marks.groupKey === group.key ? marks : null
    const quakes = m?.quakes ?? null

    const marksCanvas = rowsEl.querySelector<HTMLCanvasElement>('canvas.records-marks')
    if (marksCanvas !== null) drawMarks(marksCanvas, m, range, ink, hoverX)

    // 段は `buildRows` が `axes` の順に並べている（見出しと Canvas が同じ順）。
    const axisCanvases = [...rowsEl.querySelectorAll<HTMLCanvasElement>('canvas.records-axis')]
    const peakEls = [...rowsEl.querySelectorAll<HTMLElement>('.records-peak')]
    const scaleEls = [...rowsEl.querySelectorAll<HTMLElement>('.records-scale')]
    axisCanvases.forEach((canvas, i) => {
      const axis = traces[i] ?? null
      const p = peaks[i] ?? null
      const peakEl = peakEls[i]
      if (peakEl !== undefined) peakEl.textContent = p === null ? '' : peakLabel(p, valueUnit, span, axis?.columnMs ?? null)
      const scaleEl = scaleEls[i]
      if (scaleEl !== undefined) scaleEl.textContent = scaleLabel(halfSpan, valueUnit)
      const last = i === axisCanvases.length - 1
      const height = AXIS_HEIGHT
      const prepared = prepareCanvas(canvas, height)
      if (prepared === null) return
      const { ctx, width } = prepared
      const plotHeight = last ? height - TIME_AXIS_HEIGHT : height
      const mid = plotHeight / 2
      const usable = mid - PLOT_PADDING_Y
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.45)'
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, 0.5, width - 1, plotHeight - 1)
      ctx.beginPath()
      ctx.moveTo(0, mid)
      ctx.lineTo(width, mid)
      ctx.stroke()
      drawTicks(ctx, range, width, plotHeight, last, ink)
      drawArrivals(ctx, quakes, range, width, plotHeight)
      if (axis !== null && data !== null) {
        drawHatch(ctx, traceGaps(axis.trace, range, data.fetched, axis.irregular), range, width, plotHeight)
        const c = Number.isFinite(centers[i]!) ? centers[i]! : 0
        const yOf = (v: number): number => mid - Math.max(-usable, Math.min(usable, ((v - c) / halfSpan) * usable))
        drawTrace(ctx, axis.trace, range, width, yOf, WAVE_COLOR)
        drawUnderline(ctx, axis.trace, range, width, plotHeight)
      }
      if (hoverX !== null) {
        ctx.strokeStyle = 'rgba(128, 128, 128, 0.8)'
        ctx.beginPath()
        ctx.moveTo(hoverX + 0.5, 0)
        ctx.lineTo(hoverX + 0.5, plotHeight)
        ctx.stroke()
      }
    })

    // 3 軸の合成（生のサンプルで描くときだけ）。
    const compositeCanvas = rowsEl.querySelector<HTMLCanvasElement>('canvas.records-composite')
    if (compositeCanvas !== null) {
      const peakEl = rowsEl.querySelector<HTMLElement>('.records-composite-peak')
      const runs = traces.every((t) => t !== null) ? compositeRuns(traces.map((t) => t!.trace), centers) : null
      const trace: AxisTrace | null = runs === null ? null : { kind: 'samples', runs }
      const p = trace === null ? null : tracePeak(trace, range, 0)
      if (peakEl !== null) peakEl.textContent = p === null ? '' : peakLabel(p, valueUnit, span, null)
      const prepared = prepareCanvas(compositeCanvas, COMPOSITE_HEIGHT)
      if (prepared !== null) {
        const { ctx, width, height } = prepared
        ctx.strokeStyle = 'rgba(128, 128, 128, 0.45)'
        ctx.strokeRect(0.5, 0.5, width - 1, height - 1)
        drawTicks(ctx, range, width, height, false, ink)
        drawArrivals(ctx, quakes, range, width, height)
        if (trace !== null && p !== null) {
          // **下端を 0 に、上端をこの範囲の最大の少し上に**（合成は 0 以上）。
          const top = Math.max(p.deviation, 1e-9) * 1.1
          const yOf = (v: number): number => height - PLOT_PADDING_Y - Math.min(1, v / top) * (height - 2 * PLOT_PADDING_Y)
          drawTrace(ctx, trace, range, width, yOf, COMPOSITE_COLOR)
        }
      }
    }

    // リアルタイム震度の推移。
    const intensityCanvas = rowsEl.querySelector<HTMLCanvasElement>('canvas.records-intensity')
    if (intensityCanvas !== null) {
      const headerEl = rowsEl.querySelector<HTMLElement>('.records-intensity-header')
      const d = data?.intensity ?? null
      if (headerEl !== null) headerEl.textContent = d === null ? '' : intensityHeader(d)
      const prepared = prepareCanvas(intensityCanvas, INTENSITY_HEIGHT)
      if (prepared !== null) {
        const { ctx, width, height } = prepared
        ctx.strokeStyle = 'rgba(128, 128, 128, 0.45)'
        ctx.strokeRect(0.5, 0.5, width - 1, height - 1)
        drawTicks(ctx, range, width, height, false, ink)
        drawArrivals(ctx, quakes, range, width, height)
        const values = d === null ? [] : d.series.flatMap((s) => (s.value === null ? [] : [s.value]))
        if (d !== null && values.length > 0) {
          const lo = Math.floor(Math.min(...values) - 0.1)
          const hi = Math.max(lo + 1, Math.ceil(Math.max(...values) + 0.1))
          const yOf = (v: number): number => height - PLOT_PADDING_Y - ((v - lo) / (hi - lo)) * (height - 2 * PLOT_PADDING_Y)
          ctx.fillStyle = ink
          ctx.font = '10px system-ui, sans-serif'
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          ctx.strokeStyle = 'rgba(128, 128, 128, 0.2)'
          for (let k = lo; k <= hi; k++) {
            ctx.beginPath()
            ctx.moveTo(0, yOf(k))
            ctx.lineTo(width, yOf(k))
            ctx.stroke()
            ctx.fillText(String(k), 3, yOf(k))
          }
          // 刻み（1 秒）が飛んだ所・値の無い刻みで線を切る。
          ctx.strokeStyle = INTENSITY_COLOR
          ctx.lineWidth = 1.5
          ctx.beginPath()
          let prevAt = Number.NaN
          for (const s of d.series) {
            if (s.value === null) {
              prevAt = Number.NaN
              continue
            }
            const x = xOf(s.atMs, range, width)
            if (Number.isNaN(prevAt) || s.atMs - prevAt > 1500) ctx.moveTo(x, yOf(s.value))
            else ctx.lineTo(x, yOf(s.value))
            prevAt = s.atMs
          }
          ctx.stroke()
        }
      }
    }

    // ノイズ水準の推移（見えている軸を重ねる。縦は対数）。
    const noiseCanvas = rowsEl.querySelector<HTMLCanvasElement>('canvas.records-noise')
    if (noiseCanvas !== null) {
      const headerEl = rowsEl.querySelector<HTMLElement>('.records-noise-header')
      const lines = axes.flatMap((a, i) => {
        const t = traces[i]
        return t === null || t === undefined ? [] : [{ color: axisLineColor(a.id), series: t.noise }]
      })
      const nr = noiseRange(lines.map((l) => l.series))
      if (headerEl !== null) headerEl.textContent = nr === null ? '' : noiseHeader(nr, valueUnit)
      const prepared = prepareCanvas(noiseCanvas, NOISE_HEIGHT)
      if (prepared !== null) {
        const { ctx, width, height } = prepared
        ctx.strokeStyle = 'rgba(128, 128, 128, 0.45)'
        ctx.strokeRect(0.5, 0.5, width - 1, height - 1)
        drawTicks(ctx, range, width, height, false, ink)
        if (nr !== null) drawNoise(ctx, lines, nr, range, width, height, ink)
        drawHoverLine(ctx, hoverX, height)
      }
    }

    // スペクトログラム（見えている軸ごと。色の物差しは段どうしで共通）。
    const f = freq !== null && freq.groupKey === group.key && freq.unit === unit ? freq : null
    const grams = axes.map((a) => f?.spectrograms.get(a.id) ?? null)
    const gramUnit: ValueUnit = grams.find((g) => g !== null)?.unit ?? valueUnit
    const gramRange = dbRange(
      (function* () {
        for (const g of grams) if (g !== null) for (const row of g.power) for (const p of row) yield psdToDb(p, g.unit)
      })(),
    )
    const gramCanvases = [...rowsEl.querySelectorAll<HTMLCanvasElement>('canvas.records-spectrogram')]
    const gramHeaders = [...rowsEl.querySelectorAll<HTMLElement>('.records-spectrogram-header')]
    gramCanvases.forEach((canvas, i) => {
      const g = grams[i] ?? null
      const headerEl = gramHeaders[i]
      if (headerEl !== undefined) headerEl.textContent = g === null ? '' : spectrogramHeader(g.columnMs)
      const prepared = prepareCanvas(canvas, SPECTROGRAM_HEIGHT)
      if (prepared === null) return
      const { ctx, width, height } = prepared
      if (g !== null && gramRange !== null) drawSpectrogram(ctx, g, gramRange, range, width, height)
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.45)'
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, 0.5, width - 1, height - 1)
      drawFrequencyLabels(ctx, height)
      drawHoverLine(ctx, hoverX, height)
    })
    const dbScaleEl = rowsEl.querySelector<HTMLElement>('.records-db-scale')
    if (dbScaleEl !== null) {
      dbScaleEl.innerHTML =
        gramRange === null
          ? ''
          : `<span style="display: inline-block; width: 120px; height: 10px; vertical-align: middle; margin-right: 0.4rem; background: ${colorScaleCss()}"></span>${escapeHtml(dbScaleText(gramRange, gramUnit))}`
    }

    // 範囲のスペクトル（横は周波数）。
    const spectra = axes.map((a) => ({ axis: a, data: f?.spectra.get(a.id) ?? null }))
    const firstSpectrum = spectra.find((s) => s.data !== null)?.data ?? null
    spectrumHeaderEl.textContent =
      firstSpectrum === null ? '' : firstSpectrum.segments === 0 ? SPECTRUM_EMPTY_TEXT : spectrumHeader(firstSpectrum.segments, firstSpectrum.source)
    const spectrumUnit: ValueUnit = firstSpectrum?.unit ?? valueUnit
    const legendLines = [axisColorLegend()]
    if (spectrumUnit === 'gal') legendLines.push(escapeHtml(NOISE_MODEL_LEGEND))
    spectrumLegendEl.innerHTML = legendLines.join('\n')
    {
      const prepared = prepareCanvas(spectrumEl, SPECTRUM_HEIGHT)
      if (prepared !== null) {
        const { ctx, width, height } = prepared
        const lines = spectra.flatMap((s) => (s.data === null ? [] : [{ color: axisLineColor(s.axis.id), data: s.data }]))
        drawSpectrum(ctx, lines, spectrumUnit, width, height, ink, hoverSpectrumX)
      }
    }
    if (hoverSpectrumX === null || firstSpectrum === null) {
      spectrumReadoutEl.textContent = ''
    } else {
      const hz = hzOfX(hoverSpectrumX, Math.max(1, spectrumEl.clientWidth))
      const items = spectra.map((s) => {
        const b = s.data === null ? -1 : binAt(s.data.binEdgesHz, hz)
        return { short: s.axis.short, db: s.data === null || b < 0 ? Number.NaN : psdToDb(s.data.power[b]!, s.data.unit) }
      })
      spectrumReadoutEl.textContent = spectrumReadout(hz, items) ?? ''
    }

    // 状態の行。
    const axisData = traces.filter((t): t is AxisData => t !== null)
    if (data === null) {
      sourceEl.textContent = ''
    } else {
      const first = axisData[0]
      sourceEl.textContent = first === undefined ? '' : sourceNote(first.source, first.columnMs)
    }
    const notes: string[] = []
    if (getStoredToken() === null) notes.push(TOKEN_MISSING_TEXT)
    if (failure !== null) notes.push(fetchFailureText(failure))
    if (m?.failure !== null && m?.failure !== undefined) notes.push(fetchFailureText(m.failure))
    if (freqFailure !== null) notes.push(fetchFailureText(freqFailure))
    if (data !== null) {
      if (axisData.length > 0 && peaks.every((p) => p === null)) notes.push(EMPTY_RANGE_TEXT)
      const problems = problemsNote(maxTally(axisData.map((a) => a.hours)))
      if (problems !== null) notes.push(problems)
      const unscaled = unscaledNote(Math.max(0, ...axisData.map((a) => a.unscaledHours)))
      if (unscaled !== null) notes.push(unscaled)
    }
    noteEl.textContent = notes.join('　')

    // 印の段の凡例と注。
    const legend = [RECEPTION_LEGEND, QUAKE_LEGEND, SHAKE_LEGEND]
    if (span <= SAMPLES_RANGE_MAX_MS) legend.push(UNDERLINE_LEGEND)
    marksLegendEl.textContent = legend.join('\n')
    const marksNotes: string[] = []
    if (group.kind === 'station') marksNotes.push(group.stationId === null ? RECEPTION_STATION_GONE_TEXT : RECEPTION_STATION_NOTE)
    if (m !== null) {
      const pending = receptionPendingNote(m.receptionPending)
      if (pending !== null) marksNotes.push(pending)
      if (m.receptionTruncated) marksNotes.push(RECEPTION_TRUNCATED_TEXT)
      if (m.quakeState === 'too-wide') marksNotes.push(QUAKE_TOO_WIDE_TEXT)
      else if (m.quakeState === 'loading') marksNotes.push(QUAKE_LOADING_TEXT)
      else if (m.quakeState === 'failed') marksNotes.push(quakeFailureText(m.quakeFailure ?? ''))
      if (m.quakeState !== 'too-wide' && m.quakes !== null) {
        if (m.quakes.off) marksNotes.push(QUAKE_OFF_TEXT)
        else if (m.quakes.failedDays.length > 0) marksNotes.push(quakeFailedDaysText(m.quakes.failedDays))
      }
      if (m.quakeState !== 'too-wide' && group.kind === 'raw' && group.stationId === null) marksNotes.push(QUAKE_UNLOCATED_TEXT)
      if (m.shakesTruncated) marksNotes.push(SHAKE_TRUNCATED_TEXT)
    }
    marksNoteEl.textContent = marksNotes.join('\n')

    // 指した所の値（波形・気象庁の地震・揺れの記録・受信）。
    if (hoverX === null) {
      readoutEl.textContent = ''
    } else {
      const canvas = axisCanvases[0] ?? marksCanvas
      const width = canvas === undefined || canvas === null ? 1 : Math.max(1, canvas.clientWidth)
      const at = range.fromMs + (hoverX / width) * span
      const tol = (HOVER_TOLERANCE_PX / width) * span
      const lines: string[] = []
      if (data !== null) {
        lines.push(
          readoutText(
            axes.map((a, i) => ({ short: a.short, value: traces[i] === null ? null : traceValueAt(traces[i]!.trace, at) })),
            valueUnit,
            at,
            span,
          ),
        )
      }
      if (hoverSpectrogramY !== null) {
        const hz = hzOfY(hoverSpectrogramY, SPECTROGRAM_HEIGHT)
        const items = axes.map((a, i) => {
          const g = grams[i] ?? null
          if (g === null) return { short: a.short, db: Number.NaN }
          const j = Math.floor((at - g.firstColumnMs) / g.columnMs)
          const b = binAt(g.binEdgesHz, hz)
          const p = b < 0 ? undefined : g.power[j]?.[b]
          return { short: a.short, db: p === undefined ? Number.NaN : psdToDb(p, g.unit) }
        })
        const line = spectrogramReadout(hz, items)
        if (line !== null) lines.push(line)
      }
      if (m !== null) {
        for (const q of quakesAt(m.quakes?.quakes ?? [], at, tol).slice(0, READOUT_MAX_ITEMS)) lines.push(quakeReadout(q))
        for (const e of shakesAt(m.shakes, at, tol).slice(0, READOUT_MAX_ITEMS)) lines.push(shakeReadout(e))
        const rec = m.reception === null ? null : receptionAt(m.reception, at, tol)
        if (rec !== null) lines.push(rec)
      }
      readoutEl.textContent = lines.join('\n')
    }

    // **期間より広い幅は「全体」と同じ絵になるが、押した見た目にはしない**（記録が 1 時間しか無いと、
    // 全体・1 週・1 日・6 時間・1 時間がまとめて押された見た目になる）。
    for (const b of spansEl.querySelectorAll<HTMLButtonElement>('button[data-span-index]')) {
      const choice = SPAN_CHOICES[Number(b.dataset.spanIndex)]!
      const target = choice.ms ?? bounds.toMs - bounds.fromMs
      b.setAttribute('aria-pressed', String(Math.abs(span - target) < 1))
    }
  }

  // ---- 取る ----

  const load = async (): Promise<void> => {
    if (group === null) return
    loadController?.abort()
    const controller = new AbortController()
    loadController = controller
    const g = group
    const u = unit
    const r = range
    if (getStoredToken() === null) {
      draw()
      return
    }
    const width = Math.max(1, rowsEl.querySelector<HTMLCanvasElement>('canvas.records-axis')?.clientWidth ?? rowsEl.clientWidth)
    const plan = planFetch(r, width)
    try {
      const axes = await Promise.all(
        g.axes.map(async (a): Promise<[string, AxisData | null]> => {
          if (plan.kind === 'samples') {
            const body = await apiFetch<unknown>(recordsUrl('samples', { channel: a.id, from: r.fromMs, to: r.toMs, unit: u }), { signal: controller.signal })
            const s = readSamplesData(body)
            if (s === null) throw new Error('応答の形が違う')
            return [
              a.id,
              {
                trace: traceOfSamples(s),
                unit: s.unit,
                source: 'raw-samples',
                columnMs: null,
                hours: null,
                irregular: [],
                unscaledHours: s.problems.unscaledHours,
                noise: secondRms(s.runs, r),
              },
            ]
          }
          const body = await apiFetch<unknown>(
            recordsUrl('envelope', { channel: a.id, from: r.fromMs, to: r.toMs, columns: plan.columns, unit: u }),
            { signal: controller.signal },
          )
          const e = readEnvelopeData(body)
          if (e === null) throw new Error('応答の形が違う')
          return [
            a.id,
            {
              trace: traceOfEnvelope(e),
              unit: e.unit,
              source: e.source,
              columnMs: e.source === 'samples' ? null : e.columnMs,
              hours: e.hours,
              irregular: e.irregularHours,
              unscaledHours: e.problems.unscaledHours,
              noise: noiseOfEnvelopeColumns(e),
            },
          ]
        }),
      )
      let intensity: IntensityData | null = null
      if (g.kind === 'station' && g.stationKey !== null && plan.kind === 'samples') {
        const body = await apiFetch<unknown>(recordsUrl('intensity', { station: g.stationKey, from: r.fromMs, to: r.toMs }), { signal: controller.signal })
        intensity = readIntensityData(body)
        if (intensity === null) throw new Error('応答の形が違う')
      }
      if (controller.signal.aborted || signal.aborted) return
      const map = new Map<string, AxisData>()
      for (const [id, d] of axes) if (d !== null) map.set(id, d)
      loaded = { groupKey: g.key, unit: u, fetched: r, axes: map, intensity }
      failure = null
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted || signal.aborted) return
      failure = failureReason(error)
    }
    draw()
  }

  const loadOverview = async (): Promise<void> => {
    if (group === null || getStoredToken() === null) return
    overviewController?.abort()
    const controller = new AbortController()
    overviewController = controller
    const g = group
    const r = overviewRange(g)
    const columns = Math.max(1, Math.min(4096, Math.floor(overviewEl.clientWidth) || 800))
    try {
      const envelopes = await Promise.all(
        g.axes.map(async (a) => {
          const body = await apiFetch<unknown>(recordsUrl('envelope', { channel: a.id, from: r.fromMs, to: r.toMs, columns, unit }), {
            signal: controller.signal,
          })
          const e = readEnvelopeData(body)
          if (e === null) throw new Error('応答の形が違う')
          return e
        }),
      )
      if (controller.signal.aborted || signal.aborted) return
      const spread = overviewSpread(envelopes as EnvelopeData[])
      overview = spread === null ? null : { groupKey: g.key, range: r, ...spread }
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted || signal.aborted) return
      failure = failureReason(error)
    }
    draw()
  }

  /**
   * 印の段の材料を取る（受信・気象庁・揺れの記録をそれぞれ別に、届いた順に描く）。**前の取得は打ち切る**が、
   * 前の材料は取り直すまで描き続ける（同じ記録なら時刻で置くので、重なる所はそのまま正しい）。
   */
  const loadMarks = (): void => {
    if (group === null || getStoredToken() === null) return
    marksController?.abort()
    const controller = new AbortController()
    marksController = controller
    const g = group
    const r = range
    const prev = marks !== null && marks.groupKey === g.key ? marks : null
    const tooWide = r.toMs - r.fromMs > QUAKES_RANGE_MAX_MS
    const m: MarksState = {
      groupKey: g.key,
      reception: prev?.reception ?? null,
      receptionPending: prev?.receptionPending ?? 0,
      receptionTruncated: prev?.receptionTruncated ?? false,
      quakes: tooWide ? null : (prev?.quakes ?? null),
      quakeState: tooWide ? 'too-wide' : 'loading',
      quakeFailure: null,
      shakes: prev?.shakes ?? [],
      shakesTruncated: prev?.shakesTruncated ?? false,
      failure: null,
    }
    marks = m
    const stale = (): boolean => controller.signal.aborted || signal.aborted
    const fail = (error: unknown): void => {
      if (isAbort(error) || stale()) return
      m.failure = failureReason(error)
    }

    void (async () => {
      try {
        const rv = readReceptionData(await apiFetch<unknown>(recordsUrl('reception', { from: r.fromMs, to: r.toMs }), { signal: controller.signal }))
        if (rv === null) throw new Error('応答の形が違う')
        if (stale()) return
        m.reception = receptionLane(rv, new Set(g.sensors))
        m.receptionPending = rv.hours.pending
        m.receptionTruncated = rv.unreadableTruncated
      } catch (error) {
        fail(error)
      }
      if (!stale()) draw()
    })()

    if (!tooWide) {
      void (async () => {
        try {
          const params: Record<string, string | number> = { from: r.fromMs, to: r.toMs }
          if (g.stationId !== null) params.station = g.stationId
          const qv = readQuakesData(await apiFetch<unknown>(recordsUrl('quakes', params), { signal: controller.signal }))
          if (qv === null) throw new Error('応答の形が違う')
          if (stale()) return
          m.quakes = qv
          m.quakeState = 'done'
        } catch (error) {
          if (isAbort(error) || stale()) return
          m.quakeState = 'failed'
          m.quakeFailure = failureReason(error)
        }
        if (!stale()) draw()
      })()
    }

    // 揺れの記録は観測点ごと（`/events` は誰でも読める口。揺れの記録タブと同じく素の fetch で取る）。
    if (g.stationId === null) {
      m.shakes = []
      m.shakesTruncated = false
    } else {
      const stationId = g.stationId
      void (async () => {
        try {
          const url = `/events?from=${Math.floor(r.fromMs - SHAKE_LEAD_MS)}&to=${Math.ceil(r.toMs)}&limit=${EVENTS_PAGE_LIMIT}&station=${encodeURIComponent(stationId)}`
          const res = await fetch(url, { signal: controller.signal })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const sv = readShakeRange(await res.json())
          if (sv === null) throw new Error('応答の形が違う')
          if (stale()) return
          m.shakes = sv.events
          m.shakesTruncated = sv.truncated
        } catch (error) {
          fail(error)
        }
        if (!stale()) draw()
      })()
    }
  }

  /**
   * 周波数の材料（軸ごとのスペクトログラムと範囲のスペクトル）を取る。**波形と別に取る**（1 分ごとの PSD を
   * 長い範囲で束ねると時間が掛かるので、波形を待たせない）。見えていない軸の分も取る（消した軸を戻したとき
   * 取り直さずに済むように）。前の取得は打ち切るが、前の材料は取り直すまで描き続ける。
   */
  const loadFreq = async (): Promise<void> => {
    if (group === null || getStoredToken() === null) return
    freqController?.abort()
    const controller = new AbortController()
    freqController = controller
    const g = group
    const u = unit
    const r = range
    const width = Math.max(1, rowsEl.querySelector<HTMLCanvasElement>('canvas.records-spectrogram')?.clientWidth ?? rowsEl.clientWidth)
    const columns = Math.max(1, Math.min(COLUMNS_MAX, Math.floor(width)))
    try {
      const results = await Promise.all(
        g.axes.map(async (a) => {
          const [gramBody, spectrumBody] = await Promise.all([
            apiFetch<unknown>(recordsUrl('spectrogram', { channel: a.id, from: r.fromMs, to: r.toMs, columns, unit: u }), { signal: controller.signal }),
            apiFetch<unknown>(recordsUrl('spectrum', { channel: a.id, from: r.fromMs, to: r.toMs, unit: u }), { signal: controller.signal }),
          ])
          const gram = readSpectrogramData(gramBody)
          const spectrum = readSpectrumData(spectrumBody)
          if (gram === null || spectrum === null) throw new Error('応答の形が違う')
          return { id: a.id, gram, spectrum }
        }),
      )
      if (controller.signal.aborted || signal.aborted) return
      freq = {
        groupKey: g.key,
        unit: u,
        spectrograms: new Map(results.map((x) => [x.id, x.gram])),
        spectra: new Map(results.map((x) => [x.id, x.spectrum])),
      }
      freqFailure = null
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted || signal.aborted) return
      freqFailure = failureReason(error)
    }
    draw()
  }

  const scheduleLoad = (): void => {
    if (reloadTimer !== null) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      void load()
      loadMarks()
      void loadFreq()
    }, RELOAD_DEBOUNCE_MS)
  }

  const setRange = (next: TimeRange): void => {
    range = next
    atEl.value = toLocalInput((range.fromMs + range.toMs) / 2)
    draw()
    scheduleLoad()
  }

  // ---- 記録を選ぶ ----

  const selectGroup = (key: string): void => {
    group = groups.find((g) => g.key === key) ?? null
    hidden = new Set()
    loaded = null
    overview = null
    marks = null
    marksController?.abort()
    freq = null
    freqController?.abort()
    freqFailure = null
    failure = null
    if (group === null) {
      bodyEl.hidden = true
      periodEl.textContent = ''
      return
    }
    if (group.kind === 'station') unit = 'gal'
    unitEl.hidden = group.kind !== 'raw'
    for (const b of unitEl.querySelectorAll<HTMLButtonElement>('button[data-unit]')) b.setAttribute('aria-pressed', String(b.dataset.unit === unit))
    periodEl.textContent = periodText(group)
    bounds = boundsOf(group)
    range = withSpan({ fromMs: bounds.toMs - INITIAL_SPAN_MS, toMs: bounds.toMs }, INITIAL_SPAN_MS, bounds)
    axesEl.innerHTML = group.axes
      .map((a) => `<button type="button" data-axis-id="${escapeHtml(a.id)}" aria-pressed="true">${escapeHtml(a.label)}</button>`)
      .join('')
    bodyEl.hidden = false
    buildRows()
    atEl.value = toLocalInput((range.fromMs + range.toMs) / 2)
    draw()
    void load()
    void loadOverview()
    loadMarks()
    void loadFreq()
  }

  groupEl.addEventListener('change', () => selectGroup(groupEl.value), { signal })

  unitEl.addEventListener(
    'click',
    (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-unit]')
      if (b === null || group === null) return
      const next = b.dataset.unit === 'native' ? 'native' : 'gal'
      if (next === unit) return
      unit = next
      for (const x of unitEl.querySelectorAll<HTMLButtonElement>('button[data-unit]')) x.setAttribute('aria-pressed', String(x.dataset.unit === unit))
      loaded = null
      void load()
      void loadOverview()
      void loadFreq()
    },
    { signal },
  )

  spansEl.addEventListener(
    'click',
    (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-span-index]')
      if (b === null || group === null) return
      setRange(withSpan(range, SPAN_CHOICES[Number(b.dataset.spanIndex)]!.ms, bounds))
    },
    { signal },
  )

  qs(container, '.records-prev').addEventListener('click', () => setRange(shiftBy(range, -(range.toMs - range.fromMs), bounds)), { signal })
  qs(container, '.records-next').addEventListener('click', () => setRange(shiftBy(range, range.toMs - range.fromMs, bounds)), { signal })
  qs(container, '.records-go').addEventListener(
    'click',
    () => {
      const at = new Date(atEl.value).getTime()
      if (Number.isFinite(at)) setRange(centerAt(range, at, bounds))
    },
    { signal },
  )

  axesEl.addEventListener(
    'click',
    (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-axis-id]')
      if (b === null || group === null) return
      const id = b.dataset.axisId!
      // **最後の 1 本は消さない**（段が 1 つも無いと、範囲の操作の手掛かりが無くなる）。
      if (!hidden.has(id) && visibleAxes().length <= 1) return
      if (hidden.has(id)) hidden.delete(id)
      else hidden.add(id)
      b.setAttribute('aria-pressed', String(!hidden.has(id)))
      draw()
    },
    { signal },
  )

  overviewEl.addEventListener(
    'click',
    (e) => {
      if (group === null) return
      const r = overview?.range ?? overviewRange(group)
      const rect = overviewEl.getBoundingClientRect()
      const width = Math.max(1, rect.width)
      setRange(centerAt(range, r.fromMs + ((e.clientX - rect.left) / width) * (r.toMs - r.fromMs), bounds))
    },
    { signal },
  )

  // ---- 段の上の操作（ホイールで寄せる・ドラッグで送る・指した所の値） ----

  const timeAtEvent = (e: MouseEvent, canvas: HTMLElement): { atMs: number; x: number; width: number } => {
    const rect = canvas.getBoundingClientRect()
    const width = Math.max(1, rect.width)
    const x = Math.min(width, Math.max(0, e.clientX - rect.left))
    return { atMs: range.fromMs + (x / width) * (range.toMs - range.fromMs), x, width }
  }

  rowsEl.addEventListener(
    'wheel',
    (e) => {
      const canvas = (e.target as HTMLElement).closest<HTMLCanvasElement>('canvas.records-canvas')
      if (canvas === null || group === null) return
      e.preventDefault()
      const { atMs } = timeAtEvent(e, canvas)
      setRange(zoomAt(range, e.deltaY > 0 ? WHEEL_ZOOM : 1 / WHEEL_ZOOM, atMs, bounds))
    },
    { signal, passive: false },
  )

  let drag: { readonly startX: number; readonly startRange: TimeRange; readonly width: number; readonly pointerId: number } | null = null
  rowsEl.addEventListener(
    'pointerdown',
    (e) => {
      const canvas = (e.target as HTMLElement).closest<HTMLCanvasElement>('canvas.records-canvas')
      if (canvas === null || group === null) return
      drag = { startX: e.clientX, startRange: range, width: Math.max(1, canvas.getBoundingClientRect().width), pointerId: e.pointerId }
      canvas.setPointerCapture?.(e.pointerId)
    },
    { signal },
  )
  rowsEl.addEventListener(
    'pointermove',
    (e) => {
      const canvas = (e.target as HTMLElement).closest<HTMLCanvasElement>('canvas.records-canvas')
      if (drag !== null && e.pointerId === drag.pointerId) {
        const span = drag.startRange.toMs - drag.startRange.fromMs
        range = shiftBy(drag.startRange, -((e.clientX - drag.startX) / drag.width) * span, bounds)
        atEl.value = toLocalInput((range.fromMs + range.toMs) / 2)
        hoverX = null
        draw()
        scheduleLoad()
        return
      }
      if (canvas === null) return
      hoverX = timeAtEvent(e, canvas).x
      hoverSpectrogramY = canvas.classList.contains('records-spectrogram')
        ? Math.min(SPECTROGRAM_HEIGHT, Math.max(0, e.clientY - canvas.getBoundingClientRect().top))
        : null
      draw()
    },
    { signal },
  )
  const endDrag = (e: PointerEvent): void => {
    if (drag !== null && e.pointerId === drag.pointerId) drag = null
  }
  rowsEl.addEventListener('pointerup', endDrag, { signal })
  rowsEl.addEventListener('pointercancel', endDrag, { signal })
  rowsEl.addEventListener(
    'pointerleave',
    () => {
      if (drag !== null) return
      hoverX = null
      hoverSpectrogramY = null
      draw()
    },
    { signal },
  )

  // 範囲のスペクトルの枠で指した所（周波数と軸ごとの dB）。
  spectrumEl.addEventListener(
    'pointermove',
    (e) => {
      const rect = spectrumEl.getBoundingClientRect()
      hoverSpectrumX = Math.min(rect.width, Math.max(0, e.clientX - rect.left))
      draw()
    },
    { signal },
  )
  spectrumEl.addEventListener(
    'pointerleave',
    () => {
      hoverSpectrumX = null
      draw()
    },
    { signal },
  )

  globalThis.addEventListener(
    'resize',
    () => {
      draw()
      scheduleLoad()
    },
    { signal },
  )

  // ---- 一覧を読む ----

  if (getStoredToken() === null) {
    listNoteEl.textContent = TOKEN_MISSING_TEXT
    return
  }
  try {
    const list = readChannelList(await apiFetch<unknown>(recordsUrl('channels', {}), { signal }))
    if (signal.aborted) return
    if (list === null) {
      listNoteEl.textContent = fetchFailureText('応答の形が違う')
      return
    }
    groups = groupChannels(list.channels)
    listNoteEl.textContent = unreadableListNote(list.unreadable) ?? ''
    if (groups.length === 0) {
      periodEl.textContent = EMPTY_RANGE_TEXT
      return
    }
    const stations = groups.filter((g) => g.kind === 'station')
    const raws = groups.filter((g) => g.kind === 'raw')
    const option = (g: RecordGroup): string => `<option value="${escapeHtml(g.key)}">${escapeHtml(g.label)}</option>`
    groupEl.innerHTML =
      (stations.length > 0 ? `<optgroup label="観測点の合成波形">${stations.map(option).join('')}</optgroup>` : '') +
      (raws.length > 0 ? `<optgroup label="センサーの生データ">${raws.map(option).join('')}</optgroup>` : '')
    selectGroup(groups[0]!.key)
  } catch (error) {
    if (isAbort(error) || signal.aborted) return
    listNoteEl.textContent = fetchFailureText(failureReason(error))
  }
}
