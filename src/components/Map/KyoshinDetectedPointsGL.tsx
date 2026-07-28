import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import { kyoshinIndexToJma, kyoshinIntensityColor } from '../../utils/kyoshinIntensity'
import { getScaleRadius } from '../../utils/intensity'
import { addKyoshinLayer } from './gl/kyoshinLayers'

// 揺れ検知済み（確定）観測点を描画する MapLibre 版（Leaflet の KyoshinDetectedPoints 相当）。
// points は検知中のみの少数（最大でも数十点程度）なので、KyoshinPoints のような feature-state 差分は
// 行わず、更新のたびに GeoJSON を作り直して setData で丸ごと差し替える（Leaflet 版と同じくフル再描画）。
// 色・半径は feature プロパティに持たせて paint 式（['get',...]）から読み、震度の低い点が下・高い点が
// 上に重なるよう circle-sort-key に index を与える（Leaflet 版の index 昇順ソート描画と一致）。

const SRC = 'kyoshin-detected'
const LYR = 'kyoshin-detected'

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

interface Props {
  points: DetectedPoint[]
  iconScale: number
}

// 検知点1点の描画半径（Leaflet 版と同一ロジック）。震度0相当以下は固定小半径、それ以外は計測震度連動。
function detectedRadius(index: number, iconScale: number): number {
  const jma = kyoshinIndexToJma(index)
  return jma && jma.label !== '0' ? (getScaleRadius(jma.scale) + 2) * iconScale : 2.5 * iconScale
}

function buildFC(points: DetectedPoint[], iconScale: number): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      properties: {
        color: kyoshinIntensityColor(p.index) ?? '#ffffff',
        radius: detectedRadius(p.index, iconScale),
        index: p.index,
      },
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    })),
  }
}

export function KyoshinDetectedPointsGL({ points, iconScale }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)

  // source + layer を一度だけ作る。
  useEffect(() => {
    if (!map) return
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    addKyoshinLayer(map, {
      id: LYR,
      type: 'circle',
      source: SRC,
      paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 1,
        'circle-stroke-width': 0,
      },
      layout: {
        // 震度の低い点を下、高い点を上に重ねる。
        'circle-sort-key': ['get', 'index'],
      },
    })
    addedRef.current = true
    return () => {
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      addedRef.current = false
    }
  }, [map])

  // データ／倍率変化のたびに丸ごと差し替える。
  useEffect(() => {
    if (!map || !addedRef.current) return
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    src?.setData(buildFC(points, iconScale))
  }, [map, points, iconScale])

  return null
}
