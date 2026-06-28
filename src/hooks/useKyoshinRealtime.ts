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
// 同一タイムスタンプの受信失敗時リトライ間隔 (ms)
const RETRY_MS = 200
// 通常ポーリング間隔 (ms)
const POLL_MS = 1000

interface UseKyoshinRealtimeOptions {
  /** EEW の新規発報・更新・解除を検知したときに呼ばれるコールバック。 */
  onEEWEvent?: (eew: EEWAlert) => void
  /** テスト用時刻オフセット (ms)。null/undefined で現在時刻を使用。 */
  timeOffset?: number | null
}

/**
 * Yahoo 強震モニタのリアルタイム震度を取得するフック。
 * enabled が true の間のみ観測点リストを取得し、1秒ごとに震度を更新する。
 * 受信失敗時は同一タイムスタンプで RETRY_MS 間隔でリトライし続け、
 * 受信できたらその遅延で結果を反映する。
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

  // リアルタイム震度を POLL_MS ごとにポーリング（enabled の間のみ）。
  // 受信失敗時は同一タイムスタンプで RETRY_MS 後にリトライし続け、
  // 成功したら POLL_MS 後に次の tick を実行する。
  useEffect(() => {
    if (!enabled) return
    let active = true
    failCountRef.current = 0
    setError(false)
    let timer: ReturnType<typeof setTimeout> | null = null

    const processResult = (rt: Awaited<ReturnType<typeof fetchRealtimeIntensity>>) => {
      failCountRef.current = 0
      setError(false)
      setIndices(rt.indices)
      setPsWave(rt.psWave)
      setDataTime(rt.dataTime)

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
    }

    // targetTime が指定されている場合はリトライ（同一タイムスタンプを再取得）
    const tick = (targetTime?: Date) => {
      const isRetry = targetTime !== undefined
      const now = targetTime ?? (
        timeOffsetRef.current != null
          ? new Date(Date.now() + timeOffsetRef.current)
          : new Date()
      )

      fetchRealtimeIntensity(now)
        .then((rt) => {
          if (!active) return
          processResult(rt)
          // 成功したら POLL_MS 後に次の自然な tick
          timer = setTimeout(() => tick(), POLL_MS)
        })
        .catch(() => {
          if (!active) return
          // 初回試行失敗のみ連続失敗カウントを更新する
          if (!isRetry) {
            failCountRef.current += 1
            if (failCountRef.current >= ERROR_THRESHOLD) setError(true)
          }
          // 同一タイムスタンプで RETRY_MS 後にリトライ
          timer = setTimeout(() => tick(now), RETRY_MS)
        })
    }

    tick()
    return () => {
      active = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [enabled])

  return { sites, indices, psWave, dataTime, error }
}
