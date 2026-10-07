// 揺れの記録タブ（`viewShakes.ts`）のうち、DOM に触らない部分。読み取り・版の差し替え・絞り込み・
// 行と見張りの 1 行の組み立て。
//
// **記録の形はホスト側の型（`detection/shakeEvent.ts` の `ShakeEventRecord`）を持ち込まない。**
// あちらは Node 側の型を経由しているうえ、`GET /events` と押し出し（`shake-event`）は形が変わりうる
// 相手なので、ここで使う欄だけを手で読んで確かめる（`viewStatus.ts` の `StatusReportView` と同じ事情）。
//
// **組み立てる HTML へ差し込む値は例外なく `escapeHtml` を通す。** 記録の `id` と `stationId` には
// 運用者が管理コンソールで自由に付けた観測点の ID が入り、震央の名前は外の配信（P2PQuake）から来る。

import { formatBaseline, jstClock, SILENT_AFTER_MS, triggerStateWord } from '../detection/detectionWording'
import {
  EVENT_RANGE_MAX_MS,
  monthsBetween,
  nameSurelyStartsInRange,
  startMsFromEventId,
  startMsFromFileName,
} from '../detection/eventRange'
import { JST_OFFSET_MS } from '../receiver/jstTime'
import { escapeHtml } from './dom'
import { readFinite, readNonEmptyString } from './readJson'
import { formatGal } from './wavePlot'

/** 判定（`detection/shakeEvent.ts` の `ShakeVerdict`）。 */
export type ShakeVerdictView = 'quake' | 'pending' | 'quake-like' | 'local-like' | 'unchecked'

/**
 * 判定の呼び名（2026-10-06 ユーザー承認）。README の「判定は 5 段」の表の意味を短く言い換えたもの
 * （`quake-like`・`local-like` は README の分類の呼び名そのまま）。
 *
 * **知らない判定は読まない**（`readShakeRecord`）。ホストが段を足したとき、ここに無い値を
 * 近い名前へ寄せて出すと、意味の違う判定が黙って別の言葉で並ぶ。
 */
export const VERDICT_LABELS: Readonly<Record<ShakeVerdictView, string>> = {
  quake: '地震',
  pending: '照合待ち',
  'quake-like': '地震らしい',
  'local-like': '生活振動らしい',
  unchecked: '照合できず',
}

function isVerdict(value: unknown): value is ShakeVerdictView {
  return typeof value === 'string' && Object.hasOwn(VERDICT_LABELS, value)
}

/** 照合した気象庁の地震（一覧に出す欄だけ）。 */
export interface MatchedQuakeView {
  readonly name: string
  readonly magnitude: number | null
  readonly depthKm: number | null
  /** P2PQuake の形（10・20・…・70）。 */
  readonly maxScale: number | null
  /** 観測点からの震央距離（km）。 */
  readonly distanceKm: number
}

/** 揺れ 1 件（一覧と段 2 の波形に要る欄だけ）。 */
export interface ShakeRecordView {
  readonly id: string
  readonly rev: number
  readonly stationId: string
  readonly startMs: number
  readonly endMs: number
  readonly sMs: number | null
  readonly pMs: number | null
  readonly peakAccelGal: number
  readonly maxIntensity: number | null
  readonly peakRatio: number
  readonly verdict: ShakeVerdictView
  readonly matchedQuake: MatchedQuakeView | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** null は null のまま、数は数として。**それ以外の形は読めない（`undefined`）。** */
function nullableFinite(value: unknown): number | null | undefined {
  if (value === null) return null
  const n = readFinite(value)
  return n === null ? undefined : n
}

function readMatchedQuake(value: unknown): MatchedQuakeView | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const name = typeof value.name === 'string' ? value.name : null
  const distanceKm = readFinite(value.distanceKm)
  const magnitude = nullableFinite(value.magnitude)
  const depthKm = nullableFinite(value.depthKm)
  const maxScale = nullableFinite(value.maxScale)
  if (name === null || distanceKm === null || magnitude === undefined || depthKm === undefined || maxScale === undefined) {
    return undefined
  }
  return { name, magnitude, depthKm, maxScale, distanceKm }
}

/** 記録 1 版を読む。**形が違えば null**（呼び出し側が数える）。 */
export function readShakeRecord(value: unknown): ShakeRecordView | null {
  if (!isRecord(value)) return null
  const id = readNonEmptyString(value.id)
  const stationId = readNonEmptyString(value.stationId)
  const rev = readFinite(value.rev)
  const startMs = readFinite(value.startMs)
  const endMs = readFinite(value.endMs)
  const peakAccelGal = readFinite(value.peakAccelGal)
  const peakRatio = readFinite(value.peakRatio)
  const sMs = nullableFinite(value.sMs)
  const pMs = nullableFinite(value.pMs)
  const maxIntensity = nullableFinite(value.maxIntensity)
  const matchedQuake = readMatchedQuake(value.matchedQuake)
  if (
    id === null ||
    stationId === null ||
    rev === null ||
    startMs === null ||
    endMs === null ||
    endMs < startMs ||
    peakAccelGal === null ||
    peakRatio === null ||
    sMs === undefined ||
    pMs === undefined ||
    maxIntensity === undefined ||
    matchedQuake === undefined ||
    !isVerdict(value.verdict)
  ) {
    return null
  }
  return { id, rev, stationId, startMs, endMs, sMs, pMs, peakAccelGal, maxIntensity, peakRatio, verdict: value.verdict, matchedQuake }
}

/**
 * 読めなかった記録の目印。**件数ではなく目印で持つ** —— 期間の読み返しと直近の読み返しは重なるので、
 * 件数を足すと二重に数え、大きいほうを残すと別の月で増えた分を落とす。目印の集合なら重なっても抜けない。
 */
export interface UnreadableMark {
  /**
   * 区別の鍵。`file:<月>/<名前>`（ホストが読めなかったファイル）・`file:<月>`（一覧できなかった月）・
   * `id:<id>`（届いたが、この画面が読めない形だった記録）・`raw:<中身の頭>`（`id` も読めなかった記録）。
   */
  readonly key: string
  /** 名前か `id` から読めた揺れの始まり（整数へ丸めた値）。読めなければ null。 */
  readonly startMs: number | null
  /** 掛かる月（`YYYY-MM`）。分からなければ null。 */
  readonly month: string | null
}

/** `GET /events` の応答を読んだもの。 */
export interface ShakeRangeView {
  readonly events: readonly ShakeRecordView[]
  readonly marks: readonly UnreadableMark[]
}

function fileMark(name: string): UnreadableMark {
  const slash = name.indexOf('/')
  const month = slash === -1 ? name : name.slice(0, slash)
  return {
    key: `file:${name}`,
    startMs: slash === -1 ? null : startMsFromFileName(name.slice(slash + 1)),
    month: /^\d{4}-\d{2}$/.test(month) ? month : null,
  }
}

/**
 * `GET /events` の応答を読む。**`events` が配列でなければ応答ごと読めない（null）** ——
 * 空の配列として扱うと、「揺れが無かった」と「応答が壊れていた」が同じ空の一覧に見える。
 */
export function readShakeRange(value: unknown): ShakeRangeView | null {
  if (!isRecord(value) || !Array.isArray(value.events)) return null
  const events: ShakeRecordView[] = []
  const marks: UnreadableMark[] = []
  for (const raw of value.events) {
    const r = readShakeRecord(raw)
    if (r !== null) {
      events.push(r)
      continue
    }
    const id = isRecord(raw) ? readNonEmptyString(raw.id) : null
    marks.push(
      id !== null
        ? { key: `id:${id}`, startMs: startMsFromEventId(id), month: null }
        : { key: `raw:${JSON.stringify(raw)?.slice(0, 200) ?? String(raw)}`, startMs: null, month: null },
    )
  }
  if (Array.isArray(value.unreadableFiles)) {
    for (const n of value.unreadableFiles) marks.push(fileMark(typeof n === 'string' ? n : JSON.stringify(n)))
  }
  return { events, marks }
}

/**
 * 読めなかった記録の帳面。**期間全体の読み返しが拾ったものと、直近の読み返しが拾ったものを分けて持つ** ——
 * 直近の読み返しは期間の一部しか見ないので、1 つの集合へ足すだけだと、一時的に読めなかったものが
 * 直ったあとも期間を選び直すまで残る。
 */
export interface UnreadableBook {
  readonly period: ReadonlyMap<string, UnreadableMark>
  readonly recent: ReadonlyMap<string, UnreadableMark>
}

export const EMPTY_UNREADABLE_BOOK: UnreadableBook = { period: new Map(), recent: new Map() }

/**
 * その範囲の読み返しが、**この目印の記録を必ず見直すか**。真なら、その回に出てこなかった目印は直ったとみなせる。
 * - 始まりが分かる目印 → 名前の丸めを見込んでも範囲の内側にあるか（`nameSurelyStartsInRange`）
 * - 始まりが分からず月だけ分かる目印 → その月を一覧するか（名前から始まりを読めないファイルは、月を一覧すれば必ず開く）
 * - どちらも分からない目印（`raw:`）→ 見直したと言えない（期間を選び直すまで残す）
 */
export function rangeRechecks(mark: UnreadableMark, q: { readonly fromMs: number; readonly toMs: number }): boolean {
  if (mark.startMs !== null) return nameSurelyStartsInRange(mark.startMs, q.fromMs, q.toMs)
  if (mark.month !== null) return monthsBetween(q.fromMs, q.toMs).includes(mark.month)
  return false
}

/**
 * 読み返しの結果で帳面を進める。
 * - **期間を選び直した読み返し（`full`）** は、帳面をこの回の目印で置き換える。
 * - **直近の読み返し** は、直近の分をこの回の目印で置き換える。それまでの目印のうち、**この回が見直した範囲のもの
 *   は捨て**（出てこなければ直った）、**見直していないものは期間の分へ移して残す** —— 直近の範囲から外れていった
 *   記録の目印を、まだ壊れているのに黙って消さない。
 */
export function nextUnreadableBook(
  book: UnreadableBook,
  marks: readonly UnreadableMark[],
  q: { readonly fromMs: number; readonly toMs: number },
  full: boolean,
): UnreadableBook {
  const fresh = new Map(marks.map((m) => [m.key, m] as const))
  if (full) return { period: fresh, recent: new Map() }
  const period = new Map<string, UnreadableMark>()
  for (const m of [...book.period.values(), ...book.recent.values()]) {
    if (!rangeRechecks(m, q)) period.set(m.key, m)
  }
  return { period, recent: fresh }
}

/** 帳面の件数（期間の分と直近の分で重なる目印は 1 件と数える）。 */
export function unreadableCount(book: UnreadableBook): number {
  const keys = new Set([...book.period.keys(), ...book.recent.keys()])
  return keys.size
}

/**
 * 開いている記録の、一覧にある新しい版。**一覧のほうが版が進んでいれば、それを返す**（無ければ元のまま）。
 * 押し出しが切れている間は、照合の結果は読み返しでしか届かない —— 一覧だけ進んで、開いている区間の見出しと
 * 縦線が古い版のまま残らないようにする。
 */
export function newerRecord(current: ShakeRecordView, list: readonly ShakeRecordView[]): ShakeRecordView {
  const inList = list.find((r) => r.id === current.id)
  return inList !== undefined && inList.rev > current.rev ? inList : current
}

/**
 * 一覧へ 1 版を入れる。**同じ `id` は版（`rev`）の大きいほうを残す** —— 押し出しと読み返しが
 * 前後して届いても、照合の済んだ版を古い版で戻さない。並びは始まりの新しい順。
 */
export function upsertShake(list: readonly ShakeRecordView[], rec: ShakeRecordView): readonly ShakeRecordView[] {
  const existing = list.find((r) => r.id === rec.id)
  if (existing !== undefined && existing.rev >= rec.rev) return list
  const rest = list.filter((r) => r.id !== rec.id)
  return [...rest, rec].sort((a, b) => b.startMs - a.startMs)
}

/**
 * `GET /events` が一度に返す範囲の上限（ミリ秒）。**ホストと同じ値を同じ場所から読む**
 * （`detection/eventRange.ts`）。幅がこれを超えると `400 range-too-wide` で断られる。
 */
export const EVENTS_RANGE_MAX_MS = EVENT_RANGE_MAX_MS
/** 右端を少し先まで取る幅。押し出しが届く前に閉じた揺れを落とさない。 */
const EVENTS_RIGHT_MARGIN_MS = 60_000
/**
 * 開いている間に読み返す直近の幅。**照合は揺れが閉じてから最長 2 時間まで版を進める**
 * （README「期限を過ぎてから届いた地震情報でも、2 時間以内なら quake へ上書きする」）ので、
 * 余裕を見て 3 時間ぶんの始まりを持つ記録を読み直す。
 */
const RECENT_RELOAD_MS = 3 * 3_600_000

/**
 * 期間を選んだときの問い合わせの範囲。**幅は必ず `EVENTS_RANGE_MAX_MS` 以下に収める** ——
 * 右端に余裕を足したぶん左端を詰める（93 日ちょうどを選んでも断られない）。
 */
export function eventsQueryRange(anchorMs: number, periodDays: number): { readonly fromMs: number; readonly toMs: number } {
  const toMs = Math.ceil(anchorMs + EVENTS_RIGHT_MARGIN_MS)
  const span = Math.min(periodDays * 24 * 3_600_000 + EVENTS_RIGHT_MARGIN_MS, EVENTS_RANGE_MAX_MS)
  return { fromMs: toMs - span, toMs }
}

/**
 * 開いている間に読み返す範囲（直近 3 時間）。**押し出しが切れていても一覧が追いつく**ように、
 * 見張りの行と同じ間隔でこちらも読み直す（押し出しだけに頼ると、切れている間の揺れが黙って抜ける）。
 */
export function recentQueryRange(anchorMs: number): { readonly fromMs: number; readonly toMs: number } {
  const toMs = Math.ceil(anchorMs + EVENTS_RIGHT_MARGIN_MS)
  return { fromMs: toMs - RECENT_RELOAD_MS - EVENTS_RIGHT_MARGIN_MS, toMs }
}

/** 見せる範囲。 */
export interface ShakeFilter {
  /** 始まりがこの範囲（`[fromMs, toMs)`）に入るものを出す。 */
  readonly fromMs: number
  readonly toMs: number
  /** 生活振動らしいものを隠す。**隠すのはこの判定だけ。** */
  readonly hideLocal: boolean
}

export function visibleShakes(list: readonly ShakeRecordView[], f: ShakeFilter): readonly ShakeRecordView[] {
  return list.filter((r) => r.startMs >= f.fromMs && r.startMs < f.toMs && !(f.hideLocal && r.verdict === 'local-like'))
}

const two = (n: number): string => String(n).padStart(2, '0')

/**
 * 揺れの始まり（日本時間の `MM/DD HH:MM:SS`）。**端末の時間帯で出さない** —— ホストのログと
 * 記録の置き場所（月のディレクトリ）が日本時間で、違う端末から開くと時刻がずれて見える。
 */
export function formatShakeStart(ms: number): string {
  const d = new Date(ms + JST_OFFSET_MS)
  return `${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`
}

/** P2PQuake の震度の形 → 震度の名前。**表に無い値は名前を付けない**（46 は未入電を含むなど意味が違う）。 */
const SCALE_NAMES: Readonly<Record<number, string>> = {
  10: '1',
  20: '2',
  30: '3',
  40: '4',
  45: '5弱',
  50: '5強',
  55: '6弱',
  60: '6強',
  70: '7',
}

/**
 * 照合した地震を 1 つの文字列に（例「千葉県北西部 M4.2 最大震度3（120 km）」）。
 * **分からない部分は省く**（推し量って埋めない）。HTML へ入れるときは呼び出し側でエスケープする。
 */
export function formatMatchedQuake(q: MatchedQuakeView): string {
  const parts = [q.name]
  if (q.magnitude !== null) parts.push(`M${q.magnitude.toFixed(1)}`)
  const scale = q.maxScale === null ? undefined : SCALE_NAMES[q.maxScale]
  if (scale !== undefined) parts.push(`最大震度${scale}`)
  return `${parts.join(' ')}（${Math.round(q.distanceKm)} km）`
}

/**
 * 一覧の 1 行。**組み立て済みの HTML**（差し込む値は `escapeHtml` を通している）。
 *
 * S 波は始まりからの秒で出す（揺れのどこで S が来たかを読む欄なので）。拾えなかった S と
 * 届かなかった震度は「—」—— 0 と書くと「始まりと同時に来た」「揺れていない」に読める。
 */
export function shakeRowHtml(r: ShakeRecordView, selected: boolean): string {
  const lengthSec = ((r.endMs - r.startMs) / 1000).toFixed(1)
  const s = r.sMs === null ? '—' : `+${((r.sMs - r.startMs) / 1000).toFixed(1)} 秒`
  const intensity = r.maxIntensity === null ? '—' : r.maxIntensity.toFixed(1)
  const quake = r.matchedQuake === null ? '' : escapeHtml(formatMatchedQuake(r.matchedQuake))
  return (
    `<tr class="shake-row${selected ? ' selected' : ''}" data-shake-id="${escapeHtml(r.id)}">` +
    `<td>${formatShakeStart(r.startMs)}</td>` +
    `<td>${lengthSec} 秒</td>` +
    `<td><span class="badge verdict-${r.verdict}">${VERDICT_LABELS[r.verdict]}</span></td>` +
    `<td>${formatGal(r.peakAccelGal)} gal</td>` +
    `<td>${intensity}</td>` +
    `<td>${r.peakRatio.toFixed(1)} 倍</td>` +
    `<td>${s}</td>` +
    `<td>${quake}</td>` +
    `<td class="muted">${escapeHtml(r.stationId)}</td>` +
    '</tr>'
  )
}

/** 見張りの 1 行に要る、観測点 1 つぶんの引き金の状態（`/status` の `detection.triggers`）。 */
export interface TriggerView {
  readonly stationId: string
  /** ホストの時計。 */
  readonly lastFedAtMs: number | null
  /** 以下の時刻はデータの時刻。 */
  readonly lastSampleMs: number | null
  readonly armed: boolean
  readonly inEvent: boolean
  readonly warmUntilMs: number | null
  readonly baselineGal: number | null
  readonly peak24h: { readonly ratio: number; readonly atMs: number } | null
  readonly peakWindowFromMs: number | null
}

function readTrigger(value: unknown): TriggerView | null {
  if (!isRecord(value)) return null
  const stationId = readNonEmptyString(value.stationId)
  const lastFedAtMs = nullableFinite(value.lastFedAtMs)
  const lastSampleMs = nullableFinite(value.lastSampleMs)
  const warmUntilMs = nullableFinite(value.warmUntilMs)
  const baselineGal = nullableFinite(value.baselineGal)
  const peakWindowFromMs = nullableFinite(value.peakWindowFromMs)
  let peak24h: TriggerView['peak24h'] | undefined
  if (value.peak24h === null) peak24h = null
  else if (isRecord(value.peak24h)) {
    const ratio = readFinite(value.peak24h.ratio)
    const atMs = readFinite(value.peak24h.atMs)
    peak24h = ratio === null || atMs === null ? undefined : { ratio, atMs }
  }
  if (
    stationId === null ||
    lastFedAtMs === undefined ||
    lastSampleMs === undefined ||
    warmUntilMs === undefined ||
    baselineGal === undefined ||
    peakWindowFromMs === undefined ||
    peak24h === undefined ||
    typeof value.armed !== 'boolean' ||
    typeof value.inEvent !== 'boolean'
  ) {
    return null
  }
  return { stationId, lastFedAtMs, lastSampleMs, armed: value.armed, inEvent: value.inEvent, warmUntilMs, baselineGal, peak24h, peakWindowFromMs }
}

/**
 * `/status` から引き金の状態を読む。**欄が無ければ null**（応答の形が違う）——
 * 空の配列にすると「見張っている観測点が無い」と取り違える。形の違う要素は外し、その数を添える。
 */
export function readTriggers(
  status: unknown,
): { readonly items: readonly TriggerView[]; readonly malformedCount: number } | null {
  if (!isRecord(status) || !isRecord(status.detection) || !Array.isArray(status.detection.triggers)) return null
  const items: TriggerView[] = []
  let malformedCount = 0
  for (const raw of status.detection.triggers) {
    const t = readTrigger(raw)
    if (t !== null) items.push(t)
    else malformedCount += 1
  }
  // **読めなかった要素の数も返す** —— 黙って外すと、全部読めなかったときに「観測点が無い」と同じ空白になる。
  return { items, malformedCount }
}

/** 比の最大を何時間ぶん覚えるか（ホストの `quakeTrigger.ts` の 24 時間）。 */
const PEAK_WINDOW_MS = 24 * 3_600_000
/** ホストは 1 分刻みで覚えるので、それだけ欠けていても 24 時間ぶんと見なす。 */
const PEAK_WINDOW_SLACK_MS = 60_000

/**
 * 観測点 1 つぶんの見張りの行。**組み立て済みの HTML**（観測点の ID は `escapeHtml` を通す）。
 * `nowMs` はホストの時計（`/status` の `generatedAtMs`）。
 *
 * **言い方はホストの 1 時間ごとのログと共有する**（`detection/detectionWording.ts`）。
 * **2 つの時計を混ぜない** —— 「届いているか」はホストの時計（`lastFedAtMs` と `nowMs`）だけで見る。
 * 比の最大の時刻と覚えている範囲はデータの時刻。
 *
 * **覚えている範囲が 24 時間に満たなければ「HH:MM からの」と書く**（ホストの起動直後など。
 * 2026-10-06 ユーザー承認）—— 「この 24 時間の」と書くと、事実より広い範囲を言うことになる。
 */
export function triggerLine(t: TriggerView, nowMs: number): { readonly warn: boolean; readonly text: string } {
  const head = `${escapeHtml(t.stationId)}：`
  if (t.lastFedAtMs === null) return { warn: true, text: `${head}波形が届いていない（起動から一度も）` }
  if (nowMs - t.lastFedAtMs >= SILENT_AFTER_MS) {
    return { warn: true, text: `${head}波形が届いていない（最後は ${jstClock(t.lastFedAtMs, nowMs)}）` }
  }
  const covers24h =
    t.peakWindowFromMs === null ||
    t.lastSampleMs === null ||
    t.lastSampleMs - t.peakWindowFromMs >= PEAK_WINDOW_MS - PEAK_WINDOW_SLACK_MS
  const scope = covers24h || t.peakWindowFromMs === null ? 'この 24 時間' : `${jstClock(t.peakWindowFromMs, nowMs)} から`
  const peak = t.peak24h === null ? 'なし' : `${t.peak24h.ratio.toFixed(2)} 倍（${jstClock(t.peak24h.atMs, nowMs)}）`
  return {
    warn: t.peak24h === null,
    text: `${head}${triggerStateWord(t)}・${scope}の比の最大 ${peak}・平常時の揺れ ${formatBaseline(t.baselineGal)}`,
  }
}
