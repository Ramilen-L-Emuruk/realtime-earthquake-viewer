import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { EewEpicenter } from '../../hooks/useEewLayerData'

// EEW（緊急地震速報）の震源(×印・点滅)を描画する MapLibre 版（Leaflet 版 JapanMap の
// EEW 震源マーカー相当）。全モードで表示し、リアルタイム震度モード以外は半透明にする。
// 複数 EEW 時は全震源を表示する。

interface Props {
  epicenters: EewEpicenter[]
  iconScale: number
  /** リアルタイム震度モードのとき不透明、それ以外は半透明（0.4）。 */
  fullOpacity: boolean
}

function buildCrossEl(iconScale: number, opacity: number): HTMLDivElement {
  const s = Math.round(32 * iconScale)
  const el = document.createElement('div')
  el.style.cssText = `width:${s}px;height:${s}px;opacity:${opacity}`
  // eew-blink クラスで点滅（Leaflet 版 getEpicenterIcon(blink=true) と同じ CSS）。
  el.innerHTML =
    `<svg viewBox="0 0 32 32" width="${s}" height="${s}" class="eew-blink" xmlns="http://www.w3.org/2000/svg">` +
    `<line x1="4" y1="4" x2="28" y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/>` +
    `<line x1="28" y1="4" x2="4" y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/></svg>`
  return el
}

export function EewEpicentersGL({ epicenters, iconScale, fullOpacity }: Props) {
  const map = useMapGL()
  const markersRef = useRef<maplibregl.Marker[]>([])

  useEffect(() => {
    if (!map) return
    const opacity = fullOpacity ? 1 : 0.4
    for (const ep of epicenters) {
      const el = buildCrossEl(iconScale, opacity)
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([ep.position[1], ep.position[0]])
        .addTo(map)
      markersRef.current.push(marker)
    }
    return () => {
      for (const mk of markersRef.current) mk.remove()
      markersRef.current = []
    }
  }, [map, epicenters, iconScale, fullOpacity])

  return null
}
