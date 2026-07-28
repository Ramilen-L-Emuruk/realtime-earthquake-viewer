import { useMemo } from 'react'
import type { JMAQuake, JMALpgm } from '../types/earthquake'
import { useStationCoords } from './useStationCoords'
import { useSubRegions } from './useSubRegions'
import {
  lookupPointCoords,
  buildAreaPrefIndex,
  buildStationPrefIndex,
  type LatLng,
} from '../utils/stationCoords'
import { pointInRings, normalizeEpicenterLng } from '../utils/geo'

// 地震モードの描画に必要な派生データ（観測点ごとの震度点／一次細分区域集約／震源）を
// 一箇所で計算する共有フック。Leaflet 版 JapanMap 内の同名 memo 群と同じ導出を行う
// （MapLibre 版 JapanMapGL と Leaflet 版の描画一致を保証するため単一の情報源に集約）。
//
// zoom は地図の現在ズーム。MAX_ZOOM 以下では観測点個別ではなく一次細分区域ごとの最大震度へ
// 集約する（aggregateByRegion）。zoom は動的なので呼び出し側（各エンジンの地図）が観測して渡す。

// 集約切替のズーム閾値（gl/camera.ts の MAX_ZOOM・Leaflet 版 JapanMap の MAX_ZOOM と一致）。
export const QUAKE_MAX_ZOOM = 8
// 震源経度の正規化に使う日本中心の経度（Leaflet 版 JAPAN_CENTER[1] と一致）。
const JAPAN_CENTER_LNG = 137.7

export interface IntensityMarker {
  key: string
  position: LatLng
  scale: number
  pref: string
  addr: string
}

export interface RegionAggregate {
  name: string
  scale: number
  rings: LatLng[][]
  label: LatLng
}

export interface LpgmMarker {
  position: LatLng
  lgInt: number
}

export interface LpgmRegionAggregate {
  name: string
  maxLgInt: number
  rings: LatLng[][]
  label: LatLng
}

export interface QuakeLayerData {
  /** 観測点ごとの震度点（震度の弱い順＝強い震度を前面に描画する想定）。 */
  intensityMarkers: IntensityMarker[]
  /** true のとき一次細分区域へ集約して塗る（zoom <= QUAKE_MAX_ZOOM）。 */
  aggregateByRegion: boolean
  /** 区域ごとの最大震度集約（弱い順）。aggregateByRegion=false のときは空。 */
  regionAggregates: RegionAggregate[]
  /** 震源が有効か。 */
  hasEpicenter: boolean
  /** 震源座標（[lat, lng]・経度は地図中心基準で正規化済み）。無効時は null。 */
  epicenter: LatLng | null
  /** 震源ポップアップ用の都道府県別最大震度（震度の降順）。 */
  prefIntensities: [string, number][]
  /** 長周期地震動（LPGM）電文が進行中か（進行中は quake 震度表示を置き換える）。 */
  lpgmActive: boolean
  /** LPGM 観測点マーカー（階級の弱い順）。 */
  lpgmMarkers: LpgmMarker[]
  /** LPGM 一次細分区域集約（階級の弱い順）。 */
  lpgmRegionAggregates: LpgmRegionAggregate[]
}

export function useQuakeLayerData(
  mode: string,
  quake: JMAQuake | null | undefined,
  zoom: number,
  lpgm?: JMALpgm | null,
): QuakeLayerData {
  const stationCoords = useStationCoords()
  const subregions = useSubRegions()

  const areaPrefIndex = useMemo(
    () => (stationCoords ? buildAreaPrefIndex(stationCoords) : new Map<string, string>()),
    [stationCoords],
  )
  const stationPrefIndex = useMemo(
    () => (stationCoords ? buildStationPrefIndex(stationCoords) : new Map<string, string>()),
    [stationCoords],
  )

  const intensityMarkers = useMemo<IntensityMarker[]>(() => {
    if (mode !== 'quake' || !quake || !stationCoords) return []
    const markers: IntensityMarker[] = []
    quake.points.forEach((p, i) => {
      const pref =
        p.pref || ((p.isArea ? areaPrefIndex.get(p.addr) : stationPrefIndex.get(p.addr)) ?? '')
      const position = lookupPointCoords(stationCoords, pref, p.addr, p.isArea)
      if (!position) return
      markers.push({ key: `${pref}|${p.addr}|${i}`, position, scale: p.scale, pref, addr: p.addr })
    })
    return markers.sort((a, b) => a.scale - b.scale)
  }, [mode, quake, stationCoords, areaPrefIndex, stationPrefIndex])

  const aggregateByRegion = mode === 'quake' && !!quake && zoom <= QUAKE_MAX_ZOOM

  // 一次細分区域に bbox を付与（点内包判定の前段フィルタ用）。
  const subregionIndex = useMemo(() => {
    if (!subregions) return []
    return subregions.map((sr) => {
      let minLat = Infinity,
        maxLat = -Infinity,
        minLng = Infinity,
        maxLng = -Infinity
      for (const ring of sr.rings)
        for (const [la, ln] of ring) {
          if (la < minLat) minLat = la
          if (la > maxLat) maxLat = la
          if (ln < minLng) minLng = ln
          if (ln > maxLng) maxLng = ln
        }
      return { sr, minLat, maxLat, minLng, maxLng }
    })
  }, [subregions])

  const regionAggregates = useMemo<RegionAggregate[]>(() => {
    if (!aggregateByRegion || subregionIndex.length === 0) return []
    const maxByName = new Map<string, number>()

    // パス1: isArea:false 観測点 → 点内包判定。
    for (const m of intensityMarkers) {
      const [lat, lng] = m.position
      for (const e of subregionIndex) {
        if (lat < e.minLat || lat > e.maxLat || lng < e.minLng || lng > e.maxLng) continue
        if (pointInRings(lat, lng, e.sr.rings)) {
          const cur = maxByName.get(e.sr.name)
          if (cur == null || m.scale > cur) maxByName.set(e.sr.name, m.scale)
          break
        }
      }
    }

    // パス2: isArea:true の地点 → 区域名で直接マッチ（観測点が海上でも確実に塗る）。
    if (quake) {
      for (const p of quake.points) {
        if (!p.isArea) continue
        const cur = maxByName.get(p.addr)
        if (cur == null || p.scale > cur) maxByName.set(p.addr, p.scale)
      }
    }

    const list: RegionAggregate[] = []
    for (const e of subregionIndex) {
      const scale = maxByName.get(e.sr.name)
      if (scale != null) list.push({ name: e.sr.name, scale, rings: e.sr.rings, label: e.sr.label })
    }
    return list.sort((a, b) => a.scale - b.scale)
  }, [aggregateByRegion, subregionIndex, intensityMarkers, quake])

  const hasEpicenter = !!(
    quake &&
    quake.earthquake.hypocenter.latitude > -200 &&
    quake.earthquake.hypocenter.longitude > -200
  )

  const epicenter = useMemo<LatLng | null>(() => {
    if (!hasEpicenter || !quake) return null
    return [
      quake.earthquake.hypocenter.latitude,
      normalizeEpicenterLng(quake.earthquake.hypocenter.longitude, JAPAN_CENTER_LNG),
    ]
  }, [hasEpicenter, quake])

  // 震源ポップアップ用の都道府県別最大震度（Leaflet 版 prefIntensities と同一導出）。
  const prefIntensities = useMemo<[string, number][]>(() => {
    if (!quake) return []
    const maxByPref = quake.points.reduce<Record<string, number>>((acc, p) => {
      if (!acc[p.pref] || p.scale > acc[p.pref]) acc[p.pref] = p.scale
      return acc
    }, {})
    return Object.entries(maxByPref).sort((a, b) => b[1] - a[1])
  }, [quake])

  const lpgmActive = !!(lpgm && !lpgm.cancelled)

  // LPGM 観測点マーカー（Leaflet 版 lpgmMarkers と同一導出）。
  const lpgmMarkers = useMemo<LpgmMarker[]>(() => {
    if (!lpgmActive || !lpgm?.points?.length || !stationCoords) return []
    const markers: LpgmMarker[] = []
    for (const p of lpgm.points) {
      const pref = p.pref || stationPrefIndex.get(p.name) || ''
      const position = lookupPointCoords(stationCoords, pref, p.name, false)
      if (!position) continue
      markers.push({ position, lgInt: p.lgInt })
    }
    return markers.sort((a, b) => a.lgInt - b.lgInt)
  }, [lpgmActive, lpgm, stationCoords, stationPrefIndex])

  // LPGM 一次細分区域集約（Leaflet 版 lpgmRegionAggregates と同一導出）。
  const lpgmRegionAggregates = useMemo<LpgmRegionAggregate[]>(() => {
    if (!lpgmActive || !lpgm?.regions?.length || !subregions) return []
    const maxByName = new Map(lpgm.regions.map((r) => [r.name, r.maxLgInt]))
    return subregions
      .filter((sr) => (maxByName.get(sr.name) ?? 0) >= 1)
      .map((sr) => ({ name: sr.name, maxLgInt: maxByName.get(sr.name)!, rings: sr.rings, label: sr.label }))
      .sort((a, b) => a.maxLgInt - b.maxLgInt)
  }, [lpgmActive, lpgm, subregions])

  return {
    intensityMarkers,
    aggregateByRegion,
    regionAggregates,
    hasEpicenter,
    epicenter,
    prefIntensities,
    lpgmActive,
    lpgmMarkers,
    lpgmRegionAggregates,
  }
}
