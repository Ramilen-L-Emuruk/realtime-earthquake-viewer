import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getLpgmClassColor } from '../../utils/lpgm'
import type { LpgmMarker } from '../../hooks/useQuakeLayerData'
import { addOrderedLayer } from './gl/layerOrder'

// 長周期地震動観測点を色付きドットで描画する MapLibre 版（Leaflet の LpgmPoints 相当）。
// 高ズーム時（区域集約しないとき）に階級 1〜4 を JMA 公式色で表示する。色は前計算して feature
// プロパティに持たせ、circle-sort-key に lgInt を与えて強い階級を前面へ（弱→強の順）。

const SRC = 'quake-lpgm-points'
const LYR = 'quake-lpgm-points'
const BASE_RADIUS = 5

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

interface Props {
  markers: LpgmMarker[]
  iconScale: number
  visible: boolean
}

function buildFC(markers: LpgmMarker[]): FeatureCollection<Point> {
  const features: Feature<Point>[] = markers.map((m) => ({
    type: 'Feature',
    properties: { color: getLpgmClassColor(m.lgInt), lgInt: m.lgInt },
    geometry: { type: 'Point', coordinates: [m.position[1], m.position[0]] },
  }))
  return { type: 'FeatureCollection', features }
}

export function LpgmPointsGL({ markers, iconScale, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)

  useEffect(() => {
    if (!map) return
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: LYR,
      type: 'circle',
      source: SRC,
      layout: {
        'circle-sort-key': ['get', 'lgInt'],
        visibility: visible ? 'visible' : 'none',
      },
      paint: {
        'circle-radius': BASE_RADIUS * iconScale,
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.9,
        'circle-stroke-color': 'rgba(255,255,255,0.7)',
        'circle-stroke-width': 1,
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
    src?.setData(buildFC(markers))
  }, [map, markers])

  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setPaintProperty(LYR, 'circle-radius', BASE_RADIUS * iconScale)
  }, [map, iconScale])

  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible])

  return null
}
