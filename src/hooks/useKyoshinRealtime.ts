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
// 同一タイムスタンプの受信失敗時リトライ間隔 (ms)
const RETRY_MS = 200
// 成功後に次タイムスタンプへ進むまでの待機時間 (ms)
const POLL_MS = 1000
// Yahoo サーバーがデータを公開するまでの遅延を考慮したオフセット (ms)。
// 秒境界直後はデータが未公開のことが多いため、この分だけ過去を参照して初回失敗を減らす。
const FETCH_OFFSET_MS = 500

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
  const currentSiteConfigIdRef = useRef<string | null>(null)
  const failCountRef = useRef(0)
  const prevHypoInfoRef = useRef<YahooHypoInfoItem[]>([])
  // コールバック・オプションを ref で保持し tick クロージャから安定参照する
  const onEEWEventRef = useRef(options?.onEEWEvent)
  onEEWEventRef.current = options?.onEEWEvent
  const timeOffsetRef = useRef(options?.timeOffset ?? null)
  timeOffsetRef.current = options?.timeOffset ?? null

  // リアルタイム震度をポーリング（enabled の間のみ）。
  // 各 tick は明示的な target タイムスタンプを取得する。
  // 成功したら target + POLL_MS を次の target として POLL_MS 後に tick する（コマ落ち防止）。
  // 失敗時は同一 target で RETRY_MS 後にリトライし続ける。
  // siteConfigId が変化したとき（リプレイ日付切替など）に対応する sitelist を自動で取得する。
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

      // siteConfigId が変わった場合のみ対応する sitelist を取得して反映する
      if (rt.siteConfigId && rt.siteConfigId !== currentSiteConfigIdRef.current) {
        currentSiteConfigIdRef.current = rt.siteConfigId
        fetchSiteList(rt.siteConfigId)
          .then((s) => { if (active) setSites(s) })
          .catch(() => { /* 取得失敗は無視（次 tick で再試行される） */ })
      }

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

    // target: 今回 fetch するタイムスタンプ。isRetry: 同一 target の再試行かどうか。
    const tick = (target: Date, isRetry = false) => {
      fetchRealtimeIntensity(target)
        .then((rt) => {
          if (!active) return
          processResult(rt)
          // 成功タイムスタンプの POLL_MS 後を次回 target にする（コマ落ちしない連番進行）
          const nextTarget = new Date(target.getTime() + POLL_MS)
          timer = setTimeout(() => tick(nextTarget), POLL_MS)
        })
        .catch(() => {
          if (!active) return
          // 初回試行失敗のみ連続失敗カウントを更新する
          if (!isRetry) {
            failCountRef.current += 1
            if (failCountRef.current >= ERROR_THRESHOLD) setError(true)
          }
          // 同一 target で RETRY_MS 後にリトライ
          timer = setTimeout(() => tick(target, true), RETRY_MS)
        })
    }

    // 初回 target: FETCH_OFFSET_MS 分だけ過去から開始し、秒境界直後の未公開による失敗を抑制する
    const initialTarget = timeOffsetRef.current != null
      ? new Date(Date.now() + timeOffsetRef.current - FETCH_OFFSET_MS)
      : new Date(Date.now() - FETCH_OFFSET_MS)
    tick(initialTarget)
    return () => {
      active = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [enabled])

  return { sites, indices, psWave, dataTime, error }
}
