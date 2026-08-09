import { useMemo } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { LatLng } from '../utils/stationCoords'
import { useSubRegions } from './useSubRegions'
import { eewAreas } from '../utils/eew'
import { normalizeEpicenterLng } from '../utils/geo'

// EEW（緊急地震速報）の描画に必要な派生データ（対象地域の予想震度塗り／予想長周期地震動塗り／
// 各 EEW の震源）を計算する共有フック。Leaflet 版 JapanMap 内の eewAreaFills /
// eewLpgmRegionAggregates / EEW 震源 memo と同じ導出。

const JAPAN_CENTER_LNG = 137.7

export interface EewAreaFill {
  name: string
  scale: number
  isWarning: boolean
  rings: LatLng[][]
}

export interface EewLpgmRegionAggregate {
  name: string
  maxLgInt: number
  rings: LatLng[][]
}

export interface EewEpicenter {
  id: string
  position: LatLng
  /** 仮定震源要素（単独観測点処理）による未確定の震源か。確定震源と描き分けるために使う。 */
  isAssumed: boolean
}

export function useEewLayerData(
  mode: string,
  eews: EEWAlert[],
  eewLpgmEventId?: string | null,
): {
  eewAreaFills: EewAreaFill[]
  eewLpgmRegionAggregates: EewLpgmRegionAggregate[]
  eewEpicenters: EewEpicenter[]
} {
  const subregions = useSubRegions()

  const subregionByName = useMemo(() => {
    const m = new Map<string, { rings: LatLng[][] }>()
    if (subregions) for (const sr of subregions) m.set(sr.name, sr)
    return m
  }, [subregions])

  // EEW 対象地域を予想最大震度(scaleTo)の色で塗る。kindCode 10/11/19 は強震動警戒域（警報）。
  const eewAreaFills = useMemo<EewAreaFill[]>(() => {
    if (mode !== 'kyoshin' || eews.length === 0) return []
    const maxByName = new Map<string, number>()
    const warningNames = new Set<string>()
    for (const eew of eews) {
      for (const a of eewAreas(eew)) {
        maxByName.set(a.name, Math.max(maxByName.get(a.name) ?? 0, a.scaleTo))
        if (a.kindCode === '10' || a.kindCode === '11' || a.kindCode === '19') warningNames.add(a.name)
      }
    }
    const list: EewAreaFill[] = []
    for (const [name, scale] of maxByName) {
      const sr = subregionByName.get(name)
      if (sr && scale > 0) list.push({ name, scale, isWarning: warningNames.has(name), rings: sr.rings })
    }
    // 弱い予想震度を先（下）、強い予想震度を後（前面）に。
    return list.sort((a, b) => a.scale - b.scale)
  }, [mode, eews, subregionByName])

  // 選択された EEW の地域別予想長周期地震動階級を区域塗りで表示。
  // これは「予想」値なので、地震情報タブの実測の区域塗り（QuakeRegionFillGL /
  // LpgmRegionFillGL）と同じ地図に並ぶと実測と見分けがつかない。eewAreaFills と同じく
  // kyoshin モードに限定する（トグル元も RealtimeTab の EEW カードのみ）。
  const eewLpgmRegionAggregates = useMemo<EewLpgmRegionAggregate[]>(() => {
    if (mode !== 'kyoshin' || !eewLpgmEventId || !subregions) return []
    const eew = eews.find((e) => (e.issue?.eventId ?? e.id) === eewLpgmEventId)
    if (!eew) return []
    const areas = eewAreas(eew).filter((a) => (a.lgIntTo ?? 0) >= 1)
    if (areas.length === 0) return []
    const maxByName = new Map(areas.map((a) => [a.name, a.lgIntTo!]))
    return subregions
      .filter((sr) => (maxByName.get(sr.name) ?? 0) >= 1)
      .map((sr) => ({ name: sr.name, maxLgInt: maxByName.get(sr.name)!, rings: sr.rings }))
      .sort((a, b) => a.maxLgInt - b.maxLgInt)
  }, [mode, eewLpgmEventId, eews, subregions])

  // 各 EEW の震源（有効なもののみ・経度は地図中心基準で正規化）。全モードで表示する。
  const eewEpicenters = useMemo<EewEpicenter[]>(() => {
    const list: EewEpicenter[] = []
    for (const eew of eews) {
      const hc = eew.earthquake.hypocenter
      if (hc.latitude > -200 && hc.longitude > -200) {
        list.push({
          id: eew.id,
          position: [hc.latitude, normalizeEpicenterLng(hc.longitude, JAPAN_CENTER_LNG)],
          // 単独観測点処理の震源は後続報で大きく動く。予報円を出さない・カードで M/深さを
          // 隠すのと同じ扱いを地図の震源にも与えるため、確定/未確定を描画側へ伝える。
          isAssumed: eew.earthquake.condition === '仮定震源要素',
        })
      }
    }
    return list
  }, [eews])

  return { eewAreaFills, eewLpgmRegionAggregates, eewEpicenters }
}
