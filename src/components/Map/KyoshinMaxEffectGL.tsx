import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { SiteCoords } from '../../services/kyoshin'
import { kyoshinIntensityColor, kyoshinIndexToJma } from '../../utils/kyoshinIntensity'
import { addOrderedLayer } from './gl/layerOrder'

// 最大震度更新時の波紋エフェクトを描画する MapLibre 版（Leaflet の KyoshinMaxEffect 相当）。
// 波紋は表示上のJMA震度階級（kyoshinIndexToJma の rank）が MIN_TRIGGER_RANK 以上へ
// 1段階以上上がったときに発生する短命アニメーション（同時に有効なのは通常 0〜1 個）。
// 円の stroke を DURATION ミリ秒かけて拡大＋フェードさせる。
//
// MapLibre では波紋 1 個を circle feature 1 個で表し、rAF ループで半径・stroke 不透明度を
// feature-state で毎フレーム更新する（円は画面ピクセル半径なので Leaflet の containerPoint 半径と等価）。
// 失効した波紋は setData でソースから取り除く。色は feature プロパティ（['get','color']）から読む。
//
// 発生時の半径・膨張倍率は intensity.ts の getScaleRadius（マーカー用の控えめな値）を流用せず、
// 波紋専用のカーブ（RIPPLE_BASE_RADIUS／RIPPLE_EXPANSION）を使う。震度1〜4あたりはgetScaleRadiusの
// 差が1px刻みしかなく波紋の大小がほぼ見分けられなかったため、発生時の大きさ・広がる勢いの両方を
// 震度に応じてはっきり変化させ、震度が高いほど大きく・勢いよく広がるようにしている。
//
// トリガー判定は生indexではなく rank（表示階級）で行う。強震モニタの生indexは0.5刻みの
// 計測震度に対応する整数値で、同じJMA階級の範囲内に複数の生index値が存在する
// （例: 震度4＝計測震度3.5〜4.5未満には index 13/14 の2値がある）。実際の揺れは連続的に
// 上下するため、生indexの最大値だけを見ていると、表示震度が変わらないまま生indexが
// 微増するたびに波紋が誤発生してしまう（2026-08-10 に発覚）。

const DURATION = 600
const MIN_TRIGGER_RANK = 1

const SRC = 'kyoshin-ripple'
const LYR = 'kyoshin-ripple'

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

// 波紋の発生時半径（px、iconScale適用前）。JMA 震度スケール値（getScaleRadius と同じキー）ごとに指定。
const RIPPLE_BASE_RADIUS: Record<number, number> = {
  '-1': 5,
  10: 5,  // 震度0/1
  20: 6,  // 震度2
  30: 8,  // 震度3
  40: 10, // 震度4
  45: 13, // 震度5弱
  50: 15, // 震度5強
  55: 18, // 震度6弱
  60: 21, // 震度6強
  70: 26, // 震度7
}

// 波紋の膨張倍率（発生時半径の何倍まで広がるか）。震度が高いほど大きく勢いよく広がる。
const RIPPLE_EXPANSION: Record<number, number> = {
  '-1': 2.5,
  10: 2.5,
  20: 3,
  30: 3.5,
  40: 4,
  45: 4.5,
  50: 5,
  55: 5.5,
  60: 6,
  70: 7,
}

function getRippleBaseRadius(scale: number): number {
  return RIPPLE_BASE_RADIUS[scale] ?? 5
}

function getRippleExpansion(scale: number): number {
  return RIPPLE_EXPANSION[scale] ?? 2.5
}

interface Ripple {
  id: number
  color: string
  startTime: number
  baseRadius: number
  expansion: number
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
  const prevRankRef = useRef<number>(-1)
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
        // rAF で毎フレーム更新する半径・不透明度を瞬時に反映させる。既定(約300ms)のままだと
        // 高頻度更新に約300msの遅延フィルタが重なり、波紋の拡大・フェードが鈍って歪む。
        'circle-radius-transition': { duration: 0, delay: 0 },
        'circle-stroke-opacity-transition': { duration: 0, delay: 0 },
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
        const radius = r.baseRadius + r.baseRadius * (r.expansion - 1) * eased
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

  // 最大震度階級（rank）の監視。MIN_TRIGGER_RANK 以上へ1段階以上上がったら波紋を発生させる。
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

    const jma = kyoshinIndexToJma(maxIdx)
    const rank = jma?.rank ?? -1

    // rank が下がった（揺れが収まった・再生リセットやデータソース切替で最大値が変わった等）場合は
    // 前回 rank を追従させるだけで、波紋は発生させない。
    if (rank < prevRankRef.current) {
      prevRankRef.current = rank
      return
    }

    if (jma && rank >= MIN_TRIGGER_RANK && rank > prevRankRef.current && maxSiteIdx >= 0) {
      const [lat, lng] = sites[maxSiteIdx]
      const color = kyoshinIntensityColor(maxIdx) ?? '#ffffff'
      const baseRadius = getRippleBaseRadius(jma.scale) * iconScale
      const expansion = getRippleExpansion(jma.scale)
      const id = nextIdRef.current++
      const feature: Feature<Point> = {
        type: 'Feature',
        id,
        properties: { color },
        geometry: { type: 'Point', coordinates: [lng, lat] },
      }
      ripplesRef.current = [...ripplesRef.current, { id, color, startTime: performance.now(), baseRadius, expansion, feature }]
      syncSource()
      startLoop()
    }

    prevRankRef.current = rank
  }, [map, indices, sites, iconScale])

  return null
}
