import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource } from 'maplibre-gl'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getLpgmClassColor, getLpgmClassLabel } from '../../utils/lpgm'
import type { LpgmRegionAggregate } from '../../hooks/useQuakeLayerData'
import { ringToLngLat } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'
import { attachMarkerClaim, type PopupHandle } from './gl/popupRegistry'
import { buildLpgmBadgeEl, LPGM_BADGE_Z } from './gl/lpgmBadge'

// 長周期地震動のズームアウト時、一次細分区域ごとの最大階級を塗る MapLibre 版
// （Leaflet 版 JapanMap の lpgm-region-fill ペイン＋区域中心マーカー相当）。
// 区域塗りは fill+line、区域中心の階級ラベルは HTML マーカー（Leaflet の getLpgmRegionIcon
// 四角ボックスを再現・glyph 非依存）で描く。バッジ要素自体は観測点ラベル（LpgmPointsGL）と共有
// （gl/lpgmBadge.ts）。

const FILL_SRC = 'quake-lpgm-region-fill'
const FILL_LYR = 'quake-lpgm-region-fill'
const LINE_LYR = 'quake-lpgm-region-fill-line'

const EMPTY_FC: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] }

interface Props {
  regionAggregates: LpgmRegionAggregate[]
  iconScale: number
  visible: boolean
}

function buildFillFC(regions: LpgmRegionAggregate[]): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = []
  for (const r of regions) {
    const color = getLpgmClassColor(r.maxLgInt)
    for (const ring of r.rings) {
      features.push({
        type: 'Feature',
        properties: { color },
        geometry: { type: 'Polygon', coordinates: [ringToLngLat(ring)] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

function popupHtml(name: string, lgInt: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return (
    `<div class="text-sm"><div class="font-bold">${esc(name)}</div>` +
    `<div class="text-xs" style="color:#94a3b8">長周期地震動 ${esc(getLpgmClassLabel(lgInt))}</div></div>`
  )
}

export function LpgmRegionFillGL({ regionAggregates, iconScale, visible }: Props) {
  const map = useMapGL()
  const markersRef = useRef<maplibregl.Marker[]>([])
  // ラベルマーカーのクリック宣言（レイヤー由来のポップアップと二重に開かないための調停）。
  const claimsRef = useRef<PopupHandle[]>([])
  const addedRef = useRef(false)

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
      const el = buildLpgmBadgeEl(r.maxLgInt, iconScale)
      el.style.zIndex = String(r.maxLgInt * LPGM_BADGE_Z)
      const popup = new maplibregl.Popup({ closeButton: true, offset: 12 }).setHTML(
        popupHtml(r.name, r.maxLgInt),
      )
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([r.label[1], r.label[0]])
        .setPopup(popup)
        .addTo(map)
      claimsRef.current.push(attachMarkerClaim(map, el))
      markersRef.current.push(marker)
    }
  }, [map, regionAggregates, iconScale, visible])

  useEffect(() => {
    if (!map || !map.getLayer(FILL_LYR)) return
    const v = visible ? 'visible' : 'none'
    map.setLayoutProperty(FILL_LYR, 'visibility', v)
    map.setLayoutProperty(LINE_LYR, 'visibility', v)
  }, [map, visible])

  return null
}
