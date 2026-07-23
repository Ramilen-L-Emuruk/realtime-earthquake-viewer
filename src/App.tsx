import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { IconNav, type TabId } from './components/IconNav'
import { JapanMap, type MapMode } from './components/Map/JapanMap'
import { MapUpdateTime } from './components/MapUpdateTime'
import { EarthquakeTab } from './components/EarthquakeTab'
import { RealtimeTab } from './components/RealtimeTab'
import { TsunamiTab } from './components/TsunamiTab'
import { SettingsTab } from './components/SettingsTab'
import { TelegramTab } from './components/TelegramTab'
import { SpecialInfoBanner } from './components/SpecialInfoBanner'
import { useEarthquakes } from './hooks/useEarthquakes'
import { useSettings } from './hooks/useSettings'
import { useAlertTitle } from './hooks/useAlertTitle'
import { useLiveEventHandler } from './hooks/useLiveEventHandler'
import { useKyoshinAlerts } from './hooks/useKyoshinAlerts'
import { useKyoshinRealtime } from './hooks/useKyoshinRealtime'
import { useKyoshinDetection } from './hooks/useKyoshinDetection'
import { useKyoshinDetectorV2 } from './hooks/useKyoshinDetectorV2'
import { useSWaveCountdown } from './hooks/useSWaveCountdown'
import { useDmdssWaves } from './hooks/useDmdssWaves'
import { useQuakeHeatmap } from './hooks/useQuakeHeatmap'
import { getIntensityLabel } from './utils/intensity'
import { formatMagnitude, formatDateTimeLocal } from './utils/formatters'
import { computeEEWLevel } from './utils/eew'
import { tsunamiOverallGrade } from './utils/tsunami'
import { playCountdownBeep, unlockAudio, setSoundVolume } from './utils/alertSound'
import { loadTtsPhraseBreakDict } from './utils/ttsPhraseBreakDict'
import type { EEWAlert, JMAQuake } from './types/earthquake'
import { fetchDmdataReplayEvents, filterPreWindowEvents, clearReplayCache } from './services/dmdataReplay'
import { log } from './utils/logger'
import { setReplayOffset as setClockReplayOffset, serverNow, serverDate } from './utils/clock'

// 平常時のウィンドウタイトル（index.html の <title> と一致させる）。
// AutoHotKey 等が、情報更新時のタイトル変化を検知してイベントを発火できるようにする。
const DEFAULT_TITLE = import.meta.env.VITE_VARIANT === 'dmdss'
  ? 'リアルタイム地震ビューアー (DM-D.S.S)'
  : 'リアルタイム地震ビューアー'

const isDmdss = import.meta.env.VITE_VARIANT === 'dmdss'

export function App() {
  const { settings, updateSetting } = useSettings()
  const [activeTab, setActiveTab] = useState<TabId>(settings.defaultTab)
  const [selectedQuakeId, setSelectedQuakeId] = useState<string | null>(null)
  const [focusedObsName, setFocusedObsName] = useState<{ name: string; ts: number } | null>(null)
  const [activeLpgmEventId, setActiveLpgmEventId] = useState<string | null>(null)
  const [activeLpgmSource, setActiveLpgmSource] = useState<'earthquake' | 'eew' | null>(null)
  // 地震カード切替時は LPGM 表示をリセットする
  const selectQuake = (id: string | null) => {
    setSelectedQuakeId(id)
    setActiveLpgmEventId(null)
    setActiveLpgmSource(null)
  }
  // EEW 発報中（cancelledAt 除外済み）・揺れ検知フラグ・地震情報リスト・デフォルトタブを
  // タイマーコールバック内やフック間で参照するための ref。
  // 値の確定はレンダー後半（useEarthquakes / useKyoshinDetection の後）で毎レンダー代入する。
  const activeEEWsRef = useRef<ReadonlyMap<string, EEWAlert>>(new Map())
  const kyoshinDetectedRef = useRef(false)
  const earthquakesRef = useRef<JMAQuake[]>([])
  const defaultTabRef = useRef<TabId>(settings.defaultTab)
  // ウィンドウタイトル（情報タイトル）管理
  const title = useAlertTitle({ activeEEWsRef, kyoshinDetectedRef })
  // SW アップデート検知時のカウントダウン秒数（null = 待機なし、0以下でリロード）
  const [updateCountdown, setUpdateCountdown] = useState<number | null>(null)
  // DMDSS版: WS接続中は現在時刻を毎秒更新して地図上の更新時刻をリアルタイム表示する
  const [nowTick, setNowTick] = useState<Date | null>(null)

  // リアルタイムタブ以外へ移動した後 15 秒間、EEW 続報による realtime タブへの
  // 強制移動を抑制するタイムスタンプ（0 = 抑制なし）
  const realtimeTabSuppressedUntilRef = useRef<number>(0)

  // リアルタイム以外のタブへ移動するときに呼ぶ。抑制タイマーをリセットする。
  const setActiveTabNonRealtime = (tab: Exclude<TabId, 'realtime'>) => {
    realtimeTabSuppressedUntilRef.current = Date.now() + 15000
    setActiveTab(tab)
  }

  // EEW 続報（新規発報・レベルアップ以外）による realtime タブ移動。
  // 抑制タイマー発動中はスキップする。
  const setActiveTabRealtimeOnUpdate = () => {
    const remaining = realtimeTabSuppressedUntilRef.current - Date.now()
    if (remaining > 0) {
      log.debug(`[tab] → realtime スキップ (EEW続報・抑制中 残り${remaining}ms)`)
      return
    }
    log.debug('[tab] → realtime (EEW続報)')
    setActiveTab('realtime')
  }

  // useLiveEventHandler が返す resetTsunamiScrollToTop を revertToDefaultTab から呼べるようにする ref。
  // revertToDefaultTab はフック呼び出しより前に定義されるため、defaultTabRef と同様に
  // ref 経由で後から実体を代入する（呼び出されるのは常にレンダー後のためタイミング上問題ない）。
  const resetTsunamiScrollRef = useRef<() => void>(() => {})

  // デフォルトタブへ復帰する。デフォルトタブが realtime の場合は
  // 抑制タイマーをセットせずそのまま移動する（realtime への強制移動を
  // 抑制する意味がないため）。
  // 津波イベントを経由しない復帰で津波タブに切り替わる場合は、スクロール位置も一番上へ戻す。
  const revertToDefaultTab = () => {
    const tab = defaultTabRef.current
    if (tab === 'realtime') {
      setActiveTab('realtime')
    } else {
      setActiveTabNonRealtime(tab)
    }
    if (tab === 'tsunami') resetTsunamiScrollRef.current()
  }

  // ライブイベント受信処理（通知音・タイトル・タブ切替・読み上げ・ブラウザ通知）
  const { handleLiveEvent, resetTracking, restorePreWindowTracking, obsUpdateStatus, focusedDistrict, resetTsunamiScrollToTop } = useLiveEventHandler({
    settings, title, earthquakesRef, kyoshinDetectedRef, defaultTabRef,
    setActiveTab, setActiveTabNonRealtime, setActiveTabRealtimeOnUpdate,
    revertToDefaultTab, selectQuake, setActiveLpgmEventId,
  })
  resetTsunamiScrollRef.current = resetTsunamiScrollToTop

  const [replayTimeOffset, setReplayTimeOffset] = useState<number | null>(null)

  const {
    earthquakes, tsunamis, activeEEWs, lpgmByEventId, nankai, kohatsu, connectionStatus, lastUpdate, isLoading, isLoadingMore, hasMore, error,
    telegramLog, clearTelegramLog,
    injectEvent, loadMoreEarthquakes,
    simulateEarthquake,
    simulateEEW, simulateEEWWarning, simulateEEWForecast,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch, simulateTsunamiForecast,
    simulateNankai, simulateKohatsu,
    resetState, loadReplayEvents,
  } = useEarthquakes(handleLiveEvent, settings.dmdataApiKey, settings.dmdataTestDelivery, replayTimeOffset)
  earthquakesRef.current = earthquakes

  const { points: quakeHeatPoints } = useQuakeHeatmap(settings.showQuakeHeatmap, settings.dmdataApiKey, earthquakes)

  // 最新の非解除津波電文から観測データを収集（地図バー描画用）
  const latestTsunamiObservations = useMemo(() => {
    const latest = [...tsunamis].reverse().find((t) => !t.cancelled && (t.observations?.length ?? 0) > 0)
    return latest?.observations ?? []
  }, [tsunamis])

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

  // TTS 読み辞書をアプリ起動時に事前ロードする（VOICEVOX 有効・無効に関わらず）
  useEffect(() => {
    loadTtsPhraseBreakDict().catch(() => {})
  }, [])

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
  // キャンセル表示中のカードは選択対象から除外する（フォールバック用）
  const latestNonCancelled = filteredEarthquakes.find(q => !q.cancelledAt) ?? null
  // 選択中の地震（未選択／一覧から消えた場合はキャンセル済み除外の最新にフォールバック）
  const selectedQuake = filteredEarthquakes.find(q => q.earthquake.time === selectedQuakeId && !q.cancelledAt) ?? latestNonCancelled
  // 地図に表示中の LPGM（バッジクリックでトグル）
  const activeLpgm = activeLpgmEventId ? (lpgmByEventId.get(activeLpgmEventId) ?? null) : null

  // 選択中の地震カードがキャンセル状態になったら即座に選択解除する
  useEffect(() => {
    if (!selectedQuakeId) return
    const selected = filteredEarthquakes.find(q => q.earthquake.time === selectedQuakeId)
    if (selected?.cancelledAt) {
      setSelectedQuakeId(null)
    }
  }, [filteredEarthquakes, selectedQuakeId])

  // cancelledAt（10秒表示中）の EEW は地図・挙動系から除外する
  const activeEEWsNoCancelled = useMemo(
    () => new Map([...activeEEWs].filter(([, v]) => !v.cancelledAt)),
    [activeEEWs],
  )

  // EEW カード経由で選択したLPGMは、次報でforecastMaxLpgmClassがなくなった場合や
  // EEW 解除時に自動的に選択解除する
  useEffect(() => {
    if (!activeLpgmEventId || activeLpgmSource !== 'eew') return
    const eew = activeEEWsNoCancelled.get(activeLpgmEventId)
    if (!eew || eew.forecastMaxLpgmClass == null || eew.forecastMaxLpgmClass < 1) {
      setActiveLpgmEventId(null)
      setActiveLpgmSource(null)
    }
  }, [activeEEWs, activeLpgmEventId, activeLpgmSource])

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
    if (title.alertTitle) {
      document.title = title.alertTitle
    } else if (updateCountdown !== null) {
      document.title = `🔄 ${updateCountdown}秒後に再起動します — ${DEFAULT_TITLE}`
    } else {
      document.title = DEFAULT_TITLE
    }
  }, [title.alertTitle, updateCountdown])

  // SW アップデート検知: sw-updated イベントを受け取りカウントダウンを開始する
  useEffect(() => {
    const onSwUpdated = () => setUpdateCountdown(prev => prev ?? 10)
    window.addEventListener('sw-updated', onSwUpdated)
    return () => window.removeEventListener('sw-updated', onSwUpdated)
  }, [])

  // アプリ時計とログのタイムスタンプをリプレイ時刻に追従させる
  // （clock はライブ時サーバー同期、リプレイ時は setReplayOffset で絶対制御）
  useEffect(() => {
    setClockReplayOffset(replayTimeOffset)
  }, [replayTimeOffset])

  // DMDSS版: リプレイ中はリプレイ時刻で毎秒更新、WS接続中は実時刻で毎秒更新、それ以外は null
  useEffect(() => {
    if (replayTimeOffset !== null) {
      const tick = () => setNowTick(serverDate())
      tick()
      const id = setInterval(tick, 1000)
      return () => clearInterval(id)
    }
    if (!isDmdss || connectionStatus !== 'connected') {
      setNowTick(null)
      return
    }
    setNowTick(serverDate())
    const id = setInterval(() => setNowTick(serverDate()), 1000)
    return () => clearInterval(id)
  }, [connectionStatus, replayTimeOffset])

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
    if (title.alertTitle !== null) return
    if (updateCountdown <= 0) {
      window.location.reload()
      return
    }
    const id = setTimeout(() => setUpdateCountdown(n => (n !== null ? n - 1 : null)), 1000)
    return () => clearTimeout(id)
  }, [updateCountdown, title.alertTitle])

  // 設定・電文ログタブ表示中は、地図には直前に表示していたタブの内容をそのまま残す。
  const [lastContentTab, setLastContentTab] = useState<TabId>(settings.defaultTab)
  useEffect(() => {
    if (activeTab !== 'settings' && activeTab !== 'telegrams') setLastContentTab(activeTab)
  }, [activeTab])
  const mapTab = (activeTab === 'settings' || activeTab === 'telegrams') ? lastContentTab : activeTab

  // 津波発表中フラグ（解除済みでない津波情報があるか。Forecast＝若干の海面変動も含む）とバッジ用グレード
  // tsunamiGrade は色分け用のため MajorWarning/Warning/Watch のみ（Forecast は除外）
  const tsunamiGrade = tsunamiOverallGrade(tsunamis)
  const tsunamiActive = tsunamis.some(t => !t.cancelled)

  // 初回ページロード時に REST API で取得した既存の EEW/津波状態をタイトルに反映する
  // （WebSocket 受信前に既にアクティブな情報がある場合のみ一度だけ動作）
  const initialTitleAppliedRef = useRef(false)
  useEffect(() => {
    if (initialTitleAppliedRef.current) return
    if (activeEEWsNoCancelled.size === 0 && !tsunamiActive) return
    initialTitleAppliedRef.current = true
    // 津波のみアクティブ・一定時間表示モード ON の場合は表示ウィンドウを開始する
    if (tsunamiActive && activeEEWsNoCancelled.size === 0 && settings.tsunamiTitleTemporary) {
      title.showTsunamiTitle()
    } else {
      // tsunami はタイトルフラグではなく実際の発表中フラグを渡す（初期反映のため override 必須）
      title.applyPriority({
        eews: activeEEWsNoCancelled,
        tsunami: tsunamiActive,
        priority: settings.tsunamiPriorityDefault,
        kyoshinDetected: false,
      })
    }
  }, [activeEEWsNoCancelled, tsunamiActive, settings.tsunamiPriorityDefault, settings.tsunamiTitleTemporary])

  // 津波解除検出: true→false の遷移でタイマーをキャンセルし優先度ロジックを即時適用
  const prevTsunamiActiveRef = useRef(false)
  useEffect(() => {
    if (!prevTsunamiActiveRef.current && tsunamiActive) {
      log.debug(`[tsunami] 発表検出 grade=${tsunamiGrade}`)
    } else if (prevTsunamiActiveRef.current && !tsunamiActive) {
      log.debug('[tsunami] 解除検出 (tsunamiActive: true→false)')
      title.endTsunamiTitleWindow()
      title.applyPriority({ tsunami: false })
    }
    prevTsunamiActiveRef.current = tsunamiActive
  }, [tsunamiActive, tsunamiGrade])

  // アイドル復帰で戻すデフォルトタブ。津波優先トグル ON かつ津波発表中なら
  // 津波情報、それ以外は設定のデフォルトタブ（宣言はコンポーネント冒頭・代入はここ）。
  defaultTabRef.current =
    settings.tsunamiPriorityDefault && tsunamiActive ? 'tsunami' : settings.defaultTab
  // タイマーコールバック内で最新値を参照するための毎レンダー同期（activeEEWsRef と title 内部 ref）
  activeEEWsRef.current = activeEEWsNoCancelled
  title.syncInputs({
    tsunamiActive,
    tsunamiPriority: settings.tsunamiPriorityDefault,
    tsunamiTitleTemporary: settings.tsunamiTitleTemporary,
    idleRevertSec: settings.idleRevertSec,
  })

  // 設定秒数 情報更新（activeTab の自動切替・DMDSS 更新）もユーザー操作もなければ
  // デフォルトタブへ戻す。activeTab / lastUpdate の変化、および操作のたびにリセット。
  // idleRevertSec が 0 以下なら自動復帰は無効。
  useEffect(() => {
    if (settings.idleRevertSec <= 0) return
    const ms = settings.idleRevertSec * 1000
    // EEW 発報中または揺れ検知中はリアルタイムタブを維持する。それ以外はデフォルトタブへ戻す。
    const revert = () => {
      if (activeEEWsRef.current.size > 0 || kyoshinDetectedRef.current) {
        log.debug(`[tab] → realtime (アイドル復帰・EEW中または揺れ検知中 idleRevertSec=${settings.idleRevertSec})`)
        setActiveTab('realtime')
      } else {
        log.debug(`[tab] → ${defaultTabRef.current} (アイドル復帰 idleRevertSec=${settings.idleRevertSec})`)
        revertToDefaultTab()
        if (!title.tsunamiTitleFlag()) {
          title.setTitle(null)
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
  const [kyoshinInputDateTime, setKyoshinInputDateTime] = useState(() => formatDateTimeLocal(new Date()))
  const [replayIsFetching, setReplayIsFetching] = useState(false)
  // リプレイ開始後に次のウィンドウをプリフェッチする終端時刻
  const prefetchEndRef = useRef<Date | null>(null)

  const handleStartReplay = useCallback(async (targetDate: Date) => {
    log.debug(`[replay] リプレイ開始 targetDate=${targetDate.toISOString()}`)
    const offset = targetDate.getTime() - Date.now()
    const toTime = new Date(targetDate.getTime() + 3600_000)
    const preFrom = new Date(targetDate.getTime() - 24 * 3600_000)
    resetState()
    resetTracking()
    clearReplayCache()
    setReplayTimeOffset(offset)
    prefetchEndRef.current = toTime
    setReplayIsFetching(true)
    try {
      const [normalEvents, preEvents] = await Promise.all([
        fetchDmdataReplayEvents(settings.dmdataApiKey, targetDate, toTime),
        fetchDmdataReplayEvents(settings.dmdataApiKey, preFrom, targetDate),
      ])
      // pre-window: T時点で有効な電文を即時発火（replayTime = T-1ms）させて初期状態を再現する
      const preFiltered = filterPreWindowEvents(preEvents, targetDate)
        .map(e => ({ ...e, replayTime: new Date(targetDate.getTime() - 1), silent: true }))
      // フェッチ中に WS 切断タイミングで ref が再セットされる競合を排除するため直前に再リセット
      resetTracking()

      // pre-window イベントから T 時点の追跡 ref を復元する（サイレント注入後の正確な音判定に必要）
      restorePreWindowTracking(preFiltered)

      loadReplayEvents([...preFiltered, ...normalEvents])
    } catch (e) {
      log.error('[replay] リプレイデータ取得失敗', e)
    } finally {
      setReplayIsFetching(false)
    }
  }, [resetState, resetTracking, restorePreWindowTracking, loadReplayEvents, settings.dmdataApiKey])

  const handleStopReplay = useCallback(() => {
    setReplayTimeOffset(null)
    prefetchEndRef.current = null
    resetState()
    resetTracking()
    clearReplayCache()
  }, [resetState, resetTracking])

  // 再生時刻が prefetchEnd - 10分 に近づいたら次の1時間を先読みする
  const replayCurrentTime = replayTimeOffset !== null ? serverDate() : null
  useEffect(() => {
    if (replayTimeOffset === null || replayIsFetching || !prefetchEndRef.current) return
    const remaining = prefetchEndRef.current.getTime() - serverNow()
    if (remaining > 10 * 60_000) return
    const nextFrom = prefetchEndRef.current
    const nextTo = new Date(nextFrom.getTime() + 3600_000)
    prefetchEndRef.current = nextTo
    setReplayIsFetching(true)
    fetchDmdataReplayEvents(settings.dmdataApiKey, nextFrom, nextTo)
      .then(loadReplayEvents)
      .catch((e) => log.error('[replay] 先読み取得失敗', e))
      .finally(() => setReplayIsFetching(false))
  }, [replayCurrentTime, replayTimeOffset, replayIsFetching, loadReplayEvents, settings.dmdataApiKey])

  // DMDSS版: Yahoo hypoInfo からのEEW検出は不要（DMDATAが直接配信するため）
  const kyoshin = useKyoshinRealtime(true, {
    onEEWEvent: isDmdss ? undefined : injectEvent,
    timeOffset: replayTimeOffset,
  })
  const kyoshinDetection = useKyoshinDetection(kyoshin.sites, kyoshin.indices)
  // タイマーコールバック内から最新の detected 値を参照する ref（宣言はコンポーネント冒頭・代入はここ）
  kyoshinDetectedRef.current = kyoshinDetection.detected

  // 新検知エンジン（純粋コア）。検知結果はリアルタイムタブの視覚カードにのみ用いる。
  // 音・自動タブ切替・自動フィットには一切関与させない（frameScore 未調整のため）。
  // localStorage['kyoshinDetectorV2'] === '0' で無効化できる（既定 ON）。
  const kyoshinV2Enabled = useMemo(() => {
    try {
      return localStorage.getItem('kyoshinDetectorV2') !== '0'
    } catch {
      return true
    }
  }, [])
  const kyoshinV2 = useKyoshinDetectorV2(kyoshin.sites, kyoshin.indices, kyoshin.dataTime, kyoshinV2Enabled)

  // DMDSS版: EEWデータから P波・S波半径を自前計算（100ms更新でスムーズ拡張）
  // activeEEWs (Map) の参照が安定している限り配列を再生成しない
  const activeEEWList = useMemo(() => Array.from(activeEEWsNoCancelled.values()), [activeEEWsNoCancelled])
  const dmdssWaves = useDmdssWaves(activeEEWList, isDmdss, replayTimeOffset)
  const psWave = isDmdss ? dmdssWaves : kyoshin.psWave

  // EEW受信中または揺れ検知中は全観測点ベースの最大インデックスを使う（表示と音を一致させる）
  const hasActiveEEW = activeEEWsNoCancelled.size > 0

  const home = useMemo(
    () => (settings.homeLat !== null && settings.homeLng !== null
      ? { lat: settings.homeLat, lng: settings.homeLng }
      : null),
    [settings.homeLat, settings.homeLng],
  )
  const swaveArrival = useSWaveCountdown(psWave, home, hasActiveEEW)

  const prevEtaRef = useRef<number | null>(null)
  useEffect(() => {
    const eta = swaveArrival?.etaSec ?? null
    if (
      settings.soundEnabled &&
      eta !== null &&
      eta >= 1 &&
      eta <= 5 &&
      eta !== prevEtaRef.current
    ) {
      playCountdownBeep(eta)
    }
    prevEtaRef.current = eta
  }, [swaveArrival?.etaSec, settings.soundEnabled])

  // 揺れ検知の開始/終了・レベル変化に応じたタブ切替・タイトル・通知音・ブラウザ通知
  useKyoshinAlerts({
    kyoshinDetection,
    kyoshinIndices: kyoshin.indices,
    hasActiveEEW,
    settings,
    title,
    activeEEWsRef,
    defaultTabRef,
    setActiveTab,
    revertToDefaultTab,
  })

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
            observations={latestTsunamiObservations}
            lpgm={activeLpgm ?? undefined}
            iconScale={settings.mapIconScale}
            showBathymetry={settings.showBathymetry}
            showActiveFaults={settings.showActiveFaults}
            heatPoints={quakeHeatPoints}
            showPlateBoundaries={settings.showPlateBoundaries}
            kyoshinSites={kyoshin.sites}
            kyoshinIndices={kyoshin.indices}
            kyoshinPsWave={psWave}
            eews={Array.from(activeEEWsNoCancelled.values())}
            detectedPoints={kyoshinDetection.points}
            candidatePoints={kyoshinDetection.candidatePoints}
            candidateId={kyoshinDetection.candidateId}
            kyoshinV2Detections={kyoshinV2.detections}
            idleRevertSec={settings.idleRevertSec}
            eewLpgmEventId={activeLpgmSource === 'eew' ? activeLpgmEventId : null}
            focusObsName={focusedObsName}
            obsUpdateStatus={obsUpdateStatus}
          />
          <MapUpdateTime lastUpdate={overlayUpdateTime} error={overlayError} />
          <SpecialInfoBanner nankai={nankai} kohatsu={kohatsu} />
        </div>

        {/* パネル（タブに応じて内容を切替）。モバイルは下部固定高さ + スクロール。 */}
        {/* 各タブを absolute で重ねて visibility で切り替えることで、スクロール位置をタブごとに独立管理する。
            display:none（hidden クラス）は scrollTop をリセットするため使わない。 */}
        <div className="h-96 flex-shrink-0 lg:h-auto lg:flex-none lg:w-96 border-t lg:border-t-0 lg:border-l border-border relative">
          <div className={`absolute inset-0 overflow-y-auto${activeTab !== 'earthquake' ? ' invisible pointer-events-none' : ''}`}>
            <EarthquakeTab
              earthquakes={filteredEarthquakes}
              selectedId={selectedQuake?.earthquake.time ?? null}
              onSelect={selectQuake}
              isLoading={isLoading}
              isLoadingMore={isLoadingMore}
              hasMore={hasMore}
              onLoadMore={loadMoreEarthquakes}
              error={error}
              lpgmByEventId={lpgmByEventId}
              activeLpgmEventId={activeLpgmEventId}
              onToggleLpgm={(eventId) => {
                setActiveLpgmEventId(prev => {
                  const next = prev === eventId ? null : eventId
                  setActiveLpgmSource(next ? 'earthquake' : null)
                  return next
                })
              }}
            />
          </div>
          <div className={`absolute inset-0 overflow-y-auto${activeTab !== 'realtime' ? ' invisible pointer-events-none' : ''}`}>
            <RealtimeTab
              eews={Array.from(activeEEWs.values())}
              kyoshinDetection={kyoshinDetection}
              kyoshinSites={kyoshin.sites}
              kyoshinIndices={kyoshin.indices}
              kyoshinV2Detections={kyoshinV2.detections}
              swaveArrival={swaveArrival}
              activeLpgmEventId={activeLpgmEventId}
              onToggleLpgm={(eventId) => {
                setActiveLpgmEventId(prev => {
                  const next = prev === eventId ? null : eventId
                  setActiveLpgmSource(next ? 'eew' : null)
                  return next
                })
              }}
              onDeactivateLpgm={() => {
                setActiveLpgmEventId(null)
                setActiveLpgmSource(null)
              }}
            />
          </div>
          <div className={`absolute inset-0 overflow-y-auto${activeTab !== 'tsunami' ? ' invisible pointer-events-none' : ''}`}>
            <TsunamiTab
              tsunamis={tsunamis}
              earthquakes={filteredEarthquakes}
              onEarthquakeLink={(earthquakeTime) => {
                selectQuake(earthquakeTime)
                setActiveTabNonRealtime('earthquake')
              }}
              onObservationClick={(name) => setFocusedObsName({ name, ts: Date.now() })}
              focusedDistrict={focusedDistrict}
              obsUpdateStatus={obsUpdateStatus}
            />
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
                tsunami:          simulateTsunami,
                tsunamiWarning:   simulateTsunamiWarning,
                tsunamiWatch:     simulateTsunamiWatch,
                tsunamiForecast:  simulateTsunamiForecast,
                nankaiChecking:   () => simulateNankai('調査中'),
                nankaiWatch:      () => simulateNankai('巨大地震注意'),
                nankaiWarning:    () => simulateNankai('巨大地震警戒'),
                kohatsu:          simulateKohatsu,
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
              kyoshinTimeOffset={replayTimeOffset}
              onSetKyoshinTimeOffset={isDmdss ? undefined : setReplayTimeOffset}
              kyoshinInputDateTime={kyoshinInputDateTime}
              onSetKyoshinInputDateTime={setKyoshinInputDateTime}
              replayIsFetching={replayIsFetching}
              onStartReplay={isDmdss ? handleStartReplay : undefined}
              onStopReplay={isDmdss ? handleStopReplay : undefined}
            />
          </div>
        </div>

        {/* アイコンナビ（一番外側＝右端 / モバイルは最下部） */}
        <IconNav
          activeTab={activeTab}
          onTabChange={(tab) => {
            if (tab === 'realtime') {
              realtimeTabSuppressedUntilRef.current = 0
              log.debug('[tab] → realtime (手動選択)')
              setActiveTab('realtime')
            } else {
              log.debug(`[tab] → ${tab} (手動選択)`)
              setActiveTabNonRealtime(tab)
            }
          }}
          tsunamiGrade={tsunamiGrade}
          eewLevel={computeEEWLevel(activeEEWsNoCancelled)}
        />
      </div>
    </div>
  )
}
