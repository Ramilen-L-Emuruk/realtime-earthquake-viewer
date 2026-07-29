import { useEffect, useRef, useState } from 'react'
import type { SiteCoords } from '../services/kyoshin'
import {
  step,
  initState,
  buildStationMeta,
  extractLearned,
  hydrateLearned,
  siteKey,
  chronicNoiseFloor,
  type DetectorState,
  type StationMeta,
  type LearnedState,
  type DetectionEvent,
  type TriggerResult,
} from '../utils/kyoshinDetector'
import { log } from '../utils/logger'

/** 学習資産（点別床・セル慢性活性）の localStorage キー。座標/セル基準なので siteConfigId 版差に非依存。 */
const LEARNED_KEY = 'kyoshin-v3-learned'
/** 学習資産の保存間隔(ms)。毎フレーム書くと無駄なのでスロットルする。 */
const SAVE_INTERVAL_MS = 60_000

/** localStorage から学習資産を復元した初期状態を作る（無ければ空状態）。 */
function loadInitialState(): DetectorState {
  const base = initState(0)
  try {
    const raw = localStorage.getItem(LEARNED_KEY)
    if (!raw) return base
    const learned = JSON.parse(raw) as LearnedState
    if (!learned || typeof learned !== 'object' || !learned.floors) return base
    return hydrateLearned(base, learned)
  } catch {
    return base
  }
}

/** 学習資産を localStorage に保存する（容量超過・無効環境は握りつぶす）。 */
function saveLearned(state: DetectorState): void {
  try {
    localStorage.setItem(LEARNED_KEY, JSON.stringify(extractLearned(state)))
  } catch {
    /* localStorage 不可（容量超過・プライベートモード等）は学習を諦めるだけ。検知は継続 */
  }
}

export interface KyoshinDetectorV2Result {
  /** アクティブな検知イベント（最大震度降順） */
  detections: DetectionEvent[]
  /** 今フレームのトリガー点 */
  triggers: TriggerResult[]
  /** 対象データ時刻 */
  dataTime: string
  /**
   * 観測点ごとの表示用慢性ノイズ床（座標キー→value）。震度0ドット表示（KyoshinSubThresholdGL）が
   * 慢性的にノイジーな観測点を鈍く見せるフィルタに使う。未学習（空オブジェクト）はフィルタ未適用の合図。
   */
  floors: Record<string, number>
}

const EMPTY: KyoshinDetectorV2Result = { detections: [], triggers: [], dataTime: '', floors: {} }

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
 * @param hasActiveWarningEEW severity='Warning' の EEW が発表中か（Forecast 除く・cancelled 除く）。
 *   true の間は confirmed の確定条件を緩和する（§19）。低確度の予報級では緩和しない。
 */
export function useKyoshinDetectorV2(
  sites: SiteCoords,
  indices: number[],
  dataTime: string,
  enabled: boolean,
  hasActiveWarningEEW: boolean,
): KyoshinDetectorV2Result {
  const stateRef = useRef<DetectorState>(loadInitialState())
  const metaRef = useRef<{ sig: string; meta: StationMeta } | null>(null)
  const lastSaveRef = useRef(0)
  // dataTime 更新時のみ step() を進める設計（下記 useEffect の deps 参照）に合わせ、EEW 状態は
  // ref で最新値を持ち回す（deps に含めると EEW 変化のたびに同一フレームへ再度 step() してしまう）。
  const hasActiveWarningEEWRef = useRef(hasActiveWarningEEW)
  hasActiveWarningEEWRef.current = hasActiveWarningEEW
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
      {
        dataTimeMs,
        sites: sites as [number, number][],
        values: indices,
        eewActive: hasActiveWarningEEWRef.current,
      },
      metaRef.current.meta,
    )
    stateRef.current = state

    const floors: Record<string, number> = {}
    for (const [key, s] of Object.entries(state.sites)) floors[key] = chronicNoiseFloor(s)

    setResult({ detections, triggers, dataTime, floors })

    // 学習資産（点別床・セル慢性活性）を定期的に永続化する（再読込・5時リロード後も学習を保つ）
    if (dataTimeMs - lastSaveRef.current >= SAVE_INTERVAL_MS) {
      lastSaveRef.current = dataTimeMs
      saveLearned(state)
    }

    // 検証用にグローバル公開（Playwright から window.__kyoshinV2 を参照する）
    ;(window as unknown as Record<string, unknown>).__kyoshinV2 = {
      detections,
      triggers: triggers.length,
      dataTime,
      eewActive: hasActiveWarningEEWRef.current,
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
