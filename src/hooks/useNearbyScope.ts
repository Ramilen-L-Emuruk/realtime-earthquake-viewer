// ホーム地点の周り（半径 30km）を表す {@link NearbyScope} を作る。
//
// **行動チェックリストと自作地震計の波形が同じものを見る。** 元は
// `useActionChecklist` の内側にあったが、「近所が揺れているか」を要る場所が
// 2 つになったので外へ出した。
//
// **判定を 2 度書かないこと。** 別々に持つと、片方だけ半径や索引の扱いを変えた
// ときに「音は鳴るのに画は出ない」形の食い違いが生まれる —— 地図のカメラが
// 揺れフォーカスの要求を「音を鳴らすのと同じ判定」から出しているのと同じ理由
// （`docs/spec/map-rendering-spec.md` §6）。
//
// **全点の距離計算を含む**ので、`home`・観測点データ・強震モニタの観測点が
// 変わったときだけ引き直す。

import { useMemo } from 'react'
import { NO_SCOPE, type NearbyScope } from '../utils/actionChecklistTrigger'
import {
  allRegionNames,
  allStationNames,
  nearbyKyoshinKeys,
  nearbyRegionNames,
  nearbyStationNames,
  type HomePoint,
} from '../utils/nearbyStations'
import type { StationCoordsData } from '../utils/stationCoords'
import type { SiteCoords } from '../services/kyoshin'

export function useNearbyScope(params: {
  home: HomePoint | null
  stationCoords: StationCoordsData | null
  /** 強震モニタの観測点座標（半径内の観測点キーを引くのに使う）。 */
  kyoshinSites: SiteCoords
}): NearbyScope {
  const { home, stationCoords, kyoshinSites } = params
  return useMemo(() => {
    if (!home || !stationCoords) return NO_SCOPE
    return {
      kyoshinKeys: nearbyKyoshinKeys(kyoshinSites, home),
      stationNames: nearbyStationNames(stationCoords, home),
      regionNames: nearbyRegionNames(stationCoords, home),
      // 全件版は地域を絞れるときにしか使わないので、ここで一緒に作る。
      knownStationNames: allStationNames(stationCoords),
      knownRegionNames: allRegionNames(stationCoords),
    }
  }, [home, stationCoords, kyoshinSites])
}
