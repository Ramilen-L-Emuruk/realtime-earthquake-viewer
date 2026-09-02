import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { TsunamiMissingMarker } from '../../hooks/useTsunamiLayerData'
import { arrivalMetrics, popupOffset, ARRIVAL_RING_COLOR, ARRIVAL_OPACITY } from './gl/tsunamiArrivalMarker'
import { missingMarkMetrics } from './gl/tsunamiMissingMarker'
import { TSUNAMI_MISSING_COLOR } from '../../utils/tsunamiStyle'
import { overSuffixedHeight } from '../../utils/tsunami'
import { formatTime } from '../../utils/formatters'

// 観測データが欠測となっている観測点の印を描画する。
//
// 到達確認マーカー（TsunamiArrivalMarkersGL）と対になるが、意味が違うので別の印にしてある
// （理由と寸法は `gl/tsunamiMissingMarker.ts` の冒頭）。差分更新・点滅・後始末の作りは
// 到達確認マーカーと揃えてある。

function tooltipHtml(marker: TsunamiMissingMarker): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lines = [`<div class="font-bold">${esc(marker.name)}</div>`]
  if (marker.arrivalTime) {
    lines.push(`<div class="text-xs" style="color:#e5e7eb">${formatTime(marker.arrivalTime).slice(0, 5)} 到達</div>`)
  }
  // これまでに観測できた波高があれば出す。欠測になる前の値であることを添えないと、いまの波高だと読める。
  if (marker.height) {
    lines.push(`<div class="text-xs" style="color:#e5e7eb">これまでの最大波 ${esc(overSuffixedHeight(marker.height))}</div>`)
  }
  lines.push(`<div class="text-xs" style="color:${TSUNAMI_MISSING_COLOR}">欠測（観測データが得られていません）</div>`)
  return `<div class="text-sm">${lines.join('')}</div>`
}

// 既存 el の見た目だけ更新する。className の丸ごと代入は Marker がコンストラクタで付与する
// 'maplibregl-marker' クラスを消してしまうため、blink クラスは classList.toggle で足し引きする。
function updateMarkerEl(el: HTMLDivElement, marker: TsunamiMissingMarker, iconScale: number): void {
  const { ring, size } = arrivalMetrics(iconScale)
  const { length, thickness } = missingMarkMetrics(iconScale)
  // 寸法は毎回ここで書く（観測点名キーで既存マーカーを再利用するため、生成時だけの設定は
  // 倍率を変えたときに取り残される）。
  el.style.width = `${size}px`
  el.style.height = `${size}px`
  el.classList.toggle('tsunami-obs-blink', marker.blinking)
  // 丸そのものは内側の要素に描く（根の `opacity` は Marker が自前で管理するため）。
  // 中央の横棒はさらにその内側へ置く。
  el.innerHTML =
    `<div style="position:absolute;inset:0;box-sizing:border-box;border-radius:50%;` +
    `background:${TSUNAMI_MISSING_COLOR};border:${ring}px solid ${ARRIVAL_RING_COLOR};` +
    `box-shadow:0 0 3px rgba(0,0,0,0.7);opacity:${ARRIVAL_OPACITY}">` +
    `<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);` +
    `width:${length}px;height:${thickness}px;background:${ARRIVAL_RING_COLOR}"></div>` +
    `</div>`
}

function buildMarkerEl(marker: TsunamiMissingMarker, iconScale: number): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = 'position:relative'
  updateMarkerEl(el, marker, iconScale)
  return el
}

interface Props {
  markers: TsunamiMissingMarker[]
  /** 地図アイコンの倍率（設定値）。観測棒・到達確認マーカーと揃えて拡縮する。 */
  iconScale: number
}

interface MarkerEntry {
  marker: maplibregl.Marker
  popup: maplibregl.Popup
  el: HTMLDivElement
}

export function TsunamiMissingMarkersGL({ markers, iconScale }: Props) {
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
    // 欠測が解けた・区域が減った等で消えたものを後始末する。
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
