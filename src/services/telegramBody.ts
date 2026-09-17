/**
 * DMDATA の電文本体（テキスト）を取る唯一の入口。
 *
 * **素の `fetch` で電文本体を取らないこと。** ここを通さない経路は控えに載らず、
 * 同じ `id` を何度も取り直す —— 配信元のリファレンスが名指しで避けるよう求めている形で、
 * 実際に利用量の指摘を受けた（→ [`docs/spec/data-sources-spec.md`](../../docs/spec/data-sources-spec.md)
 * §2「リクエスト数を抑える」）。
 *
 * **二進電文（推計震度分布図 IXAC41）も同じ入口を通る**（`fetchTelegramBytes`）。取り出し方だけを
 * 分けてある —— `res.text()` を通すと不正なバイトが U+FFFD へ潰れて元へ戻せないため。
 * **門と 429 の窓はテキスト版と共有する**（同じエンドポイント・同じレート枠なので、別々に持つと
 * 合算で上限を超える）。**永続の控えだけはバイト列版が持たない**（理由は
 * `fetchTelegramBytes` の説明）。
 *
 * 独立したファイルに置いているのは循環 import を作らないため（`dmdata.ts` と
 * `dmdataReplayLive.ts` の両方から使い、後者は前者に依存していない）。
 */
import { authHeader } from '../utils/dmdataApiKey'
import { readTelegramBody, writeTelegramBody } from '../utils/telegramBodyCache'
import {
  waitForDataApiSlot, dataApiGateWaiting, setDataApiGateIntervalForTest, resetDataApiGateForTest,
  rateLimitedUntil, noteRateLimited, noteRateLimitCleared,
} from './dmdataRequestGates'

/**
 * 電文本体の取得を直列化する門は `services/dmdataRequestGates.ts` が持つ。
 *
 * **アーカイブ本体（`/v1/archive/:id`）と枠を共有する。** 配信元のレート表が
 * `data.api.dmdata.jp/v1/:id` と `/v1/archive/:id` へ `rowspan` で 50req/5min を掛けており、
 * 「3 行それぞれ」とも「3 行の合計」とも読めるため、**合算として扱う**（詳しい理由は
 * `dmdataRequestGates.ts` の冒頭）。**控えから読めた分はここを通らない**（通信しないので待つ理由がない）。
 */

/** いま枠を待っている件数。初回起動の進み具合を検証で読む。 */
export function telegramGateWaiting(): number {
  return dataApiGateWaiting()
}

/**
 * テスト用。門の間隔を差し替える。
 *
 * **名前は互換のために残している**（3 つのテストファイルが呼んでいる）。実体は
 * `dmdataRequestGates.ts` の門で、**電文本体とアーカイブ本体の両方に効く**。
 */
export function setBodyGateIntervalForTest(ms: number): void {
  setDataApiGateIntervalForTest(ms)
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
  /**
   * 429 の窓が明けていないため**取りに行かなかった**場合、その窓が明ける時刻。
   * 取りに行った（または控えから読めた）なら `null`。
   *
   * **配信元から受けた 429 と区別する。** どちらも `status` は 429 だが、呼び出し側が
   * 利用者へ伝える内容が違う —— 受けた側は「配信元から断られた」で、こちらは
   * 「こちらの判断で待っている」。混ぜると**待てば取れるものが恒久的な喪失として**
   * 記録・画面に出る（→ `types/replay.ts` の `rateLimitedTelegrams`）。
   *
   * **フラグではなく時刻を返す。** 呼び出し側が「あと何秒」を記録に出せる
   * （アーカイブ本体の `RateLimitWindowError` と揃える）。
   */
  rateLimitedUntil: number | null
}

/**
 * **`rateLimited` を `failed` と分けている。** あちらは「投げたのに駄目だった」で、
 * こちらは「こちらの判断で投げなかった」。混ぜると `fetched + fromCache + failed` が
 * 実際の試行数と合わなくなり、この統計が読めなくなる（削減できたかの判断に使う）。
 */
const stats = { fromCache: 0, fetched: 0, failed: 0, coalesced: 0, rateLimited: 0 }

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
export function telegramBodyStats(): {
  fromCache: number; fetched: number; failed: number; coalesced: number; rateLimited: number
} {
  return { ...stats }
}

/** テスト用。数えた件数を空にする。 */
export function resetTelegramBodyStatsForTest(): void {
  stats.fromCache = 0
  stats.fetched = 0
  stats.failed = 0
  stats.coalesced = 0
  stats.rateLimited = 0
  inFlight.clear()
  resetDataApiGateForTest()
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
 *
 * **export しているのは、呼び出し側が `RateLimitWindowError` へ渡す id を作るため。**
 * あちらの第 1 引数は「窓を持っているリソースの id」で、アーカイブ側は
 * `archiveIdFromUrl` の結果を渡している。**電文側が URL を渡すと、同じ型に入る値の意味が
 * 経路で食い違う**（いまは `.id` を読む先が無いので実害は出ないが、診断へ出す処理を足した
 * 途端にずれる）。
 */
export function telegramIdFromUrl(url: string): string | null {
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
      return { xml: cached, status: null, fromCache: true, rateLimitedUntil: null }
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

/**
 * 429 の窓と門を通してから投げる。**テキスト版とバイト列版で共有する。**
 *
 * 別々に持つと、同じエンドポイント（`data.api.dmdata.jp/v1/:id`）に対して枠と窓が
 * 二重になり、合算で配信元の上限を超える。
 *
 * - **通信そのものの例外は捕まえない。** 呼び出し側（`dmdataReplayLive.ts` の
 *   `fetchLiveQuakeTelegrams`）が 1 件ごとに受けて**取りこぼしとして数えている**ので、
 *   ここで `null` へ潰すとその計上から漏れる —— しかも「取得できなかった」が
 *   「その電文は無かった」と見分けられなくなる。**例外も数えてから投げ直す。**
 * - HTTP のエラー（`!res.ok`）は `Response` のまま返し、呼び出し側が種別つきで記録する。
 * - **枠を待ってから投げる。** 呼び出し側は同時実行数を絞ってなお複数を並べてくるので、
 *   ここで直列化しないと配信元の上限をそのまま超える（→ `utils/requestGate.ts`）。
 * - **429 を受けたばかりの id は取りに行かない**（→ `services/dmdataRequestGates.ts`）。
 *   控えが効くのは成功した分だけなので、429 で落ちた電文は操作のたびに再要求される
 *   （「もっと見る」は範囲をまるごと問い合わせ直す）。配信元が指数バックオフを求めているのは
 *   この形に対してで、**門の 6 秒はバックオフではない**（失敗が続いても伸びない）。
 *   **門の枠を使う前に見る** —— 取りに行かないものに 6 秒の枠を消費させない。
 */
async function fetchThroughGate(
  apiKey: string, url: string, id: string | null, urgent: boolean,
): Promise<{ kind: 'rateLimited'; until: number } | { kind: 'response'; res: Response }> {
  const until = id ? rateLimitedUntil('body', id) : null
  if (until !== null) {
    stats.rateLimited++
    return { kind: 'rateLimited', until }
  }
  await waitForDataApiSlot({ urgent })
  let res: Response
  try {
    res = await fetch(url, { headers: { Authorization: authHeader(apiKey) } })
  } catch (e) {
    stats.failed++
    throw e
  }
  if (!res.ok) {
    stats.failed++
    // **429 だけは窓を置く。** 他の失敗（500 等）は次の操作で取り直してよい
    if (id && res.status === 429) noteRateLimited('body', id)
    return { kind: 'response', res }
  }
  // **成功したら窓と回数を捨てる。** 残すと、回復した id が長い窓を持ち続ける
  if (id) noteRateLimitCleared('body', id)
  return { kind: 'response', res }
}

/** 控えを見ずに取得して控える。 */
async function fetchFresh(
  apiKey: string, url: string, id: string | null, urgent: boolean,
): Promise<TelegramTextResult> {
  const out = await fetchThroughGate(apiKey, url, id, urgent)
  if (out.kind === 'rateLimited') {
    return { xml: null, status: 429, fromCache: false, rateLimitedUntil: out.until }
  }
  const { res } = out
  if (!res.ok) return { xml: null, status: res.status, fromCache: false, rateLimitedUntil: null }
  const xml = await res.text()
  stats.fetched++
  // 控えへの書き込みは待たない。**電文はもう手元にあるので、控えられなくても先へ進む**
  if (id) void writeTelegramBody(id, xml)
  return { xml, status: res.status, fromCache: false, rateLimitedUntil: null }
}

export interface TelegramBytesResult {
  /** 電文の本体。取得できなければ `null`。 */
  bytes: Uint8Array | null
  /** HTTP ステータス。**429 の窓で見送ったときも 429**（見分けるのは `rateLimitedUntil`）。 */
  status: number | null
  /** 見送った場合、窓が明ける時刻（テキスト版と同じ扱い）。取りに行ったなら `null`。 */
  rateLimitedUntil: number | null
}

/**
 * 電文本体をバイト列で取る（二進電文＝推計震度分布図 IXAC41 用）。
 *
 * **`res.text()` を通さない** —— 不正なバイトが U+FFFD へ潰れて元へ戻せない。
 *
 * **門と 429 の窓はテキスト版と共有する**（`fetchThroughGate`）。同じエンドポイント・同じ
 * レート枠なので、素の `fetch` で取ると門をすり抜けて瞬間のレートが上限を超える。
 * 実際にこの形になっていた（呼び出し側は最大 8 並列）。
 *
 * **永続の控えは持たない。** テキスト側の控え（`utils/telegramBodyCache.ts`）は文字列を扱う
 * ので、バイト列には別の入れ物が要る（`utils/archiveBodyCache.ts` と同じ形になる）。
 * **同じ id を繰り返し取らない役はセッション内の控えが担っている**（呼び出し側の
 * `binaryBodyCache`）。**ページを再読込すると取り直しになる**ので、そこが問題になれば足す。
 *
 * **`urgent` は受け取らない。** 二進電文は起動時の復元では取らない（ライブとリプレイだけ）。
 *
 * **同じ id への同時要求はまとめない。** テキスト側の `inFlight` は
 * `Promise<TelegramTextResult>` を持つため相乗りできず、呼び出し側が URL を鍵にした
 * `binaryBodyCache` で同じ役を果たしている。
 */
export async function fetchTelegramBytes(apiKey: string, url: string): Promise<TelegramBytesResult> {
  const id = telegramIdFromUrl(url)
  const out = await fetchThroughGate(apiKey, url, id, false)
  if (out.kind === 'rateLimited') return { bytes: null, status: 429, rateLimitedUntil: out.until }
  const { res } = out
  if (!res.ok) return { bytes: null, status: res.status, rateLimitedUntil: null }
  const bytes = new Uint8Array(await res.arrayBuffer())
  stats.fetched++
  return { bytes, status: res.status, rateLimitedUntil: null }
}
