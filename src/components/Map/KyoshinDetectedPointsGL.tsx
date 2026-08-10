import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import { kyoshinIndexToJma } from '../../utils/kyoshinIntensity'
import { getScaleRadius } from '../../utils/intensity'
import { addOrderedLayer } from './gl/layerOrder'
import {
  ensureKyoshinDetectedIcons,
  kyoshinDetectedIconId,
  KYOSHIN_DETECTED_ICON_BASE_RADIUS,
} from './gl/kyoshinDetectedIcons'

// 揺れ検知点（confirmed＝確定／likely＝候補）を描画する MapLibre 版（Leaflet の KyoshinDetectedPoints 相当）。
// 丸背景・色・フチ・震度ラベルを Canvas2D で事前ラスタライズした1枚の画像（gl/kyoshinDetectedIcons.ts）を
// icon-image として表示する（地震情報タブの観測点 QuakeIntensityPointsGL と同方式）。
//
// 丸背景を circle レイヤーで、震度ラベルを別の symbol レイヤーで重ねる方式（旧実装）も試したが、
// circle は MapLibre の衝突判定に一切参加しない仕様のため丸同士の重なりを防げず、さらに文字レイヤーは
// 丸レイヤーとは独立に描画されるため「下に完全に隠れた丸の文字まで重ねて表示してしまう」問題があった
// （2026-08-10 の実機検証）。丸ごと icon-image 化することで、重なった場合も「丸＋文字セット」で
// 前面に来た1点だけが完全に読める状態になる（QuakeIntensityPointsGL と同じ考え方）。
// icon-allow-overlap は true のまま（重なりは許容し、位置情報を落とさない）。symbol-sort-key で
// 震度の高い点を前面に描くことで、密集地帯でも「一番強い震度」は必ず正しく読める。
//
// points は検知中のみの少数（confirmed＋likely合わせても最大でも数十〜百点程度）なので、KyoshinPoints
// のような feature-state 差分は行わず、更新のたびに GeoJSON を作り直して setData で丸ごと差し替える
// （Leaflet 版と同じくフル再描画）。

const SRC = 'kyoshin-detected'
const LYR = 'kyoshin-detected'

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

// 確信度別の半径ボーナス（通常震度点の半径 getScaleRadius(scale) に加算）。
// confirmed は likely よりさらに大きく＋太めの白フチ（gl/kyoshinDetectedIcons.ts）で、
// 一目で「確定」と分かるようにする。
const CONFIRMED_RADIUS_BONUS = 6
const CANDIDATE_RADIUS_BONUS = 2

interface Props {
  confirmedPoints: DetectedPoint[]
  candidatePoints: DetectedPoint[]
  iconScale: number
  visible: boolean
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

function buildFC(
  confirmedPoints: DetectedPoint[],
  candidatePoints: DetectedPoint[],
  iconScale: number,
): FeatureCollection<Point> {
  // confirmed と座標が重なる candidate は confirmed 側の見た目を優先し、二重描画しない。
  const confirmedKeys = new Set(confirmedPoints.map(pointKey))
  const filteredCandidates = candidatePoints.filter((p) => !confirmedKeys.has(pointKey(p)))

  const confirmedFeatures = confirmedPoints.map((p) => {
    const radius = detectedRadius(p.index, iconScale, CONFIRMED_RADIUS_BONUS)
    const rank = kyoshinIndexToJma(p.index)?.rank ?? 0
    return {
      type: 'Feature' as const,
      properties: {
        index: p.index,
        iconId: kyoshinDetectedIconId(rank, true),
        iconSizeRatio: radius / KYOSHIN_DETECTED_ICON_BASE_RADIUS,
      },
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
    }
  })

  const candidateFeatures = filteredCandidates.map((p) => {
    const radius = detectedRadius(p.index, iconScale, CANDIDATE_RADIUS_BONUS)
    const rank = kyoshinIndexToJma(p.index)?.rank ?? 0
    return {
      type: 'Feature' as const,
      properties: {
        index: p.index,
        iconId: kyoshinDetectedIconId(rank, false),
        iconSizeRatio: radius / KYOSHIN_DETECTED_ICON_BASE_RADIUS,
      },
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
    }
  })

  return { type: 'FeatureCollection', features: [...confirmedFeatures, ...candidateFeatures] }
}

export function KyoshinDetectedPointsGL({ confirmedPoints, candidatePoints, iconScale, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  // 直近に setData した内容の署名。points は kyoshinView が indices tick（毎秒）で作り直されるため
  // 検知フットプリントが不変でも参照だけ変わる。同一内容の再 setData（＝geojson-vt 再タイル化）を避ける。
  const lastSigRef = useRef<string | null>(null)

  // source + layer を一度だけ作る。
  useEffect(() => {
    if (!map) return
    ensureKyoshinDetectedIcons(map)
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    lastSigRef.current = JSON.stringify(EMPTY_FC) // 生成直後の空 FC を基準に（同一なら以降スキップ）
    addOrderedLayer(map, {
      id: LYR,
      type: 'symbol',
      source: SRC,
      layout: {
        'icon-image': ['get', 'iconId'],
        'icon-size': ['get', 'iconSizeRatio'],
        // 地震情報タブの観測点（QuakeIntensityPointsGL）と同方式: 重なりは許容し、
        // symbol-sort-key（震度が高いほど大きい値）で震度の強い点を前面に描く。
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'index'],
        visibility: visible ? 'visible' : 'none',
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

  // 表示切替（モード切替用）。
  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible])

  return null
}
