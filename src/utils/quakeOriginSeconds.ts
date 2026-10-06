// 地震カードの発生時刻を**秒まで**決める。自作地震計の波形へ P 波・S 波の線を引くための値。
//
// **地震情報の発生時刻は分までしか無い。** 電文の `OriginTime` は秒が 00 に丸められていて
// （実電文の控え 2412 通で全件）、そのまま使うと線が最大 59 秒ずれる。秒を持つ出どころは 2 つで、
// 正確な順に使う。
//
//   1. **緊急地震速報の発生時刻**（最終報）。秒まで正確
//   2. **地震 ID**（14 桁）。秒まであるが、観測点が地震を検知した時刻（地震発現時刻）と同じ値なので、
//      **発生時刻より 1〜9 秒遅い**（中央値 3 秒・62 件）
//
// どちらも無ければ秒は無い —— **線は引かない**（根拠の無い目盛りを実測の絵へ重ねない）。
//
// 出どころの取り方（どこから・いつ取るか）は `hooks/useQuakeOriginSeconds.ts`。ここは
// 「手元の材料からどれを採るか」だけを決める純関数。

/** 秒の出どころ。線の確からしさが違うので、描く側が見分けられるよう持ち回す。 */
export type OriginSecondsSource = 'eew' | 'event-id'

export interface OriginSeconds {
  /** 発生時刻（エポックミリ秒）。 */
  readonly originMs: number
  readonly source: OriginSecondsSource
}

/** 地震 ID の書式（日本時間の `YYYYMMDDhhmmss`）。 */
const EVENT_ID_PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/

/** 日本時間（UTC+9）。地震 ID は日本時間で書かれている。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/**
 * 地震 ID をエポックミリ秒へ直す。**読めなければ `null`。**
 *
 * **日本時間として読む。** 端末の時間帯で読むと、日本国外の端末だけ時刻がずれる。
 * **存在しない日時（13 月・31 日の無い月など）は弾く** —— `Date.UTC` は黙って繰り上げるので、
 * 組み立て直した値が元と一致するかで確かめる。
 */
export function parseEventIdMs(eventId: string): number | null {
  const m = EVENT_ID_PATTERN.exec(eventId)
  if (m === null) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  const utc = Date.UTC(y, mo - 1, d, h, mi, s)
  const back = new Date(utc)
  if (
    back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
    || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s
  ) return null
  return utc - JST_OFFSET_MS
}

/** 時計表記（`YYYY/MM/DD hh:mm[:ss[.sss]]`・`YYYY-MM-DD hh:mm…` も可）。時間帯を持たない。 */
const WALL_CLOCK_PATTERN = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/

/**
 * 地震カードの時刻をエポックミリ秒へ直す。**読めなければ `NaN`。**
 *
 * **時間帯を持たない表記は日本時間として読む。** P2PQuake の時刻（`2026/10/03 13:26:00`）は
 * 気象庁の日本時間の時計表記で、`new Date()` に渡すと端末の時間帯で読まれる —— 日本国外の
 * 端末では、気象庁の地震一覧（時間帯つきの絶対時刻）と分が合わず、突き合わせが全滅する。
 * 時間帯を持つ表記（DMDATA の ISO 形式）はそのまま読む。
 */
export function parseJstTimeMs(time: string): number {
  const m = WALL_CLOCK_PATTERN.exec(time.trim())
  if (m === null) return Date.parse(time)
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number)
  const s = m[6] === undefined ? 0 : Number(m[6])
  const utc = Date.UTC(y, mo - 1, d, h, mi, s)
  const back = new Date(utc)
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h) return Number.NaN
  return utc - JST_OFFSET_MS
}

/**
 * 手元の材料から秒を決める。**どちらも無ければ `null`。**
 *
 * @param eventId その地震の地震 ID（分からなければ `null`）
 * @param eewOriginMs 同じ地震 ID の緊急地震速報の発生時刻（無ければ `undefined`）
 */
export function resolveOriginSeconds(
  eventId: string | null,
  eewOriginMs: number | undefined,
): OriginSeconds | null {
  if (eventId === null) return null
  if (eewOriginMs !== undefined && Number.isFinite(eewOriginMs)) {
    return { originMs: eewOriginMs, source: 'eew' }
  }
  const fromId = parseEventIdMs(eventId)
  return fromId === null ? null : { originMs: fromId, source: 'event-id' }
}

/** 気象庁の地震一覧（`bosai/quake/data/list.json`）の 1 件のうち、突き合わせに使う欄。 */
export interface JmaQuakeListEntry {
  /** 地震 ID。 */
  readonly eid: string
  /** 発生時刻（ISO・分まで）。 */
  readonly at: string
  /** 震央地名。 */
  readonly anm: string
  /** マグニチュード（文字列。不明なら空のことがある）。 */
  readonly mag: string
}

/** 突き合わせる側（地震カード）の材料。 */
export interface QuakeForIdLookup {
  /** 地震カードの発生時刻（分まで）。 */
  readonly timeMs: number
  /** 震央地名。 */
  readonly epicenter: string
  /** マグニチュード。不明なら `null`。 */
  readonly magnitude: number | null
}

const MINUTE_MS = 60_000

/**
 * 地震 ID を持たない地震カード（P2PQuake 経路）について、気象庁の地震一覧から地震 ID を引く。
 * **1 つに決まらなければ `null`。**
 *
 * **発生の分と震央地名が一致するものを探し、複数あれば規模で絞る。** それでも 2 つ以上残れば
 * 採らない —— 同じ分・同じ震央地名・同じ規模の地震は区別できず、取り違えると別の地震の
 * 秒で線を引くことになる（取り違えは「線が無い」より重い）。
 *
 * 一覧は 1 つの地震について報ごとに行を持つ（震度速報・震源・震度情報…）ので、
 * 同じ `eid` は 1 つに数える。
 */
export function findJmaEventId(
  quake: QuakeForIdLookup,
  entries: readonly JmaQuakeListEntry[],
): string | null {
  if (!Number.isFinite(quake.timeMs) || quake.epicenter === '') return null
  const minute = Math.floor(quake.timeMs / MINUTE_MS)
  const sameMinuteAndPlace = entries.filter((e) => {
    const at = Date.parse(e.at)
    return Number.isFinite(at) && Math.floor(at / MINUTE_MS) === minute && e.anm === quake.epicenter
  })
  const pick = (list: readonly JmaQuakeListEntry[]): string | null => {
    const ids = new Set(list.map((e) => e.eid))
    return ids.size === 1 ? [...ids][0] : null
  }
  const first = pick(sameMinuteAndPlace)
  if (first !== null || sameMinuteAndPlace.length === 0) return first
  if (quake.magnitude === null) return null
  const sameMag = sameMinuteAndPlace.filter((e) => {
    const mag = Number.parseFloat(e.mag)
    return Number.isFinite(mag) && Math.abs(mag - (quake.magnitude as number)) < 0.05
  })
  return pick(sameMag)
}
