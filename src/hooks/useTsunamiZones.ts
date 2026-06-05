import { useEffect, useState } from 'react'
import { loadTsunamiZones, type TsunamiZones } from '../utils/tsunamiZones'

/**
 * 津波予報区の海岸線データを読み込むフック。
 * 読み込み完了までは null を返す。取得失敗時も null のまま（地図は海岸線無しで動作）。
 */
export function useTsunamiZones(): TsunamiZones | null {
  const [data, setData] = useState<TsunamiZones | null>(null)

  useEffect(() => {
    let active = true
    loadTsunamiZones()
      .then((d) => {
        if (active) setData(d)
      })
      .catch(() => {
        // 海岸線データが取得できなくても地図自体は表示する
      })
    return () => {
      active = false
    }
  }, [])

  return data
}
