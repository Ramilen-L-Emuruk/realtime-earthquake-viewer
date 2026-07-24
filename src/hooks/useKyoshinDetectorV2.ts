import { useEffect, useRef, useState } from 'react'
import type { SiteCoords } from '../services/kyoshin'
import {
  step,
  initState,
  buildStationMeta,
  siteKey,
  type DetectorState,
  type StationMeta,
  type DetectionEvent,
  type TriggerResult,
} from '../utils/kyoshinDetector'
import { log } from '../utils/logger'

export interface KyoshinDetectorV2Result {
  /** アクティブな検知イベント（最大震度降順） */
  detections: DetectionEvent[]
  /** 今フレームのトリガー点 */
  triggers: TriggerResult[]
  /** 対象データ時刻 */
  dataTime: string
}

const EMPTY: KyoshinDetectorV2Result = { detections: [], triggers: [], dataTime: '' }

/** 観測点集合の簡易シグネチャ（点数＋先頭・末尾座標）。これが変わったら近傍メタを組み直す。 */
function siteSignature(sites: SiteCoords): string {
  if (sites.length === 0) return ''
  const first = sites[0]
  const last = sites[sites.length - 1]
  return `${sites.length}|${siteKey(first[0], first[1])}|${siteKey(last[0], last[1])}`
}

/**
 * 強震モニタ検知エンジン（純粋コア step・V3 近傍一致型）の React ラッパー。
 *
 * 強震モニタ検知の唯一のエンジン。検知結果は音・自動タブ切替・自動フィット・地図オーバーレイ・
 * リアルタイムタブのカード表示を駆動する。デバッグ用に最新結果を window.__kyoshinV2 へ公開する。
 *
 * 近傍グラフ・格子割当（StationMeta）は観測点集合が変わったときだけ再計算してキャッシュする
 * （実行時座標から純粋な幾何計算・追加リクエスト 0）。
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
  const metaRef = useRef<{ sig: string; meta: StationMeta } | null>(null)
  const [result, setResult] = useState<KyoshinDetectorV2Result>(EMPTY)

  useEffect(() => {
    if (!enabled) return
    if (!dataTime || indices.length === 0 || sites.length === 0) return
    const dataTimeMs = new Date(dataTime).getTime()
    if (!Number.isFinite(dataTimeMs)) return

    // 観測点集合が変わったときだけ近傍メタを構築（フレーム毎の O(点数²) を避ける）
    const sig = siteSignature(sites)
    if (!metaRef.current || metaRef.current.sig !== sig) {
      metaRef.current = { sig, meta: buildStationMeta(sites as [number, number][]) }
    }

    const { state, detections, triggers } = step(
      stateRef.current,
      { dataTimeMs, sites: sites as [number, number][], values: indices },
      metaRef.current.meta,
    )
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
        confirmed.map((d) => ({
          id: d.id,
          maxIntensity: d.maxIntensity.toFixed(1),
          size: d.lastSize,
          epi: d.epicenter,
        })),
      )
    }
    // indices/sites は dataTime と同時に更新されるため deps は dataTime/enabled のみでよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataTime, enabled])

  return result
}
