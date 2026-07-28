import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource } from 'maplibre-gl'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getIntensityColor, getIntensityLabel, getScaleRadius } from '../../utils/intensity'
import type { RegionAggregate } from '../../hooks/useQuakeLayerData'
import { ringToLngLat } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'

// 地震モードのズームアウト時、一次細分区域ごとの最大震度を塗る MapLibre 版
// （Leaflet 版 JapanMap の quake-region-fill ペイン＋区域中心マーカー相当）。
// 区域塗りは fill+line レイヤー、区域中心の震度ラベルは HTML マーカー（maplibregl.Marker）で描く
// （ラベル文字は symbol+text だと glyph 依存になるため、Leaflet の DivIcon と同じく HTML で出す）。

const FILL_SRC = 'quake-region-fill'
const FILL_LYR = 'quake-region-fill'
const LINE_LYR = 'quake-region-fill-line'
const INTENSITY_Z = 1000

const EMPTY_FC: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] }

interface Props {
  regionAggregates: RegionAggregate[]
  iconScale: number
  visible: boolean
}

// 各区域の全リングを、color/scale プロパティ付きの Polygon Feature 群にする。
// 弱い震度を先（下）、強い震度を後（上）に並べて前面に重ねる（regionAggregates は弱→強でソート済み）。
function buildFillFC(regions: RegionAggregate[]): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = []
  for (const r of regions) {
    const color = getIntensityColor(r.scale)
    for (const ring of r.rings) {
      features.push({
        type: 'Feature',
        properties: { color, scale: r.scale },
        geometry: { type: 'Polygon', coordinates: [ringToLngLat(ring)] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

// 区域中心の震度ラベル（Leaflet 版 getIntensityIcon と同じ円形ボックス）を作る。
function buildLabelEl(scale: number, iconScale: number): HTMLDivElement {
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

function popupHtml(name: string, scale: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return (
    `<div class="text-sm"><div class="font-bold" style="color:#111">${esc(name)}</div>` +
    `<div class="text-xs" style="color:#4b5563">最大震度 ${esc(getIntensityLabel(scale))}</div></div>`
  )
}

export function QuakeRegionFillGL({ regionAggregates, iconScale, visible }: Props) {
  const map = useMapGL()
  const markersRef = useRef<maplibregl.Marker[]>([])
  const addedRef = useRef(false)

  // fill + line レイヤーを一度だけ作る。
  useEffect(() => {
    if (!map) return
    map.addSource(FILL_SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: FILL_LYR,
      type: 'fill',
      source: FILL_SRC,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.5 },
    })
    // 枠線（Leaflet の weight1・塗りと同色）。MAP_LAYER_ORDER 上で fill の直上に入る。
    addOrderedLayer(map, {
      id: LINE_LYR,
      type: 'line',
      source: FILL_SRC,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 1 },
    })
    addedRef.current = true
    return () => {
      for (const mk of markersRef.current) mk.remove()
      markersRef.current = []
      if (map.getLayer(LINE_LYR)) map.removeLayer(LINE_LYR)
      if (map.getLayer(FILL_LYR)) map.removeLayer(FILL_LYR)
      if (map.getSource(FILL_SRC)) map.removeSource(FILL_SRC)
      addedRef.current = false
    }
  }, [map])

  // データ／倍率変化: 塗りを差し替え、ラベルマーカーを作り直す。
  useEffect(() => {
    if (!map || !addedRef.current) return
    const src = map.getSource(FILL_SRC) as GeoJSONSource | undefined
    src?.setData(buildFillFC(regionAggregates))

    for (const mk of markersRef.current) mk.remove()
    markersRef.current = []
    if (!visible) return
    for (const r of regionAggregates) {
      const el = buildLabelEl(r.scale, iconScale)
      // 強い震度ほど前面（Leaflet の zIndexOffset = scale*INTENSITY_Z 相当）。
      el.style.zIndex = String(r.scale * INTENSITY_Z)
      const popup = new maplibregl.Popup({ closeButton: true, offset: 12 }).setHTML(
        popupHtml(r.name, r.scale),
      )
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([r.label[1], r.label[0]])
        .setPopup(popup)
        .addTo(map)
      markersRef.current.push(marker)
    }
  }, [map, regionAggregates, iconScale, visible])

  // 表示切替（fill/line レイヤー）。マーカーは上の effect が visible を見て出し分ける。
  useEffect(() => {
    if (!map || !map.getLayer(FILL_LYR)) return
    const v = visible ? 'visible' : 'none'
    map.setLayoutProperty(FILL_LYR, 'visibility', v)
    map.setLayoutProperty(LINE_LYR, 'visibility', v)
  }, [map, visible])

  return null
}
