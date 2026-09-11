/**
 * バナーから開く付加文の面（→ docs/spec/tsunami-spec.md §9）の高さを決める。
 *
 * **寸法の判断をコンポーネントの外へ出してある。** 描画の中に置くと、`ResizeObserver` を
 * 差し替えないと動かせず、テストで押さえられない（実際に押さえられないまま 3 巡続けて
 * 指摘が出た）。ここなら数値を渡すだけで確かめられる。
 */

/** 面の下端とパネルの下端のあいだに残す隙間（px）。 */
export const COMMENTS_OVERLAY_GAP = 8

/**
 * 面を出すのに要る最低の高さ（px）。本文は 11px・行間 1.6 なので、これで 2 行ぶんにあたる。
 *
 * これを割るなら**開かせない**（→ {@link canShowCommentsOverlay}）。中身が 1 行も見えない
 * 面を開くと、矢印だけ ▶→▼ に変わって何も起きず、理由も出ない。
 */
export const COMMENTS_MIN_HEIGHT = 48

/**
 * 面の高さの上限を返す。まだ測れていなければ `undefined`。
 *
 * **パネルの実寸から引く。** 画面の高さ（`vh`）で切ると、上下分割でパネルが画面の一部しか
 * 占めていないときに下へはみ出す。
 *
 * **下限を置かない。** 「狭くても最低これだけは出す」という床を置くと、パネルを縮めたときに
 * 床の方が残りより大きくなり、はみ出させない目的そのものを裏切る。狭ければ狭いまま返す。
 */
export function commentsOverlayMaxHeight(panelHeight: number, bannerHeight: number): number | undefined {
  if (panelHeight <= 0) return undefined
  return Math.max(0, panelHeight - bannerHeight - COMMENTS_OVERLAY_GAP)
}

/**
 * 面を開かせてよいか。
 *
 * `undefined`（まだ測れていない）は**開かせる側へ倒す**。測る前に閉じると、表示された直後の
 * 数フレームだけ押せない入口になり、利用者からは「押しても反応しないことがある」に見える。
 */
export function canShowCommentsOverlay(maxHeight: number | undefined): boolean {
  return maxHeight === undefined || maxHeight >= COMMENTS_MIN_HEIGHT
}
