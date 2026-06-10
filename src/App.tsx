import { useState, useEffect, useRef } from 'react'
import { IconNav, type TabId } from './components/IconNav'
import { JapanMap, type MapMode } from './components/Map/JapanMap'
import { MapUpdateTime } from './components/MapUpdateTime'
import { EarthquakeTab } from './components/EarthquakeTab'
import { RealtimeTab } from './components/RealtimeTab'
import { TsunamiTab } from './components/TsunamiTab'
import { SettingsTab } from './components/SettingsTab'
import { useEarthquakes } from './hooks/useEarthquakes'
import { useSettings } from './hooks/useSettings'
import { useKyoshinRealtime } from './hooks/useKyoshinRealtime'
import { useKyoshinDetection } from './hooks/useKyoshinDetection'
import { getIntensityLabel } from './utils/intensity'
import { formatMagnitude } from './utils/formatters'
import { eewMaxScale } from './utils/eew'
import { tsunamiMaxGrade, tsunamiOverallGrade } from './utils/tsunami'
import { playAlertSound, playKyoshinUpdateSound, kyoshinLevel, unlockAudio, setSoundVolume, type AlertSoundType } from './utils/alertSound'
import type { P2PQuakeEvent, EEWAlert } from './types/earthquake'

// 平常時のウィンドウタイトル（index.html の <title> と一致させる）。
// AutoHotKey 等が、情報更新時のタイトル変化を検知してイベントを発火できるようにする。
const DEFAULT_TITLE = 'リアルタイム地震ビューアー'

// EEW 単発のレベル算出: 0=低震度予報 / 1=警報（震度5弱以上） / 2=特別警報（震度6弱以上）
// scaleTo:99 は P2PQuake の「震度算出不能」コードなので通常の震度比較から除外する
function computeSingleEEWLevel(eew: EEWAlert): 0 | 1 | 2 {
  const scale = eewMaxScale(eew)
  const intensityKnown = scale < 99
  return (intensityKnown && scale >= 55) ? 2
       : (eew.severity === 'Warning' || (intensityKnown && scale >= 45)) ? 1
       : 0
}

function computeEEWLevel(eews: ReadonlyMap<string, EEWAlert>): 0 | 1 | 2 | null {
  if (eews.size === 0) return null
  let max: 0 | 1 | 2 = 0
  for (const eew of eews.values()) {
    const level = computeSingleEEWLevel(eew)
    if (level > max) max = level
  }
  return max
}

function selectEEWSoundType(isNew: boolean, levelUpgraded: boolean, currentLevel: 0 | 1 | 2): AlertSoundType {
  if (isNew || levelUpgraded) {
    return currentLevel === 2 ? 'eewSpecial' : currentLevel === 1 ? 'eew' : 'eewForecast'
  }
  return 'eewUpdate'
}

function computeEEWTitle(eews: ReadonlyMap<string, EEWAlert>): string {
  const primary = Array.from(eews.values()).sort((a, b) => eewMaxScale(b) - eewMaxScale(a))[0]
  const scale = eewMaxScale(primary)
  return `🚨 緊急地震速報 ${primary.earthquake.hypocenter.name}` +
    (scale > 0 ? ` 最大震度${getIntensityLabel(scale)}予想` : '') +
    (eews.size > 1 ? ` 他${eews.size - 1}件` : '')
}

function applyPriorityTitle(
  eews: ReadonlyMap<string, EEWAlert>,
  tsunami: boolean,
  priority: boolean,
  setState: (v: string | null) => void,
) {
  if (eews.size === 0 && !tsunami) { setState(null) }
  else if (eews.size > 0 && tsunami) { setState(priority ? '🌊 津波情報 発表中' : computeEEWTitle(eews)) }
  else if (eews.size > 0) { setState(computeEEWTitle(eews)) }
  else { setState('🌊 津波情報 発表中') }
}

function formatDateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function App() {
  const { settings, updateSetting } = useSettings()
  const [activeTab, setActiveTab] = useState<TabId>(settings.defaultTab)
  const [selectedQuakeId, setSelectedQuakeId] = useState<string | null>(null)
  // 情報更新時にウィンドウタイトルへ表示する文言（null = 平常時タイトル）。
  // デフォルトタブへ戻るタイミングで null に戻す。
  const [alertTitle, setAlertTitle] = useState<string | null>(null)
  // SW アップデート検知時のカウントダウン秒数（null = 待機なし、0以下でリロード）
  const [updateCountdown, setUpdateCountdown] = useState<number | null>(null)

  // 受信イベントの種別ごとに通知音を鳴らす（同種の連続発火はバースト抑制）
  const lastSoundAtRef = useRef<Record<AlertSoundType, number>>({
    earthquake: 0, earthquakePrompt: 0, earthquakeInfo: 0,
    eew: 0, eewUpdate: 0, eewCancel: 0, eewSpecial: 0, eewForecast: 0,
    tsunami: 0, tsunamiMajor: 0, tsunamiWatch: 0,
    kyoshin: 0,
  })
  // EEW の eventId ごとにレベルを追跡（複数EEW対応）
  // key = issue.eventId ?? id、value = 0=低震度予報 / 1=警報or震度3以上 / 2=特別警報
  const activeEEWLevelsRef = useRef<Map<string, 0 | 1 | 2>>(new Map())
  // 各情報タイトルのリセットタイマー（自動復帰秒数が15秒の場合は15秒、それ以外は30秒）
  const earthquakeTitleTimerRef = useRef<number>(0)
  const eewTitleTimerRef = useRef<number>(0)
  const tsunamiTitleTimerRef = useRef<number>(0)

  const handleLiveEvent = (event: P2PQuakeEvent) => {
    // 受信時に該当タブを自動表示し、ウィンドウタイトルを更新する
    // （地震情報・津波情報・緊急地震速報）。
    if (event.code === 551) {
      setActiveTab('earthquake')
      setSelectedQuakeId(null)
      const { hypocenter, maxScale } = event.earthquake
      setAlertTitle(`🔴 地震情報 ${hypocenter.name} 最大震度${getIntensityLabel(maxScale)}`)
      window.clearTimeout(earthquakeTitleTimerRef.current)
      const resetMs = settings.idleRevertSec === 15 ? 15000 : 30000
      earthquakeTitleTimerRef.current = window.setTimeout(() => {
        applyPriorityTitle(activeEEWsRef.current, tsunamiActiveRef.current, tsunamiPriorityRef.current, setAlertTitle)
      }, resetMs)
    } else if (event.code === 552 && !event.cancelled) {
      setActiveTab('tsunami')
      setAlertTitle('🌊 津波情報 発表中')
      window.clearTimeout(tsunamiTitleTimerRef.current)
      const tsunamiResetMs = settings.idleRevertSec === 15 ? 15000 : 30000
      tsunamiTitleTimerRef.current = window.setTimeout(() => {
        applyPriorityTitle(activeEEWsRef.current, tsunamiActiveRef.current, tsunamiPriorityRef.current, setAlertTitle)
      }, tsunamiResetMs)
    } else if (event.code === 556) {
      if (event.test) return

      const key = event.issue?.eventId ?? event.id

      if (event.cancelled) {
        // EEW キャンセル: 対象イベントをレベル追跡から除去し、解除のたびに音を鳴らす
        activeEEWLevelsRef.current.delete(key)
        if (settings.soundEnabled) {
          const now = Date.now()
          if (now - lastSoundAtRef.current.eewCancel >= 1500) {
            lastSoundAtRef.current.eewCancel = now
            playAlertSound('eewCancel')
          }
        }
        if (activeEEWLevelsRef.current.size === 0) {
          window.clearTimeout(eewTitleTimerRef.current)
          applyPriorityTitle(new Map<string, EEWAlert>(), tsunamiActiveRef.current, tsunamiPriorityRef.current, setAlertTitle)
          setActiveTab(defaultTabRef.current)
        }
        return
      }

      // 緊急地震速報の発報時はリアルタイムタブ（強震モニタ＋予報円）を開く
      setActiveTab('realtime')

      const currentLevel = computeSingleEEWLevel(event)
      const scale = eewMaxScale(event)

      // 新規発報か続報かを判定し、レベル引き上げを検出する
      const isNew = !activeEEWLevelsRef.current.has(key)
      const prevLevel = activeEEWLevelsRef.current.get(key) ?? 0
      const levelUpgraded = !isNew && currentLevel > prevLevel
      activeEEWLevelsRef.current.set(
        key,
        (isNew ? currentLevel : Math.max(prevLevel, currentLevel)) as 0 | 1 | 2,
      )

      if (settings.soundEnabled) {
        const eewSoundType = selectEEWSoundType(isNew, levelUpgraded, currentLevel)
        const now = Date.now()
        if (now - lastSoundAtRef.current[eewSoundType] >= 1500) {
          lastSoundAtRef.current[eewSoundType] = now
          playAlertSound(eewSoundType)
        }
      }
      // EEW タイトルをイベントデータから構築（state は未更新のため event 直接参照）
      const newCount = activeEEWLevelsRef.current.size
      const eewTitle = `🚨 緊急地震速報 ${event.earthquake.hypocenter.name}` +
        (scale > 0 ? ` 最大震度${getIntensityLabel(scale)}予想` : '') +
        (newCount > 1 ? ` 他${newCount - 1}件` : '')
      setAlertTitle(eewTitle)
      window.clearTimeout(eewTitleTimerRef.current)
      const eewResetMs = settings.idleRevertSec === 15 ? 15000 : 30000
      eewTitleTimerRef.current = window.setTimeout(() => {
        applyPriorityTitle(activeEEWsRef.current, tsunamiActiveRef.current, tsunamiPriorityRef.current, setAlertTitle)
      }, eewResetMs)
      return
    }

    // 通知音（地震情報・津波情報）
    if (!settings.soundEnabled) return
    let type: AlertSoundType | null = null
    if (event.code === 552) {
      if (!event.cancelled) {
        const grade = tsunamiMaxGrade(event)
        if      (grade === 'MajorWarning') type = 'tsunamiMajor'
        else if (grade === 'Warning')      type = 'tsunami'
        else                               type = 'tsunamiWatch'
      }
    } else if (event.code === 551) {
      const it = event.issue.type
      type = it === 'ScalePrompt'                                        ? 'earthquakePrompt'
           : (it === 'Destination' || it === 'Foreign' || it === 'Other') ? 'earthquakeInfo'
           : 'earthquake'  // ScaleAndDestination / DetailScale
    }
    if (!type) return
    const now = Date.now()
    if (now - lastSoundAtRef.current[type] < 1500) return
    lastSoundAtRef.current[type] = now
    playAlertSound(type)
  }

  const {
    earthquakes, tsunamis, activeEEWs, connectionStatus, lastUpdate, isLoading, error,
    injectEvent,
    simulateEarthquake,
    simulateEEW, simulateEEWWarning, simulateEEWForecast,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch,
  } = useEarthquakes(handleLiveEvent)

  // UI 倍率: ルート要素の font-size を変えて rem ベースの UI 全体を拡大縮小する。
  // 倍率変更で地図コンテナ幅が変わるため、Leaflet の再計算用に resize を発火する。
  useEffect(() => {
    document.documentElement.style.fontSize = `${16 * settings.uiScale}px`
    window.dispatchEvent(new Event('resize'))
  }, [settings.uiScale])

  // 音量設定の変化を alertSound モジュールに反映する
  useEffect(() => {
    setSoundVolume(settings.soundVolume)
  }, [settings.soundVolume])

  // ブラウザの自動再生制限に対応: 初回のユーザー操作で音声を有効化する
  useEffect(() => {
    const unlock = () => unlockAudio()
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  const filteredEarthquakes = earthquakes
    .filter(q => settings.minDisplayScale < 0 || q.earthquake.maxScale >= settings.minDisplayScale)
    .slice(0, settings.maxEarthquakeList)

  const latest = filteredEarthquakes[0] ?? null
  // 選択中の地震（未選択／一覧から消えた場合は最新にフォールバック）
  const selectedQuake = filteredEarthquakes.find(q => q.id === selectedQuakeId) ?? latest

  // ブラウザ通知: 新しい地震が設定震度以上なら通知
  const lastNotifiedIdRef = useRef<string | null>(null)
  useEffect(() => {
    const latestQuake = earthquakes[0]
    if (!latestQuake) return
    if (settings.notifyMinScale < 0) return
    if (latestQuake.id === lastNotifiedIdRef.current) return
    if (latestQuake.earthquake.maxScale < settings.notifyMinScale) return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    lastNotifiedIdRef.current = latestQuake.id
    const scale = getIntensityLabel(latestQuake.earthquake.maxScale)
    new Notification('地震情報', {
      body: `${latestQuake.earthquake.hypocenter.name} 最大震度${scale} ${formatMagnitude(latestQuake.earthquake.hypocenter.magnitude)}`,
      icon: `${import.meta.env.BASE_URL}icons/icon.svg`,
      tag: latestQuake.id,
    })
  }, [earthquakes, settings.notifyMinScale])

  // 情報更新時にウィンドウタイトルを変更し、平常時は既定タイトルに戻す。
  // 優先順位: 警報タイトル > アップデートカウントダウン > デフォルトタイトル
  useEffect(() => {
    if (alertTitle) {
      document.title = alertTitle
    } else if (updateCountdown !== null) {
      document.title = `🔄 ${updateCountdown}秒後にアップデートします — ${DEFAULT_TITLE}`
    } else {
      document.title = DEFAULT_TITLE
    }
  }, [alertTitle, updateCountdown])

  // SW アップデート検知: sw-updated イベントを受け取りカウントダウンを開始する
  useEffect(() => {
    const onSwUpdated = () => setUpdateCountdown(prev => prev ?? 10)
    window.addEventListener('sw-updated', onSwUpdated)
    return () => window.removeEventListener('sw-updated', onSwUpdated)
  }, [])

  // カウントダウン進行: 警報なし（alertTitle === null）のときのみ毎秒デクリメントし、0でリロード
  useEffect(() => {
    if (updateCountdown === null) return
    if (alertTitle !== null) return
    if (updateCountdown <= 0) {
      window.location.reload()
      return
    }
    const id = setTimeout(() => setUpdateCountdown(n => (n !== null ? n - 1 : null)), 1000)
    return () => clearTimeout(id)
  }, [updateCountdown, alertTitle])

  // 設定タブ表示中は、地図には直前に表示していたタブの内容をそのまま残す。
  const [lastContentTab, setLastContentTab] = useState<TabId>(settings.defaultTab)
  useEffect(() => {
    if (activeTab !== 'settings') setLastContentTab(activeTab)
  }, [activeTab])
  const mapTab = activeTab === 'settings' ? lastContentTab : activeTab

  // 津波発表中フラグ（解除済みでない津波情報があるか）とバッジ用グレード
  const tsunamiGrade = tsunamiOverallGrade(tsunamis)
  const tsunamiActive = tsunamiGrade !== null

  // 初回ページロード時に REST API で取得した既存の EEW/津波状態をタイトルに反映する
  // （WebSocket 受信前に既にアクティブな情報がある場合のみ一度だけ動作）
  const initialTitleAppliedRef = useRef(false)
  useEffect(() => {
    if (initialTitleAppliedRef.current) return
    if (activeEEWs.size === 0 && !tsunamiActive) return
    initialTitleAppliedRef.current = true
    applyPriorityTitle(activeEEWs, tsunamiActive, settings.tsunamiPriorityDefault, setAlertTitle)
  }, [activeEEWs, tsunamiActive, settings.tsunamiPriorityDefault])

  // 津波解除検出: true→false の遷移でタイマーをキャンセルし優先度ロジックを即時適用
  const prevTsunamiActiveRef = useRef(false)
  useEffect(() => {
    if (prevTsunamiActiveRef.current && !tsunamiActive) {
      window.clearTimeout(tsunamiTitleTimerRef.current)
      applyPriorityTitle(activeEEWsRef.current, false, tsunamiPriorityRef.current, setAlertTitle)
    }
    prevTsunamiActiveRef.current = tsunamiActive
  }, [tsunamiActive])

  // アイドル復帰で戻すデフォルトタブ。津波優先トグル ON かつ津波発表中なら
  // 津波情報、それ以外は設定のデフォルトタブ。タイマー発火時に最新値を参照する
  // ため ref に保持する。
  const defaultTabRef = useRef<TabId>(settings.defaultTab)
  // EEW 発報中・津波発表中・津波優先設定をタイマーコールバック内で参照するための ref
  const activeEEWsRef = useRef(activeEEWs)
  const tsunamiActiveRef = useRef(false)
  const tsunamiPriorityRef = useRef(false)
  defaultTabRef.current =
    settings.tsunamiPriorityDefault && tsunamiActive ? 'tsunami' : settings.defaultTab
  activeEEWsRef.current = activeEEWs
  tsunamiActiveRef.current = tsunamiActive
  tsunamiPriorityRef.current = settings.tsunamiPriorityDefault

  // 設定秒数 情報更新（activeTab の自動切替・P2P 更新）もユーザー操作もなければ
  // デフォルトタブへ戻す。activeTab / lastUpdate の変化、および操作のたびにリセット。
  // idleRevertSec が 0 以下なら自動復帰は無効。
  useEffect(() => {
    if (settings.idleRevertSec <= 0) return
    const ms = settings.idleRevertSec * 1000
    // EEW 発報中はリアルタイムタブを維持する。それ以外はデフォルトタブへ戻す。
    const revert = () => {
      if (activeEEWsRef.current.size > 0) {
        setActiveTab('realtime')
      } else {
        setActiveTab(defaultTabRef.current)
        if (!tsunamiActiveRef.current) {
          setAlertTitle(null)
        }
      }
    }
    let timer = window.setTimeout(revert, ms)
    const reset = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(revert, ms)
    }
    // ドラッグ中のパン操作: ボタン押下中の移動のみリセット（ホバーだけでは反応させない）。
    const resetOnDrag = (e: PointerEvent) => {
      if (e.buttons) reset()
    }
    // 操作（クリック・キー入力・ホイール/タッチ/スクロール/ドラッグ）のたびにリセット。
    // すべて capture 段階で購読する。Leaflet は地図のホイールズームやドラッグ時に
    // stopPropagation でイベントを止めるため、バブリングでは window まで届かない。
    // capture なら Leaflet が止める前に window で先に拾える。scroll は非バブリングのため
    // もともと capture が必要。
    const opts = { passive: true, capture: true } as const
    window.addEventListener('pointerdown', reset, opts)
    window.addEventListener('pointermove', resetOnDrag, opts)
    window.addEventListener('keydown', reset, opts)
    window.addEventListener('wheel', reset, opts)
    window.addEventListener('touchmove', reset, opts)
    window.addEventListener('scroll', reset, opts)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', reset, true)
      window.removeEventListener('pointermove', resetOnDrag, true)
      window.removeEventListener('keydown', reset, true)
      window.removeEventListener('wheel', reset, true)
      window.removeEventListener('touchmove', reset, true)
      window.removeEventListener('scroll', reset, true)
    }
  }, [activeTab, lastUpdate, settings.idleRevertSec])

  // 強震モニタ（常時ポーリング: タブ非表示中も揺れ検知を継続する）
  // Yahoo hypoInfo の EEW を injectEvent で状態に注入する（音・タブ切替も発火）
  const [kyoshinTimeOffset, setKyoshinTimeOffset] = useState<number | null>(null)
  const [kyoshinInputDateTime, setKyoshinInputDateTime] = useState(() => formatDateTimeLocal(new Date()))
  const kyoshin = useKyoshinRealtime(true, { onEEWEvent: injectEvent, timeOffset: kyoshinTimeOffset })
  const kyoshinDetection = useKyoshinDetection(kyoshin.sites, kyoshin.indices)

  // 揺れ検知時にリアルタイムタブを自動表示＋ウィンドウタイトル更新＋通知音
  // （false → true への遷移時のみ）
  const prevDetectedRef = useRef(false)
  useEffect(() => {
    if (kyoshinDetection.detected && !prevDetectedRef.current) {
      setActiveTab('realtime')
      setAlertTitle('📈 揺れ検知')
      if (settings.soundEnabled) {
        const now = Date.now()
        if (now - lastSoundAtRef.current.kyoshin >= 1500) {
          lastSoundAtRef.current.kyoshin = now
          playKyoshinUpdateSound(kyoshinDetection.maxIndex)
        }
      }
    }
    prevDetectedRef.current = kyoshinDetection.detected
  }, [kyoshinDetection.detected, kyoshinDetection.maxIndex, settings.soundEnabled])

  // 揺れ検知中に音レベル（震度帯）が過去最大を超えたときのみ音を鳴らす
  // 生インデックスではなく音レベル（0〜6）で比較することで、フレーム間の微細な
  // 数値変動（同一震度帯内のゆらぎ）による誤再鳴を防ぐ。
  const maxSoundLevelRef = useRef(0)
  useEffect(() => {
    if (!kyoshinDetection.detected) {
      maxSoundLevelRef.current = 0
      return
    }
    const currLevel = kyoshinLevel(kyoshinDetection.maxIndex)
    const prevMaxLevel = maxSoundLevelRef.current
    if (currLevel > prevMaxLevel) {
      maxSoundLevelRef.current = currLevel
      // 初回検知（prevMaxLevel === 0）は検知音が鳴るのでスキップ
      if (prevMaxLevel > 0 && settings.soundEnabled) {
        playKyoshinUpdateSound(kyoshinDetection.maxIndex)
      }
    }
  }, [kyoshinDetection.maxIndex, kyoshinDetection.detected, settings.soundEnabled])

  // 常時表示する地図の内容は mapTab（設定タブ中は直前のタブ）に応じて切り替える
  const mapMode: MapMode =
    mapTab === 'tsunami' ? 'tsunami' : mapTab === 'realtime' ? 'kyoshin' : 'quake'
  const mapQuake = mapTab === 'earthquake' ? selectedQuake : latest

  // 地図左上の更新時刻: リアルタイム表示はリアルタイム震度(kyoshin)の更新時刻、
  // それ以外は P2P データの最終更新時刻を表示する。
  const overlayUpdateTime =
    mapTab === 'realtime'
      ? kyoshin.dataTime
        ? new Date(kyoshin.dataTime)
        : null
      : lastUpdate
  // 更新がエラーで停止しているか（リアルタイム=取得連続失敗 / それ以外=WS切断）
  const overlayError =
    mapTab === 'realtime' ? kyoshin.error : connectionStatus === 'disconnected'

  return (
    <div className="flex flex-col h-dvh bg-app text-white overflow-hidden">
      {/* 地図(左) | パネル | アイコンナビ(右端)。モバイルは縦積み(地図上・パネル・ナビ下)。 */}
      <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
        {/* 常時表示の地図エリア（タブに応じて内容を切替） */}
        <div className="relative flex-1 min-h-0">
          <JapanMap
            mode={mapMode}
            quake={mapQuake}
            tsunamis={tsunamis}
            iconScale={settings.mapIconScale}
            showBathymetry={settings.showBathymetry}
            kyoshinSites={kyoshin.sites}
            kyoshinIndices={kyoshin.indices}
            kyoshinPsWave={kyoshin.psWave}
            eews={Array.from(activeEEWs.values())}
            detectedPoints={kyoshinDetection.points}
          />
          <MapUpdateTime lastUpdate={overlayUpdateTime} error={overlayError} />
        </div>

        {/* パネル（タブに応じて内容を切替）。モバイルは下部固定高さ + スクロール。 */}
        {/* 各タブを absolute で重ねて visibility で切り替えることで、スクロール位置をタブごとに独立管理する。
            display:none（hidden クラス）は scrollTop をリセットするため使わない。 */}
        <div className="h-80 flex-shrink-0 lg:h-auto lg:flex-none lg:w-96 border-t lg:border-t-0 lg:border-l border-border relative">
          <div className={`absolute inset-0 overflow-y-auto${activeTab !== 'earthquake' ? ' invisible pointer-events-none' : ''}`}>
            <EarthquakeTab
              earthquakes={filteredEarthquakes}
              selectedId={selectedQuake?.id ?? null}
              onSelect={setSelectedQuakeId}
              isLoading={isLoading}
              error={error}
            />
          </div>
          <div className={`absolute inset-0 overflow-y-auto${activeTab !== 'realtime' ? ' invisible pointer-events-none' : ''}`}>
            <RealtimeTab
              eews={Array.from(activeEEWs.values())}
              kyoshinDetection={kyoshinDetection}
            />
          </div>
          <div className={`absolute inset-0 overflow-y-auto${activeTab !== 'tsunami' ? ' invisible pointer-events-none' : ''}`}>
            <TsunamiTab tsunamis={tsunamis} />
          </div>
          <div className={`absolute inset-0 overflow-y-auto${activeTab !== 'settings' ? ' invisible pointer-events-none' : ''}`}>
            <SettingsTab
              settings={settings}
              onUpdate={updateSetting}
              onTest={{
                earthquake:   simulateEarthquake,
                eew:          simulateEEW,
                eewWarning:   simulateEEWWarning,
                eewForecast:  simulateEEWForecast,
                tsunami:        simulateTsunami,
                tsunamiWarning: simulateTsunamiWarning,
                tsunamiWatch:   simulateTsunamiWatch,
                notification: () => {
                  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
                    alert('先に「通知を許可する」ボタンをクリックしてください。')
                    return
                  }
                  new Notification('地震情報テスト', {
                    body: '東京都内陸部（テスト） 最大震度4 M5.5',
                    icon: `${import.meta.env.BASE_URL}icons/icon.svg`,
                    tag: 'test-notification',
                  })
                },
              }}
              kyoshinTimeOffset={kyoshinTimeOffset}
              onSetKyoshinTimeOffset={setKyoshinTimeOffset}
              kyoshinInputDateTime={kyoshinInputDateTime}
              onSetKyoshinInputDateTime={setKyoshinInputDateTime}
            />
          </div>
        </div>

        {/* アイコンナビ（一番外側＝右端 / モバイルは最下部） */}
        <IconNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
          tsunamiGrade={tsunamiGrade}
          eewLevel={computeEEWLevel(activeEEWs)}
        />
      </div>
    </div>
  )
}
