// Akamai の公開時刻サービスから、真のサーバー現在時刻を 1 リクエストで取得する。
//
// 位置づけ: このモジュールは「観測」だけを担う。得たサンプルをアプリ時計へ供給するか
//   （`clock.feedServerSample`）、記録に留めるかは呼び出し側が決める。
//
// エンドポイント: https://time.akamai.com/?iso&ms
//   - 応答は ISO8601 の平文 1 行（例: `2026-08-20T07:23:52.659Z`）。`?ms` を付けるとミリ秒が付く。
//   - `Access-Control-Allow-Origin` にリクエスト元を反射するためブラウザから直接読める。
//     応答自身が `Cache-Control: max-age=0, no-cache, no-store` を返すのでキャッシュ対策も不要
//     （2026-08-20 実測）。
//
// なぜこのサービスなのか: **dash.js（DASH Industry Forum の標準プレイヤー）の既定の時刻同期先が
//   このエンドポイント**であり、Akamai がブラウザからのクロック同期用途で大規模に供給していることを
//   承知して運用している。参考: https://dashif.org/dash.js/pages/usage/clock-sync.html
//
//   **NICT（情報通信研究機構）の日本標準時は使わない。** HTTP/HTTPS 時刻配信が 2022-03-31 に
//   公式終了しており、運営者が NTP への移行を要請しているため（経緯は
//   `docs/spec/data-sources-spec.md` §11 の 2026-08-20）。
//
// 注意: 専用の利用規約ページは見つかっていない。大規模に供給されている事実と明文の許諾は別物なので、
//   取得間隔は控えめに保ち、失敗は記録に留めて既存の較正には影響させない。

import { createLogThrottle, log } from '../utils/logger'

/** 取得先。`?iso` で ISO8601、`?ms` でミリ秒まで付く。 */
const TIME_URL = 'https://time.akamai.com/?iso&ms'

/**
 * 打ち切り時間 (ms)。
 *
 * 実測の往復時間は 32〜42ms。待ち続けるより次の周期に回した方が早く良いサンプルが取れる。
 */
const FETCH_TIMEOUT_MS = 3000

/**
 * 妥当範囲（epoch ms）。
 *
 * 壁時計と比べる形の検査にはしない。端末の日付が大きく狂っている環境こそサーバー時刻が必要な
 * 場面であり、そこで弾いてしまうと目的と逆になる。HTML エラーページや NaN のような明らかな異常だけを
 * 落とせればよいので、固定の広い窓で見る。
 */
const TIME_MIN_MS = Date.UTC(2020, 0, 1)
const TIME_MAX_MS = Date.UTC(2100, 0, 1)

/**
 * 前回サンプルからの逆行を許す幅 (ms)。
 *
 * NICT の JSON には送信値をそのまま返す `it` があり、別リクエストの応答を掴んでいないかを照合できた。
 * この平文エンドポイントには相当する仕組みが無いため、代わりに「単調時計で見て前回より戻っていない」
 * ことを見る。中間装置が古い応答を返した場合に検出できる。ジッタを許すため幅を持たせる。
 */
const BACKWARDS_TOLERANCE_MS = 2000

/** 失敗の記録を間引く間隔 (ms)。到達不能な環境で毎周期同じ行を出さない。 */
const FAILURE_LOG_INTERVAL_MS = 300_000

/**
 * **理由ごとに独立したスロットルを持つ。** 1 個で共有すると、最初に鳴った理由が残りを 5 分間隠す。
 *
 * 主経路になったことでこれが効いてくる。たとえば `network` で 1 回出たあとサービス側の応答形式が
 * 変わって `imprecise-format` に転じても、共有していると 5 分間そちらが見えず、原因を取り違える
 * （フォールバック側の `throttledMissLog` と同じ考え方）。
 */
const throttledFailureLog: Record<Exclude<RejectReason, 'in-flight'>, (emit: () => void) => void> = {
  'network': createLogThrottle(FAILURE_LOG_INTERVAL_MS),
  'http-error': createLogThrottle(FAILURE_LOG_INTERVAL_MS),
  'parse-invalid': createLogThrottle(FAILURE_LOG_INTERVAL_MS),
  'imprecise-format': createLogThrottle(FAILURE_LOG_INTERVAL_MS),
  'out-of-range': createLogThrottle(FAILURE_LOG_INTERVAL_MS),
  'went-backwards': createLogThrottle(FAILURE_LOG_INTERVAL_MS),
}

/**
 * 応答が満たすべき形。**小数秒とタイムゾーンの両方を必須にする。**
 *
 * - タイムゾーン: `Date.parse` は ISO8601 の日時にオフセットが無いと**ローカル時刻**として解釈する。
 *   将来 `Z` が落ちた場合、端末のタイムゾーン次第で数時間ずれた値を妥当範囲内として受理してしまう。
 * - 小数秒: サービスが `?ms` を無視するようになると、リクエストは正しいまま応答だけ秒単位に丸まり、
 *   **精度だけが静かに落ちる**。エラーにならないので気づけない。
 *
 * ちょうど `.000` の瞬間に小数部が省略される実装であれば取りこぼすが、頻度は 1/1000 で、棄却理由が
 * 記録に残るため誤解にはつながらない。静かな劣化を見逃すより取りこぼす方を選ぶ。
 */
const ISO_WITH_MS = /\.\d{1,3}(?:Z|[+-]\d{2}:?\d{2})$/

/** 直近に採用したサンプル。逆行検出の基準に使う。 */
let lastAccepted: { serverEpochMs: number; perfRefMs: number } | null = null

/**
 * 取得が進行中か。
 *
 * `lastAccepted` はモジュール単位で持つため、複数の取得が同時に走ると応答の到着順が要求順と入れ替わり、
 * 正当な応答を `went-backwards` と誤判定しうる。ライブ⇄リプレイを打ち切り時間（3 秒）より短い間隔で
 * 往復させると、停止済みインスタンスの取得と新しいインスタンスの取得が重なって実際に起こる。
 * 30 秒ごとの計測で 1 回見送る損失は無いに等しいので、重なったら後から来た方を捨てる。
 */
let inFlight = false

/** サーバー時刻の 1 回分のサンプル。 */
export interface ServerTimeSample {
  /** サーバーが返した時刻（epoch ms）。 */
  serverEpochMs: number
  /**
   * 往復時間 (ms)。
   *
   * 下の `perfRefMs` の基準では推定値が RTT に依存しないため、精度の重み付けには使わない。
   * 回線・メインスレッドの混み具合を診断するための指標として持つ。
   */
  rttMs: number
  /**
   * `serverEpochMs` が指す瞬間の `performance.now()`。応答が到着した時点の値。
   *
   * 現在時刻へは `serverEpochMs + (performance.now() - perfRefMs)` で換算する。単調時計で持つため、
   * 壁時計のジャンプに影響されない。
   *
   * **中点（送信と受信の平均）ではなく応答到着を基準にする。** 返る時刻は応答が生成された時点の
   * ものであり、往復の中間ではないため。実測（2026-08-20、RTT 32〜363ms の 12 サンプル）で、
   * 壁時計との差が RTT にどう依存するかを両基準で比べた結果:
   *   - 中点基準     : RTT に対する傾き -0.485。RTT が伸びるほど誤差が比例して増える（164ms 幅）
   *   - 応答到着基準 : RTT に対する傾き  0.012。11ms 幅に収まる
   * 中点を使うと -RTT/2 の系統誤差がそのまま乗る。（差の絶対値は端末時計のずれそのもので環境ごとに
   * 変わる。ここで見るべきは「RTT に依存するか」だけ）
   */
  perfRefMs: number
}

/**
 * 取得が失敗した理由。
 *
 * 「到達できない」と「応答は返るが形式が変わった」を区別するために持つ。前者は回線の問題で待てば
 * 直るが、後者はサービス側の変更であり実装を直すしかない。理由を落とすと、計測値が出なくなった
 * 原因をログから切り分けられなくなる。
 */
type RejectReason =
  /** 通信できなかった（接続失敗・打ち切り）。 */
  | 'network'
  /** 応答は返ったが 2xx 以外。 */
  | 'http-error'
  /** 応答本文を時刻として解釈できない（形式変更）。 */
  | 'parse-invalid'
  /** 解釈はできるが小数秒またはタイムゾーンが欠けている（精度の静かな劣化・ローカル時刻誤解釈の防止）。 */
  | 'imprecise-format'
  /** 別の取得が進行中だった（重なりを避けて見送った）。 */
  | 'in-flight'
  /** 解釈できたが妥当範囲外。 */
  | 'out-of-range'
  /** 前回サンプルより時刻が戻っている（古い応答を掴んだ疑い）。 */
  | 'went-backwards'

type Attempt =
  | { ok: true; sample: ServerTimeSample }
  | { ok: false; reason: RejectReason }

/** 1 回問い合わせる。失敗時は理由を添えて返す。 */
async function fetchOnce(): Promise<Attempt> {
  if (inFlight) return { ok: false, reason: 'in-flight' }
  inFlight = true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const perfStart = performance.now()
    const res = await fetch(TIME_URL, { cache: 'no-store', signal: controller.signal })
    // 往復時間は「応答が返ってきた瞬間」で締める。本文の読み出しまで含めると純粋な往復ではなくなり、
    // 基準時点が実際より後ろへずれる。
    const perfEnd = performance.now()
    if (!res.ok) return { ok: false, reason: 'http-error' }

    const body = (await res.text()).trim()
    const serverEpochMs = Date.parse(body)
    if (!Number.isFinite(serverEpochMs)) return { ok: false, reason: 'parse-invalid' }
    if (!ISO_WITH_MS.test(body)) return { ok: false, reason: 'imprecise-format' }
    if (serverEpochMs < TIME_MIN_MS || serverEpochMs > TIME_MAX_MS) {
      return { ok: false, reason: 'out-of-range' }
    }
    if (lastAccepted !== null) {
      const expected = lastAccepted.serverEpochMs + (perfEnd - lastAccepted.perfRefMs)
      if (serverEpochMs < expected - BACKWARDS_TOLERANCE_MS) {
        return { ok: false, reason: 'went-backwards' }
      }
    }

    const sample = { serverEpochMs, rttMs: perfEnd - perfStart, perfRefMs: perfEnd }
    lastAccepted = { serverEpochMs, perfRefMs: perfEnd }
    return { ok: true, sample }
  } catch {
    // 接続失敗・打ち切りをまとめる。到達不能な環境では毎周期起きるため、記録は呼び出し元で間引く。
    return { ok: false, reason: 'network' }
  } finally {
    clearTimeout(timer)
    inFlight = false
  }
}

/**
 * 別の取得が進行中で今回は投げなかったことを表す番兵。
 *
 * **サービスの失敗ではない。** 進行中の方が較正するので、呼び出し側はフォールバック経路へ
 * 落ちてはいけない（落ちると Yahoo の未登録秒を無駄に撃つことになる）。
 */
export const SERVER_TIME_SKIPPED = 'skipped'

/** `fetchServerTime` の結果。サンプル／見送り／失敗の 3 状態。 */
export type ServerTimeOutcome = ServerTimeSample | typeof SERVER_TIME_SKIPPED | null

/**
 * サーバー時刻のサンプルを 1 つ得る。
 *
 * 戻り値は 3 状態。取得できたらサンプル、別の取得と重なったら `SERVER_TIME_SKIPPED`、
 * 失敗したら null。**見送りと失敗を混ぜないこと**（混ぜると、重なっただけでフォールバックへ
 * 落ちる）。
 *
 * 例外は投げない。時刻較正は「取れたら精度が上がる」性質の処理であり、取得失敗で呼び出し側の
 * 処理を止めるべきではないため。記録に失敗しても同じ扱いにする。
 */
export async function fetchServerTime(): Promise<ServerTimeOutcome> {
  const attempt = await fetchOnce()
  if (attempt.ok) return attempt.sample
  // 見送りは正常な動作なので記録しない（毎周期出ると本物の失敗が埋もれる）。
  if (attempt.reason === 'in-flight') return SERVER_TIME_SKIPPED
  try {
    // 理由を必ず添える。`network` なら回線の問題（待てば直る）、`parse-invalid` などが出ていれば
    // サービス側の形式変更（実装を直すしかない）と読み分けられる。
    throttledFailureLog[attempt.reason](() =>
      log.warn(`[time] サーバー時刻を取得できず: ${attempt.reason}`),
    )
  } catch {
    // 記録そのものの失敗で「例外を投げない」契約を破らない。ここが最後の砦であり、これ以上
    // 報告できる先が無いため飲み込む（呼び出し側は null を受けて較正を見送る）。
  }
  return null
}
