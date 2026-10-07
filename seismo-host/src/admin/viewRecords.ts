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

import { ApiError, apiFetch, describeAdminAuthFailure, getStoredToken } from './api'
import { escapeHtml, qs } from './dom'
import {
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

/** 軸 1 本ぶんの取れた値。 */
interface AxisData {
  readonly trace: AxisTrace
  readonly unit: ValueUnit
  readonly source: 'coarse' | 'fine' | 'samples' | 'raw-samples'
  readonly columnMs: number | null
  readonly hours: HourTallyView | null
  readonly irregular: readonly IrregularHourView[]
  readonly unscaledHours: number
}

interface Loaded {
  readonly groupKey: string
  readonly unit: 'gal' | 'native'
  readonly fetched: TimeRange
  /** 軸の id ごと。 */
  readonly axes: ReadonlyMap<string, AxisData>
  readonly intensity: IntensityData | null
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
      <p class="records-readout muted"></p>
      <p class="muted records-legend">
        <span class="records-hatch records-hatch-none"></span>${GAP_NONE_LEGEND}
        <span class="records-hatch records-hatch-pending" style="margin-left: 1rem"></span>${GAP_PENDING_LEGEND}
      </p>
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
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  let failure: string | null = null
  let hoverX: number | null = null

  signal.addEventListener('abort', () => {
    loadController?.abort()
    overviewController?.abort()
    if (reloadTimer !== null) clearTimeout(reloadTimer)
  })

  const visibleAxes = (): RecordGroup['axes'] => (group === null ? [] : group.axes.filter((a) => !hidden.has(a.id)))

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
    let html = ''
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
      if (axis !== null && data !== null) {
        drawHatch(ctx, traceGaps(axis.trace, range, data.fetched, axis.irregular), range, width, plotHeight)
        const c = Number.isFinite(centers[i]!) ? centers[i]! : 0
        const yOf = (v: number): number => mid - Math.max(-usable, Math.min(usable, ((v - c) / halfSpan) * usable))
        drawTrace(ctx, axis.trace, range, width, yOf, WAVE_COLOR)
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
    if (data !== null) {
      if (axisData.length > 0 && peaks.every((p) => p === null)) notes.push(EMPTY_RANGE_TEXT)
      const problems = problemsNote(maxTally(axisData.map((a) => a.hours)))
      if (problems !== null) notes.push(problems)
      const unscaled = unscaledNote(Math.max(0, ...axisData.map((a) => a.unscaledHours)))
      if (unscaled !== null) notes.push(unscaled)
    }
    noteEl.textContent = notes.join('　')

    // 指した所の値。
    if (hoverX === null || data === null) {
      readoutEl.textContent = ''
    } else {
      const canvas = axisCanvases[0]
      const width = canvas === undefined ? 1 : Math.max(1, canvas.clientWidth)
      const at = range.fromMs + (hoverX / width) * span
      readoutEl.textContent = readoutText(
        axes.map((a, i) => ({ short: a.short, value: traces[i] === null ? null : traceValueAt(traces[i]!.trace, at) })),
        valueUnit,
        at,
        span,
      )
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
            return [a.id, { trace: traceOfSamples(s), unit: s.unit, source: 'raw-samples', columnMs: null, hours: null, irregular: [], unscaledHours: s.problems.unscaledHours }]
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

  const scheduleLoad = (): void => {
    if (reloadTimer !== null) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      void load()
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
