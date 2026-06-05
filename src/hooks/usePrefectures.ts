import { useEffect, useState } from 'react'
import { loadPrefectures, type Prefectures } from '../utils/prefectures'

/**
 * 都道府県の境界データを読み込むフック。
 * 読み込み完了までは null を返す。取得失敗時も null のまま（地図は境界無しで動作）。
 */
export function usePrefectures(): Prefectures | null {
  const [data, setData] = useState<Prefectures | null>(null)

  useEffect(() => {
    let active = true
    loadPrefectures()
      .then((d) => {
        if (active) setData(d)
      })
      .catch(() => {
        // 境界データが取得できなくても地図自体は表示する
      })
    return () => {
      active = false
    }
  }, [])

  return data
}
