import { useEffect, useRef, useState } from 'react'
import type { SiteCoords } from '../services/kyoshin'
import {
  step,
  initState,
  type DetectorState,
  type DetectionEvent,
  type TriggerResult,
} from '../utils/kyoshinDetector'
import { log } from '../utils/logger'

export interface KyoshinDetectorV2Result {
  /** アクティブな検知イベント（スコア降順） */
  detections: DetectionEvent[]
  /** 今フレームのトリガー点 */
  triggers: TriggerResult[]
  /** 対象データ時刻 */
  dataTime: string
}

const EMPTY: KyoshinDetectorV2Result = { detections: [], triggers: [], dataTime: '' }

/**
 * 新・強震モニタ検知エンジン（純粋コア step）の React ラッパー。
 *
 * 既存 useKyoshinDetection と**並走**させて検証するためのフック（設計書 §10.4 / §13）。
 * UI・音・タブ切替には一切影響を与えず、検知結果を返すのみ。
 * 検証用に最新結果を window.__kyoshinV2 へ公開する。
 *
 * @param sites 観測点座標（useKyoshinRealtime.sites）
 * @param indices 計測震度インデックス（useKyoshinRealtime.indices）
 * @param dataTime データ時刻文字列（useKyoshinRealtime.dataTime）
 * @param enabled 有効フラグ（false の間は何もしない）
 */
export function useKyoshinDetectorV2(
  sites: SiteCoords,
  indices: number[],
  dataTime: string,
  enabled: boolean,
): KyoshinDetectorV2Result {
  const stateRef = useRef<DetectorState>(initState(0))
  const [result, setResult] = useState<KyoshinDetectorV2Result>(EMPTY)

  useEffect(() => {
    if (!enabled) return
    if (!dataTime || indices.length === 0 || sites.length === 0) return
    const dataTimeMs = new Date(dataTime).getTime()
    if (!Number.isFinite(dataTimeMs)) return

    const { state, detections, triggers } = step(stateRef.current, {
      dataTimeMs,
      sites: sites as [number, number][],
      values: indices,
    })
    stateRef.current = state
    setResult({ detections, triggers, dataTime })

    // 検証用にグローバル公開（Playwright から window.__kyoshinV2 を参照する）
    ;(window as unknown as Record<string, unknown>).__kyoshinV2 = {
      detections,
      triggers: triggers.length,
      dataTime,
    }
    const confirmed = detections.filter((d) => d.confidence === 'confirmed')
    if (confirmed.length > 0) {
      log.debug(
        `[kyoshinV2] confirmed=${confirmed.length} triggers=${triggers.length} @${dataTime}`,
        confirmed.map((d) => ({ id: d.id, epi: d.epicenter, score: d.score.toFixed(2) })),
      )
    }
    // indices/sites は dataTime と同時に更新されるため deps は dataTime/enabled のみでよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataTime, enabled])

  return result
}
