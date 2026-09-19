/**
 * DMDATA への取得が配信元の上限に触れないようにする門。**ホストごとに枠を分けている。**
 *
 * | ホスト | 何を取るか | 守る上限 |
 * |---|---|---|
 * | `data.api.dmdata.jp` | 電文本体・アーカイブ本体 | 50req/5min ＋ 2000req/10min |
 * | `api.dmdata.jp` | 一覧・目録・EEW の詳細 | 2000req/10min |
 *
 * **これは配信元の表をそのまま写したもの**（[API v2 リファレンス](https://dmdata.jp/docs/reference/api/v2/)
 * 「レートリミット」）。**上限に達するまでは 1 件も待たせない** —— 配信元が定めているのは
 * 窓ごとの上限であって配り方ではないので、間隔を空ける理由がない（→ `utils/requestGate.ts`）。
 *
 * **枠を 1 つにまとめない。** 2000req/10min は**ドメインと IP の組み合わせごと**に掛かるので、
 * 別ドメインの `api.dmdata.jp` と `data.api.dmdata.jp` はそれぞれ 2000 を持つ。まとめると
 * 実際より厳しく数えることになる。
 *
 * ---
 *
 * ## `data.api.dmdata.jp` の枠
 *
 * **電文本体（`/v1/:id`）とアーカイブ本体（`/v1/archive/:id`）が同じ枠を共有する。**
 *
 * 配信元のレート表は、3 つの URL に `rowspan` で 50req/5min を掛けている ——
 * `data.api.dmdata.jp/v1/:id`・`jmafiledata.api.dmdata.jp/v1/:id`・
 * `data.api.dmdata.jp/v1/archive/:id`。**「3 行それぞれ」とも「3 行の合計」とも読める**
 * （HTML の `rowspan=3` を実際に確かめたが、表の書き方からは決まらない）。
 *
 * **合算として扱う。** アプリは `jmafiledata` を使わないので、実際に共有するのは電文本体と
 * アーカイブ本体の 2 つ。どちらの読み方でも上限に触れない側へ倒す。
 *
 * **独立したファイルに置いているのは、門の名前を取得対象に縛らないため。** 元は
 * `telegramBody.ts` の中にあり `bodyGate` という名前だったので、アーカイブ本体から
 * 使うと名前が実態と食い違った。
 */
import { createRateGate, type RateLimitWindow } from '../utils/requestGate'
import { log } from '../utils/logger'

/**
 * `data.api.dmdata.jp` が守る上限。
 *
 * **配信元の表と 1 対 1。勝手に足したり削ったりしないこと。**
 * 50req/5min は電文本体とアーカイブ本体の合算として扱う（このファイルの冒頭）。
 *
 * **均等割りに戻さないこと。** 5 分あたりの総量はどちらの方式でも 50 件が上限で、
 * **配信元にかかる量は変わらない**のに、均等割りはまとまった取得を「本数 × 6 秒」
 * そのまま待たせる（起動時の履歴で約 42 秒・リプレイの開始で約 96 秒かかっていた）。
 */
const DATA_API_LIMITS: readonly RateLimitWindow[] = [
  { windowMs: 5 * 60_000, max: 50 },
  { windowMs: 10 * 60_000, max: 2000 },
]

/**
 * `api.dmdata.jp` が守る上限。
 *
 * **このホストに固有の上限は無い**（パラメータ系の 20req/2min を除くが、そこは使っていない）。
 * 掛かるのはドメイン×IP の 2000req/10min だけ。
 *
 * **実運用では届かない**（一覧は 1 回の操作で数件しか出ない）。置いているのは、範囲指定が
 * 効かなくなったときの歯止め —— ページを辿るループの上限（`LIST_MAX_PAGES` ほか）と同じ役目で、
 * こちらは件数ではなくレートの側から押さえる。
 */
const API_LIMITS: readonly RateLimitWindow[] = [
  { windowMs: 10 * 60_000, max: 2000 },
]

let gate = createRateGate(DATA_API_LIMITS)

/**
 * `data.api.dmdata.jp` の枠が空くまで待つ。**上限に達していなければ待たない。**
 *
 * `urgent` を渡すと、待っている通常の取得を追い越す。**枠そのものは増えない。**
 * 渡すのは「待たせると意味が薄れるもの」だけ —— いまは起動時に発表中の緊急地震速報を
 * 復元する経路だけが使う。
 * **履歴・補助情報・リプレイ・アーカイブ本体には渡さないこと**（全部が urgent なら
 * 優先度は意味を失う）。
 */
export function waitForDataApiSlot(opts?: { urgent?: boolean }): Promise<void> {
  return gate.wait(opts)
}

/** いま枠を待っている件数。初回起動の進み具合を検証で読む。 */
export function dataApiGateWaiting(): number {
  return gate.waiting()
}

/**
 * テスト用。門の制限を差し替える。
 *
 * **`ms` は「その間隔で 1 件」という制限に変換する**（`{ windowMs: ms, max: 1 }`）——
 * 窓ごとの上限という一般形で固定間隔も表せるため、間隔を渡していた既存のテストが
 * そのまま通る。`0` 以下は「制限なし」。
 *
 * **門が効いているかは `utils/requestGate.test.ts` が本物の制限で確かめる。** ここで
 * 差し替えるのは、控えの振る舞い（上限で古い順に捨てる等）を確かめるテストのため。
 * **本番の値を緩める口ではない。**
 */
export function setDataApiGateIntervalForTest(ms: number): void {
  gate = createRateGate(ms > 0 ? [{ windowMs: ms, max: 1 }] : [])
}

/**
 * テスト用。待っている全員を通して門を初期化する。
 *
 * **制限は変えない**（差し替えたいなら `setDataApiGateIntervalForTest`）。テストの
 * あいだに残った待ち行列が次のテストへ持ち越されるのを防ぐためのもの。
 */
export function resetDataApiGateForTest(): void {
  gate.resetForTest()
}

let apiGate = createRateGate(API_LIMITS)

/**
 * `api.dmdata.jp` の枠が空くまで待つ。**実運用では待たない**（上の `API_LIMITS`）。
 *
 * `urgent` を渡すと、待っている通常の要求を追い越す。渡すのは **WebSocket の開始と枠の解放**
 * だけ —— あれは電文の受信そのものの起点で、一覧や目録の待ち行列の後ろに回すと EEW の
 * 受信開始が遅れる。
 */
export function waitForApiSlot(opts?: { urgent?: boolean }): Promise<void> {
  return apiGate.wait(opts)
}

/** テスト用。`api.dmdata.jp` の門の制限を差し替える（変換の仕方は `setDataApiGateIntervalForTest`）。 */
export function setApiGateIntervalForTest(ms: number): void {
  apiGate = createRateGate(ms > 0 ? [{ windowMs: ms, max: 1 }] : [])
}

/** テスト用。`api.dmdata.jp` の門の待ち行列を空にする。 */
export function resetApiGateForTest(): void {
  apiGate.resetForTest()
}

/**
 * いずれかの門が上限で取得を待たせているなら、次の枠が空く時刻。待ちが無ければ `null`。
 *
 * **画面の「取得制限中」はこれを読む。** 2 つの門を 1 つの答えにまとめるのは、利用者に
 * とってはどちらのホストで待っているかに意味が無いため。両方が待たせているときは
 * **遅いほうを返す** —— 早いほうを返すと、その時刻を過ぎても表示が消えない。
 */
export function dmdataThrottledUntil(): number | null {
  const a = gate.throttledUntil()
  const b = apiGate.throttledUntil()
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

// ---
// ## 429 を受けたものは、しばらく取りに行かない
//
// **配信元が名指しで求めている**——「429 エラーが発生した場合、「指数関数バックオフ」による
// 再リクエスト処理の実施をお願いします」（API v2 リファレンス「レートリミット」）。
//
// **アプリの REST は再試行しない**ので「バックオフして再試行」の形にはならない。
// 危ういのは**操作のたびに同じ URL を取り直す形があること**:
//
// - 控えが効くのは**成功した分だけ**。429 で落ちたものは控えに載らないので、次の操作で再要求される
// - 「もっと見る」はクリックごとに範囲をまるごと問い合わせ直す（目録と当日の一覧は控えが効かない）
//
// 上の門は上限に達するまで待たせないので、**それはバックオフではない**。
// ここで「取りに行かない窓」を持ち、429 を受けるたびに倍にする。
//
// **429 は id 単位で返る。** 実測した応答の本文は「Don't try to get the same data.」と書いており、
// 止まるのはアカウントでも IP でもなく**繰り返し取得された id** だけ（→
// `data-sources-spec.md` §2「429 は「頻度」ではなく「同じ id の取り直し」に返る」）。
// だから窓も id ごとに持つ。

/** 最初の窓。**実測で 40 分ほどで回復した**ので、そこへ向けて倍々に伸ばす起点。 */
const RATE_LIMIT_BASE_MS = 60_000

/** 窓の頭打ち。これより長く待つと、回復しているのに取りに行かない時間が延びるだけ。 */
const RATE_LIMIT_MAX_MS = 30 * 60_000

/**
 * 窓が明けてからこの時間が経ったら、連続回数（`step`）ごと忘れる。
 *
 * **`step` を残すのは指数バックオフの趣旨**（429 を繰り返す id は次も長く待つ）だが、
 * 永久に残すと記録だけが積み上がる。窓の頭打ち（30 分）より十分長く取れば、
 * 続けて 429 を受けている間は忘れない。
 */
const RATE_LIMIT_FORGET_MS = 60 * 60_000

interface RateLimitState {
  /** この時刻まで取りに行かない。 */
  until: number
  /** 何回続けて 429 を受けたか（0 始まり）。窓の長さを決める。 */
  step: number
}

/**
 * 429 の窓を持つ鍵の種別。
 *
 * **同じ id でも意味が違うので名前空間を分ける。** 電文本体の id（`/v1/:id`）と
 * アーカイブ本体の id（`/v1/archive/:id`）は別々に発行されるもので、**値が一致しない保証は
 * どこにも無い**。1 つの表に混ぜると、衝突したときに片方の 429 が無関係なもう片方を
 * 最長 30 分止める —— しかも記録には「429 を受けたので待つ」としか出ないので、
 * 別のリソースの窓に巻き込まれたことが分からない。
 */
export type RateLimitScope = 'body' | 'archive'

const rateLimited = new Map<string, RateLimitState>()

function scopedKey(scope: RateLimitScope, id: string): string {
  return `${scope}:${id}`
}

/**
 * 429 を受けたことを記録し、次に取りに行ってよい時刻を決める。
 *
 * **続けて受けるほど窓を倍にする**（60 秒 → 2 分 → 4 分 → … → 30 分で頭打ち）。
 *
 * @param scope 電文本体かアーカイブ本体か（同じ id でも別の窓として持つ）
 * @param id 電文 id やアーカイブ id（429 は id 単位で返るため）
 */
export function noteRateLimited(scope: RateLimitScope, id: string): void {
  const key = scopedKey(scope, id)
  const prev = rateLimited.get(key)
  const step = prev ? prev.step + 1 : 0
  const wait = Math.min(RATE_LIMIT_BASE_MS * 2 ** step, RATE_LIMIT_MAX_MS)
  rateLimited.set(key, { until: Date.now() + wait, step })
  log.warn(
    `[dmdata] 429（取得の制限）を受けたので ${Math.round(wait / 1000)} 秒は取りに行きません id=${key}`
    + `（連続 ${step + 1} 回目）`,
  )
}

/**
 * いま取りに行ってよいか。取りに行ってはいけないなら、明ける時刻を返す。
 *
 * **窓が明けても `step` はしばらく消さない。** 429 を繰り返す id は次も長く待つ——それが
 * 指数バックオフの趣旨。消すのは成功したとき（`noteRateLimitCleared`）と、窓が明けてから
 * `RATE_LIMIT_FORGET_MS` が経ったとき。
 */
export function rateLimitedUntil(scope: RateLimitScope, id: string): number | null {
  const key = scopedKey(scope, id)
  const s = rateLimited.get(key)
  if (!s) return null
  const now = Date.now()
  if (now < s.until) return s.until
  // 窓が明けてから十分経ったものは忘れる（記録だけが積み上がるのを防ぐ）
  if (now - s.until > RATE_LIMIT_FORGET_MS) rateLimited.delete(key)
  return null
}

/**
 * 取得が成功したことを記録する（窓と回数を捨てる）。
 *
 * **これが無いと、一度 429 を受けた id は回復後も長い窓を持ち続ける。**
 */
export function noteRateLimitCleared(scope: RateLimitScope, id: string): void {
  rateLimited.delete(scopedKey(scope, id))
}

/** テスト用。429 の記録を空にする。 */
export function resetRateLimitsForTest(): void {
  rateLimited.clear()
}

/**
 * 429 の窓が明けていないため取りに行かなかった、ということを表す。
 *
 * **通常の取得失敗と区別できる形にしている。** 呼び出し側が同じ枠で数えると 3 つが壊れる
 * （→ `types/replay.ts` の `rateLimitedSources`）。`instanceof` で見分ける。
 */
export class RateLimitWindowError extends Error {
  constructor(
    /** 窓を持っているリソースの id。 */
    readonly id: string,
    /** この時刻まで取りに行かない。 */
    readonly until: number,
  ) {
    super(`429 の窓が明けていません id=${id}`)
    this.name = 'RateLimitWindowError'
  }
}
