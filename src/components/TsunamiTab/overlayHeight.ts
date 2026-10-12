/**
 * バナーから開く付加文の面（→ docs/spec/tsunami-spec.md §9）の高さを決める。
 *
 * **寸法の判断をコンポーネントの外へ出してある。** 描画の中に置くと、`ResizeObserver` を
 * 差し替えないと動かせず、テストで押さえられない（実際に押さえられないまま 3 巡続けて
 * 指摘が出た）。ここなら数値を渡すだけで確かめられる。
 */

/**
 * バナーを貼り付けたあと、区域の行のために残す高さの下限（px）。区域の見出しと観測点 1 行ほど。
 *
 * 貼り付けたバナーは、その高さぶん区域の行の居場所を恒久的に削る。パネルを縮めると
 * （上下分割で比率 0.2 など）バナーだけでパネルが埋まり、行に一度も届かなくなる
 * （実測と条件は docs/spec/tsunami-spec.md §9「スクロールの自動制御」）。読み上げの追従も
 * バナーの下を視野にするので、視野の高さが無くなって動かなくなる。
 *
 * **割合ではなく残りの高さで測る**（2026-10-12 ユーザー承認）。守りたいのは「行に届くこと」なので、
 * それを直接測る。パネルの半分を境にすると、既定の比率でも縦の短い画面で貼り付けが外れていた。
 */
export const BANNER_STICKY_MIN_ROOM_PX = 100

/**
 * バナーを貼り付けるか。**行の居場所が足りなくなるなら貼り付けをやめ、行と一緒に流す**（2026-10-12 ユーザー承認）。
 *
 * まだ測れていなければ（どちらかが 0 以下）貼り付ける側へ倒す —— 表示された直後の
 * 数フレームだけ貼り付けが外れて見えるのを避けるため。
 *
 * バナーの高さは貼り付けの有無で変わらないので、行き来して揺れることは無い。
 */
export function isBannerSticky(panelHeight: number, bannerHeight: number): boolean {
  if (panelHeight <= 0 || bannerHeight <= 0) return true
  return panelHeight - bannerHeight >= BANNER_STICKY_MIN_ROOM_PX
}

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
