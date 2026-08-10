import { useEffect, useRef } from 'react'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getLpgmClassColor, getLpgmClassLabel } from '../../utils/lpgm'
import type { LpgmRegionAggregate } from '../../hooks/useQuakeLayerData'
import { ringToLngLat } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { escapeHtml } from './gl/popupHtml'
import { ensureLpgmIcons, lpgmIconId, LPGM_ICON_BASE_RADIUS } from './gl/lpgmIcons'

// 長周期地震動のズームアウト時、一次細分区域ごとの最大階級を塗る MapLibre 版
// （Leaflet 版 JapanMap の lpgm-region-fill ペイン＋区域中心マーカー相当）。
// 区域塗りは fill+line、区域中心の階級ラベルは観測点（LpgmPointsGL）と同じ icon-image 方式で描く
// （gl/lpgmIcons.ts の Canvas2D 事前ラスタライズ画像を共有）。クリックのみでポップアップを出す
// （ホバーは元々無し）。

const FILL_SRC = 'quake-lpgm-region-fill'
const FILL_LYR = 'quake-lpgm-region-fill'
const LINE_LYR = 'quake-lpgm-region-fill-line'
const LABEL_SRC = 'quake-lpgm-region-label'
const LABEL_LYR = 'quake-lpgm-region-label'
const HIT_TOL_PX = 10
// 旧 HTML Marker 版（buildLpgmBadgeEl）のバッジサイズ(32px固定・階級によらない)を踏襲。
const BASE_RADIUS = 16

const EMPTY_FILL_FC: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] }
const EMPTY_LABEL_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

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

function buildLabelFC(regions: LpgmRegionAggregate[], iconScale: number): FeatureCollection<Point> {
  const features: Feature<Point>[] = regions.map((r) => ({
    type: 'Feature',
    properties: {
      iconId: lpgmIconId(r.maxLgInt),
      iconSizeRatio: (BASE_RADIUS * iconScale) / LPGM_ICON_BASE_RADIUS,
      lgInt: r.maxLgInt,
      name: r.name,
    },
    geometry: { type: 'Point', coordinates: [r.label[1], r.label[0]] },
  }))
  return { type: 'FeatureCollection', features }
}

function clickHtml(f: MapGeoJSONFeature): string {
  const lgInt = Number(f.properties?.lgInt ?? 0)
  const name = String(f.properties?.name ?? '')
  return (
    `<div class="text-sm"><div class="font-bold">${escapeHtml(name)}</div>` +
    `<div class="text-xs" style="color:#94a3b8">長周期地震動 ${escapeHtml(getLpgmClassLabel(lgInt))}</div></div>`
  )
}

export function LpgmRegionFillGL({ regionAggregates, iconScale, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  const popupRef = useRef<PopupHandle | null>(null)

  useEffect(() => {
    if (!map) return
    ensureLpgmIcons(map)
    map.addSource(FILL_SRC, { type: 'geojson', data: EMPTY_FILL_FC })
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
    map.addSource(LABEL_SRC, { type: 'geojson', data: EMPTY_LABEL_FC })
    addOrderedLayer(map, {
      id: LABEL_LYR,
      type: 'symbol',
      source: LABEL_SRC,
      layout: {
        'icon-image': ['get', 'iconId'],
        'icon-size': ['get', 'iconSizeRatio'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'lgInt'],
        visibility: visible ? 'visible' : 'none',
      },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: LABEL_LYR,
      priority: 'point',
      tolPx: HIT_TOL_PX,
      rankKey: 'lgInt',
      buildClickHtml: clickHtml,
    })
    addedRef.current = true
    return () => {
      popupRef.current?.remove()
      popupRef.current = null
      if (map.getLayer(LABEL_LYR)) map.removeLayer(LABEL_LYR)
      if (map.getSource(LABEL_SRC)) map.removeSource(LABEL_SRC)
      if (map.getLayer(LINE_LYR)) map.removeLayer(LINE_LYR)
      if (map.getLayer(FILL_LYR)) map.removeLayer(FILL_LYR)
      if (map.getSource(FILL_SRC)) map.removeSource(FILL_SRC)
      addedRef.current = false
    }
  }, [map])

  useEffect(() => {
    if (!map || !addedRef.current) return
    const fillSrc = map.getSource(FILL_SRC) as GeoJSONSource | undefined
    fillSrc?.setData(buildFillFC(regionAggregates))
    const labelSrc = map.getSource(LABEL_SRC) as GeoJSONSource | undefined
    labelSrc?.setData(buildLabelFC(regionAggregates, iconScale))
  }, [map, regionAggregates, iconScale])

  useEffect(() => {
    if (!map || !map.getLayer(FILL_LYR)) return
    const v = visible ? 'visible' : 'none'
    map.setLayoutProperty(FILL_LYR, 'visibility', v)
    map.setLayoutProperty(LINE_LYR, 'visibility', v)
    map.setLayoutProperty(LABEL_LYR, 'visibility', v)
  }, [map, visible])

  return null
}
