import * as maplibregl from 'maplibre-gl'
import type { LatLng } from '../../../utils/stationCoords'

// カメラ操作の共通ヘルパ（MapLibre 版）。Leaflet の flyToLite/flyToBoundsLite 相当だが、
// flyTo 中のペイン非表示最適化（flyToLite.ts）は MapLibre では不要のため素の camera API を使う。
// Leaflet は duration を秒で受けるが MapLibre は ms のため *1000 する。座標は本アプリ共通の
// [lat,lng]（LatLng）で受け、MapLibre 用に [lng,lat] へ入れ替える。
// モード別のフィット（地震/EEW/検知/津波）は派生データに依存するため各レイヤーのフェーズで実装し、
// ここは基盤（定数＋汎用フィット）だけを提供する。

export const MAX_ZOOM = 8
// JapanMap.tsx の JAPAN_BOUNDS [[lat,lng],[lat,lng]] を [lng,lat] へ変換した値。
export const JAPAN_BOUNDS: [[number, number], [number, number]] = [
  [129.43, 30.99],
  [145.82, 45.52],
]
// JapanMap.tsx の JAPAN_CENTER [lat,lng] を [lng,lat] へ。
export const JAPAN_CENTER: [number, number] = [137.7, 38.25]

/** 日本全体にフィットする（本アプリの既定フレーミング・padding 20）。 */
export function fitJapan(map: maplibregl.Map, durationSec = 1.0): void {
  map.fitBounds(JAPAN_BOUNDS, { padding: 20, duration: durationSec * 1000 })
}

/** 1 点へ flyTo する（[lat,lng] で受ける）。 */
export function flyToPoint(map: maplibregl.Map, [lat, lng]: LatLng, zoom = MAX_ZOOM, durationSec = 1.0): void {
  map.flyTo({ center: [lng, lat], zoom, duration: durationSec * 1000 })
}

/** 座標群にフィットする（1 点なら flyTo）。padding は Leaflet の [px,px] 相当を一律 px で受ける。 */
export function fitToPositions(
  map: maplibregl.Map,
  positions: LatLng[],
  opts: { padding?: number; maxZoom?: number; durationSec?: number } = {},
): void {
  if (positions.length === 0) return
  const { padding = 48, maxZoom = MAX_ZOOM, durationSec = 1.0 } = opts
  if (positions.length === 1) {
    flyToPoint(map, positions[0], maxZoom, durationSec)
    return
  }
  const bounds = new maplibregl.LngLatBounds()
  for (const [lat, lng] of positions) bounds.extend([lng, lat])
  map.fitBounds(bounds, { padding, maxZoom, duration: durationSec * 1000 })
}
