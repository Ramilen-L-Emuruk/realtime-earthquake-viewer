// リプレイの「当日経路」。日次アーカイブがまだ無い日を、保存期間内の電文を引ける API で埋める。
//
// なぜ要るか: DMDATA の日次アーカイブは JST 日単位で、当日ぶんは翌日にならないと生成されない。
// アーカイブだけを見ていると、今日を指定したリプレイは電文 0 件になり、前日をまたぐ指定では
// 「前日側だけ再生されて今日側が静まり返る」という中途半端な状態になる。
//
// 取得元は種別で分かれる。
//   - 地震・津波・長周期: /v2/telegram に formatMode=json を付ける（アーカイブと同じ JSON 本体が返る）
//   - 南海トラフ・後発地震: /v2/telegram（XML 版。これらは XML パーサでしか読めない）
//   - EEW: /v2/gd/eew（イベント一覧）→ /v2/gd/eew/{eventId}（全報）→ 各報の電文 URL
//
// EEW だけ経路が違うのは、/v2/telegram が EEW を保持していないため（type=VXSE45 を指定しても
// 0 件が返る。アーカイブには入っている）。/v2/gd/eew の一覧は最終報しか返さないので、
// 報の推移を再現するにはイベント個別の API まで辿る必要がある。
//
// 日付の基準が API ごとに違う点に注意（取り違えると丸一日ぶんずれる）。
//   - アーカイブの date は **JST 日**
//   - /v2/telegram と /v2/gd/eew の datetime=A~B は **UTC の半開区間 [A, B)**（A~A は 0 件）
//
// アーカイブとの同等性は実データで確認済み。詳細は docs/spec/settings-pwa-spec.md §6。
import { log } from '../utils/logger'
import { authHeader } from '../utils/dmdataApiKey'
import type { JMAQuake } from '../types/earthquake'
import type { ReplayEntry } from '../types/replay'
import {
  HANDLED_TYPES, QUAKE_TYPES, XML_ONLY_TYPES,
  buildJsonPayload, buildXmlPayload,
} from './dmdataTelegramPayload'

const API_BASE = 'https://api.dmdata.jp/v2'
/** 一覧 API の 1 ページあたりの取得件数（API の上限）。 */
const LIST_LIMIT = 100
/**
 * 電文本体の同時取得数。
 *
 * アーカイブ経路は 1 日ぶんを 1 ファイルで落とせるが、こちらは電文 1 通につき 1 リクエストになる。
 * 揺れの多い日は EEW だけで数百通に達するため、無制限に投げず一定数で流す。
 */
const BODY_CONCURRENCY = 8
/**
 * EEW イベントの詳細を引くかどうかを一覧の時刻で判定するときの余裕。
 *
 * 一覧が持つのは「最終報の時刻」と「震源時刻」で、初報の時刻は入っていない。震源時刻は
 * 続報で数秒〜十数秒ずれるため、境界ちょうどで切ると窓の端のイベントを落としかねない。
 */
const EEW_EVENT_MARGIN_MS = 3 * 60_000

const JST_OFFSET_MS = 9 * 3600_000
const DAY_MS = 86_400_000
/** `enumerateJstDates` が一度に返す日数の上限（暴走防止。実運用の指定は数日以内）。 */
const MAX_ENUMERATED_DAYS = 60

/** 電文一覧 API / gd-eew の telegrams が返す 1 件分。 */
interface TelegramListItem {
  id: string
  /** JSON 版のときだけ入り、元の XML 版電文の id を指す。 */
  originalId?: string
  head: { type: string; time: string; test: boolean }
  /** ミリ秒精度の受信時刻。アーカイブ経路がファイル名から取っている値と同じもの。 */
  receivedTime: string
  url: string
}

interface EewListItem {
  eventId: string
  /** 最終報の発表時刻。 */
  dateTime: string
  earthquake?: { originTime?: string }
}

// 電文本体のキャッシュ（URL → 本文）。URL は電文 id に対応するため中身は不変。
//
// 一覧の応答はキャッシュしない。再生が進むと同じ UTC 日を何度も引くことになるが、
// その間にも新しい電文が届くため、キャッシュすると後から届いた電文が永久に見えなくなる。
const bodyCache = new Map<string, Promise<string>>()

export function clearLiveReplayCache(): void {
  bodyCache.clear()
}

/** 日時を JST 日付文字列（YYYY-MM-DD）に変換する。 */
export function toJstDateStr(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 期間 [from, to) が跨る JST 日付を古い順に列挙する。
 *
 * @param from 期間の始まり
 * @param to 期間の終わり（この時刻は含まない）
 * @returns JST 日付文字列の配列。`to <= from` なら空
 */
export function enumerateJstDates(from: Date, to: Date): string[] {
  if (!(to.getTime() > from.getTime())) return []
  const first = Math.floor((from.getTime() + JST_OFFSET_MS) / DAY_MS)
  const last = Math.floor((to.getTime() - 1 + JST_OFFSET_MS) / DAY_MS)
  // 上限を超えたら黙って切らずに投げる。切ると、落とした日ぶんの電文が取りこぼしとして
  // 数えられないまま消える。現在の呼び出し元はいずれも数日以内の期間しか渡さないため、
  // ここに達すること自体が呼び出し側の異常を意味する。
  if (last - first + 1 > MAX_ENUMERATED_DAYS) {
    throw new Error(`当日経路の対象期間が広すぎます（${last - first + 1} 日 / 上限 ${MAX_ENUMERATED_DAYS} 日）: ${from.toISOString()}〜${to.toISOString()}`)
  }
  const days: string[] = []
  for (let i = first; i <= last; i++) {
    days.push(new Date(i * DAY_MS).toISOString().slice(0, 10))
  }
  return days
}

/**
 * アーカイブが存在しない JST 日（＝当日経路で埋める日）を決める。
 *
 * アーカイブ経路と当日経路の担当日はここで排他になる。同じ日を両方が読むと同一電文が
 * 二重に再生されるため、判定はこの 1 箇所に集約する。
 *
 * @param from 取得したい期間の始まり
 * @param to 取得したい期間の終わり（この時刻は含まない）
 * @param archiveDates アーカイブ一覧が返した date（JST 日付文字列）
 * @returns 当日経路が担当する JST 日付の配列
 */
export function resolveLiveDates(from: Date, to: Date, archiveDates: Iterable<string>): string[] {
  const covered = new Set(archiveDates)
  return enumerateJstDates(from, to).filter(d => !covered.has(d))
}

/**
 * 対象の JST 日をすべて覆う UTC 日付範囲を作る（`datetime=A~B` 用）。
 *
 * JST 日 D は UTC の [D-1T15:00Z, DT15:00Z) にあたる。`datetime` は UTC の半開区間
 * [A T00:00Z, B T00:00Z) なので、最古の D の前日から最新の D の翌日までを指定すれば覆える。
 */
function utcRangeForJstDates(days: string[]): { from: string; to: string } {
  const sorted = [...days].sort()
  const shift = (day: string, deltaDays: number) =>
    new Date(Date.parse(`${day}T00:00:00Z`) + deltaDays * DAY_MS).toISOString().slice(0, 10)
  return { from: shift(sorted[0], -1), to: shift(sorted[sorted.length - 1], 1) }
}

/**
 * 同時実行数を絞って写像する。
 *
 * `fn` が投げても残りの要素は最後まで処理し、すべて終えてから最初の例外を投げ直す。
 * 途中で打ち切ると 2 つのことが黙って起きる。
 *   - そのワーカーが拾うはずだった要素が未処理のまま残る（取りこぼしとして数えられない）
 *   - `Promise.all` の即時 reject で呼び出し元が先へ進んだあとも、他のワーカーは走り続け、
 *     呼び出し元が読み終えた共有配列へ書き込みを続ける
 */
async function mapWithLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const errors: unknown[] = []
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try {
        await fn(items[i])
      } catch (e) {
        errors.push(e)
      }
    }
  })
  await Promise.all(workers)
  if (errors.length > 0) {
    if (errors.length > 1) log.error(`[replay] 並列処理で ${errors.length} 件の例外が発生した（最初の 1 件を投げ直す）`, errors)
    throw errors[0]
  }
}

async function getJson<T>(url: string, apiKey: string, what: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: authHeader(apiKey) } })
  if (!res.ok) throw new Error(`${what} failed: ${res.status}`)
  const json = (await res.json()) as { status?: string } & T
  if (json.status !== 'ok') throw new Error(`${what} error`)
  return json
}

/** 電文本体を取得する（URL 単位でキャッシュ）。 */
function fetchBody(url: string, apiKey: string): Promise<string> {
  const cached = bodyCache.get(url)
  if (cached) return cached
  const promise = (async () => {
    const res = await fetch(url, { headers: { Authorization: authHeader(apiKey) } })
    if (!res.ok) throw new Error(`Telegram body fetch failed: ${res.status}`)
    return res.text()
  })()
  bodyCache.set(url, promise)
  // 失敗した Promise を残すと、以後そのセッション中は同じ URL が常にキャッシュ済みの失敗を返し、
  // ネットワークが復旧しても再取得されない（アーカイブのキャッシュと同じ理由）。
  // この catch はキャッシュ掃除専用で、エラー自体は返した promise 経由で呼び出し元へ伝わる。
  promise.catch(() => bodyCache.delete(url))
  return promise
}

/**
 * 電文一覧を全ページ取得する。
 *
 * @param jsonMode true なら JSON 版（`formatMode=json`）、false なら XML 版を返させる
 */
async function listTelegrams(
  apiKey: string,
  utcFrom: string,
  utcTo: string,
  jsonMode: boolean,
): Promise<TelegramListItem[]> {
  const items: TelegramListItem[] = []
  let cursorToken: string | undefined
  for (;;) {
    const params = new URLSearchParams({ datetime: `${utcFrom}~${utcTo}`, limit: String(LIST_LIMIT) })
    if (jsonMode) params.set('formatMode', 'json')
    if (cursorToken) params.set('cursorToken', cursorToken)
    const json = await getJson<{ items?: TelegramListItem[]; nextToken?: string }>(
      `${API_BASE}/telegram?${params.toString()}`, apiKey, 'Telegram list',
    )
    items.push(...(json.items ?? []))
    if (!json.nextToken) break
    cursorToken = json.nextToken
  }
  return items
}

/**
 * 一覧の 1 件をどう扱うかの判定。
 *
 * `exclude`（対象外）と `malformed`（時刻が壊れていて扱えない）を分けるのは、後者が
 * **取りこぼし**だから。アーカイブ経路も同じ状況を取りこぼしとして数えており、ここだけ
 * 対象外に混ぜると UI の取りこぼし通知に出ず「静かな時間帯だった」と区別が付かなくなる。
 */
type TelegramVerdict = 'include' | 'exclude' | 'malformed'

/**
 * 一覧の 1 件を取り込むべきか判定する。
 *
 * @param jsonMode その一覧が JSON 版を返す設定で引かれたか
 * @param days 当日経路が担当する JST 日付
 */
function classifyTelegram(
  item: TelegramListItem,
  jsonMode: boolean,
  fromTime: Date,
  toTime: Date,
  days: ReadonlySet<string>,
): TelegramVerdict {
  if (!item?.head || item.head.test) return 'exclude'
  const headType = item.head.type
  if (!HANDLED_TYPES.has(headType)) return 'exclude'
  // XML パーサしか無い種別は XML 版（originalId 無し）を、それ以外は JSON 版（originalId 有り）を拾う。
  // 同じ電文が両方の版で一覧に載るため、ここで版を選ばないと二重に取り込む。
  const wantsXml = XML_ONLY_TYPES.has(headType)
  if (wantsXml === jsonMode) return 'exclude'
  if (wantsXml ? Boolean(item.originalId) : !item.originalId) return 'exclude'
  // 担当日の判定は受信時刻で行う（アーカイブが日をまとめる基準と同じ）。
  const received = new Date(item.receivedTime)
  if (Number.isNaN(received.getTime())) {
    log.warn(`[replay] receivedTime が不正な電文をスキップ id=${item.id} time=${String(item.receivedTime)}`)
    return 'malformed'
  }
  if (!days.has(toJstDateStr(received))) return 'exclude'
  // 窓の判定は head.time で行う（アーカイブ経路と揃える。ここを受信時刻に変えると、
  // 同じ電文が取得元によって入ったり入らなかったりする）。
  const headTime = new Date(typeof item.head.time === 'string' ? item.head.time : NaN)
  if (Number.isNaN(headTime.getTime())) {
    log.warn(`[replay] head.time が不正な電文をスキップ id=${item.id} time=${String(item.head.time)}`)
    return 'malformed'
  }
  return headTime >= fromTime && headTime < toTime ? 'include' : 'exclude'
}

/** EEW の全報を電文一覧の形で集める。 */
async function listEewTelegrams(
  apiKey: string,
  utcFrom: string,
  utcTo: string,
  fromTime: Date,
  toTime: Date,
): Promise<{ items: TelegramListItem[]; failedSources: string[] }> {
  const events: EewListItem[] = []
  let cursorToken: string | undefined
  for (;;) {
    const params = new URLSearchParams({ datetime: `${utcFrom}~${utcTo}`, limit: String(LIST_LIMIT) })
    if (cursorToken) params.set('cursorToken', cursorToken)
    const json = await getJson<{ items?: EewListItem[]; nextToken?: string }>(
      `${API_BASE}/gd/eew?${params.toString()}`, apiKey, 'EEW list',
    )
    events.push(...(json.items ?? []))
    if (!json.nextToken) break
    cursorToken = json.nextToken
  }

  // 詳細（全報）はイベント 1 件につき 1 リクエストかかる。窓に一報も掛からないイベントは
  // 一覧の時刻だけで落とせる。最終報が窓より前なら全報が窓より前、震源時刻が窓より後なら
  // 全報が窓より後（報は震源時刻より前には出ない）。
  const targets = events.filter((ev) => {
    const last = Date.parse(ev.dateTime)
    if (Number.isFinite(last) && last < fromTime.getTime() - EEW_EVENT_MARGIN_MS) return false
    const origin = Date.parse(ev.earthquake?.originTime ?? '')
    if (Number.isFinite(origin) && origin > toTime.getTime() + EEW_EVENT_MARGIN_MS) return false
    return true
  })

  const failedSources: string[] = []
  const items: TelegramListItem[] = []
  await mapWithLimit(targets, BODY_CONCURRENCY, async (ev) => {
    try {
      const json = await getJson<{ items?: Array<{ telegrams?: TelegramListItem[] }> }>(
        `${API_BASE}/gd/eew/${encodeURIComponent(ev.eventId)}`, apiKey, 'EEW detail',
      )
      for (const rep of json.items ?? []) {
        for (const tg of rep.telegrams ?? []) items.push(tg)
      }
    } catch (e) {
      // 1 イベントの詳細が引けなくても他のイベントは活かす。失ったのは「そのイベントの全報」で
      // 報数は分からないため、電文の件数ではなく**取得元**として数える（電文 1 件として数えると、
      // 数十報のイベントを失っても UI には「1 件」としか出ず実態より軽く見える）。
      log.error(`[replay] EEW の詳細取得に失敗したためスキップ eventId=${ev.eventId}`, e)
      failedSources.push(`eew:${ev.eventId}`)
    }
  })
  return { items, failedSources }
}

export interface LiveReplayResult {
  entries: ReplayEntry[]
  /** 取り込めなかった電文の数。 */
  skipped: number
  /**
   * 読めなかった取得元の識別子。
   *
   * 引けなかった一覧（`live-telegram:<日>` / `live-telegram-xml:<日>` / `live-eew:<日>`）と、
   * 全報を引けなかった EEW イベント（`eew:<eventId>`）。
   *
   * 「失ったのが何通か分からない」損失を電文の件数に混ぜないための枠。呼び出し元は
   * アーカイブの失敗と同じ集合へ積む。
   */
  failedSources: string[]
}

/**
 * アーカイブが無い日の電文を集めて再生用エントリにする。
 *
 * @param apiKey DMDATA の APIキー
 * @param fromTime 取得したい期間の始まり
 * @param toTime 取得したい期間の終わり（この時刻は含まない）
 * @param days 当日経路が担当する JST 日付（`resolveLiveDates` の結果）
 * @returns 再生用エントリ・取りこぼし件数・読めなかった取得元
 * @throws 3 本の一覧をすべて引けなかった場合（その日ぶんが 1 通も取れていない状態）。
 *   一部だけ引けなかったときは投げず、引けた分を返して失敗を `failedSources` に記録する
 */
export async function fetchLiveReplayEntries(
  apiKey: string,
  fromTime: Date,
  toTime: Date,
  days: string[],
): Promise<LiveReplayResult> {
  if (days.length === 0) return { entries: [], skipped: 0, failedSources: [] }
  const daySet = new Set(days)
  const { from: utcFrom, to: utcTo } = utcRangeForJstDates(days)

  // 3 本の一覧は互いに隔離する。1 本の一時障害で他の 2 本の成果まで捨てると、
  // 「EEW の一覧がこけただけで今日の地震も津波も出ない」ことになる。しかも取得元が
  // 当日経路 1 本しか無い窓（本編の 1 時間）では、それが全滅と見なされて例外になり、
  // 地震電文が取れていたのに再生ごと止まる。
  const settled = await Promise.allSettled([
    listTelegrams(apiKey, utcFrom, utcTo, true),
    listTelegrams(apiKey, utcFrom, utcTo, false),
    listEewTelegrams(apiKey, utcFrom, utcTo, fromTime, toTime),
  ])
  const dayLabel = days.join(',')
  const listFailures: string[] = []
  // 失敗した一覧の本数。全滅（＝その日ぶんが 1 通も取れていない）の判定に使う。
  // 識別子の件数と分けるのは、識別子を日ごとに 1 本ずつ積むため。
  let failedListCount = 0
  function take<T>(result: PromiseSettledResult<T>, label: string, fallback: T): T {
    if (result.status === 'fulfilled') return result.value
    log.error(`[replay] ${label} の一覧取得に失敗したためスキップ 日=${dayLabel}`, result.reason)
    failedListCount++
    // 識別子は日ごとに分ける。まとめて 1 本にすると、日の組み合わせが違う取得
    //（本編・初期状態・先読み）で同じ失敗が別物として数えられ、識別子で数える意味が消える。
    for (const day of days) listFailures.push(`${label}:${day}`)
    return fallback
  }
  const jsonList = take(settled[0], 'live-telegram', [] as TelegramListItem[])
  const xmlList = take(settled[1], 'live-telegram-xml', [] as TelegramListItem[])
  const eew = take(settled[2], 'live-eew', { items: [] as TelegramListItem[], failedSources: [] as string[] })
  // 3 本とも引けなければ、その日ぶんは 1 通も取れていない。呼び出し元が「その日の取得元が
  // 読めなかった」として扱えるよう投げる（部分的に取れた場合と区別が付かなくなるため）。
  if (failedListCount === settled.length) {
    throw new Error(`Live fetch failed: 当日経路の一覧をすべて取得できませんでした（日=${dayLabel}）`)
  }

  let skipped = 0
  // EEW は /v2/gd/eew から来るが、返る 1 件分の形は電文一覧と同じ（JSON 版）なので同じ判定に掛ける。
  const targets: Array<{ item: TelegramListItem; xml: boolean }> = []
  for (const cand of [
    ...jsonList.map(item => ({ item, xml: false })),
    ...eew.items.map(item => ({ item, xml: false })),
    ...xmlList.map(item => ({ item, xml: true })),
  ]) {
    const verdict = classifyTelegram(cand.item, !cand.xml, fromTime, toTime, daySet)
    if (verdict === 'malformed') skipped++
    else if (verdict === 'include') targets.push(cand)
  }

  const entries: ReplayEntry[] = []
  await mapWithLimit(targets, BODY_CONCURRENCY, async ({ item, xml }) => {
    const headType = item.head.type
    try {
      const text = await fetchBody(item.url, apiKey)
      const payload = xml
        ? buildXmlPayload(headType, text)
        : buildJsonPayload(headType, JSON.parse(text) as Record<string, unknown>)
      if (!payload) {
        log.warn(`[replay] 電文のパースに失敗しスキップ id=${item.id} type=${headType}`)
        skipped++
        return
      }
      // 受信時刻はミリ秒精度。アーカイブ経路がファイル名の 17 桁から取っている値と同じもので、
      // 発表時刻（分単位）より細かいため、報が連続する EEW でも順序と間隔が保たれる。
      entries.push({ payload, replayTime: new Date(item.receivedTime) })
    } catch (e) {
      // 1 通の失敗（取得エラー・JSON 破損・パーサ内の例外）で全体を落とさない。
      log.error(`[replay] 電文の取り込みに失敗しスキップ id=${item.id} type=${headType}`, e)
      skipped++
    }
  })

  const failedSources = [...listFailures, ...eew.failedSources]
  log.info(`[replay] アーカイブ未生成の日を当日経路で補完 日=${dayLabel} 電文=${entries.length} 取りこぼし=${skipped} 読めなかった取得元=${failedSources.length}`)
  return { entries, skipped, failedSources }
}

/**
 * アーカイブが無い日の地震電文を集める（地震カードの履歴復元用）。
 *
 * 日単位で呼ぶ。履歴の打ち切りが日単位のため（日の途中で切ると同一イベントの続報が分断され、
 * 震度速報だけのカードが残りうる）、複数日をまとめて取ると打ち切りの判断ができない。
 *
 * @param apiKey DMDATA の APIキー
 * @param day 対象の JST 日付（YYYY-MM-DD）
 * @param before この時刻より後に発表された電文は採らない（＝再生開始時刻）
 * @returns 統合前の生の地震電文と取りこぼし件数
 * @throws 一覧 API が失敗した場合
 */
export async function fetchLiveQuakeTelegrams(
  apiKey: string,
  day: string,
  before: Date,
): Promise<{ quakes: JMAQuake[]; skipped: number }> {
  const daySet = new Set([day])
  const { from: utcFrom, to: utcTo } = utcRangeForJstDates([day])
  // 下限は日の始まりより 1 日ぶん手前に置く。担当日の切り出しは `daySet`（受信時刻の JST 日）が
  // 行うため、ここでの下限は「日をまたいで受信された電文」を落とさないための余裕でよい。
  //
  // 日の始まりちょうどに置くと、**発表が前日の深夜・受信が日付をまたいだ電文**が両側から漏れる。
  // 前日ぶんの呼び出しでは受信日が違うので弾かれ、当日ぶんの呼び出しでは発表が下限より前だと
  // 弾かれる（前日・当日がともにアーカイブ未生成のときに起きる）。
  const windowFrom = new Date(Date.parse(`${day}T00:00:00Z`) - JST_OFFSET_MS - DAY_MS)
  // アーカイブ経路の履歴復元は `entryTime > before` を捨てる（`before` ちょうどは残す）。
  // 窓判定は上限を含まないため、1ms 足して同じ範囲にする。
  const until = new Date(before.getTime() + 1)

  const list = await listTelegrams(apiKey, utcFrom, utcTo, true)
  let skipped = 0
  const targets: TelegramListItem[] = []
  for (const item of list) {
    if (!QUAKE_TYPES.has(item.head?.type)) continue
    const verdict = classifyTelegram(item, true, windowFrom, until, daySet)
    if (verdict === 'malformed') skipped++
    else if (verdict === 'include') targets.push(item)
  }

  const quakes: JMAQuake[] = []
  await mapWithLimit(targets, BODY_CONCURRENCY, async (item) => {
    try {
      const data = JSON.parse(await fetchBody(item.url, apiKey)) as Record<string, unknown>
      const payload = buildJsonPayload(item.head.type, data)
      if (payload?.kind !== 'event' || payload.event.kind !== 'quake') {
        log.warn(`[replay] 履歴用電文のパースに失敗しスキップ id=${item.id} type=${item.head.type}`)
        skipped++
        return
      }
      quakes.push(payload.event)
    } catch (e) {
      log.error(`[replay] 履歴用電文の取り込みに失敗しスキップ id=${item.id} type=${item.head.type}`, e)
      skipped++
    }
  })
  return { quakes, skipped }
}
