import { useEffect, useState } from 'react'
import { loadActiveFaults, type ActiveFaultSegment } from '../utils/activeFaults'
import { log } from '../utils/logger'

/**
 * 全国活断層線データを読み込むフック。
 * 読み込み完了までは null を返す。取得失敗時も null のまま（地図は活断層線無しで動作）。
 */
export function useActiveFaults(): ActiveFaultSegment[] | null {
  const [data, setData] = useState<ActiveFaultSegment[] | null>(null)

  useEffect(() => {
    let active = true
    loadActiveFaults()
      .then((d) => {
        if (active) setData(d)
      })
      .catch((err) => {
        log.warn('[data] active-faults 取得失敗（活断層線なしで継続）', err)
      })
    return () => {
      active = false
    }
  }, [])

  return data
}
