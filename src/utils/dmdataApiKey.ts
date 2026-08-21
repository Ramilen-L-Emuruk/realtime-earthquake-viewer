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
 * APIキーが `btoa` と HTTP ヘッダに載せられない文字を含むことを表すエラー。
 *
 * 通常の通信失敗（401/403・ネットワーク断）と区別するために独立した型にしている。
 * `DmdataWebSocket` はこれを認証エラーと同じ「再試行しても直らない失敗」として扱う。
 */
export class DmdataApiKeyError extends Error {
  constructor() {
    super(DMDATA_API_KEY_INVALID_MESSAGE)
    this.name = 'DmdataApiKeyError'
  }
}

/**
 * APIキーが通信に使える形かを判定する。
 *
 * @param apiKey 設定タブに入力された値
 * @returns 空でなく、全文字が印字可能 ASCII なら true
 */
export function isValidDmdataApiKey(apiKey: string): boolean {
  return PRINTABLE_ASCII_ONLY.test(apiKey)
}

/**
 * Basic 認証ヘッダ（`Basic base64(apiKey:)`）を組む。
 *
 * @param apiKey 設定タブに入力された値
 * @returns `Authorization` ヘッダの値
 * @throws {DmdataApiKeyError} キーが空、または印字可能 ASCII 以外を含む場合。
 *   `btoa` の DOMException をそのまま投げると呼び出し元が理由を判別できないため、
 *   到達前に自前の型へ置き換える。
 */
export function authHeader(apiKey: string): string {
  if (!isValidDmdataApiKey(apiKey)) throw new DmdataApiKeyError()
  return 'Basic ' + btoa(apiKey + ':')
}
