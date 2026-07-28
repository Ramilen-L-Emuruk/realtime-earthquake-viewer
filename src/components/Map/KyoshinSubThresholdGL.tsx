import { useEffect, useRef } from 'react'
import type { FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { SiteCoords } from '../../services/kyoshin'
import { SHINDO0_COLOR } from '../../utils/kyoshinIntensity'
import { addKyoshinLayer } from './gl/kyoshinLayers'

// 強震モニタの震度0以下（index 1〜6）を描画する MapLibre 版（Leaflet の KyoshinSubThreshold 相当）。
// index 0（データ無し）と index 7+（震度1以上・KyoshinPoints が描画）は対象外。
//
// 【暫定実装・要 FBO 化】現行 Leaflet 版は「同レベルのドット同士が重なっても濃くならない」非加算合成
// （SVG の <g opacity> 単位合成）を行う。MapLibre で厳密に再現するにはレベルごとのオフスクリーン FBO へ
// 不透明描画してから opacity で合成するカスタムレイヤーが要る（PoC で実証・poc/subthreshold-rt.ts の
// 動的インデックスバッファ方式）。本コンポーネントはまず circle レイヤー＋feature-state でレベル別
// 不透明度を出す簡易版で、密集して同レベルが重なる箇所ではアルファが加算されて濃くなる差異が残る。
// FBO 非加算合成への置き換えは次の増分で行う（移行計画 F3b・docs/webgl-glyph 系ではなく F3）。
//
// 毎秒更新は KyoshinPoints と同じく feature-state 差分（レベルが変わった点だけ setFeatureState）。

const MAX_SUB_IDX = 6
const BASE_RADIUS = 2.5

const SRC = 'kyoshin-subthreshold'
const LYR = 'kyoshin-subthreshold'

// 指数カーブで不透明度: index 1 → 微小、index 6 → 0.35（Leaflet 版 subThresholdOpacity と一致）。
function subThresholdOpacity(idx: number): number {
  if (idx <= 0) return 0
  const t = idx / MAX_SUB_IDX
  return ((Math.exp(t) - 1) / (Math.E - 1)) * 0.35
}

interface Props {
  sites: SiteCoords
  indices: number[]
  iconScale: number
}

export function KyoshinSubThresholdGL({ sites, indices, iconScale }: Props) {
  const map = useMapGL()
  const prevLevelsRef = useRef<Int8Array>(new Int8Array(0))
  const addedRef = useRef(false)

  useEffect(() => {
    if (!map || sites.length === 0) return
    const fc: FeatureCollection<Point> = {
      type: 'FeatureCollection',
      features: sites.map(([lat, lng], i) => ({
        type: 'Feature',
        id: i,
        properties: {},
        geometry: { type: 'Point', coordinates: [lng, lat] },
      })),
    }
    map.addSource(SRC, { type: 'geojson', data: fc })
    addKyoshinLayer(map, {
      id: LYR,
      type: 'circle',
      source: SRC,
      paint: {
        'circle-radius': BASE_RADIUS * iconScale,
        'circle-color': SHINDO0_COLOR,
        'circle-opacity': ['coalesce', ['feature-state', 'opacity'], 0],
        'circle-stroke-width': 0,
      },
    })
    prevLevelsRef.current = new Int8Array(sites.length)
    addedRef.current = true
    return () => {
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      addedRef.current = false
      prevLevelsRef.current = new Int8Array(0)
    }
  }, [map, sites])

  // 毎秒の震度更新（feature-state 差分・変化した点だけ）。
  useEffect(() => {
    if (!map || !addedRef.current) return
    const prev = prevLevelsRef.current
    for (let i = 0; i < sites.length; i++) {
      const idx = indices[i] ?? 0
      const level = idx >= 1 && idx <= MAX_SUB_IDX ? idx : 0
      if (level === prev[i]) continue
      prev[i] = level
      map.setFeatureState({ source: SRC, id: i }, { opacity: subThresholdOpacity(level) })
    }
  }, [map, indices, sites])

  // UI 倍率の変化で半径を更新。
  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setPaintProperty(LYR, 'circle-radius', BASE_RADIUS * iconScale)
  }, [map, iconScale])

  return null
}
