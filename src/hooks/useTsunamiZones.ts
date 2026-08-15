import { useEffect, useState } from 'react'
import { loadTsunamiZones, type TsunamiZones } from '../utils/tsunamiZones'
import { log } from '../utils/logger'

// 失敗ログを出したか（モジュール単位）。React StrictMode では effect が二重に走るため、
// 素直に catch で出すと同一の失敗が 2 本並ぶ。原因は 1 つなのでログも 1 本に抑える。
// 成功時のリセットは、要求元が本フック 1 箇所しかない現状では発火しない（2 回目の取得自体が
// 起きない）。要求元が増えたときに「後から起きた別の失敗を握り潰さない」ための備え。
let failureLogged = false

/**
 * 津波予報区の海岸線データを読み込むフック。
 * 読み込み完了までは null を返す。取得失敗時も null のまま（地図は海岸線無しで動作）。
 *
 * 区域データ（useSubRegions）・座標テーブル（useStationCoords）と違い、取得成功の購読による
 * 復帰は持たない。本データの要求元は本フック 1 箇所だけで、後から再取得を試みる別の呼び出し元が
 * 存在しないため（購読しても通知する側がいない）。要求元が増えたら
 * utils/subregions.ts の onSubRegionsLoaded と同じ仕組みを検討すること。
 */
export function useTsunamiZones(): TsunamiZones | null {
  const [data, setData] = useState<TsunamiZones | null>(null)

  useEffect(() => {
    let active = true
    loadTsunamiZones()
      .then((d) => {
        failureLogged = false
        if (active) setData(d)
      })
      .catch((err) => {
        // 海岸線データが取得できなくても地図自体は表示する。ただし津波モードの主表示である
        // 警報・注意報の海岸線は、このデータでしか描けないため代替表示が無い（観測点の波高バーは
        // 別データなので残る）。ページを再読み込みするまで復帰しない。
        if (!failureLogged) {
          failureLogged = true
          log.error(
            '[data] tsunami-zones 取得失敗（津波警報・注意報の海岸線が地図に出ない。波高バーと一覧は表示される）',
            err,
          )
        }
      })
    return () => {
      active = false
    }
  }, [])

  return data
}
