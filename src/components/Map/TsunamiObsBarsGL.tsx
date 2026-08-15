import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { TsunamiObsBar } from '../../hooks/useTsunamiLayerData'
import { barMetrics, popupOffset, BAR_RADIUS } from './gl/tsunamiObsBar'

// 津波観測棒（波高バー）を描画する MapLibre 版（Leaflet の tsunami-obs-bars 相当）。
// 各観測点に、波高に比例した高さの縦バーを HTML マーカー（底辺アンカー）で立てる。
// 更新中の点は tsunami-obs-blink クラスで点滅（Leaflet と同じ CSS）。ホバーで観測点名・波高を表示。
//
// 観測点名をキーに差分更新する（Marker/Popup/DOM要素は使い回し、内容だけ書き換える）。
// 全remove→全再生成だと、発報中の高頻度な観測値更新のたびに全観測棒が一瞬消えてから
// 再生成され、ちらつく。

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
function updateBarEl(el: HTMLDivElement, bar: TsunamiObsBar, iconScale: number): void {
  const { w, foot, barPx } = barMetrics(bar, iconScale)
  // 角丸だけは倍率を掛けない（枠線・影と同じ装飾の扱い・gl/tsunamiObsBar.ts 参照）。
  const r = BAR_RADIUS
  // 寸法は幅・高さとも毎回ここで書く。倍率変更時は観測点名キーで既存マーカーを再利用する（下の
  // 差分更新）ため、生成時にしか設定しない値があると、その値だけ古い倍率のまま取り残される。
  el.style.width = `${w + foot}px`
  el.style.height = `${barPx + foot}px`
  el.classList.toggle('tsunami-obs-blink', bar.blinking)
  el.innerHTML =
    `<div style="width:${w}px;height:${barPx}px;background:${bar.color};border-radius:${r}px ${r}px 0 0;opacity:0.9"></div>` +
    `<div style="width:${w + foot}px;height:${foot}px;background:${bar.color};border-radius:0 0 ${r}px ${r}px;opacity:0.3"></div>`
}

function buildBarEl(bar: TsunamiObsBar, iconScale: number): HTMLDivElement {
  const el = document.createElement('div')
  // 寸法は updateBarEl が受け持つ（上記の理由）。ここではレイアウトだけ決める。
  el.style.cssText = 'display:flex;flex-direction:column;align-items:center'
  updateBarEl(el, bar, iconScale)
  return el
}

interface Props {
  bars: TsunamiObsBar[]
  /** 地図アイコンの倍率（設定値）。震度マーカー等と揃えて観測棒も拡縮する。 */
  iconScale: number
}

interface BarEntry {
  marker: maplibregl.Marker
  popup: maplibregl.Popup
  el: HTMLDivElement
}

export function TsunamiObsBarsGL({ bars, iconScale }: Props) {
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
        updateBarEl(existing.el, bar, iconScale)
        existing.popup.setHTML(tooltipHtml(bar)).setOffset(popupOffset(bar, iconScale))
        continue
      }
      const el = buildBarEl(bar, iconScale)
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([bar.lng, bar.lat])
        .addTo(map)
      // ホバーでツールチップ（波高）を表示。
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: popupOffset(bar, iconScale),
      }).setHTML(tooltipHtml(bar))
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
  }, [map, bars, iconScale])

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
