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
  EVENT_PAGE_LIMIT_MAX,
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
  /** 範囲のうち古いほうに、返されていない記録が残っているか（ホストが件数で区切ったか）。 */
  readonly truncated: boolean
  /** ここから範囲の終わりまでは漏れなく返された。続きはここを終わりにして読む。 */
  readonly coveredFromMs: number
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
  // **区切ったかを読めなければ応答ごと読めない** —— 推し量ると、「その範囲の全部」と「新しいほうの一部」を
  // 取り違える（続きを読むボタンが出ない、または出続ける）。
  const coveredFromMs = readFinite(value.coveredFromMs)
  if (typeof value.truncated !== 'boolean' || coveredFromMs === null) return null
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
  return { events, marks, truncated: value.truncated, coveredFromMs }
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
 * 読み返しの種類。`full` は期間を選び直した回、`recent` は開いている間の直近の読み直し、
 * `older` は「さらに古い記録を読む」で続きを読んだ回。
 */
export type ReadKind = 'full' | 'recent' | 'older'

/**
 * 読み返しの結果で帳面を進める。`q` は**その回が漏れなく見直した範囲**（ホストが件数で区切ったなら、
 * 範囲の頭ではなく見終えた範囲の頭から）。
 * - **期間を選び直した読み返し（`full`）** は、帳面をこの回の目印で置き換える。
 * - **直近の読み返し（`recent`）** は、直近の分をこの回の目印で置き換える。それまでの目印のうち、**この回が見直した範囲のもの
 *   は捨て**（出てこなければ直った）、**見直していないものは期間の分へ移して残す** —— 直近の範囲から外れていった
 *   記録の目印を、まだ壊れているのに黙って消さない。
 * - **続きを読んだ回（`older`）** は、この回の目印を期間の分へ足す。見直した範囲の古い目印は捨て、直近の分は
 *   置き換えない（直近の読み直しが次に見る）。
 */
export function nextUnreadableBook(
  book: UnreadableBook,
  marks: readonly UnreadableMark[],
  q: { readonly fromMs: number; readonly toMs: number },
  kind: ReadKind,
): UnreadableBook {
  const fresh = new Map(marks.map((m) => [m.key, m] as const))
  if (kind === 'full') return { period: fresh, recent: new Map() }
  if (kind === 'older') {
    const period = new Map<string, UnreadableMark>()
    for (const m of book.period.values()) if (!rangeRechecks(m, q)) period.set(m.key, m)
    for (const [key, m] of fresh) period.set(key, m)
    const recent = new Map<string, UnreadableMark>()
    for (const m of book.recent.values()) if (!rangeRechecks(m, q)) recent.set(m.key, m)
    return { period, recent }
  }
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
 * 読み返しの成否。**読み返しの種類ごとに分けて持つ** —— 1 つにまとめると、ある種類の成功が別の種類の失敗を消す
 * （期間を一度も読めていないのに直近の読み直しの成功で失敗の行が消え、「揺れは無い」に化ける）か、
 * ある種類の失敗を別の種類の成功が消せずに残り続ける（続きの失敗が、直近の読み直しが何度通っても表に居座る）。
 */
export interface LoadState {
  /** 期間全体の読み返しの失敗（表の中に出す）。 */
  readonly period: string | null
  /** 直近の読み直しの失敗（表の中に出す）。 */
  readonly recent: string | null
  /** 続き（さらに古い記録）の読み返しの失敗。**表ではなく続きのボタンの横に出す**（読めていないのは表の末尾の先）。 */
  readonly older: string | null
  /** 選んだ期間を一度でも読めたか。読めるまでは、開いている間の読み直しで期間全体を読み直す。 */
  readonly periodLoaded: boolean
}

export const INITIAL_LOAD_STATE: LoadState = { period: null, recent: null, older: null, periodLoaded: false }

/**
 * 期間を選び直したとき。**続きの失敗は前の期間のものなので捨てる。** 期間・直近の失敗は、読み直しの結果が
 * 出るまで残す（結果が出る前に消すと、取れていないのに「揺れは無い」が一瞬出る）。
 */
export function startPeriodLoad(state: LoadState): LoadState {
  return { ...state, older: null, periodLoaded: false }
}

/**
 * 読み返しの結果で成否を進める（`failure` は失敗の理由。成功なら `null`）。
 * - `full` が通れば、直近の範囲も含めて期間を読み直したので、期間・直近・続きの失敗をすべて消す。
 * - `recent` / `older` は、自分の種類の失敗だけを書き換える。
 */
export function nextLoadState(state: LoadState, kind: ReadKind, failure: string | null): LoadState {
  if (kind === 'full') {
    return failure === null
      ? { period: null, recent: null, older: null, periodLoaded: true }
      : { ...state, period: failure }
  }
  return kind === 'recent' ? { ...state, recent: failure } : { ...state, older: failure }
}

/** 表の中に出す失敗の理由（無ければ `null`）。**続きの失敗は表に出さない**（`LoadState.older`）。 */
export function tableFailure(state: LoadState): string | null {
  return state.period ?? state.recent
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
 * `GET /events` に頼む件数（ホストが受け付ける上限ちょうど。2026-10-07 ユーザー承認）。**ホストと同じ値を
 * 同じ場所から読む**（`detection/eventRange.ts`）—— 上限を超えて頼むと `400 bad-limit` で断られる。
 */
export const EVENTS_PAGE_LIMIT = EVENT_PAGE_LIMIT_MAX
/** 右端を少し先まで取る幅。押し出しが届く前に閉じた揺れを落とさない。 */
const EVENTS_RIGHT_MARGIN_MS = 60_000
/**
 * 開いている間に読み返す直近の幅。**照合は揺れが閉じてから最長 2 時間まで版を進める**
 * （README「期限を過ぎてから届いた地震情報でも、2 時間以内なら quake へ上書きする」）ので、
 * 余裕を見て 3 時間ぶんの始まりを持つ記録を読み直す。
 */
const RECENT_RELOAD_MS = 3 * 3_600_000

/** 時刻の範囲（`[fromMs, toMs)`）。 */
export interface TimeRange {
  readonly fromMs: number
  readonly toMs: number
}

/**
 * 期間のボタンを選んだときの問い合わせの範囲（直近 `periodDays` 日＋右端の余裕）。**幅は詰めない** ——
 * ホストは範囲の広さではなく件数で区切る（`EVENTS_PAGE_LIMIT`）。
 */
export function eventsQueryRange(anchorMs: number, periodDays: number): TimeRange {
  const toMs = Math.ceil(anchorMs + EVENTS_RIGHT_MARGIN_MS)
  return { fromMs: toMs - (periodDays * 24 * 3_600_000 + EVENTS_RIGHT_MARGIN_MS), toMs }
}

/**
 * `GET /events` の URL。**端は整数へ外向きに揃える**（ホストは 10 進の整数しか読まない）。
 * 生活振動らしいものを隠すなら、ホストで除いてから数えてもらう —— 画面で隠すと、上限まで返った分の
 * 大半が隠れて数行しか残らないことがある。
 */
export function eventsUrl(q: TimeRange, hideLocal: boolean): string {
  return `/events?from=${Math.floor(q.fromMs)}&to=${Math.ceil(q.toMs)}&limit=${EVENTS_PAGE_LIMIT}${hideLocal ? '&hide=local' : ''}`
}

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/

/** `YYYY-MM-DD`（日本時間）の 0 時。**読めない・存在しない日なら null。** */
function jstMidnight(text: string): number | null {
  const m = DATE_TEXT.exec(text)
  if (m === null) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const utc = Date.UTC(y, mo - 1, d)
  const back = new Date(utc)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return utc - JST_OFFSET_MS
}

/**
 * 日付で選んだ期間（日本時間）。始まりの日の 0 時から、**終わりの日の翌日 0 時まで**（終わりの日を含む）。
 * 終わりが始まりより前・日付として読めないなら null（問い合わせない）。
 */
export function jstDayRange(fromDate: string, toDate: string): TimeRange | null {
  const fromMs = jstMidnight(fromDate)
  const toStart = jstMidnight(toDate)
  if (fromMs === null || toStart === null || toStart < fromMs) return null
  return { fromMs, toMs: toStart + 24 * 3_600_000 }
}

/** 日本時間の日付（`YYYY-MM-DD`）。日付の入力へ入れる値。 */
export function jstDateOf(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10)
}

/** 2 つの範囲の重なり。重ならなければ null。 */
export function clipRange(a: TimeRange, b: TimeRange): TimeRange | null {
  const fromMs = Math.max(a.fromMs, b.fromMs)
  const toMs = Math.min(a.toMs, b.toMs)
  return fromMs < toMs ? { fromMs, toMs } : null
}

/** ホストが件数で区切ったときに、表の下へ添える文（2026-10-07 ユーザー承認）。`shown` は出している件数。 */
export function truncatedNote(shown: number): string {
  return `新しいほうから ${shown} 件を出している`
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
