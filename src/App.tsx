import { useState, useEffect, useRef, useMemo } from 'react'
import { IconNav, type TabId } from './components/IconNav'
import { JapanMap, type MapMode } from './components/Map/JapanMap'
import { MapUpdateTime } from './components/MapUpdateTime'
import { EarthquakeTab } from './components/EarthquakeTab'
import { RealtimeTab } from './components/RealtimeTab'
import { TsunamiTab } from './components/TsunamiTab'
import { SettingsTab } from './components/SettingsTab'
import { TelegramTab } from './components/TelegramTab'
import { useEarthquakes } from './hooks/useEarthquakes'
import { useSettings } from './hooks/useSettings'
import { useKyoshinRealtime } from './hooks/useKyoshinRealtime'
import { useKyoshinDetection, MIN_DETECTION_INDEX } from './hooks/useKyoshinDetection'
import { useSWaveCountdown } from './hooks/useSWaveCountdown'
import { useDmdssWaves, VS_KM_PER_SEC } from './hooks/useDmdssWaves'
import { getIntensityLabel } from './utils/intensity'
import { formatMagnitude } from './utils/formatters'
import { eewMaxScale } from './utils/eew'
import { tsunamiMaxGrade, tsunamiOverallGrade } from './utils/tsunami'
import { playAlertSound, playKyoshinUpdateSound, kyoshinLevel, unlockAudio, setSoundVolume, type AlertSoundType } from './utils/alertSound'
import { kyoshinIndexToLabel } from './utils/kyoshinIntensity'
import type { P2PQuakeEvent, EEWAlert } from './types/earthquake'

// 平常時のウィンドウタイトル（index.html の <title> と一致させる）。
// AutoHotKey 等が、情報更新時のタイトル変化を検知してイベントを発火できるようにする。
const DEFAULT_TITLE = import.meta.env.VITE_VARIANT === 'dmdss'
  ? 'リアルタイム地震ビューアー (DM-D.S.S)'
  : 'リアルタイム地震ビューアー'

const isDmdss = import.meta.env.VITE_VARIANT === 'dmdss'

function showBrowserNotification(
  title: string,
  body: string,
  tag: string,
  requireInteraction = false,
) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  new Notification(title, {
    body,
    icon: `${import.meta.env.BASE_URL}icons/icon.svg`,
    tag,
    requireInteraction,
  })
}

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
  kyoshinDetected: boolean,
  setState: (v: string | null) => void,
) {
  if (eews.size === 0 && !tsunami) { setState(kyoshinDetected ? '📈 揺れ検知' : null) }
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
  // 直近に「新規地震」として注目を移した earthquake.time。続報（同一 time）では選択を維持する。
  const lastNewQuakeTimeRef = useRef<string | null>(null)
  // 情報更新時にウィンドウタイトルへ表示する文言（null = 平常時タイトル）。
  // デフォルトタブへ戻るタイミングで null に戻す。
  const [alertTitle, setAlertTitle] = useState<string | null>(null)
  // SW アップデート検知時のカウントダウン秒数（null = 待機なし、0以下でリロード）
  const [updateCountdown, setUpdateCountdown] = useState<number | null>(null)
  // DMDSS版: WS接続中は現在時刻を毎秒更新して地図上の更新時刻をリアルタイム表示する
  const [nowTick, setNowTick] = useState<Date | null>(null)

  // EEW の eventId ごとにレベルを追跡（複数EEW対応）
  // key = issue.eventId ?? id、value = 0=低震度予報 / 1=警報（severity=Warning または予想震度5弱以上） / 2=特別警報
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
      // 新規地震（別の earthquake.time）のときだけ最新へ注目を移す。
      // 同一地震の続報（速報→詳細など）では現在の選択を維持する。
      if (event.earthquake.time !== lastNewQuakeTimeRef.current) {
        setSelectedQuakeId(null)
        lastNewQuakeTimeRef.current = event.earthquake.time
      }
      const { hypocenter, maxScale } = event.earthquake
      setAlertTitle(`🔴 地震情報 ${hypocenter.name} 最大震度${getIntensityLabel(maxScale)}`)
      window.clearTimeout(earthquakeTitleTimerRef.current)
      const resetMs = settings.idleRevertSec === 15 ? 15000 : 30000
      earthquakeTitleTimerRef.current = window.setTimeout(() => {
        applyPriorityTitle(activeEEWsRef.current, tsunamiActiveRef.current, tsunamiPriorityRef.current, kyoshinDetectedRef.current, setAlertTitle)
      }, resetMs)
    } else if (event.code === 552 && !event.cancelled) {
      setActiveTab('tsunami')
      setAlertTitle('🌊 津波情報 発表中')
      window.clearTimeout(tsunamiTitleTimerRef.current)
      const tsunamiResetMs = settings.idleRevertSec === 15 ? 15000 : 30000
      tsunamiTitleTimerRef.current = window.setTimeout(() => {
        applyPriorityTitle(activeEEWsRef.current, tsunamiActiveRef.current, tsunamiPriorityRef.current, kyoshinDetectedRef.current, setAlertTitle)
      }, tsunamiResetMs)
    } else if (event.code === 556) {
      if (event.test) return

      const key = event.issue?.eventId ?? event.id

      if (event.cancelled) {
        // EEW キャンセル: 対象イベントをレベル追跡から除去し、解除のたびに音を鳴らす
        activeEEWLevelsRef.current.delete(key)
        if (settings.soundEnabled) {
          playAlertSound('eewCancel')
        }
        if (activeEEWLevelsRef.current.size === 0) {
          window.clearTimeout(eewTitleTimerRef.current)
          applyPriorityTitle(new Map<string, EEWAlert>(), tsunamiActiveRef.current, tsunamiPriorityRef.current, kyoshinDetectedRef.current, setAlertTitle)
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
      setAlertTitle(eewTitle)
      window.clearTimeout(eewTitleTimerRef.current)
      const eewResetMs = settings.idleRevertSec === 15 ? 15000 : 30000
      eewTitleTimerRef.current = window.setTimeout(() => {
        applyPriorityTitle(activeEEWsRef.current, tsunamiActiveRef.current, tsunamiPriorityRef.current, kyoshinDetectedRef.current, setAlertTitle)
      }, eewResetMs)
      return
    }

    // ブラウザ通知（津波）— 音が無効でも送る
    if (event.code === 552 && !event.cancelled && settings.notifyMinScale >= 0 && settings.notifyTsunami) {
      const grade = tsunamiMaxGrade(event)
      const tsunamiNotifyTitle = grade === 'MajorWarning' ? '大津波警報'
        : grade === 'Warning' ? '津波警報' : '津波注意報'
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
    playAlertSound(type)
  }

  const {
    earthquakes, tsunamis, activeEEWs, lpgmByOriginTime, connectionStatus, lastUpdate, isLoading, isLoadingMore, hasMore, error,
    telegramLog, clearTelegramLog,
    injectEvent, loadMoreEarthquakes,
    simulateEarthquake,
    simulateEEW, simulateEEWWarning, simulateEEWForecast,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch,
  } = useEarthquakes(handleLiveEvent, settings.dmdataApiKey, settings.dmdataTestDelivery, settings.eewFinalClearSec)

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

  const latest = filteredEarthquakes[0] ?? null
  // 選択中の地震（未選択／一覧から消えた場合は最新にフォールバック）
  const selectedQuake = filteredEarthquakes.find(q => q.earthquake.time === selectedQuakeId) ?? latest

  // ブラウザ通知: 新しい地震が設定震度以上なら通知
  const lastNotifiedIdRef = useRef<string | null>(null)
  useEffect(() => {
    const latestQuake = earthquakes[0]
    if (!latestQuake) return
    if (settings.notifyMinScale < 0) return
    if (latestQuake.earthquake.time === lastNotifiedIdRef.current) return
    if (latestQuake.earthquake.maxScale < settings.notifyMinScale) return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    lastNotifiedIdRef.current = latestQuake.earthquake.time
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
      document.title = `🔄 ${updateCountdown}秒後に再起動します — ${DEFAULT_TITLE}`
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

  // DMDSS版: WS接続中は nowTick を毎秒更新、切断時は null にリセット
  useEffect(() => {
    if (!isDmdss || connectionStatus !== 'connected') {
      setNowTick(null)
      return
    }
    setNowTick(new Date())
    const id = setInterval(() => setNowTick(new Date()), 1000)
    return () => clearInterval(id)
  }, [connectionStatus])

  // 定期自動リロード（毎日午前5時にカウントダウン開始）
  useEffect(() => {
    if (settings.periodicReloadHours <= 0) return
    const msUntilNext5AM = () => {
      const now = new Date()
      const next = new Date(now)
      next.setHours(5, 0, 0, 0)
      if (next <= now) next.setDate(next.getDate() + 1)
      return next.getTime() - now.getTime()
    }
    const id = setTimeout(() => {
      setUpdateCountdown(prev => prev ?? 10)
    }, msUntilNext5AM())
    return () => clearTimeout(id)
  }, [settings.periodicReloadHours])

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

  // 設定・電文ログタブ表示中は、地図には直前に表示していたタブの内容をそのまま残す。
  const [lastContentTab, setLastContentTab] = useState<TabId>(settings.defaultTab)
  useEffect(() => {
    if (activeTab !== 'settings' && activeTab !== 'telegrams') setLastContentTab(activeTab)
  }, [activeTab])
  const mapTab = (activeTab === 'settings' || activeTab === 'telegrams') ? lastContentTab : activeTab

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
    applyPriorityTitle(activeEEWs, tsunamiActive, settings.tsunamiPriorityDefault, false, setAlertTitle)
  }, [activeEEWs, tsunamiActive, settings.tsunamiPriorityDefault])

  // 津波解除検出: true→false の遷移でタイマーをキャンセルし優先度ロジックを即時適用
  const prevTsunamiActiveRef = useRef(false)
  useEffect(() => {
    if (prevTsunamiActiveRef.current && !tsunamiActive) {
      window.clearTimeout(tsunamiTitleTimerRef.current)
      applyPriorityTitle(activeEEWsRef.current, false, tsunamiPriorityRef.current, kyoshinDetectedRef.current, setAlertTitle)
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
    // EEW 発報中または揺れ検知中はリアルタイムタブを維持する。それ以外はデフォルトタブへ戻す。
    const revert = () => {
      if (activeEEWsRef.current.size > 0 || kyoshinDetectedRef.current) {
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
  // DMDSS版: Yahoo hypoInfo からのEEW検出は不要（DMDATAが直接配信するため）
  const kyoshin = useKyoshinRealtime(true, {
    onEEWEvent: isDmdss ? undefined : injectEvent,
    timeOffset: kyoshinTimeOffset,
  })
  const kyoshinDetection = useKyoshinDetection(kyoshin.sites, kyoshin.indices)
  // タイマーコールバック内から最新の detected 値を参照するための ref（activeEEWsRef と同パターン）
  const kyoshinDetectedRef = useRef(false)
  kyoshinDetectedRef.current = kyoshinDetection.detected

  // DMDSS版: EEWデータから P波・S波半径を自前計算（100ms更新でスムーズ拡張）
  // activeEEWs (Map) の参照が安定している限り配列を再生成しない
  const activeEEWList = useMemo(() => Array.from(activeEEWs.values()), [activeEEWs])
  const dmdssWaves = useDmdssWaves(activeEEWList, isDmdss)
  const psWave = isDmdss ? dmdssWaves : kyoshin.psWave

  // EEW受信中または揺れ検知中は全観測点ベースの最大インデックスを使う（表示と音を一致させる）
  const hasActiveEEW = activeEEWs.size > 0

  const home = useMemo(
    () => (settings.homeLat !== null && settings.homeLng !== null
      ? { lat: settings.homeLat, lng: settings.homeLng }
      : null),
    [settings.homeLat, settings.homeLng],
  )
  const swaveArrival = useSWaveCountdown(psWave, home, hasActiveEEW, isDmdss ? VS_KM_PER_SEC : undefined)

  const effectiveKyoshinMaxIndex = useMemo(() => {
    if (!(hasActiveEEW || kyoshinDetection.detected)) return kyoshinDetection.maxIndex
    let max = 0
    for (const idx of kyoshin.indices) {
      if (idx >= MIN_DETECTION_INDEX && idx > max) max = idx
    }
    return max > 0 ? max : kyoshinDetection.maxIndex
  }, [hasActiveEEW, kyoshinDetection.detected, kyoshinDetection.maxIndex, kyoshin.indices])

  // 揺れ検知時にリアルタイムタブを自動表示＋ウィンドウタイトル更新＋通知音
  // 検知終了（true → false）時は EEW・津波の状態に合わせてタイトルを再評価する
  const prevDetectedRef = useRef(false)
  useEffect(() => {
    if (kyoshinDetection.detected && !prevDetectedRef.current) {
      setActiveTab('realtime')
      setAlertTitle('📈 揺れ検知')
      if (settings.soundEnabled) {
        playAlertSound('kyoshin')
      }
      if (settings.notifyMinScale >= 0 && settings.notifyDetection) {
        const label = kyoshinIndexToLabel(effectiveKyoshinMaxIndex) ?? '?'
        showBrowserNotification('揺れを検知中', `推定最大震度 ${label}（強震モニタ）`, 'kyoshin-detection')
      }
    } else if (!kyoshinDetection.detected && prevDetectedRef.current) {
      applyPriorityTitle(activeEEWsRef.current, tsunamiActiveRef.current, tsunamiPriorityRef.current, false, setAlertTitle)
    }
    prevDetectedRef.current = kyoshinDetection.detected
  }, [kyoshinDetection.detected, effectiveKyoshinMaxIndex, settings.soundEnabled, settings.notifyDetection])

  // 揺れ検知中に音レベル（震度帯）が過去最大を超えたときのみ音を鳴らす
  // 生インデックスではなく音レベル（0〜6）で比較することで、フレーム間の微細な
  // 数値変動（同一震度帯内のゆらぎ）による誤再鳴を防ぐ。
  const maxSoundLevelRef = useRef(0)
  useEffect(() => {
    if (!kyoshinDetection.detected) {
      maxSoundLevelRef.current = 0
      return
    }
    const currLevel = kyoshinLevel(effectiveKyoshinMaxIndex)
    const prevMaxLevel = maxSoundLevelRef.current
    if (currLevel > prevMaxLevel) {
      maxSoundLevelRef.current = currLevel
      // 初回検知（prevMaxLevel === 0）は検知音が鳴るのでスキップ
      if (prevMaxLevel > 0 && settings.soundEnabled) {
        playKyoshinUpdateSound(effectiveKyoshinMaxIndex)
      }
    }
  }, [effectiveKyoshinMaxIndex, kyoshinDetection.detected, settings.soundEnabled])

  // 常時表示する地図の内容は mapTab（設定タブ中は直前のタブ）に応じて切り替える
  const mapMode: MapMode =
    mapTab === 'tsunami' ? 'tsunami' : mapTab === 'realtime' ? 'kyoshin' : 'quake'
  const mapQuake = mapTab === 'earthquake' ? selectedQuake : latest

  // 地図左上の更新時刻: リアルタイム表示はリアルタイム震度(kyoshin)の更新時刻、
  // DMDSS版かつWS接続中は現在時刻を毎秒更新、それ以外は最終受信時刻を表示する。
  const overlayUpdateTime =
    mapTab === 'realtime'
      ? kyoshin.dataTime
        ? new Date(kyoshin.dataTime)
        : null
      : (isDmdss && nowTick !== null)
        ? nowTick
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
            kyoshinPsWave={psWave}
            eews={Array.from(activeEEWs.values())}
            detectedPoints={kyoshinDetection.points}
          />
          <MapUpdateTime lastUpdate={overlayUpdateTime} error={overlayError} />
        </div>

        {/* パネル（タブに応じて内容を切替）。モバイルは下部固定高さ + スクロール。 */}
        {/* 各タブを absolute で重ねて visibility で切り替えることで、スクロール位置をタブごとに独立管理する。
            display:none（hidden クラス）は scrollTop をリセットするため使わない。 */}
        <div className="h-96 flex-shrink-0 lg:h-auto lg:flex-none lg:w-96 border-t lg:border-t-0 lg:border-l border-border relative">
          <div className={`absolute inset-0 overflow-y-auto${activeTab !== 'earthquake' ? ' invisible pointer-events-none' : ''}`}>
            <EarthquakeTab
              earthquakes={filteredEarthquakes}
              selectedId={selectedQuake?.earthquake.time ?? null}
              onSelect={setSelectedQuakeId}
              isLoading={isLoading}
              isLoadingMore={isLoadingMore}
              hasMore={hasMore}
              onLoadMore={loadMoreEarthquakes}
              error={error}
              lpgmByOriginTime={lpgmByOriginTime}
            />
          </div>
          <div className={`absolute inset-0 overflow-y-auto${activeTab !== 'realtime' ? ' invisible pointer-events-none' : ''}`}>
            <RealtimeTab
              eews={Array.from(activeEEWs.values())}
              kyoshinDetection={kyoshinDetection}
              kyoshinSites={kyoshin.sites}
              kyoshinIndices={kyoshin.indices}
              swaveArrival={swaveArrival}
            />
          </div>
          <div className={`absolute inset-0 overflow-y-auto${activeTab !== 'tsunami' ? ' invisible pointer-events-none' : ''}`}>
            <TsunamiTab tsunamis={tsunamis} />
          </div>
          <div className={`absolute inset-0 overflow-y-auto${activeTab !== 'telegrams' ? ' invisible pointer-events-none' : ''}`}>
            <TelegramTab telegramLog={telegramLog} onClear={clearTelegramLog} />
          </div>
          <div className={`absolute inset-0 overflow-y-auto${activeTab !== 'settings' ? ' invisible pointer-events-none' : ''}`}>
            <SettingsTab
              settings={settings}
              onUpdate={updateSetting}
              dmdataConnectionStatus={connectionStatus}
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
