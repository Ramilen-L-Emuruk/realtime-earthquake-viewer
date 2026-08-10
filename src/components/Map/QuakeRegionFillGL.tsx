import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource } from 'maplibre-gl'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getIntensityColor, getIntensityLabel } from '../../utils/intensity'
import type { RegionAggregate } from '../../hooks/useQuakeLayerData'
import { ringToLngLat } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'
import { attachMarkerClaim, type PopupHandle } from './gl/popupRegistry'
import { buildIntensityBadgeEl, INTENSITY_BADGE_Z } from './gl/intensityBadge'

// 地震モードのズームアウト時、一次細分区域ごとの最大震度を塗る MapLibre 版
// （Leaflet 版 JapanMap の quake-region-fill ペイン＋区域中心マーカー相当）。
// 区域塗りは fill+line レイヤー、区域中心の震度ラベルは HTML マーカー（maplibregl.Marker）で描く
// （ラベル文字は symbol+text だと glyph 依存になるため、Leaflet の DivIcon と同じく HTML で出す）。
// バッジ要素自体は観測点ラベル（QuakeIntensityPointsGL）と共有（gl/intensityBadge.ts）。

const FILL_SRC = 'quake-region-fill'
const FILL_LYR = 'quake-region-fill'
const LINE_LYR = 'quake-region-fill-line'

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

function popupHtml(name: string, scale: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return (
    `<div class="text-sm"><div class="font-bold">${esc(name)}</div>` +
    `<div class="text-xs" style="color:#94a3b8">最大震度 ${esc(getIntensityLabel(scale))}</div></div>`
  )
}

export function QuakeRegionFillGL({ regionAggregates, iconScale, visible }: Props) {
  const map = useMapGL()
  const markersRef = useRef<maplibregl.Marker[]>([])
  // ラベルマーカーのクリック宣言（レイヤー由来のポップアップと二重に開かないための調停）。
  const claimsRef = useRef<PopupHandle[]>([])
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
      for (const c of claimsRef.current) c.remove()
      claimsRef.current = []
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

    for (const c of claimsRef.current) c.remove()
    claimsRef.current = []
    for (const mk of markersRef.current) mk.remove()
    markersRef.current = []
    if (!visible) return
    for (const r of regionAggregates) {
      const el = buildIntensityBadgeEl(r.scale, iconScale)
      // 強い震度ほど前面（Leaflet の zIndexOffset = scale*INTENSITY_BADGE_Z 相当）。
      el.style.zIndex = String(r.scale * INTENSITY_BADGE_Z)
      const popup = new maplibregl.Popup({ closeButton: true, offset: 12 }).setHTML(
        popupHtml(r.name, r.scale),
      )
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([r.label[1], r.label[0]])
        .setPopup(popup)
        .addTo(map)
      claimsRef.current.push(attachMarkerClaim(map, el))
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
