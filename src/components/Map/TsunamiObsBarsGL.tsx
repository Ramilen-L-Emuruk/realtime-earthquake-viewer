import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { TsunamiObsBar } from '../../hooks/useTsunamiLayerData'

// 津波観測棒（波高バー）を描画する MapLibre 版（Leaflet の tsunami-obs-bars 相当）。
// 各観測点に、波高に比例した高さの縦バーを HTML マーカー（底辺アンカー）で立てる。
// 更新中の点は tsunami-obs-blink クラスで点滅（Leaflet と同じ CSS）。ホバーで観測点名・波高を表示。
//
// 観測点名をキーに差分更新する（Marker/Popup/DOM要素は使い回し、内容だけ書き換える）。
// 全remove→全再生成だと、発報中の高頻度な観測値更新のたびに全観測棒が一瞬消えてから
// 再生成され、ちらつく。

const W = 6
const FOOT = 3

function tooltipHtml(bar: TsunamiObsBar): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const desc = `${bar.height.over ? '>' : ''}${bar.height.description}`
  return (
    `<div class="text-sm"><div class="font-bold">${esc(bar.name)}</div>` +
    `<div class="text-xs" style="color:${bar.color}">${esc(desc)}</div></div>`
  )
}

// 既存 el の見た目だけ更新する。className の丸ごと代入は Marker がコンストラクタで付与する
// 'maplibregl-marker' クラスを消してしまうため、blink クラスは classList.toggle で足し引きする。
function updateBarEl(el: HTMLDivElement, bar: TsunamiObsBar): void {
  el.style.height = `${bar.barPx + FOOT}px`
  el.classList.toggle('tsunami-obs-blink', bar.blinking)
  el.innerHTML =
    `<div style="width:${W}px;height:${bar.barPx}px;background:${bar.color};border-radius:3px 3px 0 0;opacity:0.9"></div>` +
    `<div style="width:${W + FOOT}px;height:${FOOT}px;background:${bar.color};border-radius:0 0 3px 3px;opacity:0.3"></div>`
}

function buildBarEl(bar: TsunamiObsBar): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = `display:flex;flex-direction:column;align-items:center;width:${W + FOOT}px`
  updateBarEl(el, bar)
  return el
}

interface Props {
  bars: TsunamiObsBar[]
}

interface BarEntry {
  marker: maplibregl.Marker
  popup: maplibregl.Popup
  el: HTMLDivElement
}

export function TsunamiObsBarsGL({ bars }: Props) {
  const map = useMapGL()
  const entriesRef = useRef<Map<string, BarEntry>>(new Map())

  useEffect(() => {
    if (!map) return
    const entries = entriesRef.current
    const seen = new Set<string>()
    for (const bar of bars) {
      seen.add(bar.name)
      const existing = entries.get(bar.name)
      if (existing) {
        updateBarEl(existing.el, bar)
        existing.popup.setHTML(tooltipHtml(bar)).setOffset([10, -bar.barPx / 2])
        continue
      }
      const el = buildBarEl(bar)
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([bar.lng, bar.lat])
        .addTo(map)
      // ホバーでツールチップ（波高）を表示。
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: [10, -bar.barPx / 2] }).setHTML(
        tooltipHtml(bar),
      )
      el.addEventListener('mouseenter', () => popup.setLngLat([bar.lng, bar.lat]).addTo(map))
      el.addEventListener('mouseleave', () => popup.remove())
      entries.set(bar.name, { marker, popup, el })
    }
    // 今回の更新に含まれなくなった観測点（区域が減った・別の事象に切り替わった等）を後始末。
    for (const [name, entry] of entries) {
      if (seen.has(name)) continue
      entry.popup.remove()
      entry.marker.remove()
      entries.delete(name)
    }
  }, [map, bars])

  // アンマウント時に全観測棒を後始末する。
  useEffect(() => {
    const entries = entriesRef.current
    return () => {
      for (const entry of entries.values()) {
        entry.popup.remove()
        entry.marker.remove()
      }
      entries.clear()
    }
  }, [map])

  return null
}
