// 「波形の記録」の印の段（受信・気象庁・揺れの記録）と、波形の下に引く届き方の線（#621 段 f）の当て方。
// DOM・Canvas に触らない部分。**画面に出す文言はどれも 2026-10-08 ユーザー承認。**
//
// 材料は 3 つの口から取る（どれも読み返しで、押し出しは使わない）。
//
// | 列 | 口 | 範囲 |
// |---|---|---|
// | 受信 | `/api/records/reception` | 記録の範囲と同じ（400 日まで） |
// | 気象庁 | `/api/records/quakes` | 7 日まで（2026-10-08 ユーザー承認） |
// | 揺れの記録 | `/events` | 新しいほうから 500 件まで |
//
// **観測点の合成波形の受信の帯は、いまこの観測点に割り当てている基板のセンサーぶん。** 受信の記録はセンサーごとに
// しか持たない（合成の前の段の事実）ので、どのセンサーを重ねるかは画面の側でチャンネルの一覧から決める。

import { formatClockDigits, readTally, type HourTallyView, type SampleRunView, type TimeRange } from './recordsPlot'
import { readFinite, readNonEmptyString } from './readJson'
import { formatQuakeName, VERDICT_LABELS, type ShakeRecordView } from './shakeHistory'

/** 気象庁の地震を重ねる範囲の上限（ホストの `RECORD_QUAKES_RANGE_MAX_MS` と同じ 7 日）。 */
export const QUAKES_RANGE_MAX_MS = 7 * 24 * 3_600_000
/** 印の段の 1 列の高さ（CSS ピクセル）。 */
export const MARK_LANE_HEIGHT_PX = 14
/** 波形の下に引く届き方の線の太さ（CSS ピクセル）。 */
export const UNDERLINE_HEIGHT_PX = 3
/** これより細い P・S の幅は線で描く（帯にすると見えない）。 */
const BAND_MIN_PX = 2

export interface Span {
  readonly fromMs: number
  readonly toMs: number
}

// ---- 応答を読む ----------------------------------------------------------------------------

export interface ReceptionView {
  readonly sensors: readonly {
    readonly sensor: string
    readonly backlog: readonly Span[]
    readonly late: readonly Span[]
    readonly questionable: readonly Span[]
  }[]
  /** 読めなかったパケット（記録した時刻）。センサーを持たない。 */
  readonly unreadableAtMs: readonly number[]
  /** 上限で切ったか（範囲の中の件を全部は返していない）。 */
  readonly unreadableTruncated: boolean
  readonly hours: HourTallyView
}

function readSpans(v: unknown): Span[] | null {
  if (!Array.isArray(v)) return null
  const out: Span[] = []
  for (const s of v) {
    if (typeof s !== 'object' || s === null) return null
    const o = s as Record<string, unknown>
    const fromMs = readFinite(o.fromMs)
    const toMs = readFinite(o.toMs)
    if (fromMs === null || toMs === null || toMs < fromMs) return null
    out.push({ fromMs, toMs })
  }
  return out
}

/** `reception` の応答を読む。**形が違えば応答ごと読めない（null）** —— 帯を黙って落とすと「何も無かった」に見える。 */
export function readReceptionData(value: unknown): ReceptionView | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const hours = readTally(v.hours)
  if (hours === null || !Array.isArray(v.sensors) || typeof v.unreadable !== 'object' || v.unreadable === null) return null
  const sensors: ReceptionView['sensors'][number][] = []
  for (const s of v.sensors) {
    if (typeof s !== 'object' || s === null) return null
    const o = s as Record<string, unknown>
    const sensor = readNonEmptyString(o.sensor)
    const backlog = readSpans(o.backlog)
    const late = readSpans(o.late)
    const questionable = readSpans(o.questionable)
    if (sensor === null || backlog === null || late === null || questionable === null) return null
    sensors.push({ sensor, backlog, late, questionable })
  }
  const u = v.unreadable as Record<string, unknown>
  if (!Array.isArray(u.items) || typeof u.truncated !== 'boolean') return null
  const unreadableAtMs: number[] = []
  for (const it of u.items) {
    const at = typeof it === 'object' && it !== null ? readFinite((it as Record<string, unknown>).atMs) : null
    if (at === null) return null
    unreadableAtMs.push(at)
  }
  return { sensors, unreadableAtMs, unreadableTruncated: u.truncated, hours }
}

/** 気象庁の地震 1 件（ホストが観測点への P・S の幅を添えたもの）。 */
export interface QuakeMarkView {
  readonly name: string
  readonly originMs: number
  readonly originPrecisionMs: number
  readonly magnitude: number | null
  readonly maxScale: number | null
  /** 観測点からの震央距離（観測点の位置が分からなければ null）。 */
  readonly distanceKm: number | null
  readonly p: Span | null
  readonly s: Span | null
}

export interface QuakesView {
  /** ホストが地震情報を取らない設定か。 */
  readonly off: boolean
  /** 観測点の位置が分かったか（P・S を引けるか）。 */
  readonly located: boolean
  readonly quakes: readonly QuakeMarkView[]
  /** 地震一覧を取れなかった日（`YYYY-MM-DD`）。 */
  readonly failedDays: readonly string[]
  readonly problem: string | null
  /** 発生時刻を秒まで寄せる材料（震源リスト・緊急地震速報）を取れなかった日（`YYYY-MM-DD`）。 */
  readonly refineFailedDays: { readonly hypocenter: readonly string[]; readonly eew: readonly string[] }
}

function readDays(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  return v.every((d) => typeof d === 'string') ? (v as string[]) : null
}

function nullableFinite(v: unknown): number | null | undefined {
  if (v === null) return null
  const n = readFinite(v)
  return n === null ? undefined : n
}

function nullableSpan(v: unknown): Span | null | undefined {
  if (v === null) return null
  const s = readSpans([v])
  return s === null ? undefined : s[0]!
}

/** `quakes` の応答を読む。**1 件でも形が違えば応答ごと読めない（null）。** */
export function readQuakesData(value: unknown): QuakesView | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.off !== 'boolean' || typeof v.located !== 'boolean' || !Array.isArray(v.quakes) || !Array.isArray(v.failedDays)) return null
  const quakes: QuakeMarkView[] = []
  for (const q of v.quakes) {
    if (typeof q !== 'object' || q === null) return null
    const o = q as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name : null
    const originMs = readFinite(o.originMs)
    const originPrecisionMs = readFinite(o.originPrecisionMs)
    const magnitude = nullableFinite(o.magnitude)
    const maxScale = nullableFinite(o.maxScale)
    const distanceKm = nullableFinite(o.distanceKm)
    const p = nullableSpan(o.p)
    const s = nullableSpan(o.s)
    if (name === null || originMs === null || originPrecisionMs === null || magnitude === undefined || maxScale === undefined || distanceKm === undefined || p === undefined || s === undefined) {
      return null
    }
    quakes.push({ name, originMs, originPrecisionMs, magnitude, maxScale, distanceKm, p, s })
  }
  const failedDays = v.failedDays.filter((d): d is string => typeof d === 'string')
  const problem = typeof v.problem === 'string' ? v.problem : null
  // **秒の材料の取れなかった日は、形が違えば応答ごと読めない** —— 黙って空にすると「取れなかった」が
  // 「載っていない」と同じ見え方へ戻る（この欄を足した理由そのもの）。
  const rf = typeof v.refineFailedDays === 'object' && v.refineFailedDays !== null ? (v.refineFailedDays as Record<string, unknown>) : null
  const hypocenter = rf === null ? null : readDays(rf.hypocenter)
  const eew = rf === null ? null : readDays(rf.eew)
  if (hypocenter === null || eew === null) return null
  return { off: v.off, located: v.located, quakes, failedDays, problem, refineFailedDays: { hypocenter, eew } }
}

// ---- 受信の列 ------------------------------------------------------------------------------

export interface ReceptionLane {
  readonly backlog: readonly Span[]
  readonly late: readonly Span[]
  readonly questionable: readonly Span[]
  readonly unreadableAtMs: readonly number[]
}

function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.fromMs - b.fromMs)
  const out: Span[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && s.fromMs <= last.toMs) out[out.length - 1] = { fromMs: last.fromMs, toMs: Math.max(last.toMs, s.toMs) }
    else out.push({ fromMs: s.fromMs, toMs: s.toMs })
  }
  return out
}

/** 選んだセンサーの帯を種類ごとに重ねる。**読めなかったパケットはセンサーを持たないので、いつも全部入れる。** */
export function receptionLane(r: ReceptionView, sensors: ReadonlySet<string>): ReceptionLane {
  const chosen = r.sensors.filter((s) => sensors.has(s.sensor))
  return {
    backlog: mergeSpans(chosen.flatMap((s) => s.backlog)),
    late: mergeSpans(chosen.flatMap((s) => s.late)),
    questionable: mergeSpans(chosen.flatMap((s) => s.questionable)),
    unreadableAtMs: [...r.unreadableAtMs].sort((a, b) => a - b),
  }
}

// ---- 波形の下の線 ---------------------------------------------------------------------------

export type UnderlineKind = 'backlog' | 'late' | 'revised' | 'questionable'

/**
 * 生のサンプルの届き方を、波形の下に引く線へ。**ライブと分からない届き方には引かない**（線の無い所がふつう）。
 * 時刻の疑わしさは届き方と重なりうるので、別の線として返す（描く側が上に重ねる）。続いた区間は 1 本へまとめる。
 */
export function originUnderline(runs: readonly SampleRunView[]): { readonly kind: UnderlineKind; readonly fromMs: number; readonly toMs: number }[] {
  const out: { kind: UnderlineKind; fromMs: number; toMs: number }[] = []
  const push = (kind: UnderlineKind, fromMs: number, toMs: number): void => {
    for (let i = out.length - 1; i >= 0; i--) {
      const last = out[i]!
      if (last.kind !== kind) continue
      if (last.toMs >= fromMs) {
        last.toMs = Math.max(last.toMs, toMs)
        return
      }
      break
    }
    out.push({ kind, fromMs, toMs })
  }
  for (const run of [...runs].sort((a, b) => a.firstSampleMs - b.firstSampleMs)) {
    const toMs = run.firstSampleMs + run.values.length * run.msPerSample
    if (run.origin === 'backlog' || run.origin === 'late' || run.origin === 'revised') push(run.origin, run.firstSampleMs, toMs)
    if (run.timeQuestionable) push('questionable', run.firstSampleMs, toMs)
  }
  return out
}

// ---- 画素への割り付け ------------------------------------------------------------------------

function xAt(atMs: number, r: TimeRange, width: number): number {
  return ((atMs - r.fromMs) / (r.toMs - r.fromMs)) * width
}

/** 区間を画素へ。範囲の外は null、端は切る。**細すぎても 1 画素は残す**（取り戻した 1 パケットぶんも見えるように）。 */
export function spanX(s: Span, r: TimeRange, width: number): { readonly x0: number; readonly x1: number } | null {
  if (!(r.toMs > r.fromMs) || s.toMs < r.fromMs || s.fromMs > r.toMs) return null
  const x0 = Math.max(0, xAt(s.fromMs, r, width))
  const x1 = Math.min(width, xAt(s.toMs, r, width))
  return x1 - x0 < 1 ? { x0, x1: x0 + 1 } : { x0, x1 }
}

export type ArrivalMark = { readonly kind: 'line'; readonly x: number } | { readonly kind: 'band'; readonly x0: number; readonly x1: number }

/** P・S の幅を、2 画素に満たなければ線（真ん中）、それ以上なら帯へ。範囲の外は null。 */
export function arrivalMark(s: Span, r: TimeRange, width: number): ArrivalMark | null {
  if (!(r.toMs > r.fromMs) || s.toMs < r.fromMs || s.fromMs > r.toMs) return null
  const x0 = xAt(s.fromMs, r, width)
  const x1 = xAt(s.toMs, r, width)
  if (x1 - x0 < BAND_MIN_PX) return { kind: 'line', x: (x0 + x1) / 2 }
  return { kind: 'band', x0: Math.max(0, x0), x1: Math.min(width, x1) }
}

// ---- カーソルの読み取り ----------------------------------------------------------------------

/** 届く時刻（秒まで分かれば 1 つ・幅があれば `P 01:29:18〜01:30:18` のように幅。2026-10-08 ユーザー承認）。 */
function arrivalText(s: Span): string {
  return s.toMs - s.fromMs <= 1000 ? formatClockDigits((s.fromMs + s.toMs) / 2, 1) : `${formatClockDigits(s.fromMs, 0)}〜${formatClockDigits(s.toMs, 0)}`
}

/** `気象庁: 千葉県北西部 M4.2 最大震度3（120 km） P 12:34:56.7・S 12:35:02.1`。位置が分からなければ距離と P・S を省く。 */
export function quakeReadout(q: QuakeMarkView): string {
  const head = `気象庁: ${formatQuakeName(q)}${q.distanceKm === null ? '' : `（${Math.round(q.distanceKm)} km）`}`
  const phases = [q.p === null ? null : `P ${arrivalText(q.p)}`, q.s === null ? null : `S ${arrivalText(q.s)}`].filter((x): x is string => x !== null)
  return phases.length === 0 ? head : `${head} ${phases.join('・')}`
}

/** 指した時刻に掛かる地震（発生から S の終わりまで。S が引けなければ発生時刻の幅）。 */
export function quakesAt(quakes: readonly QuakeMarkView[], atMs: number, tolMs: number): QuakeMarkView[] {
  return quakes.filter((q) => {
    const end = q.s?.toMs ?? q.originMs + q.originPrecisionMs
    return atMs >= q.originMs - tolMs && atMs <= end + tolMs
  })
}

/** `揺れの記録: 地震らしい 12:35:00〜12:35:40`。 */
export function shakeReadout(e: ShakeRecordView): string {
  return `揺れの記録: ${VERDICT_LABELS[e.verdict]} ${formatClockDigits(e.startMs, 0)}〜${formatClockDigits(e.endMs, 0)}`
}

export function shakesAt(events: readonly ShakeRecordView[], atMs: number, tolMs: number): ShakeRecordView[] {
  return events.filter((e) => atMs >= e.startMs - tolMs && atMs <= e.endMs + tolMs)
}

/** `受信: 基板から取り戻した分・時刻が疑わしい分`。何も掛からなければ null。 */
export function receptionAt(lane: ReceptionLane, atMs: number, tolMs: number): string | null {
  const hit = (spans: readonly Span[]): boolean => spans.some((s) => atMs >= s.fromMs - tolMs && atMs <= s.toMs + tolMs)
  const parts: string[] = []
  if (hit(lane.backlog)) parts.push('基板から取り戻した分')
  if (hit(lane.late)) parts.push('遅れて届いた分')
  if (hit(lane.questionable)) parts.push('時刻が疑わしい分')
  if (lane.unreadableAtMs.some((t) => Math.abs(t - atMs) <= tolMs)) parts.push('読めなかったパケット')
  return parts.length === 0 ? null : `受信: ${parts.join('・')}`
}

// ---- 文言 -----------------------------------------------------------------------------------

export const LANE_RECEPTION_TITLE = '受信'
export const LANE_QUAKE_TITLE = '気象庁'
export const LANE_SHAKE_TITLE = '揺れの記録'
export const RECEPTION_LEGEND = '受信: 橙 = 基板から取り戻した分・紫 = 遅れて届いた分・赤 = 時刻が疑わしい分・縦線 = 読めなかったパケット'
export const RECEPTION_STATION_NOTE = '受信の帯は、いまこの観測点に割り当てている基板のもの'
export const RECEPTION_STATION_GONE_TEXT = 'この観測点はいまの設定に無いので、受信の帯は出せない'
export const RECEPTION_TRUNCATED_TEXT = '読めなかったパケットが多く、古いほうから 2000 件だけ印を付けている'
export const UNDERLINE_LEGEND = '波形の下の線: 橙 = 取り戻した分・紫 = 遅れて届いた分・緑 = 取り戻した分から作り直した分・赤 = 時刻が疑わしい分'
export const QUAKE_LEGEND = '気象庁: ▼ = 発生時刻・破線 = この観測点に P・S が届く時刻（JMA2001 走時表）・帯 = 発生時刻が分までしか分からず、届く時刻に幅がある'
export const QUAKE_UNLOCATED_TEXT = 'このセンサーの基板は観測点に割り当てていないので、P・S の線は引けない'
export const QUAKE_TOO_WIDE_TEXT = '気象庁の地震は 7 日以内まで寄せると出る'
export const QUAKE_LOADING_TEXT = '気象庁の地震一覧を取得している'
export const QUAKE_OFF_TEXT = '気象庁の地震一覧を取らない設定になっている'
export const SHAKE_LEGEND = '揺れの記録: 帯 = 揺れの区間（色は判定）・△ = 拾った P・S'
export const SHAKE_TRUNCATED_TEXT = '揺れの記録が多く、新しい 500 件だけ印を付けている'

export function receptionPendingNote(hours: number): string | null {
  return hours > 0 ? `受信の記録の要約がまだ無い時が ${hours}（作り終えると出る）` : null
}

export function quakeFailureText(reason: string): string {
  return `気象庁の地震一覧を取得できていない（${reason}）`
}

function monthDay(d: string): string {
  return `${d.slice(5, 7)}/${d.slice(8, 10)}`
}

/**
 * `地震一覧を取れていない日がある（10/03・10/04。P2PQuake: HTTP 503）`。理由が分からなければ日付だけ
 * （理由を添えるのは 2026-10-08 ユーザー承認）。
 */
export function quakeFailedDaysText(days: readonly string[], problem: string | null): string {
  const dates = days.map(monthDay).join('・')
  return `地震一覧を取れていない日がある（${problem === null ? dates : `${dates}。${problem}`}）`
}

/**
 * `発生時刻を秒まで寄せる材料を取れていない日がある（震源リスト: 10/03・緊急地震速報: 10/04）`。**どちらも
 * 無ければ null。** その日の地震は、材料に載っていないときと同じ分の幅の帯で描かれるので、取れなかったことを
 * 別に書く（2026-10-08 ユーザー承認）。
 */
export function refineFailedDaysText(days: QuakesView['refineFailedDays']): string | null {
  const parts: string[] = []
  if (days.hypocenter.length > 0) parts.push(`震源リスト: ${days.hypocenter.map(monthDay).join('・')}`)
  if (days.eew.length > 0) parts.push(`緊急地震速報: ${days.eew.map(monthDay).join('・')}`)
  return parts.length === 0 ? null : `発生時刻を秒まで寄せる材料を取れていない日がある（${parts.join('・')}）`
}

/** `読めなかった揺れの記録が 3 件ある`。**0 なら null**（2026-10-08 ユーザー承認）。 */
export function shakeUnreadableText(count: number): string | null {
  return count > 0 ? `読めなかった揺れの記録が ${count} 件ある` : null
}
