// 到達予想トークンの検証。
//
// 自前の走時計算で「登録地点へ何秒後」を出すのは、気象業務法第 17 条の許可を要する地震動の
// 予報業務に当たりうる（気象庁「地震動の予報業務許可についてよくお寄せいただくご質問」）。
// 公開版は気象庁の発表値を伝えるだけにし、自前計算は発行済みトークンを持つ端末でだけ
// 有効にする。線引きと背景は `docs/spec/eew-spec.md` §6。
//
// **ここで検証するのは「トークンが本物か」だけ。** ブラウザの中で動く判定なので、利用者が
// 意図して迂回することは防げない。防いでいるのは**偽造**（鍵を持たない人が有効なトークンを
// 作ること）で、そのために共有の文字列ではなく公開鍵署名を使っている。
//
// 発行は `scripts/sign-arrival-token.ts`（秘密鍵は `.env.local` にあり配らない）。

import { serverNow } from './clock'
import { log } from './logger'

/**
 * 署名の検証に使う公開鍵（SPKI DER の base64）。
 *
 * **公開してよい値。** 公開鍵からは署名を作れないので、バンドルに載っていても偽造には使えない。
 * 差し替えると発行済みのトークンが全部無効になる。
 */
const PUBLIC_KEY_SPKI_BASE64 =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6MdLpq7tWwg4yKG0SevyBjSOc1q64IVwsGrYvK9YlpIOPUUOEbQErCuAhWnXBTHVpNmi9c7mH5M3N6RrsqmDeg=='

/** 署名方式はここに固定する（トークンには書かせない。理由は発行スクリプトの冒頭）。 */
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const
const VERIFY_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const

interface TokenPayload {
  sub?: unknown
  iat?: unknown
  exp?: unknown
}

/**
 * 検証の結果。
 *
 * **失効時刻まで返すのは、呼び出し側が再検証を張れるようにするため。** 真偽だけを返す形だと
 * 「いつ閉じればよいか」が判らず、トークン文字列が変わるまで開いたままになる（→ `hooks/useArrivalToken.ts`）。
 */
export interface ArrivalTokenCheck {
  valid: boolean
  /** 失効時刻（epoch ms）。通らなかったときは null。 */
  expMs: number | null
}

const INVALID: ArrivalTokenCheck = { valid: false, expMs: null }

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

/** base64url を復号する。`-` `_` を戻し、落ちているパディングを補う。 */
function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}

let keyPromise: Promise<CryptoKey> | null = null
function importPublicKey(spkiBase64: string): Promise<CryptoKey> {
  // 既定の鍵だけ覚える（テストが渡す鍵は毎回作り直す）。
  if (spkiBase64 !== PUBLIC_KEY_SPKI_BASE64) {
    return crypto.subtle.importKey('spki', base64ToBytes(spkiBase64) as unknown as ArrayBuffer, ALGORITHM, false, ['verify'])
  }
  // **失敗した Promise を覚えない。** 握ると、一時的な理由で失敗したときに再読み込みまで
  // 検証が通らなくなる（`utils/testDataLoader.ts` と同じ理由）。
  if (!keyPromise) {
    const bytes = base64ToBytes(PUBLIC_KEY_SPKI_BASE64)
    keyPromise = crypto.subtle
      .importKey('spki', bytes as unknown as ArrayBuffer, ALGORITHM, false, ['verify'])
      .catch((err) => {
        keyPromise = null
        throw err
      })
  }
  return keyPromise
}

/**
 * トークンが本物で、まだ失効していないか。
 *
 * **判らないときは通らない側を返す。** 検証に失敗する理由（形式が違う・署名が合わない・
 * `crypto.subtle` が使えない）を区別して通すと、それが自前計算を開く抜け道になる。
 *
 * 空文字（未入力）は**記録せずに**通らない。設定を触っていない端末で警告が出ても意味が無い。
 */
export async function verifyArrivalToken(token: string): Promise<ArrivalTokenCheck> {
  return verifyArrivalTokenWithKeyForTest(token, PUBLIC_KEY_SPKI_BASE64)
}

/**
 * 公開鍵を差し替えて検証する。**テスト専用。**
 *
 * テストは本物の秘密鍵を持てない（`.env.local` にしかなく、CI にも無い）ので、鍵の組を
 * その場で作って往復させるためにこの口がある。**本番の経路から呼ばないこと** ——
 * 信頼の根を呼び出し側が選べる形は、そこが抜け道になる。
 */
export async function verifyArrivalTokenWithKeyForTest(
  token: string,
  publicKeySpkiBase64: string,
): Promise<ArrivalTokenCheck> {
  const trimmed = token.trim()
  if (!trimmed) return INVALID
  const dot = trimmed.indexOf('.')
  if (dot <= 0 || dot === trimmed.length - 1 || trimmed.indexOf('.', dot + 1) !== -1) {
    log.warn('[arrival] トークンの形式が違います（<payload>.<signature> の 2 部であること）')
    return INVALID
  }
  const payloadPart = trimmed.slice(0, dot)
  const signaturePart = trimmed.slice(dot + 1)

  try {
    const key = await importPublicKey(publicKeySpkiBase64)
    const ok = await crypto.subtle.verify(
      VERIFY_PARAMS,
      key,
      base64urlToBytes(signaturePart) as unknown as ArrayBuffer,
      new TextEncoder().encode(payloadPart) as unknown as ArrayBuffer,
    )
    if (!ok) {
      log.warn('[arrival] トークンの署名が合いません')
      return INVALID
    }
    const payload: TokenPayload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadPart)))
    // **失効の判定はサーバー同期時刻で行う。** 端末の壁時計は信用しない（`utils/clock.ts`）。
    //
    // **有限であることまで見る。** `JSON.parse('{"exp":1e400}')` は `Infinity` を返し、
    // `typeof` は `number` を通すので、失効しないトークンを作れる形になる。秘密鍵を持たない
    // 第三者には作れない（署名の対象そのもの）が、失効を仕組みの中核に据えている以上
    // 「期限を持たないトークンは通さない」の例外を残さない。
    const exp = typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null
    if (exp === null) {
      log.warn('[arrival] トークンに失効日がありません')
      return INVALID
    }
    if (serverNow() / 1000 > exp) {
      log.warn('[arrival] トークンが失効しています')
      return INVALID
    }
    return { valid: true, expMs: exp * 1000 }
  } catch (err) {
    log.warn('[arrival] トークンを検証できません', err)
    return INVALID
  }
}
