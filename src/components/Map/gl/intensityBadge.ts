import { getIntensityColor, getIntensityLabel, getScaleRadius } from '../../../utils/intensity'

// 震度ラベル付きの丸バッジ HTML 要素（Leaflet 版 getIntensityIcon 相当）。
// 区域ラベル（QuakeRegionFillGL）・観測点ラベル（QuakeIntensityPointsGL）で共有する。

/** 強い震度ほど前面に来るよう、DOM z-index に scale を反映させる際の係数。 */
export const INTENSITY_BADGE_Z = 1000

export function buildIntensityBadgeEl(scale: number, iconScale: number): HTMLDivElement {
  const size = (getScaleRadius(scale) * 2 + 8) * iconScale
  const color = getIntensityColor(scale)
  const label = getIntensityLabel(scale)
  const fontSize = label.length > 1 ? size * 0.42 : size * 0.6
  const el = document.createElement('div')
  el.style.cssText =
    `width:${size}px;height:${size}px;background:${color};border:1px solid rgba(255,255,255,0.7);` +
    `border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;` +
    `font-weight:700;font-size:${fontSize}px;line-height:1;box-shadow:0 0 3px rgba(0,0,0,0.7);cursor:pointer`
  el.textContent = label
  return el
}
