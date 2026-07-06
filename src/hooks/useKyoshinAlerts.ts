import { useEffect, useMemo, useRef } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { TabId } from '../components/IconNav'
import type { AppSettings } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import { useKyoshinDetection, MIN_DETECTION_INDEX } from './useKyoshinDetection'
import { playAlertSound, playKyoshinUpdateSound, kyoshinLevel } from '../utils/alertSound'
import { kyoshinIndexToLabel } from '../utils/kyoshinIntensity'
import { showBrowserNotification } from '../utils/notifications'
import { log } from '../utils/logger'

// 強震モニタの揺れ検知に応じたタブ切替・ウィンドウタイトル・通知音・ブラウザ通知を担うフック。
// effect の依存配列は抽出前の App.tsx と同一集合を維持すること
// （増減させると再発火タイミングが変わり、音の再鳴リグレッションになる）。

export interface KyoshinAlertsDeps {
  kyoshinDetection: ReturnType<typeof useKyoshinDetection>
  kyoshinIndices: Parameters<typeof useKyoshinDetection>[1]
  /** cancelledAt 除外済みのアクティブ EEW が1件以上あるか */
  hasActiveEEW: boolean
  settings: AppSettings
  /** useAlertTitle の戻り値（ウィンドウタイトル操作 API） */
  title: AlertTitleApi
  /** cancelledAt 除外済みのアクティブ EEW（App 所有・毎レンダー更新） */
  activeEEWsRef: React.MutableRefObject<ReadonlyMap<string, EEWAlert>>
  /** アイドル復帰で戻すデフォルトタブ（App 所有・毎レンダー更新。デバッグログ用） */
  defaultTabRef: React.MutableRefObject<TabId>
  setActiveTab: (tab: TabId) => void
  revertToDefaultTab: () => void
}

export function useKyoshinAlerts(deps: KyoshinAlertsDeps) {
  const {
    kyoshinDetection, kyoshinIndices, hasActiveEEW, settings, title,
    activeEEWsRef, defaultTabRef, setActiveTab, revertToDefaultTab,
  } = deps

  // EEW受信中または揺れ検知中は全観測点ベースの最大インデックスを使う（表示と音を一致させる）
  const effectiveKyoshinMaxIndex = useMemo(() => {
    if (!(hasActiveEEW || kyoshinDetection.detected)) return kyoshinDetection.maxIndex
    let max = 0
    for (const idx of kyoshinIndices) {
      if (idx >= MIN_DETECTION_INDEX && idx > max) max = idx
    }
    return max > 0 ? max : kyoshinDetection.maxIndex
  }, [hasActiveEEW, kyoshinDetection.detected, kyoshinDetection.maxIndex, kyoshinIndices])

  // 揺れ検知時にリアルタイムタブを自動表示＋ウィンドウタイトル更新＋通知音
  // 検知終了（true → false）時は EEW・津波の状態に合わせてタイトルを再評価する
  const prevDetectedRef = useRef(false)
  useEffect(() => {
    if (kyoshinDetection.detected && !prevDetectedRef.current) {
      log.debug('[tab] → realtime (揺れ検知開始)')
      setActiveTab('realtime')
      title.setTitle('📈 揺れ検知')
      if (settings.soundEnabled) {
        playAlertSound('kyoshin')
      }
      if (settings.notifyMinScale >= 0 && settings.notifyDetection) {
        const label = kyoshinIndexToLabel(effectiveKyoshinMaxIndex) ?? '?'
        showBrowserNotification('揺れを検知中', `推定最大震度 ${label}（強震モニタ）`, 'kyoshin-detection')
      }
    } else if (!kyoshinDetection.detected && prevDetectedRef.current) {
      title.applyPriority({ kyoshinDetected: false })
      if (activeEEWsRef.current.size === 0) {
        log.debug(`[tab] → ${defaultTabRef.current} (揺れ検知終了)`)
        revertToDefaultTab()
      }
    }
    prevDetectedRef.current = kyoshinDetection.detected
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依存集合は抽出前と同一に維持する
  }, [kyoshinDetection.detected, effectiveKyoshinMaxIndex, settings.soundEnabled, settings.notifyDetection])

  // 揺れ検知中の音再鳴ロジック
  // - 過去最大レベルを超えたとき（新たな最大）→ 音を鳴らす
  // - ピーク後に一度落ちてから再上昇したとき（再エスカレーション）→ 音を鳴らす
  // 生インデックスではなく音レベル（0〜6）で比較することで、フレーム間の微細な
  // 数値変動（同一震度帯内のゆらぎ）による誤再鳴を防ぐ。
  const maxSoundLevelRef = useRef(0)
  // ピーク到達後に観測した最小レベル（再エスカレーション検出用）
  const postPeakMinLevelRef = useRef(0)
  useEffect(() => {
    if (!kyoshinDetection.detected) {
      maxSoundLevelRef.current = 0
      postPeakMinLevelRef.current = 0
      return
    }
    const currLevel = kyoshinLevel(effectiveKyoshinMaxIndex)
    const prevMaxLevel = maxSoundLevelRef.current
    if (currLevel > prevMaxLevel) {
      // 新たな最大レベルに達した
      maxSoundLevelRef.current = currLevel
      postPeakMinLevelRef.current = currLevel
      // 初回検知（prevMaxLevel === 0）は検知音が鳴るのでスキップ
      if (prevMaxLevel > 0) {
        log.debug(`[tab] → realtime (揺れ検知レベルアップ level=${prevMaxLevel}→${currLevel})`)
        setActiveTab('realtime')
        if (settings.soundEnabled) {
          playKyoshinUpdateSound(effectiveKyoshinMaxIndex)
        }
      }
    } else if (currLevel < postPeakMinLevelRef.current) {
      // ピーク後に下落中 → 最小値を更新するだけ
      postPeakMinLevelRef.current = currLevel
    } else if (currLevel > postPeakMinLevelRef.current) {
      // 一度落ちた後に再上昇（再エスカレーション）
      const prevMinLevel = postPeakMinLevelRef.current
      maxSoundLevelRef.current = currLevel
      postPeakMinLevelRef.current = currLevel
      log.debug(`[tab] → realtime (揺れ検知再エスカレーション level=${prevMinLevel}→${currLevel})`)
      setActiveTab('realtime')
      if (settings.soundEnabled) {
        playKyoshinUpdateSound(effectiveKyoshinMaxIndex)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依存集合は抽出前と同一に維持する
  }, [effectiveKyoshinMaxIndex, kyoshinDetection.detected, settings.soundEnabled])
}
