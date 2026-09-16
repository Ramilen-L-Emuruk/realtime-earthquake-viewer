/**
 * DMDATA への取得を直列化する門。**ホストごとに枠を分けている。**
 *
 * | ホスト | 何を取るか | 間隔 | 根拠 |
 * |---|---|---|---|
 * | `data.api.dmdata.jp` | 電文本体・アーカイブ本体 | 6 秒 | 50req/5min |
 * | `api.dmdata.jp` | 一覧・目録・EEW の詳細 | 500ms | 「定常的に 2req/s 以上のアクセスはお控えいただき」 |
 *
 * **枠を 1 つにまとめない。** 上限の根拠が別で、電文本体の 6 秒を一覧にも掛けると起動が
 * 目に見えて遅くなる（一覧は 1 回の操作で数件しか出ない）。逆に一覧の 500ms を電文本体へ
 * 当てれば 50req/5min を超える。
 *
 * ---
 *
 * ## `data.api.dmdata.jp` の枠
 *
 * **電文本体（`/v1/:id`）とアーカイブ本体（`/v1/archive/:id`）が同じ枠を共有する。**
 *
 * 配信元のレート表（[API v2 リファレンス](https://dmdata.jp/docs/reference/api/v2/)
 * 「レートリミット」）は、3 つの URL に `rowspan` で 50req/5min を掛けている ——
 * `data.api.dmdata.jp/v1/:id`・`jmafiledata.api.dmdata.jp/v1/:id`・
 * `data.api.dmdata.jp/v1/archive/:id`。**「3 行それぞれ」とも「3 行の合計」とも読める**
 * （表の書き方からは決まらない）。
 *
 * **合算として扱う。** アプリは `jmafiledata` を使わないので、実際に共有するのは電文本体と
 * アーカイブ本体の 2 つ。どちらの読み方でも上限に触れない側へ倒す。
 *
 * > 上限のうち「定常的に」の語をこちら側に都合よく読む必要があり、**既に配信元から利用量の
 * > 指摘を受けている状況で際どい解釈に頼るのは筋が悪い**。どの読み方でも安全側へ倒す。
 *
 * この判断は電文本体の門に元から書いてあったもので、**アーカイブ本体にも当てる**ことにした
 * （2026-09-16 の棚卸し。→ [`data-sources-spec.md`](../../docs/spec/data-sources-spec.md)
 * §2「取得の間隔を空ける」）。当てていなかった頃、アーカイブ本体は素の `fetch` を
 * `Promise.all` で**上限なく並列**に投げていた（起動時の履歴で 7 日ぶん ＝ 瞬間 7req/s）。
 *
 * **独立したファイルに置いているのは、門の名前を取得対象に縛らないため。** 元は
 * `telegramBody.ts` の中にあり `bodyGate` という名前だったので、アーカイブ本体から
 * 使うと名前が実態と食い違った。
 */
import { createRateGate } from '../utils/requestGate'
import { log } from '../utils/logger'

/**
 * `data.api.dmdata.jp` への取得間隔。上限の 50req/5min ＝ 6 秒に 1 件。
 *
 * **この値を下げないこと。** 下げれば制限に触れ、触れなくても配信元が求める
 * 「定常的に 2req/s 以下」から外れる。初回起動が数分かかるのは承知のうえで、
 * **控えが効く 2 回目以降はほとんど通らない**（電文本体は IndexedDB・アーカイブ本体も同じ）。
 *
 * バーストを許す形（直近 5 分で 50 件まで、間隔は 500ms）も考えたが採らなかった
 * （理由はこのファイルの冒頭）。
 */
const MIN_INTERVAL_MS = 6_000

let gate = createRateGate(MIN_INTERVAL_MS)

/**
 * 枠が空くまで待つ。
 *
 * `urgent` を渡すと、待っている通常の取得を追い越す。**間隔そのものは変わらない。**
 * 渡すのは「待たせると意味が薄れるもの」だけ —— いまは起動時に発表中の緊急地震速報を
 * 復元する経路だけが使う（履歴の後ろに並ぶと最悪 24 秒遅れて画面に出る）。
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
 * テスト用。門の間隔を差し替える。
 *
 * **門が効いているかは `utils/requestGate.test.ts` が本物の間隔で確かめる。** ここで
 * 差し替えるのは、控えの振る舞い（上限で古い順に捨てる等）を確かめるテストが 600 件を
 * 順に取るためで、6 秒間隔のままだと 1 時間かかる。**本番の値を緩める口ではない。**
 */
export function setDataApiGateIntervalForTest(ms: number): void {
  gate = createRateGate(ms)
}

/**
 * テスト用。待っている全員を通して門を初期化する。
 *
 * **間隔は変えない**（差し替えたいなら `setDataApiGateIntervalForTest`）。テストの
 * あいだに残った待ち行列が次のテストへ持ち越されるのを防ぐためのもの。
 */
export function resetDataApiGateForTest(): void {
  gate.resetForTest()
}

// ---
// ## `api.dmdata.jp` の枠
//
// 一覧（`/v2/telegram`・`/v2/archive`・`/v2/gd/eew`）と EEW の詳細（`/v2/gd/eew/:eventId`）。
//
// **このホストに固有の上限は無い**（パラメータ系の 20req/2min を除くが、そこは使っていない）。
// 掛かるのは①ドメイン×IP で 10 分 2000（＝3.3req/s）と②「**定常的に 2req/s 以上のアクセスは
// お控えいただき**」で、**厳しいのは②**なのでそちらへ合わせる。

/**
 * `api.dmdata.jp` への取得間隔。配信元が求める「定常的に 2req/s 以下」に合わせる。
 *
 * **この値を下げないこと。** 下げれば 2req/s を超える。
 * 一覧は 1 回の操作で数件しか出ないので、500ms でも体感には出ない。
 */
const API_MIN_INTERVAL_MS = 500

let apiGate = createRateGate(API_MIN_INTERVAL_MS)

/**
 * `api.dmdata.jp` の枠が空くまで待つ。
 *
 * **並列で呼んでも直列化される。** リプレイの当日経路は EEW の詳細を
 * `BODY_CONCURRENCY`（8）の枠で並べるので、門が無いと瞬間 8req/s になる
 * （電文本体の側はこの門ではなく上の 6 秒の門を通るため元から直列）。
 *
 * `urgent` を渡すと、待っている通常の要求を追い越す。**間隔そのものは変わらない**
 * （変えればレート制限に触れる）。渡すのは **WebSocket の開始と枠の解放**だけ ——
 * あれは電文の受信そのものの起点で、一覧や目録の待ち行列の後ろに回すと EEW の受信開始が
 * 遅れる。**一覧・目録・詳細には渡さないこと**（全部が urgent なら優先度は意味を失う）。
 */
export function waitForApiSlot(opts?: { urgent?: boolean }): Promise<void> {
  return apiGate.wait(opts)
}

/** テスト用。`api.dmdata.jp` の門の間隔を差し替える。 */
export function setApiGateIntervalForTest(ms: number): void {
  apiGate = createRateGate(ms)
}

/** テスト用。`api.dmdata.jp` の門の待ち行列を空にする。 */
export function resetApiGateForTest(): void {
  apiGate.resetForTest()
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
// 間隔は空くが（上の門）、**それはバックオフではない**——失敗が続いても伸びない。
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
