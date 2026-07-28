import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import { kyoshinIndexToJma, kyoshinIntensityColor } from '../../utils/kyoshinIntensity'
import { getScaleRadius } from '../../utils/intensity'
import { addOrderedLayer } from './gl/layerOrder'

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
  // 直近に setData した内容の署名。points は kyoshinView が indices tick（毎秒）で作り直されるため
  // 検知フットプリントが不変でも参照だけ変わる。同一内容の再 setData（＝geojson-vt 再タイル化）を避ける。
  const lastSigRef = useRef<string | null>(null)

  // source + layer を一度だけ作る。
  useEffect(() => {
    if (!map) return
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    lastSigRef.current = JSON.stringify(EMPTY_FC) // 生成直後の空 FC を基準に（同一なら以降スキップ）
    addOrderedLayer(map, {
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
      lastSigRef.current = null
    }
  }, [map])

  // データ／倍率変化のたびに丸ごと差し替える。内容が前回と同一ならスキップして再タイル化を避ける。
  useEffect(() => {
    if (!map || !addedRef.current) return
    const fc = buildFC(points, iconScale)
    const sig = JSON.stringify(fc)
    if (sig === lastSigRef.current) return
    lastSigRef.current = sig
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    src?.setData(fc)
  }, [map, points, iconScale])

  return null
}
