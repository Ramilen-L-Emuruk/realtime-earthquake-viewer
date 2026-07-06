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
import { log } from '../utils/logger'

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
// リプレイ時: 同一 target への最大リトライ回数（超過したら諦めて次 target へ進む）
const REPLAY_MAX_RETRY_COUNT = 5
// 成功後に次タイムスタンプへ進むまでの待機時間 (ms)
const POLL_MS = 1000
// Yahoo サーバーがデータを公開するまでの遅延を考慮したオフセット (ms)。
// 秒境界直後はデータが未公開のことが多いため、この分だけ過去を参照して初回失敗を減らす。
const FETCH_OFFSET_MS = 500
// target が現在時刻よりこの値以上遅れていたらリアルタイムにリセットする (ms)
const MAX_LAG_MS = 5000

interface UseKyoshinRealtimeOptions {
  /** EEW の新規発報・更新・解除を検知したときに呼ばれるコールバック。 */
  onEEWEvent?: (eew: EEWAlert) => void
  /** テスト用時刻オフセット (ms)。null/undefined で現在時刻を使用。 */
  timeOffset?: number | null
}

/**
 * Yahoo 強震モニタのリアルタイム震度を取得するフック。
 * enabled が true の間のみ観測点リストを取得し、1秒ごとに震度を更新する。
 * 受信失敗時は同一タイムスタンプで RETRY_MS 間隔でリトライし、受信できたらその遅延で結果を反映する。
 * リプレイ時（timeOffset 指定時）はリトライで消費した実時間を累積して次の待機時間から差し引き、
 * かつ REPLAY_MAX_RETRY_COUNT 回を超えたら諦めて次 target へ進める（再生時刻からの遅れが蓄積しないようにする）。
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
  // コールバックを ref で保持し tick クロージャから安定参照する
  const onEEWEventRef = useRef(options?.onEEWEvent)
  onEEWEventRef.current = options?.onEEWEvent
  // timeOffset は deps に含めてエフェクトを再起動させるため、ref ではなく直接使う
  const timeOffset = options?.timeOffset ?? null

  // リアルタイム震度をポーリング（enabled の間のみ）。
  // 各 tick は明示的な target タイムスタンプを取得する。
  // 成功したら target + POLL_MS を次の target として POLL_MS 後に tick する（コマ落ち防止）。
  // 失敗時は同一 target で RETRY_MS 後にリトライする（リプレイ時は REPLAY_MAX_RETRY_COUNT 回で打ち切り）。
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

    const isReplay = timeOffset != null

    // 初回 target: リアルタイム時のみ FETCH_OFFSET_MS 分だけ過去から開始し秒境界直後の失敗を抑制する
    const initialTarget = isReplay
      ? new Date(Date.now() + timeOffset)
      : new Date(Date.now() - FETCH_OFFSET_MS)

    // リプレイ時: (アンカー実時刻, アンカー target 時刻) の組を基準に、各 target の発火予定
    // 実時刻を絶対値で計算する。setTimeout は指定時間ぴったりには発火しないため、待機時間を
    // 「前回からの経過分を引く」相対計算にすると発火遅延がtickごとに積み重なり、再生時刻が
    // 壁時計からどんどん遅れていく。絶対時刻を基準にすることで各tickの遅延がリセットされ、
    // 蓄積しない。
    const anchorRealMs = Date.now()
    const anchorTargetMs = initialTarget.getTime()
    const scheduledWaitMs = (nextTarget: Date): number =>
      Math.max(0, anchorRealMs + (nextTarget.getTime() - anchorTargetMs) - Date.now())

    // target: 今回 fetch するタイムスタンプ。retryCount: 同一 target への再試行回数。
    const tick = (target: Date, retryCount = 0) => {
      const fetchStart = Date.now()
      fetchRealtimeIntensity(target)
        .then((rt) => {
          if (!active) return
          processResult(rt)
          const nextTarget = new Date(target.getTime() + POLL_MS)
          if (!isReplay) {
            // リアルタイム時のみ: target が現在時刻から大幅に遅れていたらリセット
            const lag = Date.now() - nextTarget.getTime()
            if (lag > MAX_LAG_MS) {
              const elapsed = Date.now() - fetchStart
              timer = setTimeout(() => tick(new Date(Date.now() - FETCH_OFFSET_MS)), Math.max(0, POLL_MS - elapsed))
              return
            }
            // fetch にかかった時間を待機時間から引いて POLL_MS ごとの一定間隔を維持する
            const elapsed = Date.now() - fetchStart
            timer = setTimeout(() => tick(nextTarget), Math.max(0, POLL_MS - elapsed))
            return
          }
          // リプレイ時: アンカーからの絶対時刻で次 tick の発火時刻を計算する
          timer = setTimeout(() => tick(nextTarget), scheduledWaitMs(nextTarget))
        })
        .catch((err) => {
          if (!active) return
          if (!isReplay) {
            // リアルタイム時のみ: 連続失敗カウントを更新しエラー状態を通知する
            if (retryCount === 0) {
              failCountRef.current += 1
              if (failCountRef.current >= ERROR_THRESHOLD) {
                log.warn(`[kyoshin] 連続取得失敗 (${failCountRef.current}回) → エラー表示`, err)
                setError(true)
              }
            }
            // 同一 target で RETRY_MS 後にリトライ
            timer = setTimeout(() => tick(target, retryCount + 1), RETRY_MS)
            return
          }
          // リプレイ時: 上限回数を超えたら諦めて次 target へ進める
          // （アーカイブ側の恒久的な欠損による無限リトライを防ぐ）
          if (retryCount + 1 >= REPLAY_MAX_RETRY_COUNT) {
            const nextTarget = new Date(target.getTime() + POLL_MS)
            timer = setTimeout(() => tick(nextTarget), scheduledWaitMs(nextTarget))
            return
          }
          timer = setTimeout(() => tick(target, retryCount + 1), RETRY_MS)
        })
    }

    tick(initialTarget)
    return () => {
      active = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [enabled, timeOffset])

  return { sites, indices, psWave, dataTime, error }
}
