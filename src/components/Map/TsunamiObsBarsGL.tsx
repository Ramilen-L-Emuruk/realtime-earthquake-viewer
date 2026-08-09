import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { TsunamiObsBar } from '../../hooks/useTsunamiLayerData'

// 津波観測棒（波高バー）を描画する MapLibre 版（Leaflet の tsunami-obs-bars 相当）。
// 各観測点に、波高に比例した高さの縦バーを HTML マーカー（底辺アンカー）で立てる。
// 更新中の点は tsunami-obs-blink クラスで点滅（Leaflet と同じ CSS）。ホバーで観測点名・波高を表示。

const W = 6
const FOOT = 3

function buildBarEl(bar: TsunamiObsBar): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = `display:flex;flex-direction:column;align-items:center;width:${W + FOOT}px;height:${bar.barPx + FOOT}px`
  if (bar.blinking) el.className = 'tsunami-obs-blink'
  el.innerHTML =
    `<div style="width:${W}px;height:${bar.barPx}px;background:${bar.color};border-radius:3px 3px 0 0;opacity:0.9"></div>` +
    `<div style="width:${W + FOOT}px;height:${FOOT}px;background:${bar.color};border-radius:0 0 3px 3px;opacity:0.3"></div>`
  return el
}

function tooltipHtml(bar: TsunamiObsBar): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const desc = `${bar.height.over ? '>' : ''}${bar.height.description}`
  return (
    `<div class="text-sm"><div class="font-bold">${esc(bar.name)}</div>` +
    `<div class="text-xs" style="color:${bar.color}">${esc(desc)}</div></div>`
  )
}

interface Props {
  bars: TsunamiObsBar[]
}

export function TsunamiObsBarsGL({ bars }: Props) {
  const map = useMapGL()
  const markersRef = useRef<maplibregl.Marker[]>([])

  useEffect(() => {
    if (!map) return
    for (const bar of bars) {
      const el = buildBarEl(bar)
      // 底辺アンカー: バーの下端を観測点座標に合わせる。
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([bar.lng, bar.lat])
        .addTo(map)
      // ホバーでツールチップ（波高）を表示。
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: [10, -bar.barPx / 2] }).setHTML(
        tooltipHtml(bar),
      )
      el.addEventListener('mouseenter', () => popup.setLngLat([bar.lng, bar.lat]).addTo(map))
      el.addEventListener('mouseleave', () => popup.remove())
      markersRef.current.push(marker)
    }
    return () => {
      for (const mk of markersRef.current) mk.remove()
      markersRef.current = []
    }
  }, [map, bars])

  return null
}
