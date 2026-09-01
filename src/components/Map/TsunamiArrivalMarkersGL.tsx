import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { TsunamiArrivalMarker } from '../../hooks/useTsunamiLayerData'
import { arrivalMetrics, popupOffset, ARRIVAL_COLOR } from './gl/tsunamiArrivalMarker'
import { formatTime } from '../../utils/formatters'

// 津波の到達確認マーカー（波高が「観測中」の観測点）を描画する。
//
// 観測棒（TsunamiObsBarsGL）と対になる。あちらは波高の数値が出た観測点、こちらはまだ出ていない
// 観測点を受け持つ。値が付いた観測点はこの一覧から消えて観測棒へ移るため、同じ観測点が
// 両方に出ることはない（振り分けは useTsunamiLayerData）。
//
// 差分更新・点滅・後始末の作りは観測棒と揃えてある（全 remove → 全再生成にすると、電文のたびに
// 印が一瞬消えてちらつく）。

function tooltipHtml(marker: TsunamiArrivalMarker): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const arrival = marker.arrivalTime
    ? `${formatTime(marker.arrivalTime).slice(0, 5)} 到達${marker.initial ? `（${esc(marker.initial)}）` : ''}`
    : '到達を確認'
  return (
    `<div class="text-sm"><div class="font-bold">${esc(marker.name)}</div>` +
    `<div class="text-xs" style="color:${ARRIVAL_COLOR}">${arrival}</div>` +
    `<div class="text-xs" style="color:#9ca3af">最大波高は観測中</div></div>`
  )
}

// 既存 el の見た目だけ更新する。className の丸ごと代入は Marker がコンストラクタで付与する
// 'maplibregl-marker' クラスを消してしまうため、blink クラスは classList.toggle で足し引きする。
function updateMarkerEl(el: HTMLDivElement, marker: TsunamiArrivalMarker, iconScale: number): void {
  const { stroke, dot, size } = arrivalMetrics(iconScale)
  // 寸法は毎回ここで書く。観測点名キーで既存マーカーを再利用するため、生成時にしか設定しない
  // 値があると、倍率を変えたときその値だけ古い倍率のまま取り残される（観測棒と同じ事情）。
  el.style.width = `${size}px`
  el.style.height = `${size}px`
  el.classList.toggle('tsunami-obs-blink', marker.blinking)
  el.innerHTML =
    `<div style="position:absolute;inset:0;border:${stroke}px solid ${ARRIVAL_COLOR};border-radius:50%;opacity:0.9"></div>` +
    `<div style="position:absolute;left:50%;top:50%;width:${dot * 2}px;height:${dot * 2}px;` +
    `margin-left:${-dot}px;margin-top:${-dot}px;background:${ARRIVAL_COLOR};border-radius:50%;opacity:0.9"></div>`
}

function buildMarkerEl(marker: TsunamiArrivalMarker, iconScale: number): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = 'position:relative;box-sizing:border-box'
  updateMarkerEl(el, marker, iconScale)
  return el
}

interface Props {
  markers: TsunamiArrivalMarker[]
  /** 地図アイコンの倍率（設定値）。観測棒と揃えて拡縮する。 */
  iconScale: number
}

interface MarkerEntry {
  marker: maplibregl.Marker
  popup: maplibregl.Popup
  el: HTMLDivElement
}

export function TsunamiArrivalMarkersGL({ markers, iconScale }: Props) {
  const map = useMapGL()
  const entriesRef = useRef<Map<string, MarkerEntry>>(new Map())

  useEffect(() => {
    if (!map) return
    const entries = entriesRef.current
    const seen = new Set<string>()
    for (const m of markers) {
      seen.add(m.name)
      const existing = entries.get(m.name)
      if (existing) {
        updateMarkerEl(existing.el, m, iconScale)
        existing.popup.setHTML(tooltipHtml(m)).setOffset(popupOffset(iconScale))
        continue
      }
      const el = buildMarkerEl(m, iconScale)
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([m.lng, m.lat])
        .addTo(map)
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: popupOffset(iconScale),
      }).setHTML(tooltipHtml(m))
      el.addEventListener('mouseenter', () => popup.setLngLat([m.lng, m.lat]).addTo(map))
      el.addEventListener('mouseleave', () => popup.remove())
      entries.set(m.name, { marker, popup, el })
    }
    // 波高が付いた観測点（観測棒へ移った）・区域が減った等で消えたものを後始末する。
    for (const [name, entry] of entries) {
      if (seen.has(name)) continue
      entry.popup.remove()
      entry.marker.remove()
      entries.delete(name)
    }
  }, [map, markers, iconScale])

  // アンマウント時に全マーカーを後始末する。
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
