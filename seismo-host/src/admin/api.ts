// `/api/*`・`/status` への通信をまとめる。
//
// **トークンは `localStorage` に置く。** ブラウザに保存した秘密は tailnet 上の
// 他端末から読めるわけではない（ブラウザのオリジン分離が効く）——README.md
// 「`/api/*` の認証」が言う「Host・Origin は偽装できる」のは非ブラウザの
// クライアントの話で、こちらは正規のブラウザ操作を前提にしている。

export const TOKEN_STORAGE_KEY = 'seismo-admin-token'

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY)
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token)
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY)
}

type TokenClearedListener = () => void
const tokenClearedListeners: TokenClearedListener[] = []

/**
 * `apiFetch` が `invalid-token` を理由にトークンを消したときに呼ばれる。
 * `app.ts` がこれを購読して、画面上のトークンの状態表示を追随させる
 * ——購読しないと、消えたのに画面はそのままで運用者が気づけない
 * （#313 段 C 敵対的レビューで検出）。
 */
export function onTokenCleared(listener: TokenClearedListener): void {
  tokenClearedListeners.push(listener)
}

function clearStoredTokenAndNotify(): void {
  clearStoredToken()
  for (const listener of tokenClearedListeners) listener()
}

/** `/api/*` が返すエラーの形。`{ error: string }` 以外は素通しする。 */
export interface ApiErrorBody {
  readonly error?: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
  ) {
    super(body?.error ?? `HTTP ${status}`)
  }
}

/**
 * `/api/*`・`/status` へ投げて JSON を受け取る。**投げるのは通信・パース失敗と
 * 非 2xx のときだけ**——呼び出し側が `try/catch` 1 箇所で全部拾える形にする。
 *
 * **トークンを消すのは `invalid-token`（401）のときだけ。** サーバー側
 * （`statusServer.ts` の `adminAuthStatusCode`）は `host-not-allowed`・
 * `origin-not-allowed` も 403 で返すが、これらはトークンの正誤と無関係
 * （`Host`・`Origin` の許可設定と実際のアクセス経路が食い違っているだけ）。
 * 理由を見ずに 401/403 をまとめて「トークンを消す」判定にすると、環境側の
 * 設定不一致のたびに正しいトークンが消え、運用者が「入れ直しても直らない」
 * ループに陥る（#313 段 C 敵対的レビューで検出）。
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getStoredToken()
  const headers = new Headers(init?.headers)
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json')

  let res: Response
  try {
    res = await fetch(path, { ...init, headers })
  } catch (error) {
    throw new Error(`通信できない: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!res.ok) {
    let body: ApiErrorBody | null = null
    try {
      body = (await res.json()) as ApiErrorBody
    } catch {
      // 本文が JSON でなくても、ステータスコードだけで ApiError は組み立てられる。
    }
    if (res.status === 401 && body?.error === 'invalid-token') {
      clearStoredTokenAndNotify()
    }
    throw new ApiError(res.status, body)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/**
 * `adminAuth.ts` の `AdminAuthFailure.reason` を日本語の文言へ変える。
 * 該当しない理由（`409 station-in-use` 等、認証以外の理由）は `null`。
 *
 * **通さないと、`host-not-allowed` のような内部の理由コードがそのまま
 * 画面に出る。** 運用者が README.md「`/api/*` の認証」まで遡らないと
 * 何が起きているか分からない（#313 段 C 2巡目レビューで検出）。
 */
export function describeAdminAuthFailure(reason: string): string | null {
  switch (reason) {
    case 'not-configured':
      // **「入力では直らない」を省かない。** 他の理由は上部の欄で解決するが、
      // これだけはサーバー側の設定を直さないと `/api/*` が丸ごと無効なまま。
      return 'サーバー側のトークンが未設定（SEISMO_ADMIN_TOKEN）。/api/* 全体が無効'
    case 'missing-authorization':
      return 'トークン未設定（上部の欄に入力すること）'
    case 'invalid-token':
      return 'トークンが違う'
    case 'host-not-allowed':
      return 'このアドレスは未許可（SEISMO_ADMIN_ALLOWED_HOSTS）'
    case 'origin-not-allowed':
      return 'このオリジンは未許可（SEISMO_ADMIN_ALLOWED_ORIGINS）'
    default:
      return null
  }
}
