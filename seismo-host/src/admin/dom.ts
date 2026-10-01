// 各タブが共通で使う小さなヘルパー（DOM の取得と、画面へ出す値の整形）。

import { STALE_AFTER_MS } from '../receiver/assignedReception'

/**
 * 最後に声を聞いてから「途絶」と見なすまで。**値はホストの警告と共有する**
 * （`receiver/assignedReception.ts`）—— 画面とログで物差しがずれないように。
 */
export { STALE_AFTER_MS }

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

/** 最後に声を聞いてからの経過。**`null`（まだ一度も無い）を `0 秒前` にしない。** */
export function ago(nowMs: number, atMs: number | null): string {
  if (atMs === null) return '未受信'
  const sec = Math.max(0, Math.round((nowMs - atMs) / 1000))
  return `${sec} 秒前`
}

/** 途絶しているか。**まだ一度も届いていない（`null`）も途絶に含める。** */
export function isStale(nowMs: number, atMs: number | null): boolean {
  return atMs === null || nowMs - atMs > STALE_AFTER_MS
}

/** 受信中か途絶かのバッジ。**固定の文字列しか入らない**ので `escapeHtml` は要らない。 */
export function receptionBadgeHtml(nowMs: number, atMs: number | null): string {
  const stale = isStale(nowMs, atMs)
  return `<span class="badge ${stale ? 'stale' : 'ok'}">${stale ? '途絶' : '受信中'}</span>`
}
