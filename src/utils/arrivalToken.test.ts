// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { verifyArrivalToken, verifyArrivalTokenWithKeyForTest } from './arrivalToken'

// **鍵の組をその場で作って往復させる。** 本物の秘密鍵は `.env.local` にしか無く CI には無いので、
// 「本物のトークンが通ること」はここでは確かめられない。代わりに**同じアルゴリズム指定で
// 署名したものが通り、細工したものが落ちること**を固定する。発行スクリプト側が同じ指定
// （ECDSA P-256 / SHA-256・署名は r‖s の生の 64 バイト）で署名しているのは
// `scripts/sign-arrival-token.ts` のコメントが単一情報源。

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const

let privateKey: CryptoKey
let publicKeyBase64: string

function toBase64(bytes: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(bytes)).toString('base64')
}
function toBase64Url(bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString('base64url')
}

/** 発行スクリプトと同じ形（`base64url(payload).base64url(署名)`）でトークンを作る。 */
async function issue(payload: Record<string, unknown>, key = privateKey): Promise<string> {
  const payloadPart = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = await crypto.subtle.sign(SIGN, key, new TextEncoder().encode(payloadPart))
  return `${payloadPart}.${toBase64Url(sig)}`
}

/** 素のトークン文字列から署名を作り直さずに payload だけ差し替える（細工したトークン）。 */
function swapPayload(token: string, payload: Record<string, unknown>): string {
  const sig = token.slice(token.indexOf('.') + 1)
  return `${toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}.${sig}`
}

const farFuture = () => Math.floor(Date.now() / 1000) + 86400

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])
  privateKey = pair.privateKey
  publicKeyBase64 = toBase64(await crypto.subtle.exportKey('spki', pair.publicKey))
})

describe('verifyArrivalTokenWithKeyForTest', () => {
  it('正しく署名され失効していないトークンは通る（正）', async () => {
    const exp = farFuture()
    const token = await issue({ sub: 'tester', iat: 0, exp })
    // **失効時刻も返す。** 呼び出し側がそこで再検証を張れないと、開いたままのセッションで
    // 期限を過ぎても閉じない（→ `hooks/useArrivalToken.ts`）。
    expect(await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)).toEqual({
      valid: true,
      expMs: exp * 1000,
    })
  })

  it('別の鍵で署名したトークンは通らない（偽造の防止）', async () => {
    const other = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])
    const token = await issue({ sub: 'tester', iat: 0, exp: farFuture() }, other.privateKey)
    expect(await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)).toEqual({
      valid: false,
      expMs: null,
    })
  })

  it('payload を書き換えたトークンは通らない（対照）', async () => {
    const token = await issue({ sub: 'tester', iat: 0, exp: farFuture() })
    const tampered = swapPayload(token, { sub: 'x', exp: farFuture() })
    expect((await verifyArrivalTokenWithKeyForTest(tampered, publicKeyBase64)).valid).toBe(false)
  })

  it('失効したトークンは通らない', async () => {
    const token = await issue({ sub: 'tester', iat: 0, exp: Math.floor(Date.now() / 1000) - 1 })
    expect((await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)).valid).toBe(false)
  })

  it('失効日を持たないトークンは通らない（安全弁）', async () => {
    // 期限が無いトークンは失効させられない。作れてしまうと、渡した相手の分を取り消す手段が消える。
    const token = await issue({ sub: 'tester', iat: 0 })
    expect((await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)).valid).toBe(false)
  })

  it('失効日が有限でないトークンは通らない（安全弁）', async () => {
    // `JSON.parse` は `1e400` を `Infinity` へ読む。`typeof` は `number` を通すので、
    // 「期限を持たないトークンは通さない」の抜け道になる。
    const payloadPart = toBase64Url(new TextEncoder().encode('{"sub":"tester","exp":1e400}'))
    const sig = await crypto.subtle.sign(SIGN, privateKey, new TextEncoder().encode(payloadPart))
    const token = `${payloadPart}.${toBase64Url(sig)}`
    expect((await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)).valid).toBe(false)
  })

  it.each([
    ['空文字', ''],
    ['空白だけ', '   '],
    ['区切りが無い', 'abcdef'],
    ['区切りが 2 つ', 'a.b.c'],
    ['payload が空', '.abc'],
    ['署名が空', 'abc.'],
    ['base64 として壊れている', '!!!.???'],
  ])('形式が違うトークンは通らない: %s', async (_name, token) => {
    expect((await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)).valid).toBe(false)
  })
})

describe('verifyArrivalToken', () => {
  it('埋め込みの公開鍵では、テスト用の鍵で署名したトークンは通らない（安全弁）', async () => {
    // **信頼の根が差し替わっていないことの確認。** `verifyArrivalToken` が
    // `verifyArrivalTokenWithKeyForTest` と同じ鍵を使ってしまうと、テスト用の鍵で作った
    // トークンが本番でも通ることになる。
    const token = await issue({ sub: 'tester', iat: 0, exp: farFuture() })
    expect((await verifyArrivalToken(token)).valid).toBe(false)
  })

  it('未設定（空文字）は通らない', async () => {
    expect((await verifyArrivalToken('')).valid).toBe(false)
  })
})
