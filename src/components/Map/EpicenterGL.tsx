import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { JMAQuake } from '../../types/earthquake'
import type { LatLng } from '../../utils/stationCoords'
import { getIntensityColor, getIntensityLabel } from '../../utils/intensity'
import { formatMagnitude, formatDepth } from '../../utils/formatters'
import { attachMarkerClaim } from './gl/popupRegistry'

// 地震モードの震源（×印）を描画する MapLibre 版（Leaflet 版 JapanMap の震源マーカー相当）。
// × アイコンは HTML の maplibregl.Marker（Leaflet の DivIcon SVG と同じ形）で最前面に置く。
// クリックで震源名・M・深さ・都道府県別最大震度（上位6件）のポップアップを開く。

interface Props {
  quake: JMAQuake
  epicenter: LatLng
  prefIntensities: [string, number][]
  iconScale: number
}

function buildCrossEl(iconScale: number): HTMLDivElement {
  const s = Math.round(32 * iconScale)
  const el = document.createElement('div')
  el.style.cssText = `width:${s}px;height:${s}px;cursor:pointer`
  el.innerHTML =
    `<svg viewBox="0 0 32 32" width="${s}" height="${s}" xmlns="http://www.w3.org/2000/svg">` +
    `<line x1="4" y1="4" x2="28" y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/>` +
    `<line x1="28" y1="4" x2="4" y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/></svg>`
  return el
}

function buildPopupHtml(quake: JMAQuake, prefIntensities: [string, number][]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const hc = quake.earthquake.hypocenter
  const rows = prefIntensities
    .slice(0, 6)
    .map(([pref, scale]) => {
      const color = getIntensityColor(scale)
      const label = getIntensityLabel(scale)
      return (
        `<div style="display:flex;align-items:center;gap:8px;font-size:12px">` +
        `<span style="display:inline-block;width:20px;text-align:center;font-weight:700;border-radius:3px;` +
        `color:#fff;font-size:10px;background:${color}">${esc(label)}</span>` +
        `<span style="color:#cbd5e1">${esc(pref)}</span></div>`
      )
    })
    .join('')
  return (
    `<div class="text-sm" style="min-width:160px">` +
    `<div class="font-bold" style="margin-bottom:4px">${esc(hc.name)}</div>` +
    `<div class="text-xs" style="color:#94a3b8">${esc(formatMagnitude(hc.magnitude))} / 深さ ${esc(formatDepth(hc.depth))}</div>` +
    (rows ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:2px">${rows}</div>` : '') +
    `</div>`
  )
}

export function EpicenterGL({ quake, epicenter, prefIntensities, iconScale }: Props) {
  const map = useMapGL()
  const markerRef = useRef<maplibregl.Marker | null>(null)

  useEffect(() => {
    if (!map) return
    const el = buildCrossEl(iconScale)
    const popup = new maplibregl.Popup({ closeButton: true, offset: Math.round(32 * iconScale) * 0.4 }).setHTML(
      buildPopupHtml(quake, prefIntensities),
    )
    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([epicenter[1], epicenter[0]])
      .setPopup(popup)
      .addTo(map)
    // マーカーのクリックは地図コンテナへバブリングして map の click も発火させる。
    // レイヤー由来のポップアップが同時に開かないよう、調停器へこの click を宣言する。
    const claim = attachMarkerClaim(map, el)
    markerRef.current = marker
    return () => {
      claim.remove()
      marker.remove()
      markerRef.current = null
    }
  }, [map, quake, epicenter, prefIntensities, iconScale])

  return null
}
