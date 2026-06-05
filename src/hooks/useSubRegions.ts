import { useEffect, useState } from 'react'
import { loadSubRegions, type SubRegion } from '../utils/subregions'

/**
 * 一次細分区域の境界データを読み込むフック。
 * 読み込み完了までは null を返す。取得失敗時も null のまま。
 */
export function useSubRegions(): SubRegion[] | null {
  const [data, setData] = useState<SubRegion[] | null>(null)

  useEffect(() => {
    let active = true
    loadSubRegions()
      .then((d) => {
        if (active) setData(d)
      })
      .catch(() => {
        // 区域データが取得できなくても地図自体は表示する
      })
    return () => {
      active = false
    }
  }, [])

  return data
}
