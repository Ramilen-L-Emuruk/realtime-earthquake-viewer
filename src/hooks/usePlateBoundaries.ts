import { useEffect, useState } from 'react'
import { loadPlateBoundaries, type PlateBoundarySegment } from '../utils/plateBoundaries'
import { log } from '../utils/logger'

/**
 * 日本周辺のプレート境界線データを読み込むフック。
 * 読み込み完了までは null を返す。取得失敗時も null のまま（地図はプレート境界線無しで動作）。
 */
export function usePlateBoundaries(): PlateBoundarySegment[] | null {
  const [data, setData] = useState<PlateBoundarySegment[] | null>(null)

  useEffect(() => {
    let active = true
    loadPlateBoundaries()
      .then((d) => {
        if (active) setData(d)
      })
      .catch((err) => {
        log.warn('[data] plate-boundaries 取得失敗（プレート境界線なしで継続）', err)
      })
    return () => {
      active = false
    }
  }, [])

  return data
}
