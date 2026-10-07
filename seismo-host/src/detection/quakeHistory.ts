// 期間の地震情報を P2PQuake の履歴（`/v2/jma/quake`）から取る（#618 の流し直しの照合に使う）。
//
// **日付でしか絞れない**（`since_date`・`until_date` は日本時間の yyyyMMdd）。古い順に 100 件ずつ、
// `offset` を進めて辿る。上限は 10 リクエスト/分（IP ごと。`docs/spec/data-sources-spec.md` §3）なので、
// 2 本目からは間を空ける。
//
// **「取りきれた範囲」を一緒に返す。** 照合で合わなかった揺れを「地震ではなかった」と言えるのは、
// その時刻の地震情報を漏れなく持っているときだけ —— 取れなかった・ページの上限で切った・まだ載って
// いない（取った時刻の直前）範囲は、取りきれたと言わない（その範囲の合わない揺れは `unchecked` になる）。
//
// **投げない。** 取れなければ理由を `error` に入れ、どの範囲も取りきれていない結果を返す。

import { isUnsettledP2pQuake, parseP2pQuakeItem, parseP2pQuakeList, parseP2pTime } from './p2pQuake'
import type { P2pReferenceQuake } from './p2pQuake'

export const JMA_QUAKE_URL = 'https://api.p2pquake.net/v2/jma/quake'
/** 1 ページの件数（配信元の上限）。 */
export const JMA_QUAKE_PAGE_SIZE = 100
/** 2 本目からの間隔。10 リクエスト/分に余裕を見る（PWA の `JMA_QUAKE_HISTORY_REQUEST_INTERVAL_MS` と同じ）。 */
export const JMA_QUAKE_REQUEST_INTERVAL_MS = 6_500
/** ページの上限（自衛。配信元の定めではない）。9 日ぶんで実測 3〜4 ページ程度なので、桁を 1 つ余らせる。 */
export const JMA_QUAKE_MAX_PAGES_DEFAULT = 30
/**
 * 取った時刻の直前で、まだ載っていないかもしれない長さ。地震情報は発生から数分で出るが、
 * 各地の震度の報まで揃うには時間が掛かる。この幅の揺れは「取りきれた」に数えない。
 */
export const LIST_SETTLE_MS = 30 * 60_000
/**
 * 読めなかった地震情報の発生時刻から、この幅だけ後に始まった揺れまでは「取りきれた」と言わない
 * （その地震の揺れだったかもしれない）。遠い地震の S 波が届くまでの時間に余裕を見る。
 */
export const UNREADABLE_SHADOW_MS = 30 * 60_000

const JST_OFFSET_MS = 9 * 3_600_000
const DAY_MS = 24 * 3_600_000

/** 日本時間の yyyyMMdd。 */
function jstDate(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '')
}

/** その時刻を含む日本時間の日の 0 時。 */
function jstDayStart(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS
}

/** 期間の問い合わせ（`offset` を渡すと、そのページの URL）。 */
export function jmaQuakeUrls(fromMs: number, toMs: number): (offset: number) => string {
  const base = `${JMA_QUAKE_URL}?limit=${JMA_QUAKE_PAGE_SIZE}&order=1&since_date=${jstDate(fromMs)}&until_date=${jstDate(toMs)}`
  return (offset) => (offset > 0 ? `${base}&offset=${offset}` : base)
}

export interface QuakeHistoryResult {
  readonly quakes: readonly P2pReferenceQuake[]
  /** 地震情報なのに読めなかった報の数。 */
  readonly unreadable: number
  /** 投げたリクエストの数。 */
  readonly requests: number
  /** ページの上限で切ったか。 */
  readonly truncated: boolean
  /** 取れなかった理由（取れたなら null）。 */
  readonly error: string | null
  /** `[fromMs, toMs]` の地震情報を漏れなく持っているか。 */
  readonly covered: (fromMs: number, toMs: number) => boolean
}

export interface QuakeHistoryParams {
  readonly fromMs: number
  readonly toMs: number
  /** 1 ページ取る（応答の JSON を返す。失敗は投げてよい）。 */
  readonly fetchJson: (url: string) => Promise<unknown>
  readonly sleep: (ms: number) => Promise<void>
  /** 取った時刻（壁時計）。 */
  readonly now: () => number
  readonly maxPages?: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function originOfRaw(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  const q = (raw as { earthquake?: { time?: unknown } }).earthquake
  return typeof q?.time === 'string' ? parseP2pTime(q.time) : null
}

export async function fetchQuakeHistory(params: QuakeHistoryParams): Promise<QuakeHistoryResult> {
  const { fromMs, toMs, fetchJson, sleep, now } = params
  const maxPages = params.maxPages ?? JMA_QUAKE_MAX_PAGES_DEFAULT
  const urlOf = jmaQuakeUrls(fromMs, toMs)
  const raws: unknown[] = []
  let requests = 0
  let truncated = false
  let error: string | null = null
  /** 取れた中でいちばん新しい地震の時刻（ページの上限で切ったとき、そこまでを取りきれたとする）。 */
  let lastOriginMs = Number.NEGATIVE_INFINITY

  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      truncated = true
      break
    }
    if (page > 0) await sleep(JMA_QUAKE_REQUEST_INTERVAL_MS)
    let body: unknown
    try {
      requests++
      body = await fetchJson(urlOf(raws.length))
    } catch (e) {
      error = messageOf(e)
      break
    }
    if (!Array.isArray(body)) {
      error = '応答が配列ではない'
      break
    }
    for (const raw of body) {
      raws.push(raw)
      const at = originOfRaw(raw)
      if (at !== null && at > lastOriginMs) lastOriginMs = at
    }
    if (body.length < JMA_QUAKE_PAGE_SIZE) break
  }

  const { quakes, unreadable } = parseP2pQuakeList(raws)
  // **読めなかった地震情報の時刻を控える**（`parseP2pQuakeList` と同じ分け方。震源未確定の報は壊れていない）。
  // その地震と合ったかもしれない揺れを「地震ではなかった」と決めないため。時刻すら読めない報があれば、
  // どこが穴か分からないので、どの範囲も取りきれたと言わない。
  const unreadableAt: number[] = []
  let unreadableWithoutTime = false
  for (const raw of raws) {
    const code = typeof raw === 'object' && raw !== null ? (raw as { code?: unknown }).code : undefined
    if (code !== undefined && code !== 551) continue
    if (parseP2pQuakeItem(raw) !== null || isUnsettledP2pQuake(raw)) continue
    const at = originOfRaw(raw)
    if (at === null) unreadableWithoutTime = true
    else unreadableAt.push(at)
  }
  const fetchedAtMs = now()
  const coveredFrom = jstDayStart(fromMs)
  // 取りきれた範囲の終わり: 問い合わせた最後の日の終わり・まだ載っていない幅の手前・（切ったなら）取れた最後の地震。
  let coveredTo = Math.min(jstDayStart(toMs) + DAY_MS, fetchedAtMs - LIST_SETTLE_MS)
  if (truncated) coveredTo = Math.min(coveredTo, lastOriginMs)
  const covered =
    error !== null || unreadableWithoutTime
      ? () => false
      : (a: number, b: number): boolean =>
          a >= coveredFrom &&
          b <= coveredTo &&
          a <= b &&
          !unreadableAt.some((t) => t <= b && t + UNREADABLE_SHADOW_MS >= a)

  return { quakes, unreadable, requests, truncated, error, covered }
}
