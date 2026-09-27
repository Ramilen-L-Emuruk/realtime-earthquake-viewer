// 各タブが共通で使う小さな DOM ヘルパー。

/** `container` の下から 1 要素だけ探す。**無ければ投げる**——見つからないのは
 * 呼び出し側のセレクタの書き間違いで、握りつぶすと画面が無言で真っ白になる。 */
export function qs<T extends Element = HTMLElement>(container: ParentNode, selector: string): T {
  const el = container.querySelector<T>(selector)
  if (el === null) throw new Error(`要素が見つからない: ${selector}`)
  return el
}

/** テーブルへ差し込む前に HTML エスケープする（`displayName` 等は運用者の自由入力）。 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** `null` を空欄で出す。**`0` を空欄と混同しない**——`??` ではなく明示の分岐。 */
export function formatNumber(value: number | null): string {
  return value === null ? '' : String(value)
}
