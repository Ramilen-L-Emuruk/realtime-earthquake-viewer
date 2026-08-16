import { useMemo } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { LatLng } from '../utils/stationCoords'
import { useSubRegions } from './useSubRegions'
import type { SubRegion } from '../utils/subregions'
import { eewAreas, eewMaxScale } from '../utils/eew'
import { isValidIntensityScale } from '../utils/intensity'
import { isValidLpgmClass } from '../utils/lpgm'
import { normalizeEpicenterLng } from '../utils/geo'

// EEW（緊急地震速報）の描画に必要な派生データ（対象地域の予想震度塗り／予想長周期地震動塗り／
// 各 EEW の震源）を計算する共有フック。Leaflet 版 JapanMap 内の eewAreaFills /
// eewLpgmRegionAggregates / EEW 震源 memo と同じ導出。

const JAPAN_CENTER_LNG = 137.7

/** 予想震度の根拠になった EEW の震源要素（区域へのS波到達推定に使う）。 */
export interface EewOrigin {
  lat: number
  lng: number
  depth: number
  originTime: string
}

export interface EewAreaFill {
  name: string
  scale: number
  isWarning: boolean
  rings: LatLng[][]
  /** 区域の代表点。この点までの距離からS波到達を推定する。 */
  label: LatLng
  /** 予想震度の根拠になった EEW の震源。震源未確定なら null。 */
  origin: EewOrigin | null
}

export interface EewLpgmRegionAggregate {
  name: string
  maxLgInt: number
  rings: LatLng[][]
  label: LatLng
}

export interface EewEpicenter {
  id: string
  position: LatLng
  /**
   * 仮定震源要素（単独観測点処理）による未確定の震源か。
   * 確定震源と描き分けるほか、ポップアップでも「震源未確定」の注記に使う。
   */
  isAssumed: boolean
  /** 以下はポップアップ表示用（震源名・規模・深さ・第何報・警報種別・予想最大震度）。 */
  name: string
  magnitude: number
  depth: number
  serial: string
  severity: EEWAlert['severity']
  maxScale: number
  isFinal: boolean
}

export function useEewLayerData(
  eews: EEWAlert[],
  eewLpgmEventId?: string | null,
): {
  eewAreaFills: EewAreaFill[]
  eewLpgmRegionAggregates: EewLpgmRegionAggregate[]
  eewEpicenters: EewEpicenter[]
} {
  // EEW の予想震度・予想長周期は一次細分区域単位でしか表現できないため、区域データの取得に
  // 失敗した場合の代替表示は無い（塗りが出ないまま。失敗自体は useSubRegions が error ログを出す）。
  const { data: subregions } = useSubRegions()

  const subregionByName = useMemo(() => {
    const m = new Map<string, SubRegion>()
    if (subregions) for (const sr of subregions) m.set(sr.name, sr)
    return m
  }, [subregions])

  // 表示制限（kyoshin モード限定）は呼び出し側（JapanMapGL の visible prop）で行う。
  // ここで mode ガードを掛けて data を [] に落とすと、非 kyoshin タブでは source が空のまま
  // 放置され、kyoshin タブへ切り替えた瞬間に初めて setData される＝非同期タイル化待ちの間
  // 塗りが一瞬空白になるフリッカーの原因になるため、mode に関わらず常時計算する。
  // EEW 対象地域を予想最大震度(scaleTo)の色で塗る。kindCode 10/11/19 は強震動警戒域（警報）。
  const eewAreaFills = useMemo<EewAreaFill[]>(() => {
    if (eews.length === 0) return []
    const maxByName = new Map<string, number>()
    // 予想震度の最大値を与えた EEW の震源を、区域ごとに覚えておく（S波到達の推定に使う）。
    const originByName = new Map<string, EewOrigin | null>()
    const warningNames = new Set<string>()
    for (const eew of eews) {
      const hc = eew.earthquake.hypocenter
      const origin: EewOrigin | null =
        hc.latitude > -200 && hc.longitude > -200
          ? {
              lat: hc.latitude,
              lng: normalizeEpicenterLng(hc.longitude, JAPAN_CENTER_LNG),
              depth: hc.depth,
              originTime: eew.earthquake.originTime,
            }
          : null
      for (const a of eewAreas(eew)) {
        // 震度スケール外の値は塗りに使わない（eewMaxScale と同じ理由。詳細は docs/spec/eew-spec.md §4）。
        if (!isValidIntensityScale(a.scaleTo)) continue
        const cur = maxByName.get(a.name)
        if (cur == null || a.scaleTo > cur) {
          maxByName.set(a.name, a.scaleTo)
          originByName.set(a.name, origin)
        }
        if (a.kindCode === '10' || a.kindCode === '11' || a.kindCode === '19') warningNames.add(a.name)
      }
    }
    const list: EewAreaFill[] = []
    for (const [name, scale] of maxByName) {
      const sr = subregionByName.get(name)
      if (sr && scale > 0) {
        list.push({
          name,
          scale,
          isWarning: warningNames.has(name),
          rings: sr.rings,
          label: sr.label,
          origin: originByName.get(name) ?? null,
        })
      }
    }
    // 弱い予想震度を先（下）、強い予想震度を後（前面）に。
    return list.sort((a, b) => a.scale - b.scale)
  }, [eews, subregionByName])

  // 選択された EEW の地域別予想長周期地震動階級を区域塗りで表示。
  // これは「予想」値なので、地震情報タブの実測の区域塗り（QuakeRegionFillGL /
  // LpgmRegionFillGL）と同じ地図に並ぶと実測と見分けがつかない。eewAreaFills と同じく
  // kyoshin モードに限定する（表示制限は呼び出し側の visible prop・トグル元も RealtimeTab の
  // EEW カードのみ）。
  const eewLpgmRegionAggregates = useMemo<EewLpgmRegionAggregate[]>(() => {
    if (!eewLpgmEventId || !subregions) return []
    const eew = eews.find((e) => (e.issue?.eventId ?? e.id) === eewLpgmEventId)
    if (!eew) return []
    // 階級 1〜4 以外は塗りに使わない。getLpgmClassLabel() はフォールバックを持たないため、
    // 弾かないと「階級99」のような値がそのまま地図ラベルに出る。
    const areas = eewAreas(eew).filter((a) => a.lgIntTo != null && isValidLpgmClass(a.lgIntTo))
    if (areas.length === 0) return []
    const maxByName = new Map(areas.map((a) => [a.name, a.lgIntTo!]))
    return subregions
      .filter((sr) => (maxByName.get(sr.name) ?? 0) >= 1)
      .map((sr) => ({ name: sr.name, maxLgInt: maxByName.get(sr.name)!, rings: sr.rings, label: sr.label }))
      .sort((a, b) => a.maxLgInt - b.maxLgInt)
  }, [eewLpgmEventId, eews, subregions])

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
          name: hc.name,
          magnitude: hc.magnitude,
          depth: hc.depth,
          serial: eew.issue?.serial ?? '',
          severity: eew.severity,
          maxScale: eewMaxScale(eew),
          isFinal: eew.isFinal ?? false,
        })
      }
    }
    return list
  }, [eews])

  return { eewAreaFills, eewLpgmRegionAggregates, eewEpicenters }
}
