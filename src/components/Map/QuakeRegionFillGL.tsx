import { useEffect, useRef } from 'react'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getIntensityColor, getIntensityLabel, getScaleRadius } from '../../utils/intensity'
import type { RegionAggregate } from '../../hooks/useQuakeLayerData'
import { ringToLngLat } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { escapeHtml } from './gl/popupHtml'
import { ensureIntensityIcons, intensityIconId, INTENSITY_ICON_BASE_RADIUS } from './gl/intensityIcons'

// 地震モードのズームアウト時、一次細分区域ごとの最大震度を塗る MapLibre 版
// （Leaflet 版 JapanMap の quake-region-fill ペイン＋区域中心マーカー相当）。
// 区域塗りは fill+line レイヤー、区域中心の震度ラベルは観測点（QuakeIntensityPointsGL）と同じ
// icon-image 方式で描く（gl/intensityIcons.ts の Canvas2D 事前ラスタライズ画像を共有）。
// クリックのみでポップアップを出す（ホバーは元々無し）。

const FILL_SRC = 'quake-region-fill'
const FILL_LYR = 'quake-region-fill'
const LINE_LYR = 'quake-region-fill-line'
const LABEL_SRC = 'quake-region-label'
const LABEL_LYR = 'quake-region-label'
// バッジがそれほど小さくない（区域代表点は数十件程度）ため、当たり判定に少し余裕を持たせる。
const HIT_TOL_PX = 10

const EMPTY_FILL_FC: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] }
const EMPTY_LABEL_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

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

// 区域中心の震度ラベル用 Point Feature 群。
// 旧 HTML Marker 版（buildIntensityBadgeEl）のサイズ比率 (getScaleRadius*2+8) を踏襲。
function buildLabelFC(regions: RegionAggregate[], iconScale: number): FeatureCollection<Point> {
  const features: Feature<Point>[] = regions.map((r) => ({
    type: 'Feature',
    properties: {
      iconId: intensityIconId(r.scale),
      iconSizeRatio: ((getScaleRadius(r.scale) + 4) * iconScale) / INTENSITY_ICON_BASE_RADIUS,
      scale: r.scale,
      name: r.name,
    },
    geometry: { type: 'Point', coordinates: [r.label[1], r.label[0]] },
  }))
  return { type: 'FeatureCollection', features }
}

function clickHtml(f: MapGeoJSONFeature): string {
  const scale = Number(f.properties?.scale ?? -1)
  const name = String(f.properties?.name ?? '')
  return (
    `<div class="text-sm"><div class="font-bold">${escapeHtml(name)}</div>` +
    `<div class="text-xs" style="color:#94a3b8">最大震度 ${escapeHtml(getIntensityLabel(scale))}</div></div>`
  )
}

export function QuakeRegionFillGL({ regionAggregates, iconScale, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  const popupRef = useRef<PopupHandle | null>(null)

  // fill + line + ラベル用レイヤーを一度だけ作る。
  useEffect(() => {
    if (!map) return
    ensureIntensityIcons(map)
    map.addSource(FILL_SRC, { type: 'geojson', data: EMPTY_FILL_FC })
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
        'symbol-sort-key': ['get', 'scale'],
        visibility: visible ? 'visible' : 'none',
      },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: LABEL_LYR,
      priority: 'point',
      tolPx: HIT_TOL_PX,
      rankKey: 'scale',
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

  // データ／倍率変化: 塗り・ラベルを差し替え。
  useEffect(() => {
    if (!map || !addedRef.current) return
    const fillSrc = map.getSource(FILL_SRC) as GeoJSONSource | undefined
    fillSrc?.setData(buildFillFC(regionAggregates))
    const labelSrc = map.getSource(LABEL_SRC) as GeoJSONSource | undefined
    labelSrc?.setData(buildLabelFC(regionAggregates, iconScale))
  }, [map, regionAggregates, iconScale])

  // 表示切替（fill/line/ラベル レイヤー）。
  useEffect(() => {
    if (!map || !map.getLayer(FILL_LYR)) return
    const v = visible ? 'visible' : 'none'
    map.setLayoutProperty(FILL_LYR, 'visibility', v)
    map.setLayoutProperty(LINE_LYR, 'visibility', v)
    map.setLayoutProperty(LABEL_LYR, 'visibility', v)
  }, [map, visible])

  return null
}
