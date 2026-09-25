// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import {
  verifyArrivalToken, verifyArrivalTokenWithKeyForTest, arrivalTokenProblemMessage,
  arrivalTokenStatusLine,
  type ArrivalTokenProblem, type ArrivalTokenStatus,
} from './arrivalToken'
import { formatDateTimeMin } from './formatters'

// **鍵の組をその場で作って往復させる。** 本物の秘密鍵は `.env.local` にしか無く CI には無いので、
// 「本物のトークンが通ること」はここでは確かめられない。代わりに**同じアルゴリズム指定で
// 署名したものが通り、細工したものが落ちること**を固定する。発行スクリプト側が同じ指定
// （ECDSA P-256 / SHA-256・署名は r‖s の生の 64 バイト）で署名しているのは
// `scripts/sign-arrival-token.ts` のコメントが単一情報源。
//
// **通らなかった理由も固定する。** 理由は設定タブに出す唯一の手掛かりで、取り違えると
// 「期限切れなのに鍵違いと案内する」形で利用者を別の行動へ誘導する。

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
    // **通ったときの理由は null。** 設定タブはこれを見て「有効」と出す。
    expect(await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)).toEqual({
      valid: true,
      expMs: exp * 1000,
      problem: null,
    })
  })

  it('別の鍵で署名したトークンは通らない（偽造の防止）', async () => {
    const other = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])
    const token = await issue({ sub: 'tester', iat: 0, exp: farFuture() }, other.privateKey)
    // **`signature` を返す。** 「鍵の組を作り直したのに公開鍵を貼り忘れた」事故もここへ落ちる。
    expect(await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)).toEqual({
      valid: false,
      expMs: null,
      problem: 'signature',
    })
  })

  it('payload を書き換えたトークンは通らない（対照）', async () => {
    const token = await issue({ sub: 'tester', iat: 0, exp: farFuture() })
    const tampered = swapPayload(token, { sub: 'x', exp: farFuture() })
    const result = await verifyArrivalTokenWithKeyForTest(tampered, publicKeyBase64)
    expect(result.valid).toBe(false)
    expect(result.problem).toBe('signature')
  })

  it('失効したトークンは通らない', async () => {
    const exp = Math.floor(Date.now() / 1000) - 1
    const token = await issue({ sub: 'tester', iat: 0, exp })
    const result = await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)
    expect(result.valid).toBe(false)
    expect(result.problem).toBe('expired')
    // **失効だけは期限も返す。** 画面が「いつ切れたか」を出せないと、再発行を頼むかどうかの
    // 判断が付かない。`valid` は偽なので門は開かない（安全弁は下の `expired でも通らない`）。
    expect(result.expMs).toBe(exp * 1000)
  })

  it('失効日を持たないトークンは通らない（安全弁）', async () => {
    // 期限が無いトークンは失効させられない。作れてしまうと、渡した相手の分を取り消す手段が消える。
    const token = await issue({ sub: 'tester', iat: 0 })
    const result = await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)
    expect(result.valid).toBe(false)
    expect(result.problem).toBe('no-expiry')
  })

  it('失効日が有限でないトークンは通らない（安全弁）', async () => {
    // `JSON.parse` は `1e400` を `Infinity` へ読む。`typeof` は `number` を通すので、
    // 「期限を持たないトークンは通さない」の抜け道になる。
    const payloadPart = toBase64Url(new TextEncoder().encode('{"sub":"tester","exp":1e400}'))
    const sig = await crypto.subtle.sign(SIGN, privateKey, new TextEncoder().encode(payloadPart))
    const token = `${payloadPart}.${toBase64Url(sig)}`
    const result = await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)
    expect(result.valid).toBe(false)
    expect(result.problem).toBe('no-expiry')
  })

  it('失効日が `Date` の範囲を超えるトークンは通らない（安全弁）', async () => {
    // **有限でも `Date` にできない期限は通さない。** 理由は 2 つ重なる ——
    // ①西暦 275760 年より後の失効は実質「失効しない」ので、1 つ上と同じ理由で弾く
    // ②通すと画面がその値を日時へ整形しようとして落ちる（→ `arrivalTokenStatusLine`）
    // 発行側にも上限（`--days`）を置いたが、配り終えたトークンには効かない。
    const token = await issue({ sub: 'tester', iat: 0, exp: 1e16 })
    const result = await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)
    expect(result.valid).toBe(false)
    expect(result.problem).toBe('no-expiry')
  })

  it('失効日が `Date` の範囲に収まっていれば通る（対照）', async () => {
    // 上を「大きすぎる値は全部弾く」へ広げないための境目。西暦 5138 年でも通る。
    const token = await issue({ sub: 'tester', iat: 0, exp: 1e11 })
    expect((await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)).valid).toBe(true)
  })

  it.each<[string, string, ArrivalTokenProblem]>([
    ['空文字', '', 'empty'],
    ['空白だけ', '   ', 'empty'],
    ['区切りが無い', 'abcdef', 'malformed'],
    ['区切りが 2 つ', 'a.b.c', 'malformed'],
    ['payload が空', '.abc', 'malformed'],
    ['署名が空', 'abc.', 'malformed'],
    // 形は 2 部だが base64 として復号できない。**形式の誤りとは別の理由へ落ちる**
    // （復号の例外は `error` で受ける）。
    ['base64 として壊れている', '!!!.???', 'error'],
  ])('形式が違うトークンは通らない: %s', async (_name, token, problem) => {
    const result = await verifyArrivalTokenWithKeyForTest(token, publicKeyBase64)
    expect(result.valid).toBe(false)
    expect(result.problem).toBe(problem)
  })
})

describe('arrivalTokenProblemMessage', () => {
  it('未入力だけは文を持たない（対照）', () => {
    // 触っていない利用者の画面に「使えません」と読める表示を出さないための印。
    expect(arrivalTokenProblemMessage('empty')).toBe(null)
  })

  it.each<ArrivalTokenProblem>(['malformed', 'signature', 'no-expiry', 'expired', 'error'])(
    '理由ごとに異なる文を返す: %s',
    (problem) => {
      const message = arrivalTokenProblemMessage(problem)
      expect(message).not.toBe(null)
      expect(message).not.toBe('')
      // **実装の語を画面へ出さない。** 受け取って貼るだけの利用者には通じない
      // （欄の見出しに合わせて「キー」で書く）。
      expect(message).not.toMatch(/トークン|署名|payload/)
    },
  )

  it('理由ごとに文が重複しない（安全弁）', () => {
    // 1 つの「無効です」へ畳むと、期限切れと鍵違いで次の行動が変わることが伝わらない。
    const messages = (['malformed', 'signature', 'no-expiry', 'expired', 'error'] as const)
      .map(arrivalTokenProblemMessage)
    expect(new Set(messages).size).toBe(messages.length)
  })
})

// **設定タブの表示の判断をここで固定する。** 分岐が 5 通り（未入力・検証中・有効・失効・
// その他の理由）あり、描画の中に置くと押さえられない。日時の書式そのものは `formatters.ts`
// 側のテストが持つので、ここでは同じ述語を通した値が文へ入っていることだけを見る。
describe('arrivalTokenStatusLine', () => {
  const status = (over: Partial<ArrivalTokenStatus>): ArrivalTokenStatus => ({
    valid: false, expMs: null, problem: null, checking: false, ...over,
  })
  const AT_MS = Date.UTC(2027, 8, 22, 3, 45)
  const at = () => formatDateTimeMin(new Date(AT_MS).toISOString())

  it('未入力では何も出さない（対照）', () => {
    // 触っていない利用者の画面に「使えません」と読める表示を置かない。
    expect(arrivalTokenStatusLine(status({ problem: 'empty' }))).toBe(null)
  })

  it('検証が済むまでは「確認中」で、赤くはしない（正）', () => {
    // 失敗と同じ見た目にすると、貼った直後に「使えないキー」と読める表示が一瞬出る。
    expect(arrivalTokenStatusLine(status({ checking: true }))).toEqual({
      tone: 'checking', text: '確認中',
    })
  })

  it('通ったら期限まで添える（正）', () => {
    const line = arrivalTokenStatusLine(status({ valid: true, expMs: AT_MS }))
    expect(line?.tone).toBe('valid')
    expect(line?.text).toBe(`有効（${at()} まで）`)
  })

  it('期限を組めなければ「有効」だけにする（安全弁）', () => {
    // 期限が読めないことは門の判断ではないので、通ったこと自体は伝える。
    expect(arrivalTokenStatusLine(status({ valid: true, expMs: null }))?.text).toBe('有効')
    // 非有限値の `toISOString()` は例外を投げる。描画ごと落とさない。
    expect(arrivalTokenStatusLine(status({ valid: true, expMs: Number.POSITIVE_INFINITY }))?.text)
      .toBe('有効')
  })

  it('`Date` の範囲を超える期限でも例外にしない（安全弁）', () => {
    // **`Number.isFinite` では足りない。** 有限でもここを超えると `toISOString()` が投げ、
    // それがレンダー中なので設定タブが丸ごと `ErrorBoundary` へ差し替わる（直すための
    // 入力欄もその中にあるので画面から復旧できない）。
    const OVER = 8_640_000_000_000_001
    expect(() => new Date(OVER).toISOString()).toThrow(RangeError)
    expect(arrivalTokenStatusLine(status({ valid: true, expMs: OVER }))?.text).toBe('有効')
    expect(arrivalTokenStatusLine(status({ problem: 'expired', expMs: OVER }))?.text)
      .toBe(arrivalTokenProblemMessage('expired'))
  })

  it('範囲の境目（`Date` が表せる上限そのもの）は期限を出す（対照）', () => {
    // ここで弾く側へ倒すと、境目の 1 ミリ秒だけ期限が消える。
    const EDGE = 8_640_000_000_000_000
    const at = formatDateTimeMin(new Date(EDGE).toISOString())
    expect(at).not.toBe(null)
    expect(arrivalTokenStatusLine(status({ valid: true, expMs: EDGE }))?.text)
      .toBe(`有効（${at} まで）`)
  })

  it('失効だけは「いつ切れたか」を添える（正）', () => {
    const line = arrivalTokenStatusLine(status({ problem: 'expired', expMs: AT_MS }))
    expect(line?.tone).toBe('problem')
    expect(line?.text).toBe(`${at()} に${arrivalTokenProblemMessage('expired')}`)
  })

  it('失効以外は時刻を添えない（対照）', () => {
    // 時刻を無条件に前置きすると、鍵違いを「その時刻に何かが起きた」と読ませる。
    const line = arrivalTokenStatusLine(status({ problem: 'signature', expMs: AT_MS }))
    expect(line?.text).toBe(arrivalTokenProblemMessage('signature'))
  })

  it.each<ArrivalTokenProblem>(['malformed', 'signature', 'no-expiry', 'expired', 'error'])(
    '理由の文は `arrivalTokenProblemMessage` から採る: %s',
    (problem) => {
      const line = arrivalTokenStatusLine(status({ problem }))
      // 枠を赤くするかはこの `tone` が決める（設定タブは同じ答えを 2 度使う）。
      expect(line?.tone).toBe('problem')
      const message = arrivalTokenProblemMessage(problem)
      if (message === null) throw new Error(`${problem} には文があるはず`)
      expect(line?.text).toContain(message)
    },
  )
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
