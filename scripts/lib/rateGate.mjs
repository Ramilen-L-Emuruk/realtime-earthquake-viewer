// 配信元ごとの取得間隔を守るための門。**取得元を問わず、ここを通す。**
//
// 元は `scripts/telegram-audit/archive-cache.mjs` の中にあり、DMDATA アーカイブ専用に見えたため
// 他のスクリプトから使われていなかった。実際には `kind` でホストを分けられる汎用の仕組みなので、
// 共有できる場所へ出してある（`telegram-audit/archive-cache.mjs` と `lib/stationSource.mjs`、
// `telegram-audit/fetch-p2p-history.mjs` が使う）。
//
// **同じ実装を 2 本持たないこと。** 片方だけ直る日が来る。

const sleep = (ms) => new Promise(res => setTimeout(res, ms))

// ホストごとに「次に投げてよい時刻」を持つ。呼び出し側が並列ワーカーで回していても、
// 実効レートはここで決まる。
const nextSlotAt = new Map()

// 待ちを飛ばすかどうか（テスト専用。切り替えは `setRateGateDisabledForTest`）。
// **`gate` より前で宣言する** —— 後ろに置くと TDZ に入り、モジュール評価の途中で
// `gate` が呼ばれた場合に参照できない。
let disabledForTest = false

/**
 * 次の枠が来るまで待つ。
 *
 * **待つ前に枠を予約する。** `await` の後で時刻を書き込む形にすると、並列で入った呼び出しが
 * そろって同じ「前回の時刻」を読み、同じ待ち時間を計算して**一斉に発火する**
 * （実測: 5 本のワーカーで 1 本が即時・残り 4 本が 1 秒後にほぼ同時。
 * `CONCURRENCY=8` なら 6 秒ごとに 8 件のバーストになり、守るつもりだった
 * 50req/5min を 8 倍超える）。同期的に予約してから待てば、N 本目は
 * `前回 + N×間隔` へ並ぶ。
 *
 * @param kind 枠を分ける単位。**配信元（ホスト）ごとに別の値を渡す** —— 同じ値を使うと
 *   無関係な配信元どうしで待ち合わせることになり、片方が遅いだけで他方も止まる。
 * @param minIntervalMs この `kind` で連続する 2 件のあいだに最低限空ける時間。
 */
export async function gate(kind, minIntervalMs) {
  if (disabledForTest) return
  const now = Date.now()
  const target = Math.max(now, nextSlotAt.get(kind) ?? 0)
  nextSlotAt.set(kind, target + minIntervalMs)
  const wait = target - now
  if (wait > 0) await sleep(wait)
}

/**
 * テスト用。枠の予約を空にする。
 *
 * **呼び出し側が持つ実測値（stats）とまとめて空にすること。** 別々に呼ぶ形にすると
 * 呼び忘れが起き、前のテストの残りが次のテストへ漏れる（`archive-cache.mjs` の
 * `resetArchiveCacheForTest` はこれを呼んだうえで自分の stats も空にしている）。
 */
export function resetRateGateForTest() {
  nextSlotAt.clear()
}

/**
 * テスト用。待ちを飛ばす。
 *
 * **これを使うテストは「間隔が効いていること」を確かめられない。** 門そのものの検証は
 * `rateGate.test.ts` が持つので、そちらでは**絶対に無効化しないこと**。
 *
 * 使うのは「間隔を通る処理を、間隔とは別の観点で検証したい」テスト
 * （例: `stationSource.test.ts` が控えの効きを見る。22 版 × 200ms を実時間で待つと
 * 1 ファイルで 44 秒かかり、`npm test` 全体が目に見えて遅くなった）。
 *
 * **`afterEach` で必ず戻すこと。** 戻し忘れると、同じワーカーで後から走るテストの
 * 間隔まで黙って消える。
 */
export function setRateGateDisabledForTest(disabled) {
  disabledForTest = disabled === true
}

/** 待ち時間を挟む。取得の合間に使う（`gate` を通さない軽い待ちが要る場面用）。 */
export { sleep }
