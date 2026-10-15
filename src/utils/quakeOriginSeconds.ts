// 地震カードの発生時刻を**秒まで**決める。自作地震計の波形へ P 波・S 波の線を引くための値。
//
// **地震情報の発生時刻は分までしか無い。** 電文の `OriginTime` は秒が 00 に丸められていて
// （実電文の控え 2412 通で全件）、そのまま使うと線が最大 59 秒ずれる。秒の出どころは
// **発生時刻として発表された値だけ**にし、次の順に使う（2026-10-15 ユーザー承認「カタログが届くまで
// 線を引かない」・「仮定震源の報は使わない」）。
//
//   1. **緊急地震速報の発生時刻**（震源の決まった最後の報）。電文解説資料が「秒値まで有効」と
//      書くのは緊急地震速報の `OriginTime` だけ。**仮定震源要素の報は使わない** —— 揺れを捉えた
//      観測点の直下に震源を置いて逆算した値で、本当の発生より遅く出る
//   2. **長期震源カタログ**（気象庁の震源リスト。0.01 秒）の地震のうち、1 つに決まるもの
//      （→ {@link findCatalogOriginMs}）。震源リストは 2 日前までしか載らず、アプリに入るのは
//      週 1 回の更新なので、**直近の数日には無い**
//
// どちらも無ければ秒は無い —— **線は引かない**（根拠の無い目盛りを実測の絵へ重ねない）。
//
// **地震 ID（14 桁）は秒の出どころにしない。** 資料は「物理的な意味（発生時刻等）を持つものではない」
// と書き、実電文でも発生時刻から −692〜+112 秒ずれた（823 件・±15 秒超 9%）。緊急地震速報を
// 地震カードへ結ぶ**鍵**としてだけ使う。
//
// 出どころの取り方（どこから・いつ取るか）は `hooks/useQuakeOriginSeconds.ts`。ここは
// 「手元の材料からどれを採るか」だけを決める純関数。

import type { EewOriginEntry } from './eewOriginStore'
import { haversineKm, hasKnownEpicenter } from './geo'
import { hasMagnitude } from './formatters'

/** 秒の出どころ。描く範囲の余裕が出どころで違うので、描く側が見分けられるよう持ち回す。 */
export type OriginSecondsSource = 'eew' | 'catalog'

export interface OriginSeconds {
  /** 発生時刻（エポックミリ秒）。 */
  readonly originMs: number
  readonly source: OriginSecondsSource
}

/** 日本時間（UTC+9）。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

const SECOND_MS = 1000
const MINUTE_MS = 60_000

/**
 * 地震カードの時刻（分まで）に対して、本当の発生時刻が入りうる幅（ms）。**分の頭の 30 秒前〜65 秒後。**
 *
 * **カードの時刻は発生時刻ではなく、地震発現時刻（最初に揺れを捉えた時刻）が優先**
 * （`services/dmdataParser.ts`。震度速報は検知時刻）。発生は発現より、震源から最初の観測点までの
 * 走時のぶん前にある。実電文 823 地震（カードと同じ選び方で時刻を取り、気象庁の震源リストと
 * 1 対 1 に結べたもの）で、震源リストの発生時刻 − カードの分の頭は −21.15〜+61.16 秒。
 * 前を 5 秒にしていた形では 11 件が窓の外へ落ち、うち 2 件は窓の中の別の地震を「1 つに決まった」と
 * 取り違えた。30 秒にすると 823 件で取り違え 0（→ {@link findCatalogOriginMs}）。
 */
export const QUAKE_MINUTE_LEAD_MS = 30 * SECOND_MS
export const QUAKE_MINUTE_TAIL_MS = 65 * SECOND_MS

/** 地震情報の発生時刻（分まで）に対して、`originMs` が同じ地震の発生時刻として入りうるか。 */
export function withinQuakeMinute(quakeTimeMs: number, originMs: number): boolean {
  if (!Number.isFinite(quakeTimeMs) || !Number.isFinite(originMs)) return false
  const head = Math.floor(quakeTimeMs / MINUTE_MS) * MINUTE_MS
  return originMs >= head - QUAKE_MINUTE_LEAD_MS && originMs <= head + QUAKE_MINUTE_TAIL_MS
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
 * 緊急地震速報の発生時刻を、その地震カードの秒として使ってよいか。
 *
 * - **仮定震源要素の報なら使わない**（`assumed === true`）。見分けられない値（`null`。標準版の強震モニタの
 *   緊急地震速報）は使う（2026-10-15 ユーザー承認「仮定震源の報は使わない（推奨）」の説明「標準版の
 *   強震モニタ経路は仮定を見分けられないので除けない」）
 * - **地震情報の分に入らなければ結ばない** —— 同じ地震 ID の中身が別の地震で食い違うことがある
 *   （電文解説資料の出現例４: 2 秒後に起きた別の地震が同じ地震 ID の処理に乗る）
 */
export function usableEewOrigin(quakeTimeMs: number, eew: EewOriginEntry | undefined): number | null {
  if (eew === undefined || eew.assumed === true) return null
  return withinQuakeMinute(quakeTimeMs, eew.originMs) ? eew.originMs : null
}

/**
 * 手元の材料から秒を決める。**どれも無ければ `null`。**
 *
 * @param params.quakeTimeMs 地震カードの発生時刻（分まで）
 * @param params.eew 同じ地震 ID の緊急地震速報の記録（地震 ID が判らない・記録が無ければ `undefined`）
 * @param params.catalogOriginMs 長期震源カタログから 1 つに決まった発生時刻（決まらなければ `null`）
 */
export function resolveOriginSeconds(params: {
  readonly quakeTimeMs: number
  readonly eew: EewOriginEntry | undefined
  readonly catalogOriginMs: number | null
}): OriginSeconds | null {
  const fromEew = usableEewOrigin(params.quakeTimeMs, params.eew)
  if (fromEew !== null) return { originMs: fromEew, source: 'eew' }
  const { catalogOriginMs } = params
  if (catalogOriginMs !== null && Number.isFinite(catalogOriginMs)) {
    return { originMs: catalogOriginMs, source: 'catalog' }
  }
  return null
}

/** 長期震源カタログ 1 年ぶんのうち、突き合わせに使う列（`utils/hypocenterCatalog.ts` の `HypocenterYear`）。 */
export interface CatalogColumns {
  /** 発生時刻（エポックミリ秒）。**昇順。** */
  readonly timeMs: ArrayLike<number>
  readonly lat: ArrayLike<number>
  readonly lng: ArrayLike<number>
  readonly magnitude: ArrayLike<number>
}

/** 突き合わせる側（地震カード）の材料。 */
export interface QuakeForCatalogLookup {
  /** 地震カードの発生時刻（分まで）。 */
  readonly timeMs: number
  readonly latitude: number
  readonly longitude: number
  readonly magnitude: number
}

/**
 * 震央の距離の上限（km）。**30 km。**
 *
 * 地震情報の震央（0.1 度）とカタログの震央の差は、1 対 1 に結べた 823 地震で中央値 4.5 km・
 * 90%点 7.2 km・最大 29.4 km。
 */
export const CATALOG_MAX_DISTANCE_KM = 30

/**
 * 規模の差の上限。**0.3。** 上と同じ 823 地震を結んだときの条件。地震情報の M とカタログの M は
 * どちらも気象庁マグニチュードだが、速報と震源リストで値が改められることがある。
 */
export const CATALOG_MAX_MAGNITUDE_DIFF = 0.3

/** `timeMs` の昇順の列で、`fromMs` 以上になる最初の添字。 */
function lowerBound(times: ArrayLike<number>, fromMs: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (times[mid] < fromMs) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 長期震源カタログから、その地震カードの発生時刻（秒まで）を引く。**1 つに決まらなければ `null`。**
 *
 * 地震カードの分（{@link withinQuakeMinute}）・震央 {@link CATALOG_MAX_DISTANCE_KM} 以内・規模の差
 * {@link CATALOG_MAX_MAGNITUDE_DIFF} 以内のものが**ちょうど 1 つ**のときだけ採る。群発の最中は
 * 1 分に同じ場所で複数の地震が起き、取り違えると別の地震の秒で線を引く（取り違えは「線が無い」より重い）。
 *
 * **震央か規模が判らない地震では引かない**（震度速報・規模不明）。時刻だけで 1 つに決めると、
 * カタログにしか載らない小さな地震を取り違える。
 *
 * @param coveredThroughMs カタログが覆っている終端。**分の幅がこれを越える地震では引かない** ——
 *   まだ載っていない地震は「見つからない」のではなく「見ていない」で、残った別の候補を
 *   1 つに決まったと取り違える
 */
export function findCatalogOriginMs(
  quake: QuakeForCatalogLookup,
  years: readonly CatalogColumns[],
  coveredThroughMs: number,
): number | null {
  if (!Number.isFinite(quake.timeMs)) return null
  if (!hasKnownEpicenter(quake.latitude, quake.longitude) || !hasMagnitude(quake.magnitude)) return null
  const head = Math.floor(quake.timeMs / MINUTE_MS) * MINUTE_MS
  const fromMs = head - QUAKE_MINUTE_LEAD_MS
  const toMs = head + QUAKE_MINUTE_TAIL_MS
  if (!(toMs <= coveredThroughMs)) return null
  let found: number | null = null
  for (const y of years) {
    for (let i = lowerBound(y.timeMs, fromMs); i < y.timeMs.length && y.timeMs[i] <= toMs; i += 1) {
      // **許容に 1e-6 を足す。** カタログの規模は Float32 で持つ（5.3 は 5.300000190734863）ので、
      // ちょうど 0.3 違う地震が丸めの誤差で外れないように。
      if (Math.abs(y.magnitude[i] - quake.magnitude) > CATALOG_MAX_MAGNITUDE_DIFF + 1e-6) continue
      if (haversineKm(quake.latitude, quake.longitude, y.lat[i], y.lng[i]) > CATALOG_MAX_DISTANCE_KM) continue
      if (found !== null) return null
      found = y.timeMs[i]
    }
  }
  return found
}

/**
 * 突き合わせに要る年（日本時間の暦年）。分の幅が年をまたぐなら両方。
 *
 * **カタログの年は日本時間で区切られている**（`HypocenterYear.timeMs` の注記）。
 */
export function catalogYearsFor(quakeTimeMs: number): number[] {
  if (!Number.isFinite(quakeTimeMs)) return []
  const head = Math.floor(quakeTimeMs / MINUTE_MS) * MINUTE_MS
  const yearOf = (ms: number) => new Date(ms + JST_OFFSET_MS).getUTCFullYear()
  const a = yearOf(head - QUAKE_MINUTE_LEAD_MS)
  const b = yearOf(head + QUAKE_MINUTE_TAIL_MS)
  return a === b ? [a] : [a, b]
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
