import { getLpgmClassColor, getLpgmClassLabel } from '../../../utils/lpgm'

// 長周期地震動の階級ラベル付き四角バッジ HTML 要素（Leaflet 版 getLpgmRegionIcon 相当）。
// 区域ラベル（LpgmRegionFillGL）・観測点ラベル（LpgmPointsGL）で共有する。

/** 強い階級ほど前面に来るよう、DOM z-index に階級を反映させる際の係数。 */
export const LPGM_BADGE_Z = 1000

export function buildLpgmBadgeEl(lgInt: number, iconScale: number): HTMLDivElement {
  const size = 32 * iconScale
  const color = getLpgmClassColor(lgInt)
  const label = getLpgmClassLabel(lgInt).replace('階級', '')
  const fontSize = size * 0.5
  const el = document.createElement('div')
  el.style.cssText =
    `width:${size}px;height:${size}px;background:${color};border:2px solid rgba(255,255,255,0.8);` +
    `border-radius:3px;display:flex;align-items:center;justify-content:center;color:#fff;` +
    `font-weight:700;font-size:${fontSize}px;line-height:1;box-shadow:0 0 3px rgba(0,0,0,0.7);cursor:pointer`
  el.textContent = label
  return el
}
