import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getIntensityColor } from '../../utils/intensity'
import type { EewAreaFill } from '../../hooks/useEewLayerData'
import { ringToLngLat } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'

// EEW 対象地域の予想最大震度を区域塗りで表示する MapLibre 版（Leaflet の eew-region-fill 相当）。
// 警報域(isWarning: kindCode 10/11/19)は fillOpacity 0.55・枠 weight2 で強調、予報域は 0.3・weight1。
// 塗り色は予想震度色(getIntensityColor)。区域中心マーカーは持たない（Leaflet 版と同じ）。

const FILL_SRC = 'eew-region-fill'
const FILL_LYR = 'eew-region-fill'
const LINE_LYR = 'eew-region-fill-line'

const EMPTY_FC: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] }

interface Props {
  areaFills: EewAreaFill[]
  visible: boolean
}

function buildFC(areaFills: EewAreaFill[]): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = []
  for (const a of areaFills) {
    const color = getIntensityColor(a.scale)
    for (const ring of a.rings) {
      features.push({
        type: 'Feature',
        properties: {
          color,
          fillOpacity: a.isWarning ? 0.55 : 0.3,
          lineWidth: a.isWarning ? 2 : 1,
        },
        geometry: { type: 'Polygon', coordinates: [ringToLngLat(ring)] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

export function EewRegionFillGL({ areaFills, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)

  useEffect(() => {
    if (!map) return
    map.addSource(FILL_SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: FILL_LYR,
      type: 'fill',
      source: FILL_SRC,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fillOpacity'] },
    })
    addOrderedLayer(map, {
      id: LINE_LYR,
      type: 'line',
      source: FILL_SRC,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'lineWidth'] },
    })
    addedRef.current = true
    return () => {
      if (map.getLayer(LINE_LYR)) map.removeLayer(LINE_LYR)
      if (map.getLayer(FILL_LYR)) map.removeLayer(FILL_LYR)
      if (map.getSource(FILL_SRC)) map.removeSource(FILL_SRC)
      addedRef.current = false
    }
  }, [map])

  useEffect(() => {
    if (!map || !addedRef.current) return
    const src = map.getSource(FILL_SRC) as GeoJSONSource | undefined
    src?.setData(buildFC(areaFills))
  }, [map, areaFills])

  useEffect(() => {
    if (!map || !map.getLayer(FILL_LYR)) return
    const v = visible ? 'visible' : 'none'
    map.setLayoutProperty(FILL_LYR, 'visibility', v)
    map.setLayoutProperty(LINE_LYR, 'visibility', v)
  }, [map, visible])

  return null
}
