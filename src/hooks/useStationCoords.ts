import { useEffect, useState } from 'react'
import { loadStationCoords, type StationCoordsData } from '../utils/stationCoords'

/**
 * 震度観測点・細分区域の座標テーブルを読み込むフック。
 * 読み込み完了までは null を返す。取得失敗時も null のまま（地図はマーカー無しで動作）。
 */
export function useStationCoords(): StationCoordsData | null {
  const [data, setData] = useState<StationCoordsData | null>(null)

  useEffect(() => {
    let active = true
    loadStationCoords()
      .then((d) => {
        if (active) setData(d)
      })
      .catch(() => {
        // 座標データが取得できなくても地図自体は表示する
      })
    return () => {
      active = false
    }
  }, [])

  return data
}
