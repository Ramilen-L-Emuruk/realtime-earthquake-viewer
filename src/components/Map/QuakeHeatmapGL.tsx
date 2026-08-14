import { useEffect, useRef } from 'react'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { HeatPoint } from '../../utils/quakeHeatmap'
import { formatMagnitude, formatDepth, formatDateTimeMin } from '../../utils/formatters'
import { getMagnitudeColor } from '../../utils/intensity'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'

// 直近1ヶ月の地震活動ヒートマップを描画する MapLibre 版（Leaflet 版 QuakeHeatmapLayer 相当）。
// Leaflet は leaflet.heat（Canvas）だったが、MapLibre はネイティブの heatmap レイヤーで描く。
// 区域塗り（quake-region-fill）より背面（MAP_LAYER_ORDER の quake-heat スロット）に置き、
// 震度色塗り・震源マーカーの視認性と競合させない。weight は各点の重み（0〜1 前提）。
//
// クリック／ホバーで個々の地震（震源名・M・深さ・発生時刻）を出す。ただし **heatmap レイヤーは
// queryRenderedFeatures にヒットしない**（密度を描くだけで個別 feature を返さない仕様）ため、
// 同じ点を透明な circle レイヤーで重ねて当たり判定を作る。

const SRC = 'quake-heat'
const LYR = 'quake-heat'
const HIT_LYR = 'quake-heat-hit'

// Leaflet 版と揃えた見え方の基準ズーム（この付近以下で全域が均される）。
// MapLibre 基準（512px タイル）なので Leaflet 版の 8 から 1 段引いた値＝同じ縮尺（gl/camera.ts の MAX_ZOOM 参照）。
const HEAT_MAX_ZOOM = 7
// 当たり判定の円半径(px)。見た目には出ないので、指で押しやすい大きさにする。
const HIT_RADIUS_PX = 9
const HIT_TOL_PX = 4

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

interface Props {
  points: HeatPoint[]
  visible: boolean
}

function buildFC(points: HeatPoint[]): FeatureCollection<Point> {
  const features: Feature<Point>[] = points.map((p) => ({
    type: 'Feature',
    properties: {
      weight: p.weight,
      name: p.name,
      time: p.time,
      depth: p.depth,
      magnitude: p.magnitude,
    },
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
  }))
  return { type: 'FeatureCollection', features }
}

/** 震源地名。DMDSS の GD Earthquake List は名前を返さないことがある。 */
function titleOf(f: MapGeoJSONFeature): string {
  const name = String(f.properties?.name ?? '').trim()
  return name || '震源地不明'
}

function hoverHtml(f: MapGeoJSONFeature): string {
  const m = Number(f.properties?.magnitude ?? -1)
  return (
    `<div style="display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap">` +
    `${badgeHtml(formatMagnitude(m), getMagnitudeColor(m))}` +
    `<span style="font-weight:600">${escapeHtml(titleOf(f))}</span></div>`
  )
}

function clickHtml(f: MapGeoJSONFeature): string {
  const m = Number(f.properties?.magnitude ?? -1)
  const depth = Number(f.properties?.depth ?? -1)
  const time = String(f.properties?.time ?? '')
  return (
    `<div style="min-width:160px">` +
    `<div style="font-weight:700;font-size:13px">${escapeHtml(titleOf(f))}</div>` +
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px">` +
    `${badgeHtml(formatMagnitude(m), getMagnitudeColor(m))}` +
    `<span style="color:#cbd5e1">深さ ${escapeHtml(formatDepth(depth))}</span></div>` +
    (time ? `<div style="margin-top:4px;font-size:11px;color:#94a3b8">${escapeHtml(formatDateTimeMin(time))}</div>` : '') +
    `</div>`
  )
}

export function QuakeHeatmapGL({ points, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  const popupRef = useRef<PopupHandle | null>(null)

  useEffect(() => {
    if (!map) return
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: LYR,
      type: 'heatmap',
      source: SRC,
      maxzoom: HEAT_MAX_ZOOM + 1,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: {
        // 各点の重み（quakeHeatmap 側で 0〜1 に正規化済み）。
        'heatmap-weight': ['coalesce', ['get', 'weight'], 0.5],
        // ズームで密度強度を上げる（leaflet.heat の見た目に近づける）。
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.6, HEAT_MAX_ZOOM, 1.4],
        // 密度→色（leaflet.heat 既定グラデーション相当。density0 は透明）。
        'heatmap-color': [
          'interpolate',
          ['linear'],
          ['heatmap-density'],
          0, 'rgba(0,0,255,0)',
          0.2, 'rgba(0,0,255,0.4)',
          0.4, 'rgba(0,170,255,0.6)',
          0.6, 'rgba(0,255,128,0.7)',
          0.8, 'rgba(255,238,0,0.8)',
          1, 'rgba(255,0,0,0.9)',
        ],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 14, HEAT_MAX_ZOOM, 30],
        'heatmap-opacity': 0.85,
      },
    })
    // 当たり判定専用の透明レイヤー。ヒートマップが消える倍率では判定も消えるよう maxzoom を揃える。
    addOrderedLayer(map, {
      id: HIT_LYR,
      type: 'circle',
      source: SRC,
      maxzoom: HEAT_MAX_ZOOM + 1,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: {
        'circle-radius': HIT_RADIUS_PX,
        'circle-color': '#000000',
        'circle-opacity': 0,
      },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: HIT_LYR,
      priority: 'heat',
      tolPx: HIT_TOL_PX,
      rankKey: 'magnitude',
      buildHoverHtml: hoverHtml,
      buildClickHtml: clickHtml,
    })
    addedRef.current = true
    return () => {
      popupRef.current?.remove()
      popupRef.current = null
      if (map.getLayer(HIT_LYR)) map.removeLayer(HIT_LYR)
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      addedRef.current = false
    }
  }, [map])

  useEffect(() => {
    if (!map || !addedRef.current) return
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    src?.setData(buildFC(points))
  }, [map, points])

  // 表示切替（津波モードとの往復用）。
  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    const v = visible ? 'visible' : 'none'
    map.setLayoutProperty(LYR, 'visibility', v)
    map.setLayoutProperty(HIT_LYR, 'visibility', v)
  }, [map, visible])

  return null
}
