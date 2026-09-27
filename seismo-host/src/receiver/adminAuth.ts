// `/api/*`（設定の読み書き・管理操作）を守る認証判定。**`/status`・`/stream` は対象外**——
// あちらは読み取り専用で公開してよい前提のまま変えない（`statusServer.ts` 冒頭のコメント参照）。
//
// **3 点を AND で見る**（REQUIREMENTS.md §12・#317 の決定を踏まえた #313 の設計）。
// - トークン（`Authorization: Bearer <token>`）—— 運用者だけが知っている値
// - `Host` ヘッダ照合 —— DNS rebinding 対策。悪意あるページが自分のドメインを
//   private IP へ向けても、Host ヘッダの中身までは偽装しにくい
// - `Origin` 検査 —— 管理コンソール以外の配信元からのクロスオリジン書き込みを弾く
//
// **tailnet 経由でも無認証は不可**（REQUIREMENTS.md §11 決定）。tailnet に参加する
// 他端末・アプリからの攻撃経路は残るため、ネットワーク層の絞り込みだけでは防げない。
//
// **Tailscale Serve がバックエンドへプロキシする際、実際の `Host` ヘッダがどう届くかは
// 未確認**（既定値はこちらの推測——`127.0.0.1:<port>`・`localhost:<port>` を想定）。
// 環境変数で上書きできるようにしてあるのはこのため。実機で確認でき次第、既定値を見直す。

import { timingSafeEqual } from 'node:crypto'

export interface AdminAuthConfig {
  /** 運用者が設定する共有トークン。**未設定（null）なら `/api/*` 自体を無効化する**（呼び出し側の責務）。 */
  readonly token: string | null
  /** 許可する `Host` ヘッダの値（大小文字は区別しない）。空なら誰も通らない。 */
  readonly allowedHosts: readonly string[]
  /** 許可する `Origin` ヘッダの値（大小文字は区別しない）。空なら誰も通らない。 */
  readonly allowedOrigins: readonly string[]
}

/** 判定に使うヘッダだけを渡す。**`IncomingMessage` 全体には依存しない**（`parsePacket.ts` と同じ理由——テストで組み立てやすくする）。 */
export interface AdminAuthHeaders {
  readonly authorization: string | undefined
  readonly host: string | undefined
  readonly origin: string | undefined
  /**
   * `Sec-Fetch-Site`（Fetch Metadata Request Headers）。**同一オリジンの単純 GET で
   * `Origin` ヘッダが省略されたときの代替判定に使う**（#313 段 C）。
   *
   * 管理コンソール本体（`GET /admin`）を同一オリジンで配信すると、そこから
   * `fetch('/api/stations')` した実際のリクエストに `Origin` が付かないことを
   * 実機で確認した（Chrome・`mode: 'cors'` を指定しても付かない）——CORS 仕様は
   * 同一オリジンのリクエストに `Origin` を要求しないため。**このヘッダはモダン
   * ブラウザが自動で付与し、JS から上書きできない**（`fetch` の forbidden header
   * ではないが、ブラウザが送信経路を丸ごと管理し、ページの JS には触れさせない）。
   * `same-origin` はまさに「別サイトからの CSRF ではない」ことの証拠になる。
   */
  readonly secFetchSite: string | undefined
}

export type AdminAuthFailure =
  /** `config.token` が null。**呼び出し側は個別の理由を返さず、その場で `/api/*` を丸ごと塞ぐこと。** */
  | { readonly reason: 'not-configured' }
  | { readonly reason: 'missing-authorization' }
  | { readonly reason: 'invalid-token' }
  | { readonly reason: 'host-not-allowed' }
  | { readonly reason: 'origin-not-allowed' }

const BEARER_PREFIX = 'Bearer '

/** `Authorization: Bearer <token>` からトークンを取り出す。前置き無し・空文字は無効。 */
function extractBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null
  if (!authorization.startsWith(BEARER_PREFIX)) return null
  const token = authorization.slice(BEARER_PREFIX.length).trim()
  return token.length > 0 ? token : null
}

/**
 * 定数時間で比較する。**長さが違う場合だけ早期に `false` を返す**——
 * 長さの漏洩は一般に許容されるリスクで、ここを埋めるために可変長のパディングを
 * 持ち込むと実装がかえって複雑になる（`timingSafeEqual` は長さが違うと例外を投げるため、
 * 事前のガードは省略できない）。
 */
function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** `Host` ヘッダは大小文字を区別しない（RFC 7230）。許可リスト側も同じ規約で正規化して比較する。 */
function isAllowed(value: string | undefined, allowList: readonly string[]): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) return false
  return allowList.some((allowed) => allowed.trim().toLowerCase() === normalized)
}

/**
 * `/api/*` を通してよいか判定する。**例外を投げない**（`parsePacket.ts`・`stationConfig.ts` と
 * 同じ理由——壊れた・悪意あるリクエストは日常で、投げるとサーバーごと落ちる経路が増える）。
 *
 * 通ればここでは `null`。**呼び出し側は `null` を「許可」の意味で使うこと**
 * （`AdminAuthFailure` の値を持たないので、真偽値と違って誤って握りつぶしにくい）。
 *
 * **Origin・Host を先に見て、トークンは最後に見る。** 理由を返す都合上、失敗の応答は
 * `invalid-token` と `origin-not-allowed`／`host-not-allowed` とで区別が付く。
 * トークンを先に判定すると、**Origin・Host が正しいかどうかに関係なくトークンだけの
 * 正誤を確認できるオラクル**になる——Origin・Host は秘密ではないので偽装のしようが
 * あるが、トークンは秘密そのものなので、これだけを独立に総当たりされてよい理由が無い。
 * 逆に Origin・Host を先に通す形なら、トークンの正誤を確認するには（偽装であっても）
 * まず Origin・Host を正しく揃える手間が要る。
 */
export function checkAdminAuth(headers: AdminAuthHeaders, config: AdminAuthConfig): AdminAuthFailure | null {
  if (config.token === null) return { reason: 'not-configured' }

  // **`Origin` が省略されていても、`Sec-Fetch-Site: same-origin` があれば通す。**
  // 同一オリジンの単純 GET はブラウザが `Origin` を送らないことがある（上記
  // `AdminAuthHeaders.secFetchSite` のコメント参照）。それ以外（両方省略・
  // 別オリジンからの偽装試行）は従来どおり拒む——許可の条件を 1 つ足すだけで、
  // 既存の拒否範囲は狭めない。
  if (headers.origin === undefined) {
    if (headers.secFetchSite !== 'same-origin') return { reason: 'origin-not-allowed' }
  } else if (!isAllowed(headers.origin, config.allowedOrigins)) {
    return { reason: 'origin-not-allowed' }
  }
  if (!isAllowed(headers.host, config.allowedHosts)) return { reason: 'host-not-allowed' }

  const presented = extractBearerToken(headers.authorization)
  if (presented === null) return { reason: 'missing-authorization' }
  if (!tokensEqual(presented, config.token)) return { reason: 'invalid-token' }

  return null
}
