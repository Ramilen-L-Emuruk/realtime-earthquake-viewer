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
import { createRateGate } from '../utils/requestGate'

/**
 * 電文本体（`data.api.dmdata.jp/v1/:id`）の取得間隔。上限の 50req/5min ＝ 6 秒に 1 件。
 *
 * **この値を下げないこと。** 下げれば制限に触れ、触れなくても配信元が求める「定常的に 2req/s 以下」
 * から外れる。初回起動が数分かかるのは承知のうえで、**控えが効く 2 回目以降は 1 件も通らない**。
 *
 * バーストを許す形（直近 5 分で 50 件まで、間隔は 500ms）も考えたが採らなかった。上限のうち
 * 「定常的に」の語をこちら側に都合よく読む必要があり、**既に配信元から利用量の指摘を受けている
 * 状況で際どい解釈に頼るのは筋が悪い**。どの読み方でも安全側へ倒す。
 */
const BODY_MIN_INTERVAL_MS = 6_000

/**
 * 電文本体の取得を直列化する門。**控えから読めた分はここを通らない**（通信しないので待つ理由がない）。
 */
let bodyGate = createRateGate(BODY_MIN_INTERVAL_MS)

/** いま枠を待っている件数。初回起動の進み具合を検証で読む。 */
export function telegramGateWaiting(): number {
  return bodyGate.waiting()
}

/**
 * テスト用。門の間隔を差し替える。
 *
 * **門が効いているかは `utils/requestGate.test.ts` が本物の間隔で確かめる。** ここで差し替えるのは、
 * 控えの振る舞い（上限で古い順に捨てる等）を確かめるテストが 600 件を順に取るためで、
 * 6 秒間隔のままだと 1 時間かかる。**本番の値を緩める口ではない。**
 */
export function setBodyGateIntervalForTest(ms: number): void {
  bodyGate = createRateGate(ms)
}

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
  bodyGate.resetForTest()
}

if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __telegramBodyStats?: () => unknown
    __telegramGateWaiting?: () => number
  }
  w.__telegramBodyStats = telegramBodyStats
  // 初回起動が「どこまで進んだか」は件数だけでは分からない（まだ枠を待っている分が見えない）
  w.__telegramGateWaiting = telegramGateWaiting
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
 *
 * `urgent` を渡すと、門で待っている通常の取得を追い越す（→ `utils/requestGate.ts`）。
 * **間隔そのものは変わらない。** 渡すのは「待たせると意味が薄れるもの」だけ —— いまは起動時に
 * 発表中の緊急地震速報を復元する経路だけが使う（履歴の後ろに並ぶと最悪 24 秒遅れて画面に出る）。
 * **履歴・補助情報・リプレイには渡さないこと**（全部が urgent なら優先度は意味を失う）。
 *
 * **同じ `id` が既に取得中のときは `urgent` が効かない。** 下記 `inFlight` のまとめは先行した
 * 取得の Promise をそのまま返すので、それが通常の要求として門に並んでいれば、後から来た
 * `urgent` もその待ちに乗る（門の追い越しには載らない）。**いまの呼び出し元では起きない** ——
 * urgent を渡すのは緊急地震速報（`VXSE45`）だけで、通常の履歴が取るのは地震情報
 * （`VXSE51/52/53/61`）と排他なため、同じ `id` が両方から要求されることがない。
 * **urgent を渡す経路を増やすときは、この排他が崩れていないかを確かめること** ——
 * 崩れても例外もログも出ず、優先度が黙って無効になる。
 */
export function fetchTelegramText(
  apiKey: string, url: string, opts?: { urgent?: boolean },
): Promise<TelegramTextResult> {
  const urgent = opts?.urgent ?? false
  const id = telegramIdFromUrl(url)
  // 鍵を作れない URL は控えも共有もしない（別の電文を同じ鍵で扱う危険を避ける）
  if (!id) return fetchFresh(apiKey, url, null, urgent)

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
    return fetchFresh(apiKey, url, id, urgent)
  })()
  inFlight.set(id, promise)
  // **成否によらず取り終わったら外す。** 成功なら次からは控えが応え、失敗なら取り直せる
  // （失敗した Promise を残すと、以後そのセッション中ずっと同じ失敗を返す）。
  // `catch` を足しておくのは、待ち手が居ない場合に unhandled rejection にしないため。
  void promise.catch(() => {}).then(() => { inFlight.delete(id) })
  return promise
}

/** 控えを見ずに取得して控える。 */
async function fetchFresh(
  apiKey: string, url: string, id: string | null, urgent: boolean,
): Promise<TelegramTextResult> {
  // **通信そのものの例外は捕まえない。** 呼び出し側（`dmdataReplayLive.ts` の
  // `fetchLiveQuakeTelegrams`）が 1 件ごとに受けて**取りこぼしとして数えている**ので、
  // ここで `null` へ潰すとその計上から漏れる —— しかも「取得できなかった」が
  // 「その電文は無かった」と見分けられなくなる。
  // HTTP のエラー（`!res.ok`）は値で返し、呼び出し側が種別つきで記録する。
  // **例外も数えてから投げ直す。** 数えないと `fetched + fromCache + failed` が実際の試行数と
  // 合わず、「思ったより減っている」と誤読する（この統計は削減できたかの判断に使う）。
  // **枠を待ってから投げる。** 呼び出し側は同時実行数を絞ってなお複数を並べてくるので、
  // ここで直列化しないと配信元の上限をそのまま超える（→ `utils/requestGate.ts`）。
  await bodyGate.wait({ urgent })
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
