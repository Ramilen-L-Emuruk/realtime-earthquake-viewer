import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { SiteCoords } from '../../services/kyoshin'
import { kyoshinIntensityColor, kyoshinIndexToJma } from '../../utils/kyoshinIntensity'
import { getScaleRadius } from '../../utils/intensity'
import { addOrderedLayer } from './gl/layerOrder'

// 最大震度更新時の波紋エフェクトを描画する MapLibre 版（Leaflet の KyoshinMaxEffect 相当）。
// 波紋は最大インデックスが MIN_TRIGGER_INDEX 以上へ更新されたときに発生する短命アニメーション
// （同時に有効なのは通常 0〜1 個）。円の stroke を DURATION ミリ秒かけて拡大＋フェードさせる。
//
// MapLibre では波紋 1 個を circle feature 1 個で表し、rAF ループで半径・stroke 不透明度を
// feature-state で毎フレーム更新する（円は画面ピクセル半径なので Leaflet の containerPoint 半径と等価）。
// 失効した波紋は setData でソースから取り除く。色は feature プロパティ（['get','color']）から読む。

const DURATION = 600
const MIN_TRIGGER_INDEX = 7

const SRC = 'kyoshin-ripple'
const LYR = 'kyoshin-ripple'

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

interface Ripple {
  id: number
  color: string
  startTime: number
  baseRadius: number
  feature: Feature<Point>
}

interface Props {
  sites: SiteCoords
  indices: number[]
  iconScale: number
}

export function KyoshinMaxEffectGL({ sites, indices, iconScale }: Props) {
  const map = useMapGL()
  const ripplesRef = useRef<Ripple[]>([])
  const rafRef = useRef<number | null>(null)
  const prevMaxIdxRef = useRef<number>(-1)
  const nextIdRef = useRef<number>(1)
  const addedRef = useRef(false)

  // source + layer を一度だけ作る。stroke のみの円（塗り無し）。
  useEffect(() => {
    if (!map) return
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: LYR,
      type: 'circle',
      source: SRC,
      paint: {
        'circle-radius': ['coalesce', ['feature-state', 'radius'], 0],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 2.5,
        'circle-stroke-opacity': ['coalesce', ['feature-state', 'opacity'], 0],
      },
    })
    addedRef.current = true
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      ripplesRef.current = []
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      addedRef.current = false
    }
  }, [map])

  // ソースを現在の波紋集合で更新する（発生・失効時）。
  const syncSource = () => {
    if (!map || !addedRef.current) return
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: ripplesRef.current.map((r) => r.feature) })
  }

  // rAF ループ: 各波紋の半径・不透明度を feature-state で更新し、失効分を取り除く。
  const startLoop = () => {
    if (!map || rafRef.current !== null) return
    const loop = () => {
      const now = performance.now()
      const alive: Ripple[] = []
      let expiredAny = false
      for (const r of ripplesRef.current) {
        const t = (now - r.startTime) / DURATION
        if (t >= 1) {
          expiredAny = true
          continue
        }
        const eased = 1 - (1 - t) * (1 - t)
        const radius = r.baseRadius + r.baseRadius * 3 * eased
        const alpha = 0.75 * (1 - t)
        map.setFeatureState({ source: SRC, id: r.id }, { radius, opacity: alpha })
        alive.push(r)
      }
      ripplesRef.current = alive
      if (expiredAny) syncSource()
      if (alive.length > 0) {
        rafRef.current = requestAnimationFrame(loop)
      } else {
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(loop)
  }

  // 最大インデックス更新の監視。MIN_TRIGGER_INDEX 以上へ上昇したら波紋を発生させる。
  useEffect(() => {
    if (!map || !addedRef.current || indices.length === 0 || sites.length === 0) return

    let maxIdx = -1
    let maxSiteIdx = -1
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] > maxIdx) {
        maxIdx = indices[i]
        maxSiteIdx = i
      }
    }

    // 再生リセット・データソース切替で最大値が大幅に下落した場合は前回最大をリセット。
    if (maxIdx < prevMaxIdxRef.current - 5) {
      prevMaxIdxRef.current = maxIdx
      return
    }

    if (maxIdx >= MIN_TRIGGER_INDEX && maxIdx > prevMaxIdxRef.current && maxSiteIdx >= 0) {
      const [lat, lng] = sites[maxSiteIdx]
      const color = kyoshinIntensityColor(maxIdx) ?? '#ffffff'
      const jma = kyoshinIndexToJma(maxIdx)
      const baseRadius = jma ? (getScaleRadius(jma.scale) + 2) * iconScale : 3 * iconScale
      const id = nextIdRef.current++
      const feature: Feature<Point> = {
        type: 'Feature',
        id,
        properties: { color },
        geometry: { type: 'Point', coordinates: [lng, lat] },
      }
      ripplesRef.current = [...ripplesRef.current, { id, color, startTime: performance.now(), baseRadius, feature }]
      syncSource()
      startLoop()
    }

    prevMaxIdxRef.current = maxIdx
  }, [map, indices, sites, iconScale])

  return null
}
