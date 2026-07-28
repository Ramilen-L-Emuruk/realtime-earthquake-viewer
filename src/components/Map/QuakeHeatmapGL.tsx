import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { HeatPoint } from '../../utils/quakeHeatmap'
import { addOrderedLayer } from './gl/layerOrder'

// 直近1ヶ月の地震活動ヒートマップを描画する MapLibre 版（Leaflet 版 QuakeHeatmapLayer 相当）。
// Leaflet は leaflet.heat（Canvas）だったが、MapLibre はネイティブの heatmap レイヤーで描く。
// 区域塗り（quake-region-fill）より背面（MAP_LAYER_ORDER の quake-heat スロット）に置き、
// 震度色塗り・震源マーカーの視認性と競合させない。weight は各点の重み（0〜1 前提）。

const SRC = 'quake-heat'
const LYR = 'quake-heat'

// Leaflet 版と揃えた見え方の基準ズーム（この付近以下で全域が均される）。
const HEAT_MAX_ZOOM = 8

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

interface Props {
  points: HeatPoint[]
}

function buildFC(points: HeatPoint[]): FeatureCollection<Point> {
  const features: Feature<Point>[] = points.map((p) => ({
    type: 'Feature',
    properties: { weight: p.weight },
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
  }))
  return { type: 'FeatureCollection', features }
}

export function QuakeHeatmapGL({ points }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)

  useEffect(() => {
    if (!map) return
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: LYR,
      type: 'heatmap',
      source: SRC,
      maxzoom: HEAT_MAX_ZOOM + 1,
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
    addedRef.current = true
    return () => {
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

  return null
}
