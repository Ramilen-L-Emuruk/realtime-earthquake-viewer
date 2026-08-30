/**
 * 設定行の説明文の吹き出し（`DescriptionTip`）の配置計算。
 *
 * 画面端での上下反転・左右クランプという閾値依存の分岐を持つため、DOM から切り離した
 * 純粋関数として置く（ビューポートは引数で受け取る）。同じ構成の前例は
 * `src/components/Map/gl/bounds.ts` / `camera.ts`。
 */

// 吹き出しの最大幅。パネルが最も狭い sideNarrow（w-panel-narrow = 22rem）に収まる値にする。
// rem で持つのは UI 倍率（ルートの font-size）に追従させるため。
export const TIP_MAX_WIDTH_REM = 18
// 基準の行と吹き出しの間隔。
export const TIP_GAP_PX = 6
// 画面端に対して残す余白。左右のクランプと上下の反転判定で共通に使う。
export const VIEWPORT_MARGIN_PX = 8

/** 吹き出しの配置（`position: fixed` の実座標・CSS px）。 */
export interface TipPlacement {
  left: number
  top: number
}

/** 基準にする矩形。`DOMRect` のうち計算に使う 3 辺だけを要求する。 */
export interface AnchorRect {
  left: number
  top: number
  bottom: number
}

export interface Viewport {
  width: number
  height: number
}

/**
 * 折り返し幅。高さは幅が決まらないと測れないので、位置より先に確定させる。
 * 画面が狭いときは倍率よりも画面幅を優先する（高倍率のスマホで画面外へ広がらないように）。
 */
export function tipMaxWidth(viewportWidth: number, rootFontPx: number): number {
  return Math.min(TIP_MAX_WIDTH_REM * rootFontPx, viewportWidth - VIEWPORT_MARGIN_PX * 2)
}

/**
 * 基準の矩形と実測した高さから、画面内に収まる配置を決める。
 *
 * 縦は「行の下」を既定とし、収まらないぶんだけ上へ反転する。最長の説明文（196 文字）は
 * 8 行・約 150px になるため、画面下端に近い行では必ず反転が必要になる。
 * 上にも収まらない場合（吹き出しが画面高に近い）は画面内へクランプする。
 */
export function computePlacement(
  anchor: AnchorRect,
  tipHeight: number,
  maxWidth: number,
  viewport: Viewport,
): TipPlacement {
  // 横: 基準の左端に揃え、右にはみ出す分だけ左へ寄せる。左端もはみ出すなら余白位置で止める。
  let left = anchor.left
  if (left + maxWidth > viewport.width - VIEWPORT_MARGIN_PX) {
    left = viewport.width - VIEWPORT_MARGIN_PX - maxWidth
  }
  if (left < VIEWPORT_MARGIN_PX) left = VIEWPORT_MARGIN_PX

  // 縦: 下に出しきれるならそのまま。無理なら上へ反転し、それも無理なら画面内へ収める。
  let top = anchor.bottom + TIP_GAP_PX
  if (top + tipHeight > viewport.height - VIEWPORT_MARGIN_PX) {
    const above = anchor.top - TIP_GAP_PX - tipHeight
    top = above >= VIEWPORT_MARGIN_PX
      ? above
      : Math.max(VIEWPORT_MARGIN_PX, viewport.height - VIEWPORT_MARGIN_PX - tipHeight)
  }

  return { left, top }
}
