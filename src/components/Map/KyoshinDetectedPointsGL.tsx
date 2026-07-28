import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import { kyoshinIndexToJma, kyoshinIntensityColor } from '../../utils/kyoshinIntensity'
import { getScaleRadius } from '../../utils/intensity'
import { addOrderedLayer } from './gl/layerOrder'

// 揺れ検知点（confirmed＝確定／likely＝候補）を描画する MapLibre 版（Leaflet の KyoshinDetectedPoints 相当）。
// 両者とも通常の震度点（KyoshinPoints）より一回り大きい拡大マーカーで示すが、confirmed は likely より
// さらに半径を上げ白フチを付けて一段目立たせる（確信度の違いを大きさ・縁取りで視覚化する）。
// points は検知中のみの少数（confirmed＋likely合わせても最大でも数十点程度）なので、KyoshinPoints のような
// feature-state 差分は行わず、更新のたびに GeoJSON を作り直して setData で丸ごと差し替える（Leaflet 版と同じくフル再描画）。
// 色・半径・フチは feature プロパティに持たせて paint 式（['get',...]）から読み、震度の低い点が下・高い点が
// 上に重なるよう circle-sort-key に index を与える（Leaflet 版の index 昇順ソート描画と一致）。

const SRC = 'kyoshin-detected'
const LYR = 'kyoshin-detected'

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

// 確信度別の半径ボーナス（通常震度点の半径 getScaleRadius(scale) に加算）。
// confirmed は likely よりさらに大きく＋白フチで、一目で「確定」と分かるようにする。
const CONFIRMED_RADIUS_BONUS = 6
const CANDIDATE_RADIUS_BONUS = 2
const CONFIRMED_STROKE_WIDTH = 2

interface Props {
  confirmedPoints: DetectedPoint[]
  candidatePoints: DetectedPoint[]
  iconScale: number
}

// 検知点1点の描画半径（Leaflet 版と同一ロジックを confidence 別ボーナスへ一般化）。
// 震度0相当以下は固定小半径、それ以外は計測震度連動。
// フォールバック式 (bonus + 3) / 2 は bonus=2（likelyの旧confirmed相当）で旧固定値 2.5 と一致する。
function detectedRadius(index: number, iconScale: number, bonus: number): number {
  const jma = kyoshinIndexToJma(index)
  return jma && jma.label !== '0' ? (getScaleRadius(jma.scale) + bonus) * iconScale : ((bonus + 3) / 2) * iconScale
}

// confirmed/candidate とも kyoshinDetectionView.ts の同一 byKey（buildSiteIndex）由来のため、
// 同一観測点なら lat/lng はビット単位で完全一致する（丸め誤差による不一致は起きない）。
function pointKey(p: DetectedPoint): string {
  return `${p.lat},${p.lng}`
}

function buildFC(confirmedPoints: DetectedPoint[], candidatePoints: DetectedPoint[], iconScale: number): FeatureCollection<Point> {
  // confirmed と座標が重なる candidate は confirmed 側の見た目を優先し、二重描画しない。
  const confirmedKeys = new Set(confirmedPoints.map(pointKey))
  const filteredCandidates = candidatePoints.filter((p) => !confirmedKeys.has(pointKey(p)))

  const confirmedFeatures = confirmedPoints.map((p) => ({
    type: 'Feature' as const,
    properties: {
      color: kyoshinIntensityColor(p.index) ?? '#ffffff',
      radius: detectedRadius(p.index, iconScale, CONFIRMED_RADIUS_BONUS),
      strokeWidth: CONFIRMED_STROKE_WIDTH,
      index: p.index,
    },
    geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
  }))

  const candidateFeatures = filteredCandidates.map((p) => ({
    type: 'Feature' as const,
    properties: {
      color: kyoshinIntensityColor(p.index) ?? '#ffffff',
      radius: detectedRadius(p.index, iconScale, CANDIDATE_RADIUS_BONUS),
      strokeWidth: 0,
      index: p.index,
    },
    geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
  }))

  return { type: 'FeatureCollection', features: [...confirmedFeatures, ...candidateFeatures] }
}

export function KyoshinDetectedPointsGL({ confirmedPoints, candidatePoints, iconScale }: Props) {
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
        'circle-stroke-width': ['get', 'strokeWidth'],
        'circle-stroke-color': '#ffffff',
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
    const fc = buildFC(confirmedPoints, candidatePoints, iconScale)
    const sig = JSON.stringify(fc)
    if (sig === lastSigRef.current) return
    lastSigRef.current = sig
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    src?.setData(fc)
  }, [map, confirmedPoints, candidatePoints, iconScale])

  return null
}
