import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getIntensityColor, getScaleRadius } from '../../utils/intensity'
import type { IntensityMarker } from '../../hooks/useQuakeLayerData'
import { addOrderedLayer } from './gl/layerOrder'

// 地震情報タブの各観測点の震度を色付きドットで描画する MapLibre 版（Leaflet の IntensityPoints 相当）。
// 高ズーム時（区域集約しないとき）に観測点ごとに表示する。色・半径は震度(scale)から前計算して
// feature プロパティに持たせ、circle-sort-key に scale を与えて強い震度を前面へ重ねる（弱→強の順）。
// 更新は地震電文の切替時のみ（頻度が低い）なので setData で丸ごと差し替える。

const SRC = 'quake-points'
const LYR = 'quake-points'

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

interface Props {
  markers: IntensityMarker[]
  iconScale: number
  visible: boolean
}

function buildFC(markers: IntensityMarker[], iconScale: number): FeatureCollection<Point> {
  const features: Feature<Point>[] = markers.map((m) => ({
    type: 'Feature',
    properties: {
      color: getIntensityColor(m.scale),
      radius: (getScaleRadius(m.scale) + 3) * iconScale,
      scale: m.scale,
    },
    geometry: { type: 'Point', coordinates: [m.position[1], m.position[0]] },
  }))
  return { type: 'FeatureCollection', features }
}

export function QuakeIntensityPointsGL({ markers, iconScale, visible }: Props) {
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
        'circle-sort-key': ['get', 'scale'],
        visibility: visible ? 'visible' : 'none',
      },
      paint: {
        'circle-radius': ['get', 'radius'],
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

  // データ／倍率変化で丸ごと差し替え。
  useEffect(() => {
    if (!map || !addedRef.current) return
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    src?.setData(buildFC(markers, iconScale))
  }, [map, markers, iconScale])

  // 表示切替（区域集約時は非表示）。
  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible])

  return null
}
