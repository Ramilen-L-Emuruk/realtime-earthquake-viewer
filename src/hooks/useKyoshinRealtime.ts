import { useEffect, useRef, useState } from 'react'
import { fetchSiteList, fetchRealtimeIntensity, type SiteCoords } from '../services/kyoshin'

export interface KyoshinRealtime {
  sites: SiteCoords
  indices: number[]
  dataTime: string
}

/**
 * Yahoo 強震モニタのリアルタイム震度を取得するフック。
 * enabled が true の間のみ観測点リストを取得し、1秒ごとに震度を更新する。
 */
export function useKyoshinRealtime(enabled: boolean): KyoshinRealtime {
  const [sites, setSites] = useState<SiteCoords>([])
  const [indices, setIndices] = useState<number[]>([])
  const [dataTime, setDataTime] = useState('')
  const sitesLoadedRef = useRef(false)

  // 観測点リストは初回有効化時に一度だけ取得
  useEffect(() => {
    if (!enabled || sitesLoadedRef.current) return
    let active = true
    fetchSiteList()
      .then((s) => {
        if (!active) return
        sitesLoadedRef.current = true
        setSites(s)
      })
      .catch(() => {
        // 取得失敗時は次回有効化で再試行
      })
    return () => {
      active = false
    }
  }, [enabled])

  // リアルタイム震度を1秒ごとにポーリング（enabled の間のみ）
  useEffect(() => {
    if (!enabled) return
    let active = true

    const tick = async () => {
      try {
        const rt = await fetchRealtimeIntensity(new Date())
        if (!active) return
        setIndices(rt.indices)
        setDataTime(rt.dataTime)
      } catch {
        // 一時的な取得失敗は次のtickで回復
      }
    }

    tick()
    const id = setInterval(tick, 1000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [enabled])

  return { sites, indices, dataTime }
}
