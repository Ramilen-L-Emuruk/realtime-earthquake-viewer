import { useEffect, useMemo, useRef } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { TabId } from '../components/IconNav'
import type { AppSettings } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import { MIN_DETECTION_INDEX } from '../utils/kyoshinDetectionView'
import { playAlertSound, playKyoshinUpdateSound, kyoshinLevel } from '../utils/alertSound'
import { kyoshinIndexToLabel } from '../utils/kyoshinIntensity'
import { showBrowserNotification } from '../utils/notifications'
import { haversineKm } from '../utils/geo'
import { log } from '../utils/logger'

// 強震モニタの揺れ検知（V3 エンジン）に応じたタブ切替・ウィンドウタイトル・通知音・ブラウザ通知を担うフック。
//
// confirmed（確定検知）と candidate（likely・可能性）の2段で反応し、さらに Scratch 前身と同じく
// 「別地点（離れた地域）の地震」にも発報する:
//  - candidate 立ち上がり → realtime タブ＋控えめな候補音（確定前の早期反応）
//  - confirmed 立ち上がり（初検知）→ realtime タブ＋検知音＋ブラウザ通知
//  - confirmed 中の（全体）レベルアップ／再エスカレーション → 更新音（同一地震の揺れ強まり）
//  - 検知中に離れた別地域が確定（REGION_MATCH_KM より遠い）→ 検知音（別地点の地震）
//  - 各々の終了 → EEW が無ければデフォルトタブへ復帰
// 音レベルは全観測点の実効最大インデックス（表示と一致）で判定する。

/** 同一の揺れ（地域）とみなす代表点間の距離(km)。これより離れた確定は別地点＝別発報。 */
const REGION_MATCH_KM = 300
/** 別地点発報の最小間隔（フレーム）。分裂した確定が短時間に多発しても鳴らしすぎない。 */
const NEW_REGION_COOLDOWN_TICKS = 5
/** 別地点として発報する前に地域が持続すべきフレーム数（一過性フラグメント除去）。 */
const REGION_PERSIST_TICKS = 3
/** confirmed から外れて地域を破棄するまでの猶予（フレーム）。 */
const REGION_PRUNE_TICKS = 3

interface AlertRegion {
  lat: number
  lng: number
  /** 連続して現れたフレーム数（持続判定） */
  seen: number
  /** すでに別地点発報したか（初検知フレームで生成された地域は true＝初検知エフェクトが担当） */
  fired: boolean
  /** 最後に confirmedShocks に現れたフレーム */
  lastTick: number
}

export interface KyoshinAlertsDeps {
  /** confirmed イベントが1件以上あるか（V3 検知の確定） */
  confirmed: boolean
  /** likely イベントが1件以上あるか（V3 検知の可能性・早期反応の駆動元） */
  candidate: boolean
  /** confirmed 各イベント（地域）の代表点＋最大インデックス（別地点発報の入力） */
  confirmedShocks: { lat: number; lng: number; index: number }[]
  /** 現フレームのデータ時刻文字列（毎フレーム更新される別地点発報エフェクトの駆動キー） */
  dataTime: string
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
    confirmed, candidate, confirmedShocks, dataTime, hasActiveEEW, kyoshinIndices, settings, title,
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

  // 確定検知の開始/終了: realtime タブ＋タイトル＋通知音＋ブラウザ通知。
  const prevConfirmedRef = useRef(false)
  useEffect(() => {
    if (confirmed && !prevConfirmedRef.current) {
      log.debug('[tab] → realtime (揺れ検知開始 V3 confirmed)')
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
        log.debug(`[tab] → ${defaultTabRef.current} (揺れ検知終了 V3)`)
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
      log.debug('[tab] → realtime (揺れの可能性 V3 likely)')
      setActiveTab('realtime')
      title.setTitle('🔍 揺れの可能性')
      if (settings.soundEnabled) {
        playAlertSound('kyoshinCandidate')
      }
    } else if (!candidate && prevCandidateRef.current && !confirmed) {
      // 確定に昇格せず消えた場合のみ、静かに元へ戻す
      title.applyPriority({ kyoshinDetected: false })
      if (activeEEWsRef.current.size === 0) {
        log.debug(`[tab] → ${defaultTabRef.current} (揺れの可能性 失効 V3)`)
        revertToDefaultTab()
      }
    }
    prevCandidateRef.current = candidate
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依存集合は検知開始エフェクトに合わせて絞る
  }, [candidate, confirmed, settings.soundEnabled])

  // 確定検知中の音再鳴ロジック（同一地震の揺れ強まり）
  // - 過去最大レベルを超えたとき（新たな最大）→ 音を鳴らす
  // - ピーク後に一度落ちてから再上昇したとき（再エスカレーション）→ 音を鳴らす
  // 生インデックスではなく音レベル（0〜6）で比較することで、フレーム間の微細な数値変動による誤再鳴を防ぐ。
  // 「未観測」は -1 で表す（0 は有効な音レベルのため）。
  const maxSoundLevelRef = useRef(-1)
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
      maxSoundLevelRef.current = currLevel
      postPeakMinLevelRef.current = currLevel
      if (prevMaxLevel >= 0) {
        log.debug(`[tab] → realtime (揺れ検知レベルアップ level=${prevMaxLevel}→${currLevel})`)
        setActiveTab('realtime')
        if (settings.soundEnabled) {
          playKyoshinUpdateSound(effectiveKyoshinMaxIndex)
        }
      }
    } else if (currLevel < postPeakMinLevelRef.current) {
      postPeakMinLevelRef.current = currLevel
    } else if (currLevel > postPeakMinLevelRef.current) {
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

  // 別地点の地震: 検知中に、既存の確定地域から REGION_MATCH_KM より離れた新地域が確定したら発報する
  // （Scratch 前身のグリッド単位発報に相当。グローバル真偽の初検知だけでは進行中の別地点を鳴らせない）。
  // 一過性の分裂フラグメントで鳴らさないよう、持続（REGION_PERSIST_TICKS）＋クールダウンで抑制する。
  const regionsRef = useRef<AlertRegion[]>([])
  const tickRef = useRef(0)
  const lastNewRegionTickRef = useRef(-999)
  const anyConfirmedPrevRef = useRef(false)
  useEffect(() => {
    if (!dataTime) return
    const tick = ++tickRef.current
    const shocks = confirmedShocks
    const anyConfirmed = shocks.length > 0

    for (const s of shocks) {
      let reg: AlertRegion | null = null
      let best = REGION_MATCH_KM
      for (const r of regionsRef.current) {
        const d = haversineKm(s.lat, s.lng, r.lat, r.lng)
        if (d <= best) { best = d; reg = r }
      }
      if (!reg) {
        // 初検知フレームで生成された地域は初検知エフェクトが鳴らすため fired=true にして抑制する。
        regionsRef.current.push({ lat: s.lat, lng: s.lng, seen: 1, fired: !anyConfirmedPrevRef.current, lastTick: tick })
      } else {
        reg.lat = s.lat
        reg.lng = s.lng
        reg.lastTick = tick
        reg.seen++
        if (!reg.fired && anyConfirmedPrevRef.current && reg.seen >= REGION_PERSIST_TICKS && tick - lastNewRegionTickRef.current >= NEW_REGION_COOLDOWN_TICKS) {
          reg.fired = true
          lastNewRegionTickRef.current = tick
          log.debug('[tab] → realtime (別地点で揺れ検知 V3)')
          setActiveTab('realtime')
          if (settings.soundEnabled) playAlertSound('kyoshin')
          if (settings.notifyMinScale >= 0 && settings.notifyDetection) {
            const label = kyoshinIndexToLabel(effectiveKyoshinMaxIndex) ?? '?'
            showBrowserNotification('別の地点で揺れを検知', `推定最大震度 ${label}（強震モニタ）`, 'kyoshin-detection-new')
          }
        }
      }
    }
    regionsRef.current = regionsRef.current.filter((r) => tick - r.lastTick <= REGION_PRUNE_TICKS)
    if (!anyConfirmed) regionsRef.current = []
    anyConfirmedPrevRef.current = anyConfirmed
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataTime を毎フレーム駆動キーにし他は最新クロージャを参照
  }, [dataTime])
}
