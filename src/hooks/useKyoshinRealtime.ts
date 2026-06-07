import { useEffect, useRef, useState } from 'react'
import {
  fetchSiteList,
  fetchRealtimeIntensity,
  hypoInfoItemToEEW,
  type SiteCoords,
  type PsWaveCircle,
  type YahooHypoInfoItem,
} from '../services/kyoshin'
import type { EEWAlert } from '../types/earthquake'

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
// 観測点リスト取得失敗時のリトライ間隔 (ms)
const SITELIST_RETRY_MS = 10_000

interface UseKyoshinRealtimeOptions {
  /** EEW の新規発報・更新・解除を検知したときに呼ばれるコールバック。 */
  onEEWEvent?: (eew: EEWAlert) => void
  /** テスト用時刻オフセット (ms)。null/undefined で現在時刻を使用。 */
  timeOffset?: number | null
}

/**
 * Yahoo 強震モニタのリアルタイム震度を取得するフック。
 * enabled が true の間のみ観測点リストを取得し、1秒ごとに震度を更新する。
 * hypoInfo の差分検出により EEW 発報・更新・解除を onEEWEvent で通知する。
 */
export function useKyoshinRealtime(
  enabled: boolean,
  options?: UseKyoshinRealtimeOptions,
): KyoshinRealtime {
  const [sites, setSites] = useState<SiteCoords>([])
  const [indices, setIndices] = useState<number[]>([])
  const [psWave, setPsWave] = useState<PsWaveCircle[]>([])
  const [dataTime, setDataTime] = useState('')
  const [error, setError] = useState(false)
  const sitesLoadedRef = useRef(false)
  const failCountRef = useRef(0)
  const prevHypoInfoRef = useRef<YahooHypoInfoItem[]>([])
  // コールバック・オプションを ref で保持し tick クロージャから安定参照する
  const onEEWEventRef = useRef(options?.onEEWEvent)
  onEEWEventRef.current = options?.onEEWEvent
  const timeOffsetRef = useRef(options?.timeOffset ?? null)
  timeOffsetRef.current = options?.timeOffset ?? null

  // 観測点リストを取得し、失敗したら SITELIST_RETRY_MS 後にリトライする
  useEffect(() => {
    if (!enabled || sitesLoadedRef.current) return
    let active = true
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const load = () => {
      fetchSiteList()
        .then((s) => {
          if (!active) return
          sitesLoadedRef.current = true
          setSites(s)
        })
        .catch(() => {
          if (!active) return
          retryTimer = setTimeout(load, SITELIST_RETRY_MS)
        })
    }
    load()

    return () => {
      active = false
      if (retryTimer !== null) clearTimeout(retryTimer)
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
        const offset = timeOffsetRef.current
        const rt = await fetchRealtimeIntensity(
          offset != null ? new Date(Date.now() + offset) : new Date(),
        )
        if (!active) return
        failCountRef.current = 0
        setError(false)
        setIndices(rt.indices)
        setPsWave(rt.psWave)
        setDataTime(rt.dataTime)

        // hypoInfo の差分を検出して EEW イベントを通知する
        const prev = prevHypoInfoRef.current
        const curr = rt.hypoInfo
        const onEEW = onEEWEventRef.current
        if (onEEW) {
          const currMap = new Map(curr.map((it) => [it.reportId, it]))
          const prevMap = new Map(prev.map((it) => [it.reportId, it]))

          // 新規発報・報番号更新
          for (const item of curr) {
            const prevItem = prevMap.get(item.reportId)
            const isNew = !prevItem
            const isUpdated = prevItem && item.reportNum !== prevItem.reportNum
            if (isNew || isUpdated) {
              onEEW(hypoInfoItemToEEW(item))
            }
          }

          // 消滅による解除（前回あったが今回リストにない）
          for (const prevItem of prev) {
            if (!currMap.has(prevItem.reportId)) {
              const cancelledEEW = hypoInfoItemToEEW(prevItem)
              onEEW({ ...cancelledEEW, cancelled: true })
            }
          }
        }
        prevHypoInfoRef.current = curr
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
