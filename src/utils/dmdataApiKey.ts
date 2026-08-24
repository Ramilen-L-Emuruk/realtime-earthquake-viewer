// DMDATA.JP API キーの妥当性判定と Basic 認証ヘッダの単一実装。
//
// キーは Basic 認証の材料として HTTP ヘッダ値に載るため、ASCII 以外は載せられない。
// 判定を置いていなかった頃、日本語入力の変換途中の値が設定欄に入ると `btoa` が
// InvalidCharacterError を投げ、それが 3 系統に別々の形で漏れていた:
//   - 履歴取得: Promise.all の .catch に落ち、地震タブに英語の DOMException メッセージが出る
//   - WebSocket: `tryConnect` の catch が 'auth' と一致しないため 30 秒間隔で永久に再試行し続ける
//     （失敗ログはデバッグフラグ配下なので無音のまま）
//   - ヒートマップ: warn だけ残して空表示になる
// 通信を起こす前にここで弾き、理由をユーザーに見せるための土台。
//
// 許す文字は印字可能 ASCII（0x21-0x7E）に限る。キーの書式そのものを当てにいかないのは意図的で、
// 実在のキーにはピリオドが含まれる。英数だけに絞ると正規のキーを弾く事故になる。
// ここで判定したいのは「`btoa` と HTTP ヘッダを壊さないか」だけ。

// 印字可能 ASCII のみ。空白・制御文字・非 ASCII（全角・日本語等）を除く。
const PRINTABLE_ASCII_ONLY = /^[\x21-\x7E]+$/

/**
 * APIキーが不正なときにユーザーへ見せる文言。設定タブの入力欄と履歴取得のエラー表示で
 * 同じ文を使う（片方だけ直して食い違うのを防ぐ）。
 */
export const DMDATA_API_KEY_INVALID_MESSAGE =
  'APIキーに使用できない文字が含まれています。半角の英数字・記号のみで入力してください。'

/**
 * APIキーが未設定のときにユーザーへ見せる文言。
 *
 * **「不正な文字」と言い分けるのが要点。** 原因も対処も違う——未設定は利用者がまだ入れていない
 * 状態（入れれば直る）で、不正は入れた値が通信に載せられない状態（直し方が分からないと詰まる）。
 * 同じ文で通知すると、一度も入力していない人に「使用できない文字が含まれています」と告げることに
 * なり、入れた覚えのない文字を探させる（2026-08-24 にリプレイの経路で実際に起きた）。
 */
// 文言は場所に依らない形にする。この文は設定タブ（リプレイの失敗表示）にも出るため、
// 「設定タブで」と案内すると、その設定タブの中で自分を指すことになる。
export const DMDATA_API_KEY_MISSING_MESSAGE =
  'APIキーが未設定です。DM-D.S.S の APIキーを設定してください。'

/** APIキーが通信に使えない理由。 */
export type DmdataApiKeyProblem = 'missing' | 'invalid'

/**
 * APIキーが通信に使えるかを判定し、使えない場合はその理由を返す。
 *
 * @param apiKey 設定タブに入力された値
 * @returns 使えるなら null、未設定なら `'missing'`、印字可能 ASCII 以外を含むなら `'invalid'`
 */
export function dmdataApiKeyProblem(apiKey: string): DmdataApiKeyProblem | null {
  if (apiKey === '') return 'missing'
  return PRINTABLE_ASCII_ONLY.test(apiKey) ? null : 'invalid'
}

/** 上の理由に対応するユーザー向けの文言。**文言の選び方はここ 1 箇所に集約する。** */
export function dmdataApiKeyMessage(problem: DmdataApiKeyProblem): string {
  return problem === 'missing' ? DMDATA_API_KEY_MISSING_MESSAGE : DMDATA_API_KEY_INVALID_MESSAGE
}

/**
 * APIキーが通信に使えない（未設定、または `btoa` と HTTP ヘッダに載せられない文字を含む）ことを
 * 表すエラー。
 *
 * 通常の通信失敗（401/403・ネットワーク断）と区別するために独立した型にしている。
 * `DmdataWebSocket` はこれを認証エラーと同じ「再試行しても直らない失敗」として扱う。
 *
 * `problem` を持たせているのは、**受け取った側が文言を組み直さずに済むように**するため
 * （`message` は既に理由に合ったものになっている）。分岐したい場合だけ参照する。
 */
export class DmdataApiKeyError extends Error {
  readonly problem: DmdataApiKeyProblem

  constructor(problem: DmdataApiKeyProblem) {
    super(dmdataApiKeyMessage(problem))
    this.name = 'DmdataApiKeyError'
    this.problem = problem
  }
}

/**
 * APIキーが通信に使える形かを判定する。理由を問わない呼び出し側のための薄い包み
 * （理由で分岐する場合は `dmdataApiKeyProblem` を使う）。
 *
 * @param apiKey 設定タブに入力された値
 * @returns 空でなく、全文字が印字可能 ASCII なら true
 */
export function isValidDmdataApiKey(apiKey: string): boolean {
  return dmdataApiKeyProblem(apiKey) === null
}

/**
 * Basic 認証ヘッダ（`Basic base64(apiKey:)`）を組む。
 *
 * @param apiKey 設定タブに入力された値
 * @returns `Authorization` ヘッダの値
 * @throws {DmdataApiKeyError} キーが空、または印字可能 ASCII 以外を含む場合。
 *   `btoa` の DOMException をそのまま投げると呼び出し元が理由を判別できないため、
 *   到達前に自前の型へ置き換える。**未設定と不正は別の文言で投げる**——この関数を直に叩く経路
 *   （リプレイの取得）は手前で未設定を弾いていないため、ここの文言がそのままログに出る。
 */
export function authHeader(apiKey: string): string {
  const problem = dmdataApiKeyProblem(apiKey)
  if (problem) throw new DmdataApiKeyError(problem)
  return 'Basic ' + btoa(apiKey + ':')
}
