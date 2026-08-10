import type { LatLng } from '../../../utils/stationCoords'
import { calcFeltRadiusKm } from '../../../utils/eew'

// カメラ追従の目標範囲を決める純粋計算。maplibre-gl に依存しない。
//
// 追従の判定は「矩形を合成する」「収まっているかを見る」の2つだけで決まるため、
// maplibregl.LngLatBounds ではなくタプルで扱う。maplibre-gl はブラウザ専用で vitest の既定
// （node 環境）ではロードできないため、ここを分離しておくことで地図インスタンス無しに
// 単体テストできる。LngLatBounds への変換と地図操作は camera.ts が担う。
//
// 座標の並びは maplibre と同じ [west, south, east, north]（経度が先）。

export type BoundsTuple = [west: number, south: number, east: number, north: number]

/** EEW 予報円のうち追従計算に必要な要素（services/kyoshin の PsWaveCircle と互換）。 */
export interface EewFollowCircle {
  lat: number
  lng: number
  pRadius: number
  sRadius: number
  depth?: number
  magnitude?: number
}

// JapanMap.tsx の JAPAN_BOUNDS [[lat,lng],[lat,lng]] を [lng,lat] へ変換した値。
export const JAPAN_BOUNDS: [[number, number], [number, number]] = [
  [129.43, 30.99],
  [145.82, 45.52],
]

// EEW フォローの「引きの画（ルーズ）」余白係数。有感半径を囲む際に外側へ少し余白を持たせる。
// 日本全体ハードキャップがあるため大地震（有感半径が日本超え）では効かず、中小地震の見え方だけを整える。
export const EEW_FOLLOW_LOOSE = 1.2

/** 2つの矩形の外接矩形。片方が null ならもう片方をそのまま返す。 */
export function mergeBounds(a: BoundsTuple | null, b: BoundsTuple | null): BoundsTuple | null {
  if (!a) return b
  if (!b) return a
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

/** outer が inner を完全に含むか（辺が一致する場合も含むとみなす）。 */
export function boundsContains(outer: BoundsTuple, inner: BoundsTuple): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
}

/** 座標群（[lat,lng]）の外接矩形。空なら null。 */
export function boundsFromPositionsTuple(positions: LatLng[]): BoundsTuple | null {
  if (positions.length === 0) return null
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const [lat, lng] of positions) {
    if (lng < west) west = lng
    if (lng > east) east = lng
    if (lat < south) south = lat
    if (lat > north) north = lat
  }
  return [west, south, east, north]
}

// bounds が日本全体（JAPAN_BOUNDS）より広がらないよう各辺を内側へ詰める（大地震で有感半径が日本を
// 超えても海だけの画にしないためのハードキャップ）。日本と交差しない（完全に日本外の）場合は元のまま返す。
export function clampBoundsToJapan(b: BoundsTuple): BoundsTuple {
  const [[jw, js], [je, jn]] = JAPAN_BOUNDS
  const west = Math.max(b[0], jw)
  const south = Math.max(b[1], js)
  const east = Math.min(b[2], je)
  const north = Math.min(b[3], jn)
  if (west < east && south < north) return [west, south, east, north]
  return b
}

// EEW 予報円を追従するための bounds を算出する。追従基準は「揺れが実際に届く前線」＝S波円（sRadius・
// 無ければ pRadius）とし、速い P波円は追わない（P波を追うとカメラが揺れの到達より先へ際限なく広がるため）。
// 各波円の半径を「S波が届くと思われる範囲」＝有感半径（calcFeltRadiusKm・震度1+ が届く距離）でクランプし、
// ルーズ余白を掛け、最後に日本全体（JAPAN_BOUNDS）を超えないようクランプする。これにより S波前線を追い、
// 有感半径を余裕を持って囲んだところ（大地震では日本全体）でズームアウトが止まる。magnitude 不明時は
// 有感半径クランプを外し日本全体キャップのみ効かせる。
// 各円は中心 ± 半径ぶんの箱として加える（Leaflet の L.latLng(c).toBounds(radius*2*1000) と同じく半径=箱の半幅）。
export function boundsFromEewCircles(circles: EewFollowCircle[]): BoundsTuple | null {
  let bounds: BoundsTuple | null = null
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
    bounds = mergeBounds(bounds, [c.lng - lngDelta, c.lat - latDelta, c.lng + lngDelta, c.lat + latDelta])
  }
  return bounds ? clampBoundsToJapan(bounds) : null
}

/**
 * EEW の円 box と震源座標一点を合成した bounds。円がまだ無い EEW（仮定震源要素・震源未確定、または
 * usePsWaveCalc の再計算が1レンダー遅れているタイミング）でも、震源座標だけは必ず含める。
 * boundsFromEewCircles だけを追従先にすると、円の無い EEW の震源が画面外に取り残されるため。
 * 円のある EEW の震源座標は円の box に包含されるので、合成しても範囲は変わらない（無害）。
 */
export function boundsFromEewCirclesAndHypocenters(
  circles: EewFollowCircle[],
  hypocenters: LatLng[],
): BoundsTuple | null {
  return mergeBounds(boundsFromEewCircles(circles), boundsFromPositionsTuple(hypocenters))
}

/**
 * EEW 発報中のライブ追従の目標 bounds（タプル）。EEW の有感半径 bounds・震源座標と揺れ検知点の
 * 外接矩形を合成する。
 *
 * 合成する理由: どれか一つだけを追うと、他が画面外へ取り残される。かといって別々の追従を
 * 持たせると目標が複数になり、互いに相手をはみ出させ合って振動する。目標を1つに束ねることで
 * 「EEW の予想範囲・震源・実際に揺れている観測点のすべてが必ず入る」画を単一の判定で維持できる。
 *
 * 検知点側には日本全体クランプをかけない。JAPAN_BOUNDS は本州〜北海道を囲う枠で沖縄を含まないため、
 * 沖縄の観測点が反応した場合に切り捨ててしまう。ハードキャップは円側にのみ効かせる。
 */
export function boundsForLiveFollowTuple(
  circles: EewFollowCircle[],
  hypocenters: LatLng[],
  detectedPositions: LatLng[],
): BoundsTuple | null {
  return mergeBounds(boundsFromEewCirclesAndHypocenters(circles, hypocenters), boundsFromPositionsTuple(detectedPositions))
}
