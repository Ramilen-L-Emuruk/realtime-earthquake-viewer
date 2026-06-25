import type { LatLng } from './prefectures'

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const toRad = (deg: number) => deg * (Math.PI / 180)
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * 地図中心経度から見て最も近い側に経度を補正する。
 * 日本中心（137.7°）からベネズエラ（-68.8°）→ 291.2° に補正するケースで使用。
 */
export function normalizeEpicenterLng(lng: number, mapCenterLng: number): number {
  const candidates = [lng - 360, lng, lng + 360]
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - mapCenterLng) < Math.abs(best - mapCenterLng) ? candidate : best
  )
}

/**
 * 点 [lat, lng] が、複数リングからなる領域の内側にあるか判定する（even-odd / ray casting）。
 * MultiPolygon（複数の外周）・穴あきポリゴンにも対応（全リングのエッジ交差を通算）。
 */
export function pointInRings(lat: number, lng: number, rings: LatLng[][]): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][0], xi = ring[i][1]
      const yj = ring[j][0], xj = ring[j][1]
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside
      }
    }
  }
  return inside
}
