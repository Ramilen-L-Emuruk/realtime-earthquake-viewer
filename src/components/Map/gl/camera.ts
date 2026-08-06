import * as maplibregl from 'maplibre-gl'
import type { LatLng } from '../../../utils/stationCoords'
import { calcFeltRadiusKm } from '../../../utils/eew'

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

// 「プログラムによるカメラ操作が進行中か」の共有状態。kyoshin モードでは FitJapanOnEnter／
// FitToCandidate／FitToDetection／FitToEEW が同じ map インスタンスを別々のコンポーネントから
// 操作するが、MapLibre の flyTo/fitBounds はプログラム操作でも zoomstart/dragstart を発火する。
// FitToEEW はこれらのイベントで「ユーザーが手動操作したか」を判定するため、各コンポーネントが
// 私有の ref で自分の操作だけを除外していると、他コンポーネントの自動フィットをユーザー操作と
// 誤認してしまう（実際の地震では EEW と揺れ検知が同時に動くため起きやすい）。ここに一元化し、
// このファイルの fit 系関数を呼ぶたびに立てることで、発生源を問わず判定できるようにする。
const programmaticFlights = new WeakMap<maplibregl.Map, number>()

function beginProgrammaticFlight(map: maplibregl.Map): void {
  programmaticFlights.set(map, (programmaticFlights.get(map) ?? 0) + 1)
  map.once('moveend', () => {
    programmaticFlights.set(map, Math.max(0, (programmaticFlights.get(map) ?? 1) - 1))
  })
}

/** 現在 map 上でこのファイルの fit 系関数によるカメラ操作が進行中か。 */
export function isProgrammaticFlight(map: maplibregl.Map): boolean {
  return (programmaticFlights.get(map) ?? 0) > 0
}

/** 日本全体にフィットする（本アプリの既定フレーミング・padding 20）。 */
export function fitJapan(map: maplibregl.Map, durationSec = 1.0): void {
  beginProgrammaticFlight(map)
  map.fitBounds(JAPAN_BOUNDS, { padding: 20, duration: durationSec * 1000 })
}

/** 1 点へ flyTo する（[lat,lng] で受ける）。 */
export function flyToPoint(map: maplibregl.Map, [lat, lng]: LatLng, zoom = MAX_ZOOM, durationSec = 1.0): void {
  beginProgrammaticFlight(map)
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
  beginProgrammaticFlight(map)
  map.fitBounds(bounds, { padding, maxZoom, duration: durationSec * 1000 })
}

/** bounds へ fitBounds する（duration 秒→ms）。 */
export function flyToBounds(
  map: maplibregl.Map,
  bounds: maplibregl.LngLatBounds,
  opts: { padding?: number; maxZoom?: number; durationSec?: number } = {},
): void {
  const { padding = 48, maxZoom = MAX_ZOOM, durationSec = 1.0 } = opts
  beginProgrammaticFlight(map)
  map.fitBounds(bounds, { padding, maxZoom, duration: durationSec * 1000 })
}

// 旧 Leaflet 版の MapContainer は zoomSnap=0.5（da119cc JapanMap.tsx:950）で、fitBounds/flyToBounds の
// 着地ズームは常に 0.5 段階へ丸められていた。この「段階」がヒステリシスとなり、EEW 予報円が連続成長
// （実発報時 ~10/s）しても、再フィットは円が 0.5 レベルぶん育つまで発火せず頻発しなかった。
// MapLibre の fitBounds は分数ズームで円へぴったり合わせるため余白が無く、少しの成長で毎回はみ出し→
// 再フィットが頻発する（移行で失われたのは zoomSnap だけ・成長フォローの contains 判定は現行と同一）。
export const EEW_ZOOM_SNAP = 0.5

/**
 * bounds に合うズームを算出し zoomStep 段階へ切り下げて（＝わずかにズームアウトして余白を残して）fly する。
 * 旧 Leaflet の `getBoundsZoom(inside=false)`＋`zoomSnap` 相当のヒステリシスを再現する。
 */
export function flyToBoundsSnapped(
  map: maplibregl.Map,
  bounds: maplibregl.LngLatBounds,
  opts: { padding?: number; maxZoom?: number; durationSec?: number; zoomStep?: number } = {},
): void {
  const { padding = 48, maxZoom = MAX_ZOOM, durationSec = 1.0, zoomStep = EEW_ZOOM_SNAP } = opts
  const cam = map.cameraForBounds(bounds, { padding, maxZoom })
  if (!cam || cam.zoom == null) {
    // cameraForBounds が算出不可なときは通常 fitBounds にフォールバック（分数ズーム）。
    beginProgrammaticFlight(map)
    map.fitBounds(bounds, { padding, maxZoom, duration: durationSec * 1000 })
    return
  }
  // 円が収まる最大ズームを zoomStep 段階へ切り下げる。浮動小数の 6.9999… が 6.5 に落ちるのを防ぐため
  // わずかなイプシロンを足してから floor する。
  const snappedZoom = Math.floor((cam.zoom + 1e-6) / zoomStep) * zoomStep
  beginProgrammaticFlight(map)
  map.flyTo({ center: cam.center, zoom: snappedZoom, duration: durationSec * 1000 })
}

// EEW フォローの「引きの画（ルーズ）」余白係数。有感半径を囲む際に外側へ少し余白を持たせる。
// 日本全体ハードキャップがあるため大地震（有感半径が日本超え）では効かず、中小地震の見え方だけを整える。
export const EEW_FOLLOW_LOOSE = 1.2

// EEW 予報円を追従するための bounds を算出する。追従基準は「揺れが実際に届く前線」＝S波円（sRadius・
// 無ければ pRadius）とし、速い P波円は追わない（P波を追うとカメラが揺れの到達より先へ際限なく広がるため）。
// 各波円の半径を「S波が届くと思われる範囲」＝有感半径（calcFeltRadiusKm・震度1+ が届く距離）でクランプし、
// ルーズ余白を掛け、最後に日本全体（JAPAN_BOUNDS）を超えないようクランプする。これにより S波前線を追い、
// 有感半径を余裕を持って囲んだところ（大地震では日本全体）でズームアウトが止まる。magnitude 不明時は
// 有感半径クランプを外し日本全体キャップのみ効かせる。
// 各円は中心 ± 半径ぶんの箱として加える（Leaflet の L.latLng(c).toBounds(radius*2*1000) と同じく半径=箱の半幅）。
export function boundsFromCirclesForEewFollow(
  circles: { lat: number; lng: number; pRadius: number; sRadius: number; depth?: number; magnitude?: number }[],
): maplibregl.LngLatBounds | null {
  let bounds: maplibregl.LngLatBounds | null = null
  for (const c of circles) {
    // 揺れの前線＝S波円を基準に追従する（sRadius 優先・無ければ pRadius へフォールバック）。
    const waveRadiusKm = c.sRadius > 0 ? c.sRadius : c.pRadius
    if (waveRadiusKm <= 0) continue
    // S波が届くと思われる範囲でクランプ。magnitude が有効な値のときのみ有感半径を算出する。
    const hasMag = c.magnitude != null && Number.isFinite(c.magnitude) && c.magnitude > 0
    const feltRadiusKm = hasMag ? calcFeltRadiusKm(c.magnitude as number, c.depth ?? 0) : Infinity
    const radiusKm = Math.min(waveRadiusKm, feltRadiusKm) * EEW_FOLLOW_LOOSE
    const latDelta = radiusKm / 111.32
    const lngDelta = radiusKm / (111.32 * Math.cos((c.lat * Math.PI) / 180))
    const sw: [number, number] = [c.lng - lngDelta, c.lat - latDelta]
    const ne: [number, number] = [c.lng + lngDelta, c.lat + latDelta]
    if (!bounds) bounds = new maplibregl.LngLatBounds(sw, ne)
    else {
      bounds.extend(sw)
      bounds.extend(ne)
    }
  }
  return bounds ? clampBoundsToJapan(bounds) : null
}

// bounds が日本全体（JAPAN_BOUNDS）より広がらないよう各辺を内側へ詰める（大地震で有感半径が日本を
// 超えても海だけの画にしないためのハードキャップ）。日本と交差しない（完全に日本外の）場合は元のまま返す。
function clampBoundsToJapan(b: maplibregl.LngLatBounds): maplibregl.LngLatBounds {
  const [[jw, js], [je, jn]] = JAPAN_BOUNDS
  const w = Math.max(b.getWest(), jw)
  const s = Math.max(b.getSouth(), js)
  const e = Math.min(b.getEast(), je)
  const n = Math.min(b.getNorth(), jn)
  if (w < e && s < n) return new maplibregl.LngLatBounds([w, s], [e, n])
  return b
}

// 現在の表示範囲が target bounds を完全に含むか（EEW 波円成長フォローの「収まっているか」判定）。
export function mapContainsBounds(map: maplibregl.Map, target: maplibregl.LngLatBounds): boolean {
  const view = map.getBounds()
  return (
    view.getWest() <= target.getWest() &&
    view.getEast() >= target.getEast() &&
    view.getSouth() <= target.getSouth() &&
    view.getNorth() >= target.getNorth()
  )
}
