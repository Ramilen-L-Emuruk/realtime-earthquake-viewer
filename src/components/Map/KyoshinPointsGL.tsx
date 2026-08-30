import { useEffect, useRef } from 'react'
import type { FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { SiteCoords } from '../../services/kyoshin'
import { kyoshinIntensityColor } from '../../utils/kyoshinIntensity'
import { MISSING_HOLD_OPACITY } from '../../utils/kyoshinMissingHold'
import { addOrderedLayer } from './gl/layerOrder'

// 強震モニタの観測点（約1725点）のうち index 7+（震度1以上）を気象庁配色の circle で描画する
// MapLibre 版（Leaflet の KyoshinPoints 相当）。index 0（データ無し）と index 1〜6（震度0以下・
// KyoshinSubThreshold が描画）は不可視にする。
//
// 毎秒更新は **feature-state 差分**で行う（移行の主眼）。setData は再タイル化バーストが乗るため使わず
// （PoC realtime.ts で実証・docs/webgl-poc-surface-go2-2026-07-27.md 系）、色/不透明度を feature-state に
// 載せて paint 式から読む。表示レベルが変化した点だけ setFeatureState するため、静止時の更新はほぼ 0。

const BASE_RADIUS = 2.5 // 震度点のドット半径（Leaflet 版 KyoshinPoints と一致）
const VISIBLE_OPACITY = 0.85

const SRC = 'kyoshin-points'
const LYR = 'kyoshin-points'

interface Props {
  sites: SiteCoords
  indices: number[]
  /** 欠測ホールドで直前値を描いている点のフラグ（`indices` と同順）。該当点は薄く描く。 */
  stale?: boolean[]
  iconScale: number
  visible: boolean
}

export function KyoshinPointsGL({ sites, indices, stale, iconScale, visible }: Props) {
  const map = useMapGL()
  // 各点に前回適用した表示レベル（0 = 不可視、7+ = 可視）。差分更新用。
  const prevLevelsRef = useRef<Int8Array>(new Int8Array(0))
  // 各点に前回適用した「保持中か」（0/1）。レベルは保持中も直前値のまま変わらないため、
  // 不透明度の切替を取りこぼさないよう別に持つ。
  const prevStaleRef = useRef<Uint8Array>(new Uint8Array(0))
  const addedRef = useRef(false)

  // 観測点が揃ったら一度だけ source + layer を作る。feature-state 用に id を付与する。
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
    addOrderedLayer(map, {
      id: LYR,
      type: 'circle',
      source: SRC,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: {
        'circle-radius': BASE_RADIUS * iconScale,
        // **遠近を付けない。** `circle-pitch-scale` の既定は 'map' で、傾けるとカメラからの距離に
        // 応じて半径が縮む（傾き 60 度で奥は 1/4 ほど）。この地図の点・バッジ・ラベル・DOM マーカーは
        // すべて画面に正対したまま一定の大きさで描く方針なので、そちらへ揃える。とくに震度0以下を描く
        // `gl/subThresholdLayer.ts` は自前シェーダーの固定サイズ（`gl_PointSize`）なので、ここを既定の
        // まま残すと**同じ観測点なのに震度1以上だけ奥で縮む**という食い違いが出る。
        'circle-pitch-scale': 'viewport',
        // 色・不透明度は feature-state から読む（未設定＝不可視）。
        'circle-color': ['coalesce', ['feature-state', 'color'], '#000000'],
        'circle-opacity': ['coalesce', ['feature-state', 'opacity'], 0],
        'circle-stroke-width': 0,
        // 毎秒の setFeatureState 更新を瞬時に反映させる。既定(約300ms)のままだと
        // 色・不透明度の変化が補間フェードし、Leaflet 版の瞬時切替（setStyle）と乖離する。
        'circle-color-transition': { duration: 0, delay: 0 },
        'circle-opacity-transition': { duration: 0, delay: 0 },
      },
    })
    prevLevelsRef.current = new Int8Array(sites.length)
    prevStaleRef.current = new Uint8Array(sites.length)
    addedRef.current = true
    return () => {
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      addedRef.current = false
      prevLevelsRef.current = new Int8Array(0)
      prevStaleRef.current = new Uint8Array(0)
    }
  }, [map, sites])

  // 毎秒の震度更新（feature-state 差分・変化した点だけ）。
  // MAP-2: 非表示中は setFeatureState を止める。visible=false 中は prevLevelsRef が古い値のまま
  // 保持され、表示に戻った瞬間の useEffect（依存に visible を含める）で差分反映される。
  useEffect(() => {
    if (!map || !addedRef.current || !visible) return
    const prev = prevLevelsRef.current
    const prevStale = prevStaleRef.current
    for (let i = 0; i < sites.length; i++) {
      const idx = indices[i]
      const level = idx != null && idx >= 7 ? idx : 0
      const staleNow = level !== 0 && stale?.[i] === true ? 1 : 0
      if (level === prev[i] && staleNow === prevStale[i]) continue
      prev[i] = level
      prevStale[i] = staleNow
      const color = kyoshinIntensityColor(level)
      const opacity = staleNow ? VISIBLE_OPACITY * MISSING_HOLD_OPACITY : VISIBLE_OPACITY
      map.setFeatureState(
        { source: SRC, id: i },
        { color: color ?? '#000000', opacity: color ? opacity : 0 },
      )
    }
  }, [map, indices, stale, sites, visible])

  // UI 倍率の変化で半径を更新（震度によらず一律のため paint プロパティ一括更新）。
  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setPaintProperty(LYR, 'circle-radius', BASE_RADIUS * iconScale)
  }, [map, iconScale])

  // 表示切替（モード切替用）。
  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible])

  return null
}
