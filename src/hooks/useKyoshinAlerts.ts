import { useEffect, useMemo, useRef } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { TabId } from '../components/IconNav'
import type { AppSettings } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import { MIN_DETECTION_INDEX } from '../utils/kyoshinDetectionView'
import { playAlertSound, playKyoshinUpdateSound, kyoshinLevel } from '../utils/alertSound'
import { kyoshinIndexToLabel } from '../utils/kyoshinIntensity'
import { showBrowserNotification } from '../utils/notifications'
import { log } from '../utils/logger'

// 強震モニタの揺れ検知（V2 エンジン）に応じたタブ切替・ウィンドウタイトル・通知音・ブラウザ通知を担うフック。
//
// confirmed（確定検知）と candidate（likely・可能性）の2段で反応する:
//  - candidate 立ち上がり → realtime タブ＋控えめな候補音（確定前の早期反応）
//  - confirmed 立ち上がり → realtime タブ＋検知音＋ブラウザ通知
//  - confirmed 中のレベルアップ／再エスカレーション → 更新音の再鳴
//  - 各々の終了 → EEW が無ければデフォルトタブへ復帰
// 音レベルは全観測点の実効最大インデックス（表示と一致）で判定する。

export interface KyoshinAlertsDeps {
  /** confirmed イベントが1件以上あるか（V2 検知の確定） */
  confirmed: boolean
  /** likely イベントが1件以上あるか（V2 検知の可能性・早期反応の駆動元） */
  candidate: boolean
  /** cancelledAt 除外済みのアクティブ EEW が1件以上あるか */
  hasActiveEEW: boolean
  /** 現フレームの全観測点インデックス（実効最大インデックスの再計算に使う） */
  kyoshinIndices: number[]
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
    confirmed, candidate, hasActiveEEW, kyoshinIndices, settings, title,
    activeEEWsRef, defaultTabRef, setActiveTab, revertToDefaultTab,
  } = deps

  // EEW 受信中または揺れ検知中は全観測点ベースの最大インデックスを使う（表示と音を一致させる）。
  // 非検知・非 EEW 時は音を鳴らさないため 0 でよい。
  const effectiveKyoshinMaxIndex = useMemo(() => {
    if (!(hasActiveEEW || confirmed)) return 0
    let max = 0
    for (const idx of kyoshinIndices) {
      if (idx >= MIN_DETECTION_INDEX && idx > max) max = idx
    }
    return max
  }, [hasActiveEEW, confirmed, kyoshinIndices])

  // 確定検知時に realtime タブを自動表示＋ウィンドウタイトル更新＋通知音。
  // 検知終了（true → false）時は EEW・津波の状態に合わせてタイトルを再評価する。
  const prevConfirmedRef = useRef(false)
  useEffect(() => {
    if (confirmed && !prevConfirmedRef.current) {
      log.debug('[tab] → realtime (揺れ検知開始 V2 confirmed)')
      setActiveTab('realtime')
      title.setTitle('📈 揺れ検知')
      if (settings.soundEnabled) {
        playAlertSound('kyoshin')
      }
      if (settings.notifyMinScale >= 0 && settings.notifyDetection) {
        const label = kyoshinIndexToLabel(effectiveKyoshinMaxIndex) ?? '?'
        showBrowserNotification('揺れを検知中', `推定最大震度 ${label}（強震モニタ）`, 'kyoshin-detection')
      }
    } else if (!confirmed && prevConfirmedRef.current) {
      title.applyPriority({ kyoshinDetected: false })
      if (activeEEWsRef.current.size === 0) {
        log.debug(`[tab] → ${defaultTabRef.current} (揺れ検知終了 V2)`)
        revertToDefaultTab()
      }
    }
    prevConfirmedRef.current = confirmed
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 音の再鳴を安定させるため依存は限定する
  }, [confirmed, effectiveKyoshinMaxIndex, settings.soundEnabled, settings.notifyDetection])

  // 可能性（likely）発生時の早期反応: タブ切替＋タイトル変更＋控えめな候補音のみ
  // （ブラウザ通知・フル音は確定時まで行わない）。確定（confirmed）に昇格した場合は上の
  // 検知開始エフェクトが引き継ぐため、ここでは confirmed が false のときだけを対象にする。
  const prevCandidateRef = useRef(false)
  useEffect(() => {
    if (candidate && !prevCandidateRef.current && !confirmed) {
      log.debug('[tab] → realtime (揺れの可能性 V2 likely)')
      setActiveTab('realtime')
      title.setTitle('🔍 揺れの可能性')
      if (settings.soundEnabled) {
        playAlertSound('kyoshinCandidate')
      }
    } else if (!candidate && prevCandidateRef.current && !confirmed) {
      // 確定に昇格せず消えた場合のみ、静かに元へ戻す
      title.applyPriority({ kyoshinDetected: false })
      if (activeEEWsRef.current.size === 0) {
        log.debug(`[tab] → ${defaultTabRef.current} (揺れの可能性 失効 V2)`)
        revertToDefaultTab()
      }
    }
    prevCandidateRef.current = candidate
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依存集合は上の検知開始エフェクトに合わせて絞る
  }, [candidate, confirmed, settings.soundEnabled])

  // 確定検知中の音再鳴ロジック
  // - 過去最大レベルを超えたとき（新たな最大）→ 音を鳴らす
  // - ピーク後に一度落ちてから再上昇したとき（再エスカレーション）→ 音を鳴らす
  // 生インデックスではなく音レベル（0〜6）で比較することで、フレーム間の微細な
  // 数値変動（同一震度帯内のゆらぎ）による誤再鳴を防ぐ。
  // 「未観測」は -1 で表す（0 は有効な音レベルのため、0 と未観測を同一視すると
  // 検知開始時の震度が2以下＝level0 だった地震で level0→level1 の初回エスカレーションが
  // 「初回検知」判定に誤って巻き込まれ、無音になる不具合があったため）。
  const maxSoundLevelRef = useRef(-1)
  // ピーク到達後に観測した最小レベル（再エスカレーション検出用）
  const postPeakMinLevelRef = useRef(-1)
  useEffect(() => {
    if (!confirmed) {
      maxSoundLevelRef.current = -1
      postPeakMinLevelRef.current = -1
      return
    }
    const currLevel = kyoshinLevel(effectiveKyoshinMaxIndex)
    const prevMaxLevel = maxSoundLevelRef.current
    if (currLevel > prevMaxLevel) {
      // 新たな最大レベルに達した
      maxSoundLevelRef.current = currLevel
      postPeakMinLevelRef.current = currLevel
      // 初回検知（prevMaxLevel === -1＝未観測）は検知音が鳴るのでスキップ
      if (prevMaxLevel >= 0) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 音の再鳴を安定させるため依存は限定する
  }, [effectiveKyoshinMaxIndex, confirmed, settings.soundEnabled])
}
