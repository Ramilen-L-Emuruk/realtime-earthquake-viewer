/**
 * DMDATA の電文本体（テキスト）を取る唯一の入口。
 *
 * **素の `fetch` で電文本体を取らないこと。** ここを通さない経路は控えに載らず、
 * 同じ `id` を何度も取り直す —— 配信元のリファレンスが名指しで避けるよう求めている形で、
 * 実際に利用量の指摘を受けた（→ [`docs/spec/data-sources-spec.md`](../../docs/spec/data-sources-spec.md)
 * §2「リクエスト数を抑える」）。
 *
 * **二進電文（推計震度分布図 IXAC41）はここを通らない。** `res.text()` を通すと不正なバイトが
 * U+FFFD へ潰れて元へ戻せないため、取得も控えも別にしてある（`dmdataReplayLive.ts` の
 * `fetchBinaryBody`）。控えを付けるなら Blob で持つ必要があり、起動時には取らない電文なので
 * いまは対象外にしている。
 *
 * 独立したファイルに置いているのは循環 import を作らないため（`dmdata.ts` と
 * `dmdataReplayLive.ts` の両方から使い、後者は前者に依存していない）。
 */
import { authHeader } from '../utils/dmdataApiKey'
import { readTelegramBody, writeTelegramBody } from '../utils/telegramBodyCache'

export interface TelegramTextResult {
  /** 電文の XML。取得も控えも駄目だったときは `null`。 */
  xml: string | null
  /**
   * HTTP ステータス。**控えから読めたときは `null`**（通信していないため）。
   * 呼び出し側が `xml === null` のときの記録に使う。
   * 通信そのものが失敗した場合はここへ来ない —— 例外がそのまま呼び出し側へ伝わる。
   */
  status: number | null
  /** 控えから読めたか。取得を減らせているかの実測に使う。 */
  fromCache: boolean
}

const stats = { fromCache: 0, fetched: 0, failed: 0, coalesced: 0 }

/**
 * いま取得中の id → その取得。**同じ id への同時要求を 1 本にまとめる**。
 *
 * 控えは「取り終わってから」効くので、**同時に走った要求には間に合わない**。実測では
 * dev サーバーで起動 1 回の取得が 85 件ではなく 170 件になっていた —— React の
 * `StrictMode` が effect を 2 回走らせ、その 2 本がほぼ同時に同じ id を取りに行っていた
 * （片方の控えが書き終わる前にもう片方が読むため、どちらも控えを空振りする）。
 * 本番でも「もっと見る」と初回の履歴、リプレイと履歴のように、同じ電文を指す経路が
 * 重なりうる。
 */
const inFlight = new Map<string, Promise<TelegramTextResult>>()

/**
 * 控えから読めた件数と、実際に取得した件数。
 *
 * **画面には出さない。** 削減できているかを検証で確かめるための実測値
 * （ブラウザからは `window.__telegramBodyStats()` で読める）。
 */
export function telegramBodyStats(): { fromCache: number; fetched: number; failed: number; coalesced: number } {
  return { ...stats }
}

/** テスト用。数えた件数を空にする。 */
export function resetTelegramBodyStatsForTest(): void {
  stats.fromCache = 0
  stats.fetched = 0
  stats.failed = 0
  stats.coalesced = 0
  inFlight.clear()
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __telegramBodyStats?: () => unknown }).__telegramBodyStats = telegramBodyStats
}

/**
 * URL から電文 id を取り出す（`https://data.api.dmdata.jp/v1/{id}` の末尾）。
 *
 * **取り出せなければ控えを使わない。** 鍵が作れないまま控えると、別の電文を同じ鍵で
 * 上書きしうる。URL の形が変わったときは黙って素の取得へ落ちるのが安全。
 */
function telegramIdFromUrl(url: string): string | null {
  try {
    const id = new URL(url).pathname.split('/').filter(Boolean).pop()
    return id && id.length >= 8 ? id : null
  } catch {
    return null
  }
}

/**
 * 電文本体を取る。控えにあればそれを返し、無ければ取得して控える。
 *
 * **控えの失敗で取得を止めない。** IndexedDB が使えない環境（プライベートモード・容量超過）でも
 * 通常の取得で動く必要がある。
 */
export function fetchTelegramText(apiKey: string, url: string): Promise<TelegramTextResult> {
  const id = telegramIdFromUrl(url)
  // 鍵を作れない URL は控えも共有もしない（別の電文を同じ鍵で扱う危険を避ける）
  if (!id) return fetchFresh(apiKey, url, null)

  const pending = inFlight.get(id)
  if (pending) {
    stats.coalesced++
    return pending
  }

  const promise = (async () => {
    const cached = await readTelegramBody(id)
    if (cached !== null) {
      stats.fromCache++
      return { xml: cached, status: null, fromCache: true }
    }
    return fetchFresh(apiKey, url, id)
  })()
  inFlight.set(id, promise)
  // **成否によらず取り終わったら外す。** 成功なら次からは控えが応え、失敗なら取り直せる
  // （失敗した Promise を残すと、以後そのセッション中ずっと同じ失敗を返す）。
  // `catch` を足しておくのは、待ち手が居ない場合に unhandled rejection にしないため。
  void promise.catch(() => {}).then(() => { inFlight.delete(id) })
  return promise
}

/** 控えを見ずに取得して控える。 */
async function fetchFresh(apiKey: string, url: string, id: string | null): Promise<TelegramTextResult> {
  // **通信そのものの例外は捕まえない。** 呼び出し側の `Promise.allSettled` が
  // 「何件が例外で終わったか」をまとめて記録しており（`warnRejectedTelegrams`）、
  // ここで `null` へ潰すとそのまとめが出なくなる —— 1 件ずつの警告は残るが、
  // **ネットワーク断で全件落ちたときに件数が分からない**。
  // HTTP のエラー（`!res.ok`）は旧来どおり値で返し、呼び出し側が種別つきで記録する。
  // **例外も数えてから投げ直す。** 数えないと `fetched + fromCache + failed` が実際の試行数と
  // 合わず、「思ったより減っている」と誤読する（この統計は削減できたかの判断に使う）。
  let res: Response
  try {
    res = await fetch(url, { headers: { Authorization: authHeader(apiKey) } })
  } catch (e) {
    stats.failed++
    throw e
  }
  if (!res.ok) {
    stats.failed++
    return { xml: null, status: res.status, fromCache: false }
  }
  const xml = await res.text()
  stats.fetched++
  // 控えへの書き込みは待たない。**電文はもう手元にあるので、控えられなくても先へ進む**
  if (id) void writeTelegramBody(id, xml)
  return { xml, status: res.status, fromCache: false }
}
