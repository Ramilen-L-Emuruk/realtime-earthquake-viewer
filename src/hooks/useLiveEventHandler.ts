import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppEvent, EEWAlert, JMAQuake, JMATsunami } from '../types/earthquake'
import type { TabId } from '../components/IconNav'
import type { AppSettings } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import type { ReplayEntry } from '../services/dmdataReplay'
import { getIntensityLabel } from '../utils/intensity'
import { eewMaxScale, computeSingleEEWLevel, selectEEWSoundType } from '../utils/eew'
import { haversineKm } from '../utils/geo'
import { showBrowserNotification } from '../utils/notifications'
import { tsunamiMaxGrade } from '../utils/tsunami'
import { playAlertSound, type AlertSoundType } from '../utils/alertSound'
import { speakWithVoicevox } from '../utils/voicevox'
import { eewAlertToText, eewIntensityToText, eewCancelToText, earthquakeToText, earthquakeCancelToText, tsunamiToText, tsunamiDowngradeToText, tsunamiCancelToText, tsunamiObservationUpdateToText, nankaiToText, kohatsuToText, lpgmToText } from '../utils/ttsText'

// 観測点リストから、属する予報区（districtCode/districtName）を重複なく列挙する
function uniqueDistricts(observations: { districtCode?: string; districtName?: string }[]): { code?: string; name?: string }[] {
  const seen = new Set<string>()
  const result: { code?: string; name?: string }[] = []
  for (const o of observations) {
    const key = o.districtCode ?? o.districtName ?? ''
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push({ code: o.districtCode, name: o.districtName })
  }
  return result
}

// ライブイベント（地震・津波・EEW・長周期地震動・南海トラフ/後発地震）受信時の
// 通知音・ウィンドウタイトル・タブ切替・VOICEVOX 読み上げ・ブラウザ通知を担うフック。
// イベント種別ごとの続報判定・重複抑制に使う追跡 ref 群もこのフックが所有する。
//
// 注意: handleLiveEvent は毎レンダー再生成される（useCallback で包まない）。
// useEarthquakes 側が onLiveEventRef を毎レンダー更新して staleness を吸収するため、
// 依存配列を絞った useCallback で包むと settings の stale closure を作りリグレッションになる。

export interface LiveEventHandlerDeps {
  settings: AppSettings
  /** useAlertTitle の戻り値（ウィンドウタイトル操作 API） */
  title: AlertTitleApi
  /** 地震情報リスト（App 所有・useEarthquakes の直後に毎レンダー更新） */
  earthquakesRef: React.MutableRefObject<JMAQuake[]>
  /** 強震モニタの揺れ検知フラグ（App 所有・毎レンダー更新） */
  kyoshinDetectedRef: React.MutableRefObject<boolean>
  /** アイドル復帰で戻すデフォルトタブ（App 所有・毎レンダー更新。デバッグログ用） */
  defaultTabRef: React.MutableRefObject<TabId>
  setActiveTab: (tab: TabId) => void
  setActiveTabNonRealtime: (tab: Exclude<TabId, 'realtime'>) => void
  setActiveTabRealtimeOnUpdate: () => void
  revertToDefaultTab: () => void
  selectQuake: (id: string | null) => void
  setActiveLpgmEventId: (id: string | null) => void
}

export function useLiveEventHandler(deps: LiveEventHandlerDeps) {
  const {
    settings, title, earthquakesRef, kyoshinDetectedRef, defaultTabRef,
    setActiveTab, setActiveTabNonRealtime, setActiveTabRealtimeOnUpdate,
    revertToDefaultTab, selectQuake, setActiveLpgmEventId,
  } = deps

  // 直近に「新規地震」として注目を移した earthquake.time。続報（同一 time）では選択を維持する。
  const lastNewQuakeTimeRef = useRef<string | null>(null)
  // EEW の eventId ごとにレベルを追跡（複数EEW対応）
  // key = issue.eventId ?? id、value = 0=低震度予報 / 1=警報（severity=Warning または予想震度5弱以上） / 2=特別警報
  const activeEEWLevelsRef = useRef<Map<string, 0 | 1 | 2>>(new Map())
  // EEW の eventId ごとに予想最大震度スケールを追跡（同一レベル内の震度引き上げ検出用）
  const activeEEWScalesRef = useRef<Map<string, number>>(new Map())
  // 直前に読み上げた津波グレード（引き下げ検出・重複読み上げ抑制に使用）
  const lastTsunamiGradeRef = useRef<'MajorWarning' | 'Warning' | 'Watch' | 'Forecast' | null>(null)
  // 観測点ごとの読み上げ済み最大波高（更新があった観測点のみ TTS 発話するための比較用）
  const lastMaxObsHeightRef = useRef<Map<string, { value: number; over?: boolean }>>(new Map())
  // VOICEVOX EEW 読み上げデバウンス（レベルアップ確定から3秒後に読み上げ）。
  // 複数 EEW が同時進行するケース（例: 2024/1/1 能登の同時多発）があるため、
  // 全て eventId 別の Map で管理する。単一 ref にすると、後から届いた別イベントの
  // 受信タイミングでタイマー・発話対象イベントが横取りされ、片方の続報が
  // 「読み上げ済み最大震度」を更新できずに無限リトリガーする不具合が起きる。
  const eewTtsTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const eewTtsMaxTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // タイマー発火時にテキストを生成するため、eventId ごとに最新イベントを保持する（変化なし続報も含め常に最新で上書き）
  const eewTtsEventsRef = useRef<Map<string, EEWAlert>>(new Map())
  // Phase 1（「緊急地震速報、〇〇で地震。」）の再生完了 Promise。Phase 2 はこれを待ってから発話する（eventId 別）
  const eewPhase1PromisesRef = useRef<Map<string, Promise<void>>>(new Map())
  // EEW の eventId ごとに最後に Phase 1 を発話したときの震源情報を保持する（震源地名変化+座標移動の再発話判定用）
  const activeEEWAnnouncedHypocentersRef = useRef<Map<string, { name: string; lat: number; lng: number }>>(new Map())
  // 長周期地震動情報の更新検出: 受信済み eventId を追跡する
  const seenLpgmEventIdsRef = useRef<Set<string>>(new Set())
  // 津波観測点の新規/更新バッジ表示状態と自動クリアタイマー
  const [obsUpdateStatus, setObsUpdateStatus] = useState<Map<string, 'new' | 'updated'>>(() => new Map())
  const obsStatusClearTimerRef = useRef<number>(0)
  // 津波観測データ受信時にスクロールでフォーカスする予報区（今回の受信で変更があった区域全部＋その中の最高波高区域）
  const [focusedDistrict, setFocusedDistrict] = useState<{ districts: { code?: string; name?: string }[]; top: { code?: string; name?: string }; ts: number } | null>(null)

  const handleLiveEvent = (event: AppEvent) => {
    // 受信時に該当タブを自動表示し、ウィンドウタイトルを更新する
    // （地震情報・津波情報・緊急地震速報）。
    // isNewQuake は UI ブロックと TTS ブロックの両方で参照するためここで宣言する
    let isNewQuake = true
    if (event.kind === 'quake' && event.cancelled) {
      // 地震情報取消: カード削除は useEarthquakes reducer が担う。通知音・読み上げのみここで処理する。
      if (settings.soundEnabled) playAlertSound('eewCancel')
      console.debug('[tab] → earthquake (地震情報取消)')
      setActiveTabNonRealtime('earthquake')
      title.clearTitleTimer('earthquake')
      title.applyPriority()
      if (settings.voicevoxEnabled) {
        setTimeout(() => {
          speakWithVoicevox(settings.voicevoxUrl, earthquakeCancelToText(event), settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
        }, 1200)
      }
    } else if (event.kind === 'quake') {
      console.debug('[tab] → earthquake (地震情報 VXSE51/52/53/61)')
      setActiveTabNonRealtime('earthquake')
      // DMDATA は VXSE51（targetDateTime）→ VXSE52/53（originTime）で earthquake.time が1分ずれるため、
      // eventId（quake.id から抽出）で同一イベントを判定する。id がない場合は earthquake.time で比較。
      const quakeId = (event as import('../types/earthquake').JMAQuake).id
      const eventIdPart = quakeId?.match(/^dmdata-(?:xml-)?quake-(\d{14})-/)?.[1]
      // issue.type を含めて種別ごとに独立判定（震度速報/震源情報/震源・震度情報 等が別報のため）
      const incomingKey = eventIdPart
        ? `${eventIdPart}:${event.issue.type}`
        : event.earthquake.time
      isNewQuake = incomingKey !== lastNewQuakeTimeRef.current
      if (isNewQuake) {
        lastNewQuakeTimeRef.current = incomingKey
      }
      // 新規・続報いずれも、受信した地震カードを選択状態にする。
      selectQuake(event.earthquake.time)
      const { hypocenter, maxScale } = event.earthquake
      // 震度なし続報（VXSE52 等）ではタイトルを更新しない（直前の VXSE51 表示を維持する）
      if (maxScale >= 0 || isNewQuake) {
        title.setTitle(`🔴 地震情報 ${hypocenter.name} 最大震度${getIntensityLabel(maxScale)}`)
      }
      title.scheduleTitleRevert('earthquake')
    } else if (event.kind === 'tsunami' && !event.cancelled) {
      console.debug('[tab] → tsunami (津波情報 VTSE41/51/52)')
      setActiveTabNonRealtime('tsunami')
      title.showTsunamiTitle()
    } else if (event.kind === 'tsunami' && event.cancelled) {
      // 「津波解除検出」effect はレンダー後の非同期発火のため、受信直後の即時反映用にここでもタイマーをリセットする。
      console.debug('[tab] → tsunami (津波情報取消)')
      setActiveTabNonRealtime('tsunami')
      title.endTsunamiTitleWindow()
      title.applyPriority()
      if (settings.voicevoxEnabled) {
        speakWithVoicevox(settings.voicevoxUrl, tsunamiCancelToText(), settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
      }
      lastTsunamiGradeRef.current = null
      lastMaxObsHeightRef.current.clear()
      window.clearTimeout(obsStatusClearTimerRef.current)
      setObsUpdateStatus(new Map())
    } else if (event.kind === 'eew') {
      if (event.test) return

      const key = event.issue?.eventId ?? event.id

      if (event.cancelled) {
        // EEW キャンセル（誤報取消）または解除（最終報満了）: レベル追跡から除去
        // expired: true は最終報タイマー満了による自動解除 → 音は鳴らさない
        // hadKey: P2PQuake WS と Yahoo の両方から cancel が来た場合の二重鳴り防止
        const hadKey = activeEEWLevelsRef.current.has(key)
        console.debug(`[eew] キャンセル受信 key=${key} expired=${event.expired ?? false} hadKey=${hadKey} 種別=${event.expired ? '自動解除(タイマー満了)' : '誤報取消'}`)
        activeEEWLevelsRef.current.delete(key)
        activeEEWScalesRef.current.delete(key)
        activeEEWAnnouncedHypocentersRef.current.delete(key)
        if (hadKey && settings.soundEnabled && !event.expired) {
          playAlertSound('eewCancel')
        }
        if (hadKey && settings.voicevoxEnabled && !event.expired) {
          setTimeout(() => {
            speakWithVoicevox(settings.voicevoxUrl, eewCancelToText(event), settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
          }, 1200)
        }
        // 自動解除後に誤報取消電文が届いたケース: hadKey=false だが expired でもない
        // EEW は既に画面から消えているため UI 更新は不要だが、誤報をユーザーに明示通知する
        if (!hadKey && !event.expired) {
          if (settings.soundEnabled) playAlertSound('eewCancel')
          if (settings.notifyMinScale >= 0 && settings.notifyEEW) {
            showBrowserNotification(
              '緊急地震速報 誤報取消',
              `${event.earthquake.hypocenter.name} の緊急地震速報は誤報でした`,
              `eew-cancel-${key}`,
            )
          }
          if (settings.voicevoxEnabled) {
            setTimeout(() => {
              speakWithVoicevox(settings.voicevoxUrl, eewCancelToText(event), settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
            }, 1200)
          }
        }
        // EEW 解除時は当該 eventId の読み上げタイマーをキャンセルする
        const pendingTimer = eewTtsTimersRef.current.get(key)
        if (pendingTimer) { clearTimeout(pendingTimer); eewTtsTimersRef.current.delete(key) }
        const pendingMaxTimer = eewTtsMaxTimersRef.current.get(key)
        if (pendingMaxTimer) { clearTimeout(pendingMaxTimer); eewTtsMaxTimersRef.current.delete(key) }
        eewTtsEventsRef.current.delete(key)
        eewPhase1PromisesRef.current.delete(key)
        if (!event.expired && hadKey) {
          // 誤報取消（10秒キャンセル表示中）: 他に発表中のEEWがあってもリアルタイムタブでオーバーレイを見せる
          console.debug('[tab] → realtime (EEW誤報取消・キャンセル表示)')
          setActiveTab('realtime')
        }
        if (activeEEWLevelsRef.current.size === 0) {
          title.clearTitleTimer('eew')
          title.applyPriority({ eews: new Map<string, EEWAlert>() })
          // 自動解除（expired）はタブを動かさない。誤報取消の遅延到達（!hadKey かつ !expired）のみ対象。
          // 最終報を複数受信すると expired キャンセルも複数キューに入るため、
          // 2発目（hadKey=false・expired=true）でタブが動かないよう expired を明示的に除外する。
          if (!hadKey && !event.expired) {
            if (kyoshinDetectedRef.current) {
              console.debug('[tab] → realtime (EEW全解除・揺れ検知中)')
              setActiveTab('realtime')
            } else {
              console.debug(`[tab] → ${defaultTabRef.current} (EEW全解除)`)
              revertToDefaultTab()
            }
          }
        }
        return
      }

      const currentLevel = computeSingleEEWLevel(event)
      const scale = eewMaxScale(event)

      // 新規発報か続報かを判定し、レベル・震度の引き上げを検出する
      const isNew = !activeEEWLevelsRef.current.has(key)
      const prevLevel = activeEEWLevelsRef.current.get(key) ?? 0
      const prevScale = activeEEWScalesRef.current.get(key) ?? 0
      const levelUpgraded = !isNew && currentLevel > prevLevel
      const scaleUpgraded = !isNew && scale > prevScale

      // 新規発報・レベルアップは抑制なしで即時移動。続報は抑制タイマーを確認する。
      if (isNew || levelUpgraded) {
        console.debug(`[tab] → realtime (EEW${isNew ? '新規発報' : 'レベルアップ'} key=${key})`)
        setActiveTab('realtime')
      } else {
        setActiveTabRealtimeOnUpdate()
      }
      activeEEWLevelsRef.current.set(
        key,
        (isNew ? currentLevel : Math.max(prevLevel, currentLevel)) as 0 | 1 | 2,
      )
      // activeEEWScalesRef は「実際に読み上げた最大震度」を保持する。
      // 受信のたびに更新すると発話前の値で上書きされるため、firePhase2 内で更新する。

      if (settings.soundEnabled) {
        const eewSoundType = selectEEWSoundType(isNew, levelUpgraded, currentLevel, event.isFinal ?? false)
        playAlertSound(eewSoundType)
      }
      if (settings.notifyMinScale >= 0 && settings.notifyEEW && (isNew || levelUpgraded)) {
        const eewNotifyTitle = currentLevel === 2 ? '緊急地震速報 特別警報'
          : currentLevel === 1 ? '緊急地震速報 警報' : '緊急地震速報 予報'
        showBrowserNotification(
          eewNotifyTitle,
          `${event.earthquake.hypocenter.name}${scale > 0 ? ` 最大震度${getIntensityLabel(scale)}予想` : ''}`,
          `eew-${key}`,
          true,
        )
      }
      // EEW タイトルをイベントデータから構築（state は未更新のため event 直接参照）
      const newCount = activeEEWLevelsRef.current.size
      const eewTitle = `🚨 緊急地震速報 ${event.earthquake.hypocenter.name}` +
        (scale > 0 ? ` 最大震度${getIntensityLabel(scale)}予想` : '') +
        (newCount > 1 ? ` 他${newCount - 1}件` : '')
      title.setTitle(eewTitle)
      title.scheduleTitleRevert('eew')

      // VOICEVOX: 2フェーズ読み上げ
      // 第1フェーズ（isNew即時）: 「緊急地震速報、〇〇で地震。」
      // 第2フェーズ（デバウンス後、かつ第1フェーズ完了後）: 「予想最大震度〇〇。」
      if (settings.voicevoxEnabled && settings.soundEnabled) {
        eewTtsEventsRef.current.set(key, event)
        const firePhase2 = () => {
          // Phase2 が発火した時点で15秒上限タイマーをキャンセルする。
          // 3秒タイマー発火後も15秒タイマーが生き続けると、その間に scaleUpgraded で
          // 新しい3秒タイマーが登録された場合に15秒タイマーが割り込んで二重読み上げになるため。
          const maxTimer = eewTtsMaxTimersRef.current.get(key)
          if (maxTimer) {
            clearTimeout(maxTimer)
            eewTtsMaxTimersRef.current.delete(key)
          }
          const spokenEvent = eewTtsEventsRef.current.get(key)
          if (spokenEvent) {
            // 読み上げた時点の震度を「発話済み最大震度」として記録する
            activeEEWScalesRef.current.set(key, eewMaxScale(spokenEvent))
            const text = eewIntensityToText(spokenEvent)
            if (text) {
              // Phase 1 の再生が終わってから Phase 2 を発話する
              const phase1Promise = eewPhase1PromisesRef.current.get(key) ?? Promise.resolve()
              phase1Promise.then(() => {
                speakWithVoicevox(settings.voicevoxUrl, text, settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
              })
            }
          }
        }
        const scheduleEewTts = () => {
          const timer = setTimeout(() => {
            eewTtsTimersRef.current.delete(key)
            firePhase2()
          }, 3000)
          eewTtsTimersRef.current.set(key, timer)
        }
        // 続報での震源地名変化+座標移動の検出（B-3: 名前変化かつ50km超移動で再発話）
        const hypo = event.earthquake.hypocenter
        const prevHypo = activeEEWAnnouncedHypocentersRef.current.get(key)
        const hypoNameChanged = !isNew && prevHypo !== undefined && hypo.name !== prevHypo.name
        const hypoFarMoved = hypoNameChanged && Number.isFinite(hypo.latitude) && Number.isFinite(hypo.longitude)
          && haversineKm(hypo.latitude, hypo.longitude, prevHypo.lat, prevHypo.lng) > 50
        const firePhase1 = isNew || hypoFarMoved

        if (firePhase1) {
          // 第1フェーズ：即時（完了 Promise を eventId 別に保持）
          const phase1Promise = speakWithVoicevox(settings.voicevoxUrl, eewAlertToText(event), settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
          eewPhase1PromisesRef.current.set(key, phase1Promise)
          // 発話した震源情報を記録する
          if (Number.isFinite(hypo.latitude) && Number.isFinite(hypo.longitude)) {
            activeEEWAnnouncedHypocentersRef.current.set(key, { name: hypo.name, lat: hypo.latitude, lng: hypo.longitude })
          }
          if (isNew) {
            // 第2フェーズ：デバウンス
            scheduleEewTts()
            // 上限タイマー: 第一報から15秒後に強制発火
            const maxTimer = setTimeout(() => {
              eewTtsMaxTimersRef.current.delete(key)
              const pendingTimer = eewTtsTimersRef.current.get(key)
              if (pendingTimer) {
                clearTimeout(pendingTimer)
                eewTtsTimersRef.current.delete(key)
                firePhase2()
              }
            }, 15000)
            eewTtsMaxTimersRef.current.set(key, maxTimer)
          }
        } else if (levelUpgraded || scaleUpgraded) {
          const pendingTimer = eewTtsTimersRef.current.get(key)
          if (pendingTimer) { clearTimeout(pendingTimer); eewTtsTimersRef.current.delete(key) }
          scheduleEewTts()
        }
      }

      return
    }

    // 長周期地震動情報（DMDSS版のみ）
    if ((event as unknown as { kind?: string }).kind === 'lpgm') {
      console.debug('[tab] → earthquake (長周期地震動)')
      setActiveTabNonRealtime('earthquake')
      const lpgmEvent = (event as unknown as { kind: string; data: import('../types/earthquake').JMALpgm }).data
      if (!lpgmEvent.cancelled) {
        // 紐づく地震カードを選択し、自動的に LPGM 表示をオンにする
        const matchedQuake = earthquakesRef.current.find(q => {
          const eventIdPart = q.id?.match(/^dmdata-(?:xml-)?quake-(\d{14})-/)?.[1]
          return eventIdPart === lpgmEvent.eventId
        })
        if (matchedQuake) selectQuake(matchedQuake.earthquake.time)
        setActiveLpgmEventId(lpgmEvent.eventId)
      }
      if (settings.soundEnabled) {
        playAlertSound('earthquake')
      }
      if (settings.voicevoxEnabled) {
        const lpgm = lpgmEvent
        const isNewLpgm = !seenLpgmEventIdsRef.current.has(lpgm.eventId)
        setTimeout(() => {
          speakWithVoicevox(settings.voicevoxUrl, lpgmToText(lpgm, { intensityLevels: settings.ttsIntensityLevels, maxRegions: settings.ttsMaxRegions }, isNewLpgm), settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
        }, 1000)
      }
      // voicevox 有効/無効に関わらず追跡する（次回の isNewLpgm 判定に使用）
      seenLpgmEventIdsRef.current.add(lpgmEvent.eventId)
      return
    }

    // 南海トラフ臨時情報・後発地震注意情報（DMDSS版のみ）
    if ((event as unknown as { kind?: string }).kind === 'nankai' || (event as unknown as { kind?: string }).kind === 'kohatsu') {
      const specialEvent = event as unknown as { kind: string; data: { cancelled?: boolean; kindName?: string } }
      if (!specialEvent.data.cancelled) {
        if (settings.soundEnabled) {
          playAlertSound('specialInfo')
        }
        if (settings.voicevoxEnabled && settings.soundEnabled) {
          const ttsText = specialEvent.kind === 'nankai'
            ? nankaiToText(specialEvent.data as Parameters<typeof nankaiToText>[0])
            : kohatsuToText(specialEvent.data as Parameters<typeof kohatsuToText>[0])
          setTimeout(() => {
            speakWithVoicevox(settings.voicevoxUrl, ttsText, settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
          }, 1500)
        }
        // タイトル更新
        const specialTitle = specialEvent.kind === 'nankai'
          ? `⚠️ 南海トラフ臨時情報（${specialEvent.data.kindName ?? '発表中'}）`
          : '⚠️ 後発地震注意情報 発表中'
        title.setTitle(specialTitle)
        title.scheduleTitleRevert('specialInfo')
      } else {
        // 取消・終了時はタイマーをクリアして即時リセット
        title.clearTitleTimer('specialInfo')
        title.applyPriority()
        if (specialEvent.kind === 'nankai' && settings.voicevoxEnabled) {
          speakWithVoicevox(
            settings.voicevoxUrl,
            nankaiToText(specialEvent.data as Parameters<typeof nankaiToText>[0]),
            settings.voicevoxSpeakerId,
            settings.soundVolume,
          ).catch(() => {})
        }
      }
      return
    }

    // ブラウザ通知（津波）— 音が無効でも送る
    if (event.kind === 'tsunami' && !event.cancelled && settings.notifyMinScale >= 0 && settings.notifyTsunami) {
      const grade = tsunamiMaxGrade(event)
      const tsunamiNotifyTitle = grade === 'MajorWarning' ? '大津波警報'
        : grade === 'Warning' ? '津波警報'
        : grade === 'Forecast' ? '津波予報（若干の海面変動）'
        : '津波注意報'
      showBrowserNotification(
        tsunamiNotifyTitle,
        event.areas.slice(0, 5).map(a => a.name).join('、'),
        'tsunami',
        true,
      )
    }
    // 通知音（地震情報・津波情報）
    if (!settings.soundEnabled) return
    let type: AlertSoundType | null = null
    if (event.kind === 'tsunami') {
      if (!event.cancelled) {
        const grade = tsunamiMaxGrade(event)
        const GRADE_RANK_SOUND = { MajorWarning: 4, Warning: 3, Watch: 2, Forecast: 1, Unknown: 0 } as const
        type GradeSoundKey = keyof typeof GRADE_RANK_SOUND
        const prevGradeForSound = lastTsunamiGradeRef.current
        const gradeUnchanged = prevGradeForSound !== null && GRADE_RANK_SOUND[grade as GradeSoundKey] === GRADE_RANK_SOUND[prevGradeForSound as GradeSoundKey]
        const isDowngradeSound = prevGradeForSound !== null && GRADE_RANK_SOUND[grade as GradeSoundKey] < GRADE_RANK_SOUND[prevGradeForSound as GradeSoundKey]
        if (gradeUnchanged || isDowngradeSound) {
          type = 'tsunamiUpdate'
        } else if (grade === 'MajorWarning') type = 'tsunamiMajor'
        else if (grade === 'Warning')        type = 'tsunami'
        else if (grade === 'Watch')          type = 'tsunamiWatch'
        else if (grade === 'Forecast')       type = 'tsunamiForecast'
      }
    } else if (event.kind === 'quake' && !event.cancelled) {
      const it = event.issue.type
      type = it === '震度速報'                                                          ? 'earthquakePrompt'
           : (it === '震源情報' || it === '遠地地震' || it === 'その他') ? 'earthquakeInfo'
           : 'earthquake'  // 震源・震度情報 / 各地の震度情報
    }
    if (!type) return
    playAlertSound(type)

    // VOICEVOX 読み上げ（新しい情報が来たら再生中を割り込み停止して読み直す）
    if (settings.voicevoxEnabled) {
      const TTS_DELAY_MS: Partial<Record<AlertSoundType, number>> = {
        earthquake:       1000,
        earthquakePrompt:  500,
        earthquakeInfo:   1700,
        tsunamiForecast:  1900,
        tsunamiWatch:     1700,
        tsunami:          2800,
        tsunamiMajor:     4200,
        tsunamiUpdate:     800,
      }
      let ttsText: string | null = null
      if (event.kind === 'quake' && !event.cancelled) {
        ttsText = earthquakeToText(event, { intensityLevels: settings.ttsIntensityLevels, maxRegions: settings.ttsMaxRegions }, isNewQuake)
      } else if (event.kind === 'tsunami') {
        const GRADE_RANK = { MajorWarning: 4, Warning: 3, Watch: 2, Forecast: 1, Unknown: 0 } as const
        type GradeKey = keyof typeof GRADE_RANK
        const currentGrade = tsunamiMaxGrade(event)
        const prevGrade = lastTsunamiGradeRef.current

        if (prevGrade !== null && GRADE_RANK[currentGrade as GradeKey] === GRADE_RANK[prevGrade as GradeKey]) {
          // グレード不変: 観測点ごとに最大波高を追跡し、更新があった観測点のみ読み上げ
          const prevMap = lastMaxObsHeightRef.current
          const updatedObs = (event.observations ?? []).filter(o => {
            if (!o.height) return false
            const prev = prevMap.get(o.name)
            if (prev === undefined) return true
            if (o.height.value > prev.value) return true
            // 同値でも over フラグへの昇格（センサー上限超過）は読み上げ対象
            if (o.height.over && !prev.over && o.height.value >= prev.value) return true
            return false
          })
          if (updatedObs.length > 0) {
            ttsText = tsunamiObservationUpdateToText(updatedObs, event.headline)
          }
        } else {
          const isDowngrade = prevGrade !== null && GRADE_RANK[currentGrade as GradeKey] < GRADE_RANK[prevGrade as GradeKey]
          ttsText = isDowngrade ? tsunamiDowngradeToText(event) : tsunamiToText(event)
        }
      }
      if (ttsText && type) {
        const delay = TTS_DELAY_MS[type] ?? 0
        setTimeout(() => {
          speakWithVoicevox(settings.voicevoxUrl, ttsText!, settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
        }, delay)
      }
    }
    // grade・観測波高トラッキング・UI更新: voicevox 有効/無効に関わらず実行する。
    // Unknown（観測のみ電文など areas=[] のケース）はグレード追跡を維持する。
    if (event.kind === 'tsunami' && !event.cancelled) {
      const grade = tsunamiMaxGrade(event)
      const prevGrade552 = lastTsunamiGradeRef.current
      if (grade !== 'Unknown') lastTsunamiGradeRef.current = grade

      // obsUpdateStatus・focusedDistrict の更新（lastMaxObsHeightRef 更新前に判定する）
      const GRADE_RANK_552 = { MajorWarning: 4, Warning: 3, Watch: 2, Forecast: 1, Unknown: 0 } as const
      type GradeKey552 = keyof typeof GRADE_RANK_552
      const prevMap552 = lastMaxObsHeightRef.current
      const newStatusEntries: [string, 'new' | 'updated'][] = []

      if (prevGrade552 !== null && GRADE_RANK_552[grade as GradeKey552] === GRADE_RANK_552[prevGrade552 as GradeKey552]) {
        const updatedObs552 = (event.observations ?? []).filter(o => {
          if (!o.height) return false
          const prev = prevMap552.get(o.name)
          if (prev === undefined) return true
          if (o.height.value > prev.value) return true
          if (o.height.over && !prev.over && o.height.value >= prev.value) return true
          return false
        })
        if (updatedObs552.length > 0) {
          const topObs = updatedObs552.reduce((a, b) => (b.height!.value > a.height!.value ? b : a))
          setFocusedDistrict({
            districts: uniqueDistricts(updatedObs552),
            top: { code: topObs.districtCode, name: topObs.districtName },
            ts: Date.now(),
          })
          for (const o of updatedObs552) newStatusEntries.push([o.name, prevMap552.has(o.name) ? 'updated' : 'new'])
        }
      } else {
        const obsWithHeight552 = (event.observations ?? []).filter(o => !!o.height)
        if (obsWithHeight552.length > 0) {
          const topObs = obsWithHeight552.reduce((a, b) => (b.height!.value > a.height!.value ? b : a))
          setFocusedDistrict({
            districts: uniqueDistricts(obsWithHeight552),
            top: { code: topObs.districtCode, name: topObs.districtName },
            ts: Date.now(),
          })
          for (const o of obsWithHeight552) newStatusEntries.push([o.name, 'new'])
        }
      }

      if (newStatusEntries.length > 0) {
        setObsUpdateStatus(prev => {
          const next = new Map(prev)
          for (const [name, status] of newStatusEntries) next.set(name, status)
          return next
        })
        window.clearTimeout(obsStatusClearTimerRef.current)
        obsStatusClearTimerRef.current = window.setTimeout(() => setObsUpdateStatus(new Map()), 60000)
      }

      for (const o of event.observations ?? []) {
        if (!o.height) continue
        const prev = lastMaxObsHeightRef.current.get(o.name)
        if (prev === undefined || o.height.value > prev.value || (o.height.over && !prev.over)) {
          lastMaxObsHeightRef.current.set(o.name, { value: o.height.value, over: o.height.over })
        }
      }
    }
  }

  // EEW 読み上げタイマーをアンマウント時にクリーンアップする
  useEffect(() => {
    return () => {
      for (const timer of eewTtsTimersRef.current.values()) clearTimeout(timer)
      for (const timer of eewTtsMaxTimersRef.current.values()) clearTimeout(timer)
    }
  }, [])

  // リプレイ開始・終了時に追跡 ref を初期化する。
  // handleStartReplay の useCallback deps を壊さないよう安定参照（deps なし）にする。
  const resetTracking = useCallback(() => {
    lastNewQuakeTimeRef.current = null
    activeEEWLevelsRef.current.clear()
    activeEEWScalesRef.current.clear()
    activeEEWAnnouncedHypocentersRef.current.clear()
    for (const timer of eewTtsTimersRef.current.values()) clearTimeout(timer)
    eewTtsTimersRef.current.clear()
    for (const timer of eewTtsMaxTimersRef.current.values()) clearTimeout(timer)
    eewTtsMaxTimersRef.current.clear()
    eewTtsEventsRef.current.clear()
    eewPhase1PromisesRef.current.clear()
    lastTsunamiGradeRef.current = null
    lastMaxObsHeightRef.current.clear()
    seenLpgmEventIdsRef.current.clear()
  }, [])

  // pre-window イベントから T 時点の追跡 ref を復元する（サイレント注入後の正確な音判定に必要）
  const restorePreWindowTracking = useCallback((preFiltered: ReplayEntry[]) => {
    for (const { payload } of preFiltered) {
      if (payload.kind === 'event') {
        const ev = payload.event
        if (ev.kind === 'quake') {
          const quake = ev as JMAQuake
          const eventIdPart = quake.id?.match(/^dmdata-(?:xml-)?quake-(\d{14})-/)?.[1]
          lastNewQuakeTimeRef.current = eventIdPart
            ? `${eventIdPart}:${quake.issue.type}`
            : quake.earthquake.time
        } else if (ev.kind === 'eew') {
          const eew = ev as EEWAlert
          const key = eew.issue?.eventId ?? eew.id
          activeEEWLevelsRef.current.set(key, computeSingleEEWLevel(eew))
          activeEEWScalesRef.current.set(key, eewMaxScale(eew))
        } else if (ev.kind === 'tsunami') {
          const tsunami = ev as JMATsunami
          const grade = tsunamiMaxGrade(tsunami)
          if (grade !== 'Unknown') lastTsunamiGradeRef.current = grade
          for (const o of tsunami.observations ?? []) {
            if (o.height?.value != null) lastMaxObsHeightRef.current.set(o.name, { value: o.height.value, over: o.height.over })
          }
        }
      } else if (payload.kind === 'lpgm' && !payload.data.cancelled) {
        seenLpgmEventIdsRef.current.add(payload.data.eventId)
      }
    }
  }, [])

  return { handleLiveEvent, resetTracking, restorePreWindowTracking, obsUpdateStatus, focusedDistrict }
}
