import { useEffect, useRef } from 'react'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getLpgmClassColor, getLpgmClassLabel } from '../../utils/lpgm'
import type { EewLpgmRegionAggregate } from '../../hooks/useEewLayerData'
import { ringToLngLat } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'

// 選択された EEW の地域別予想長周期地震動階級を区域塗りで表示する MapLibre 版
// （Leaflet の eew-lpgm-region-fill 相当）。fill-opacity 0.5・枠 weight2。区域中心マーカーは持たない。
// クリック／ホバーで区域名と予想階級を出す（EEW 予想震度塗りと同じ作法）。

const FILL_SRC = 'eew-lpgm-region-fill'
const FILL_LYR = 'eew-lpgm-region-fill'
const LINE_LYR = 'eew-lpgm-region-fill-line'
// 面レイヤーなので当たり判定の余裕は最小でよい。
const HIT_TOL_PX = 2

const EMPTY_FC: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] }

interface Props {
  regionAggregates: EewLpgmRegionAggregate[]
  visible: boolean
}

function buildFC(regions: EewLpgmRegionAggregate[]): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = []
  for (const r of regions) {
    const color = getLpgmClassColor(r.maxLgInt)
    for (const ring of r.rings) {
      features.push({
        type: 'Feature',
        properties: { color, name: r.name, maxLgInt: r.maxLgInt },
        geometry: { type: 'Polygon', coordinates: [ringToLngLat(ring)] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

function hoverHtml(f: MapGeoJSONFeature): string {
  const lgInt = Number(f.properties?.maxLgInt ?? 0)
  return (
    `<div style="display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap">` +
    `${badgeHtml(String(lgInt), getLpgmClassColor(lgInt))}` +
    `<span style="font-weight:600">${escapeHtml(String(f.properties?.name ?? ''))}</span></div>`
  )
}

function clickHtml(f: MapGeoJSONFeature): string {
  const lgInt = Number(f.properties?.maxLgInt ?? 0)
  return (
    `<div style="min-width:160px">` +
    `<div style="font-weight:700;font-size:13px">${escapeHtml(String(f.properties?.name ?? ''))}</div>` +
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px">` +
    `${badgeHtml(String(lgInt), getLpgmClassColor(lgInt))}` +
    `<span style="color:#cbd5e1">予想 長周期地震動${escapeHtml(getLpgmClassLabel(lgInt))}</span></div>` +
    `</div>`
  )
}

export function EewLpgmRegionFillGL({ regionAggregates, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  const popupRef = useRef<PopupHandle | null>(null)

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
      paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: FILL_LYR,
      priority: 'fill',
      tolPx: HIT_TOL_PX,
      rankKey: 'maxLgInt',
      buildHoverHtml: hoverHtml,
      buildClickHtml: clickHtml,
    })
    addedRef.current = true
    return () => {
      popupRef.current?.remove()
      popupRef.current = null
      if (map.getLayer(LINE_LYR)) map.removeLayer(LINE_LYR)
      if (map.getLayer(FILL_LYR)) map.removeLayer(FILL_LYR)
      if (map.getSource(FILL_SRC)) map.removeSource(FILL_SRC)
      addedRef.current = false
    }
  }, [map])

  useEffect(() => {
    if (!map || !addedRef.current) return
    const src = map.getSource(FILL_SRC) as GeoJSONSource | undefined
    src?.setData(buildFC(regionAggregates))
  }, [map, regionAggregates])

  useEffect(() => {
    if (!map || !map.getLayer(FILL_LYR)) return
    const v = visible ? 'visible' : 'none'
    map.setLayoutProperty(FILL_LYR, 'visibility', v)
    map.setLayoutProperty(LINE_LYR, 'visibility', v)
  }, [map, visible])

  return null
}
