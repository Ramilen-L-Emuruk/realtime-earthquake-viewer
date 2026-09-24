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
import { formatDateTimeMin } from './formatters'
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
 * 通らなかった理由。**画面に出すためのもので、門の判定には使わない。**
 *
 * `empty` は未入力。設定を触っていない端末では記録も表示も出さないので、他と分けてある。
 */
export type ArrivalTokenProblem = 'empty' | 'malformed' | 'signature' | 'no-expiry' | 'expired' | 'error'

/**
 * 検証の結果。
 *
 * **失効時刻まで返すのは、呼び出し側が再検証を張れるようにするため。** 真偽だけを返す形だと
 * 「いつ閉じればよいか」が判らず、トークン文字列が変わるまで開いたままになる（→ `hooks/useArrivalToken.ts`）。
 *
 * **理由まで返すのは、画面に出すため。** 返していなかった頃は、成功も 5 通りの失敗も設定タブでは
 * 同じ見た目（何も出ない）で、確かめる手段が開発者コンソールか実際の緊急地震速報しか無かった。
 * とくに「鍵の組を作り直したのに `PUBLIC_KEY_SPKI_BASE64` を貼り忘れた」事故は、症状が
 * 「署名が合わない」だけなので、気づく契機がここにしか無い。
 *
 * **門は `valid` のままにする。** 理由で分岐して開く形にすると、それ自体が抜け道になる。
 */
export interface ArrivalTokenCheck {
  valid: boolean
  /**
   * 失効時刻（epoch ms）。読めなかったときは null。
   *
   * **失効している場合も返す** —— いつ切れたのかを画面に出すため。`valid` が偽なのに値が
   * 入っているのはこの場合だけで、再検証を張る側は `valid` を先に見るので影響しない。
   */
  expMs: number | null
  /** 通らなかった理由。通ったときは null。 */
  problem: ArrivalTokenProblem | null
}

/**
 * 検証の結果に「まだ終わっていない」を足したもの。**検証を走らせる側が作る**
 * （→ `hooks/useArrivalToken.ts`）。
 *
 * 型をここに置いているのは、この下の `arrivalTokenStatusLine` が受け取るため。
 * hook 側に置くと、画面の文言を組む述語が React へ依存することになる。
 */
export interface ArrivalTokenStatus extends ArrivalTokenCheck {
  /**
   * 検証中。**`valid` は偽なので、門としては閉じている。**
   *
   * 画面に出すために要る —— 失敗と区別できないと、トークンを貼った直後に
   * 「使えないキー」と読める表示が一瞬出る。
   */
  checking: boolean
}

const fail = (problem: ArrivalTokenProblem, expMs: number | null = null): ArrivalTokenCheck => ({
  valid: false,
  expMs,
  problem,
})

/**
 * `Date` が表せるミリ秒の範囲（±8.64e15 ＝ 西暦 275760 年あたりまで）。
 *
 * **`Number.isFinite` では足りない。** これを 1 でも超える有限の数値を `new Date(...)` へ渡すと
 * `toISOString()` が `RangeError` を投げる（実測: `8_640_000_000_000_000` は通り、
 * `8_640_000_000_000_001` と `1e20` は投げる）。
 */
const MAX_DATE_MS = 8_640_000_000_000_000

/** その値を `Date` にして日時として書き出せるか（上の範囲に収まるか）。 */
const isDateRepresentableMs = (ms: number): boolean =>
  Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS

/**
 * 画面に出す文言。**理由ごとに次の行動が変わる**ので、1 つの「無効です」へ畳まない。
 *
 * 語は設定タブの見出し（「到達予想キー」）に合わせて「キー」で書く。「トークン」「署名」は
 * 実装の語で、受け取って貼るだけの利用者には通じない。未入力は出す文が無いので null を返す。
 */
export function arrivalTokenProblemMessage(problem: ArrivalTokenProblem): string | null {
  switch (problem) {
    case 'empty':
      return null
    case 'malformed':
      return 'キーの形が違います。渡された文字列をそのまま貼ってください'
    case 'signature':
      return 'このアプリでは使えないキーです。配布元へ問い合わせてください'
    case 'no-expiry':
      return 'キーに有効期限がありません。発行し直してもらってください'
    case 'expired':
      return '有効期限が切れています。発行し直してもらってください'
    case 'error':
      return 'キーを検証できませんでした'
    default: {
      // **理由を足したら文も足す。** ここで型が合わなくなるので、書き忘れたまま通らない。
      const exhaustive: never = problem
      return exhaustive
    }
  }
}

/** 状態を表す 3 つの調子。**色の名前ではなく意味で持つ** —— 色は描く側が決める。 */
export type ArrivalTokenStatusTone = 'checking' | 'valid' | 'problem'

/** 設定タブへ出す 1 行。出すものが無ければ `null`（→ `arrivalTokenStatusLine`）。 */
export interface ArrivalTokenStatusLine {
  tone: ArrivalTokenStatusTone
  text: string
}

/**
 * 到達予想キーの状態を、設定タブへ出す 1 行へ畳む。
 *
 * **描画から判断を出してある。** 分岐が 5 通り（未入力・検証中・有効・失効・その他の理由）
 * あり、JSX の中に書くとテストで押さえられない。**入力欄の枠を赤くするかも同じ答えから
 * 決める**（`tone === 'problem'`）—— 条件を別に書くと、文は出ているのに枠は普通、という
 * 食い違いが起きる。
 *
 * **未入力では何も出さない** —— 触っていない利用者に「使えません」と読める表示を置かない
 * （入力欄の `未設定` が既にそれを伝えている）。
 */
export function arrivalTokenStatusLine(status: ArrivalTokenStatus): ArrivalTokenStatusLine | null {
  if (status.problem === 'empty') return null
  if (status.checking) return { tone: 'checking', text: '確認中' }
  // 期限は `expMs` から組む。日時の整形は `formatters.ts` を通し、読めなければ期限を省く。
  //
  // **`Date` へ渡す前に範囲を見る**（`isDateRepresentableMs`）—— 範囲外の値の `toISOString()` は
  // 例外を投げ、**それがレンダー中に起きるので設定タブが丸ごと差し替わる**（`ErrorBoundary` は
  // タブ単位）。しかも直すための入力欄がその中にあるので、画面からは復旧できない。
  // 検証の側が範囲外の期限を通さないので実際には来ないが、状態は外から渡されるので二重に見る。
  const at =
    status.expMs === null || !isDateRepresentableMs(status.expMs)
      ? null
      : formatDateTimeMin(new Date(status.expMs).toISOString())
  if (status.valid) return { tone: 'valid', text: at ? `有効（${at} まで）` : '有効' }
  // **ここへは来ない** —— `problem` が null になるのは「通った」か「検証中」で、どちらも上で
  // 返している。型のうえで残る枝なので、何も出さない側へ倒す（`valid` が門なので影響しない）。
  if (status.problem === null) return null
  const message = arrivalTokenProblemMessage(status.problem)
  if (message === null) return null
  // 失効だけは「いつ切れたか」を添える —— 再発行を頼むかどうかの判断が付く。
  const prefix = status.problem === 'expired' && at ? `${at} に` : ''
  return { tone: 'problem', text: `${prefix}${message}` }
}

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
  if (!trimmed) return fail('empty')
  const dot = trimmed.indexOf('.')
  if (dot <= 0 || dot === trimmed.length - 1 || trimmed.indexOf('.', dot + 1) !== -1) {
    log.warn('[arrival] トークンの形式が違います（<payload>.<signature> の 2 部であること）')
    return fail('malformed')
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
      return fail('signature')
    }
    const payload: TokenPayload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadPart)))
    // **失効の判定はサーバー同期時刻で行う。** 端末の壁時計は信用しない（`utils/clock.ts`）。
    //
    // **有限であることまで見る。** `JSON.parse('{"exp":1e400}')` は `Infinity` を返し、
    // `typeof` は `number` を通すので、失効しないトークンを作れる形になる。秘密鍵を持たない
    // 第三者には作れない（署名の対象そのもの）が、失効を仕組みの中核に据えている以上
    // 「期限を持たないトークンは通さない」の例外を残さない。
    //
    // **`Date` にできる範囲かも見る。** 有限でも範囲外（西暦 275760 年より後）の期限は
    // 実質「失効しない」ので、上と同じ理由で通さない。あわせて、通してしまうと画面が
    // その値を日時へ整形しようとして落ちる（→ `arrivalTokenStatusLine`）。
    // **発行側にも上限がある**（`scripts/sign-arrival-token.ts` の `--days`）が、
    // 配り終えたトークンには効かないので受け取る側でも見る。
    const exp =
      typeof payload.exp === 'number' && isDateRepresentableMs(payload.exp * 1000)
        ? payload.exp
        : null
    if (exp === null) {
      // 「持っていない」と「持っているが日時として扱えない」を書き分ける —— 前者は発行の
      // 手違い、後者は `--days` の打ち間違いで、直す場所が違う。
      log.warn(
        typeof payload.exp === 'number'
          ? '[arrival] トークンの失効日が日時として扱える範囲を超えています'
          : '[arrival] トークンに失効日がありません',
      )
      return fail('no-expiry')
    }
    if (serverNow() / 1000 > exp) {
      log.warn('[arrival] トークンが失効しています')
      return fail('expired', exp * 1000)
    }
    return { valid: true, expMs: exp * 1000, problem: null }
  } catch (err) {
    log.warn('[arrival] トークンを検証できません', err)
    return fail('error')
  }
}
