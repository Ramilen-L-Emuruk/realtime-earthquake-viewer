import { useEffect, useRef, useState } from 'react'
import {
  fetchSiteList,
  fetchRealtimeIntensity,
  type SiteCoords,
  type PsWaveCircle,
} from '../services/kyoshin'

export interface KyoshinRealtime {
  sites: SiteCoords
  indices: number[]
  psWave: PsWaveCircle[]
  dataTime: string
  /** 連続して取得に失敗し、更新が停止している場合 true */
  error: boolean
}

// この回数連続で取得に失敗したら「更新停止（エラー）」とみなす
const ERROR_THRESHOLD = 5

/**
 * Yahoo 強震モニタのリアルタイム震度を取得するフック。
 * enabled が true の間のみ観測点リストを取得し、1秒ごとに震度を更新する。
 */
export function useKyoshinRealtime(enabled: boolean): KyoshinRealtime {
  const [sites, setSites] = useState<SiteCoords>([])
  const [indices, setIndices] = useState<number[]>([])
  const [psWave, setPsWave] = useState<PsWaveCircle[]>([])
  const [dataTime, setDataTime] = useState('')
  const [error, setError] = useState(false)
  const sitesLoadedRef = useRef(false)
  const failCountRef = useRef(0)

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
    failCountRef.current = 0
    setError(false)

    const tick = async () => {
      try {
        const rt = await fetchRealtimeIntensity(new Date())
        if (!active) return
        failCountRef.current = 0
        setError(false)
        setIndices(rt.indices)
        setPsWave(rt.psWave)
        setDataTime(rt.dataTime)
      } catch {
        // 連続失敗が閾値を超えたら更新停止（エラー）とみなす
        failCountRef.current += 1
        if (active && failCountRef.current >= ERROR_THRESHOLD) setError(true)
      }
    }

    tick()
    const id = setInterval(tick, 1000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [enabled])

  return { sites, indices, psWave, dataTime, error }
}
