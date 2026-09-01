import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { TsunamiArrivalMarker } from '../../hooks/useTsunamiLayerData'
import {
  arrivalMetrics, popupOffset, ARRIVAL_COLOR, ARRIVAL_RING_COLOR, ARRIVAL_OPACITY,
} from './gl/tsunamiArrivalMarker'
import { formatTime } from '../../utils/formatters'

// 津波の到達確認マーカー（波高が「観測中」の観測点）を描画する。
//
// 観測棒（TsunamiObsBarsGL）と対になる。あちらは波高の数値が出た観測点、こちらはまだ出ていない
// 観測点を受け持つ。値が付いた観測点はこの一覧から消えて観測棒へ移るため、同じ観測点が
// 両方に出ることはない（振り分けは useTsunamiLayerData）。
//
// 差分更新・点滅・後始末の作りは観測棒と揃えてある（全 remove → 全再生成にすると、電文のたびに
// 印が一瞬消えてちらつく）。
//
// 見た目は丸バッジの家族（震度観測点・揺れ検知点）に合わせてある。形・色・不透明度を選んだ理由は
// `gl/tsunamiArrivalMarker.ts` の冒頭。

function tooltipHtml(marker: TsunamiArrivalMarker): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const arrival = marker.arrivalTime
    ? `${formatTime(marker.arrivalTime).slice(0, 5)} 到達${marker.initial ? `（${esc(marker.initial)}）` : ''}`
    : '到達を確認'
  return (
    `<div class="text-sm"><div class="font-bold">${esc(marker.name)}</div>` +
    `<div class="text-xs" style="color:#e5e7eb">${arrival}</div>` +
    `<div class="text-xs" style="color:${ARRIVAL_COLOR}">最大波高は観測中</div></div>`
  )
}

// 既存 el の見た目だけ更新する。className の丸ごと代入は Marker がコンストラクタで付与する
// 'maplibregl-marker' クラスを消してしまうため、blink クラスは classList.toggle で足し引きする。
function updateMarkerEl(el: HTMLDivElement, marker: TsunamiArrivalMarker, iconScale: number): void {
  const { ring, size } = arrivalMetrics(iconScale)
  // 寸法は毎回ここで書く。観測点名キーで既存マーカーを再利用するため、生成時にしか設定しない
  // 値があると、倍率を変えたときその値だけ古い倍率のまま取り残される（観測棒と同じ事情）。
  el.style.width = `${size}px`
  el.style.height = `${size}px`
  el.classList.toggle('tsunami-obs-blink', marker.blinking)
  // **丸そのものは内側の要素に描く。** `maplibregl.Marker` はマーカーの根の要素の `opacity` を
  // 自前で管理する（地形に隠れた点を薄くする用途）ため、根へ不透明度を書いても上書きされる。
  // 観測棒も同じ理由で、根はレイアウトだけを持ち中身の div が見た目を持つ。
  //
  // 白フチは `box-sizing: border-box` で丸の内側に収める（共有カードの描き直しと同じ収まり）。
  el.innerHTML =
    `<div style="position:absolute;inset:0;box-sizing:border-box;border-radius:50%;` +
    `background:${ARRIVAL_COLOR};border:${ring}px solid ${ARRIVAL_RING_COLOR};` +
    `box-shadow:0 0 3px rgba(0,0,0,0.7);opacity:${ARRIVAL_OPACITY}"></div>`
}

function buildMarkerEl(marker: TsunamiArrivalMarker, iconScale: number): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = 'position:relative'
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
