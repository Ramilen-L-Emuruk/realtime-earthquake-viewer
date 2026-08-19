import { useState, useEffect, useRef, useMemo, useCallback, type CSSProperties } from 'react'
import { IconNav, type TabId } from './components/IconNav'
import { PanelResizeHandle } from './components/PanelResizeHandle'
import { MapView, type MapMode } from './components/Map/MapView'
import { MapUpdateTime } from './components/MapUpdateTime'
import { MapDataStatus } from './components/MapDataStatus'
import { EarthquakeTab } from './components/EarthquakeTab'
import { RealtimeTab } from './components/RealtimeTab'
import { TsunamiTab } from './components/TsunamiTab'
import { SettingsTab } from './components/SettingsTab'
import { TelegramTab } from './components/TelegramTab'
import { SpecialInfoBanner } from './components/SpecialInfoBanner'
import { useEarthquakes } from './hooks/useEarthquakes'
import { useTestScenarios } from './hooks/useTestScenarios'
import { useSettings } from './hooks/useSettings'
import { useAlertTitle } from './hooks/useAlertTitle'
import { useLiveEventHandler } from './hooks/useLiveEventHandler'
import { useKyoshinAlerts } from './hooks/useKyoshinAlerts'
import { useKyoshinRealtime } from './hooks/useKyoshinRealtime'
import { useKyoshinDetectorV2 } from './hooks/useKyoshinDetectorV2'
import { deriveKyoshinView } from './utils/kyoshinDetectionView'
import { filterSubThresholdIndices } from './utils/kyoshinSubThresholdFilter'
import { useSWaveCountdown } from './hooks/useSWaveCountdown'
import { usePsWaveCalc } from './hooks/usePsWaveCalc'
import { useQuakeHeatmap } from './hooks/useQuakeHeatmap'
import { useDebouncedValue } from './hooks/useDebouncedValue'
import { getIntensityLabel } from './utils/intensity'
import { formatMagnitude, formatDateTimeLocal } from './utils/formatters'
import { computeEEWLevel, eewMaxLpgmClass } from './utils/eew'
import { quakeEventKey } from './utils/quakeMerge'
import { tsunamiOverallGrade } from './utils/tsunami'
import { playCountdownBeep, unlockAudio, setSoundVolume } from './utils/alertSound'
import { loadTtsPhraseBreakDict } from './utils/ttsPhraseBreakDict'
import type { EEWAlert, JMAQuake, JMATsunami } from './types/earthquake'
import { useReplayController } from './hooks/useReplayController'
import { fetchDmdataReplayEvents, clearReplayCache } from './services/dmdataReplay'
import { fetchP2PReplayEvents, clearP2PReplayCache } from './services/p2pquakeReplay'
import { log } from './utils/logger'
import { setReplayOffset as setClockReplayOffset, serverDate } from './utils/clock'
import { isDmdss } from './utils/env'

// 平常時のウィンドウタイトル（index.html の <title> と一致させる）。
// AutoHotKey 等が、情報更新時のタイトル変化を検知してイベントを発火できるようにする。
const DEFAULT_TITLE = isDmdss
  ? 'リアルタイム地震ビューアー (DM-D.S.S)'
  : 'リアルタイム地震ビューアー'

// siteConfigId 切替直後に kyoshin.sites / kyoshin.indices の siteConfigId が揃うまで
// 下流へ渡す代替として使う空配列（毎レンダー新規生成しないようモジュール定数で共有）。
// 空配列を freeze せず可変配列として扱っているのは既存 SiteCoords 型定義が可変配列のため。
const EMPTY_SITES: [number, number][] = []
const EMPTY_INDICES: number[] = []

// APIキーの入力が落ち着いたと見なすまでの待ち時間(ms)。手入力の打鍵間隔より長く、
// 貼り付け後の接続開始が待たされたと感じない程度に短く。
const API_KEY_DEBOUNCE_MS = 800

// 各タブのスクロール領域に共通で当てるクラス。パネルは縦一列の表示で横スクロールを想定しない。
// overflow-y だけを auto にすると CSS 仕様で overflow-x の visible も auto に格上げされるため、
// 中身が数 px でもはみ出すと指で左右に動いてしまう（パネル幅が最も狭い sideNarrow＝スマホ横で
// 顕在化する）。overflow-x-hidden で塞ぎ、overscroll-x-none で iOS の横ラバーバンドも止める。
const TAB_SCROLLER_CLASS = 'absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-x-none'

export function App() {
  const { settings, updateSetting } = useSettings()
  const [activeTab, setActiveTabState] = useState<TabId>(settings.defaultTab)
  // パネルの折りたたみ状態。地図を全画面で見るための一時的な状態なので、意図的に設定へ
  // 保存しない（起動直後に情報が見えない状態を作らないため、リロードで必ず展開に戻る）。
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  // 縦積みレイアウト（スマホ縦など）でのパネル高さ比率。ドラッグ中は毎フレームここだけを
  // 更新し、指を離した時点で設定（localStorage）へ保存する。
  const [panelRatio, setPanelRatio] = useState(settings.panelRatio)

  // タブ切替は「その内容をユーザーに見せる」意図なので、パネルが折りたたまれていれば必ず展開する。
  // ラッパーにしているのは、activeTab の変化を監視する useEffect では拾えない経路があるため。
  // EEW のレベルアップ・揺れ検知の続報・津波の続報はいずれも「既に表示中のタブ」へ
  // setActiveTab を呼ぶ（値が変わらない）ため、監視型だと畳んだまま気付けない。
  // 以降 App 内の全てのタブ切替（フックへ props で渡すものも含む）はこのラッパーを通す。
  const setActiveTab = useCallback((tab: TabId) => {
    setPanelCollapsed(false)
    setActiveTabState(tab)
  }, [])
  const [selectedQuakeId, setSelectedQuakeId] = useState<string | null>(null)
  // 地震カードのユーザー明示選択カウンタ。QuakeFitGL が「明示選択」と「電文更新起点の自動追従」を
  // 区別するために使う（明示選択中はユーザー操作中フラグを無視して強制フィット・
  // CameraFollowsGL.tsx QuakeFitGL 参照）。
  const [quakeSelectionTick, setQuakeSelectionTick] = useState(0)
  const [focusedObsName, setFocusedObsName] = useState<{ name: string; ts: number } | null>(null)
  const [activeLpgmEventId, setActiveLpgmEventId] = useState<string | null>(null)
  const [activeLpgmSource, setActiveLpgmSource] = useState<'earthquake' | 'eew' | null>(null)
  // 地震カード切替時は LPGM 表示をリセットする。子タブ（React.memo 化済み）へ props として
  // 渡すため useCallback で参照を安定化する（毎レンダー再生成すると memo が破られる）。
  //
  // opts.explicit は「ユーザーがカード（や津波→地震リンク）を直接クリックした」ことを示す。
  // 電文受信ハンドラ（useLiveEventHandler）からも新規・続報のたびに selectQuake を呼んで
  // 選択状態を最新カードへ追従させるが、こちらは explicit=false（省略）で呼び、
  // QuakeFitGL に「電文起点の自動更新」として扱わせる（isUserInteracting を尊重）。
  // explicit=true の呼び出しだけが quakeSelectionTick を進め、QuakeFitGL が isUserInteracting
  // を無視して強制フィットする（CameraFollowsGL.tsx の QuakeFitGL 参照）。
  const selectQuake = useCallback((id: string | null, opts?: { explicit?: boolean }) => {
    setSelectedQuakeId(id)
    setActiveLpgmEventId(null)
    setActiveLpgmSource(null)
    if (opts?.explicit) setQuakeSelectionTick(t => t + 1)
  }, [])
  // 地震情報タブ / EEW（リアルタイム）タブそれぞれで LPGM 表示をトグルするハンドラー。
  // 同じ eventId を再度渡すと非表示化、それ以外の eventId なら表示中の source を切り替える。
  const toggleLpgmFromEarthquake = useCallback((eventId: string) => {
    setActiveLpgmEventId(prev => {
      const next = prev === eventId ? null : eventId
      setActiveLpgmSource(next ? 'earthquake' : null)
      return next
    })
  }, [])
  const toggleLpgmFromEew = useCallback((eventId: string) => {
    setActiveLpgmEventId(prev => {
      const next = prev === eventId ? null : eventId
      setActiveLpgmSource(next ? 'eew' : null)
      return next
    })
  }, [])
  const deactivateLpgm = useCallback(() => {
    setActiveLpgmEventId(null)
    setActiveLpgmSource(null)
  }, [])
  // 津波タブで観測点名をクリックしたときにフォーカス対象として通知する。
  const focusTsunamiObs = useCallback((name: string) => {
    setFocusedObsName({ name, ts: Date.now() })
  }, [])
  // EEW 発報中（cancelledAt 除外済み）・揺れ検知フラグ・地震情報リスト・デフォルトタブを
  // タイマーコールバック内やフック間で参照するための ref。
  // 値の確定はレンダー後半（useEarthquakes / useKyoshinDetectorV2 の後）で毎レンダー代入する。
  const activeEEWsRef = useRef<ReadonlyMap<string, EEWAlert>>(new Map())
  const kyoshinDetectedRef = useRef(false)
  const earthquakesRef = useRef<JMAQuake[]>([])
  // 津波リスト（続報判定に使う）。値の確定は下方で毎レンダー tsunamis で更新する。
  const tsunamisRef = useRef<JMATsunami[]>([])
  const defaultTabRef = useRef<TabId>(settings.defaultTab)
  // 表示中のタブ。「同じタブをもう一度押したら折りたたむ」判定に使う。
  // handleTabChange の deps に activeTab を入れると切替のたびに関数の参照が変わり、
  // React.memo 化した IconNav が再レンダーされるため ref で参照する（値は毎レンダー同期）。
  const activeTabRef = useRef<TabId>(activeTab)
  activeTabRef.current = activeTab
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
  // 子タブ・useLiveEventHandler へ props として渡すため useCallback で参照を安定化する
  // （React.memo 化した子タブが親レンダーで無駄に再レンダーされないようにする）。
  const setActiveTabNonRealtime = useCallback((tab: Exclude<TabId, 'realtime'>) => {
    realtimeTabSuppressedUntilRef.current = Date.now() + 15000
    setActiveTab(tab)
  }, [])

  // EEW 続報（新規発報・レベルアップ以外）による realtime タブ移動。
  // 抑制タイマー発動中はスキップする。
  const setActiveTabRealtimeOnUpdate = useCallback(() => {
    const remaining = realtimeTabSuppressedUntilRef.current - Date.now()
    if (remaining > 0) {
      log.debug(`[tab] → realtime スキップ (EEW続報・抑制中 残り${remaining}ms)`)
      // タブは動かさないが、折りたたみだけは解除する。抑制は「ユーザーが自分で選んだタブを
      // 勝手に切り替えない」ための仕組みであって、情報を隠したままにするためのものではない。
      // これを入れないと「手動で別タブへ移動 → 折りたたむ → 抑制中に続報が届く」経路で、
      // 抑制が切れるまで（最大 15 秒）パネルが畳まれたままになる。
      setPanelCollapsed(false)
      return
    }
    log.info('[tab] → realtime (EEW続報)')
    setActiveTab('realtime')
  }, [])

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
    settings, title, earthquakesRef, tsunamisRef, kyoshinDetectedRef, defaultTabRef,
    setActiveTab, setActiveTabNonRealtime, setActiveTabRealtimeOnUpdate,
    revertToDefaultTab, selectQuake, setActiveLpgmEventId,
  })
  resetTsunamiScrollRef.current = resetTsunamiScrollToTop

  const [replayTimeOffset, setReplayTimeOffset] = useState<number | null>(null)

  // 通信を起こす側へ渡す APIキーは、入力が落ち着くまで待つ。設定欄は 1 文字ごとに保存するため、
  // 生の値を effect 依存に渡すと手入力・修正のたびに未完成のキーで接続と履歴取得をやり直し、
  // そのすべてが 401/403 で失敗してコンソールを埋める（無駄なリクエストとレート消費も伴う）。
  // 保存と画面表示は即座に反映したいので、遅らせるのはここだけにする。
  const debouncedApiKey = useDebouncedValue(settings.dmdataApiKey, API_KEY_DEBOUNCE_MS)

  const {
    earthquakes, tsunamis, activeEEWs, lpgmByEventId, nankai, kohatsu, connectionStatus, lastUpdate, isLoading, isLoadingMore, hasMore, error,
    telegramLog, clearTelegramLog,
    injectEvent, loadMoreEarthquakes,
    simulateEarthquake, simulateForeignQuake,
    simulateEEW, simulateEEWWarning, simulateEEWForecast, simulateEEWRetraction,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch, simulateTsunamiForecast, simulateTsunamiRetraction,
    simulateNankai, simulateKohatsu,
    resetState, loadReplayEvents,
  } = useEarthquakes(handleLiveEvent, debouncedApiKey, settings.dmdataTestDelivery, replayTimeOffset)
  earthquakesRef.current = earthquakes
  tsunamisRef.current = tsunamis

  // EarthquakeTab のカードクリックからの選択。ユーザーが自らカードをクリックした挙動なので
  // explicit=true を渡し、QuakeFitGL に isUserInteracting を無視して強制フィットさせる。
  const selectQuakeFromCard = useCallback((id: string) => {
    selectQuake(id, { explicit: true })
  }, [selectQuake])

  // 津波タブから地震情報カードへのリンク（地震タブへ移動して該当カードを選択する）。
  // selectQuake は上で useCallback 化、setActiveTabNonRealtime も useCallback 化済み。
  // ユーザーが自らリンクをクリックした挙動なので explicit=true で明示選択扱いにし、
  // モード切替（tsunami→quake）で QuakeFitGL がリマウントされた直後でも強制フィットさせる。
  const linkTsunamiToEarthquake = useCallback((quakeKey: string) => {
    selectQuake(quakeKey, { explicit: true })
    setActiveTabNonRealtime('earthquake')
  }, [selectQuake, setActiveTabNonRealtime])
  // SettingsTab の onTest オブジェクトはメモ化して同一参照を保つ（毎レンダー再生成すると
  // React.memo 化された SettingsTab が無駄に再レンダーされる）。
  // WARNING: 新規テストハンドラーを追加するときは、対応する simulate* 関数を必ず
  // 下方の deps 配列にも追加すること。deps を更新し忘れると testHandlers 内で古い
  // クロージャを握り続け、テスト関数のバグが再現できなくなる（`react-hooks/exhaustive-deps`
  // による自動検出は現状の lint 設定では実行されない）。
  const testHandlers = useMemo(() => ({
    earthquake:        simulateEarthquake,
    foreignQuake:      simulateForeignQuake,
    eew:               simulateEEW,
    eewWarning:        simulateEEWWarning,
    eewForecast:       simulateEEWForecast,
    eewRetraction:     simulateEEWRetraction,
    tsunami:           simulateTsunami,
    tsunamiWarning:    simulateTsunamiWarning,
    tsunamiWatch:      simulateTsunamiWatch,
    tsunamiForecast:   simulateTsunamiForecast,
    tsunamiRetraction: simulateTsunamiRetraction,
    nankaiChecking:    () => simulateNankai('調査中'),
    nankaiWatch:       () => simulateNankai('巨大地震注意'),
    nankaiWarning:     () => simulateNankai('巨大地震警戒'),
    kohatsu:           simulateKohatsu,
    notification:      () => {
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
  }), [
    simulateEarthquake, simulateForeignQuake,
    simulateEEW, simulateEEWWarning, simulateEEWForecast, simulateEEWRetraction,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch, simulateTsunamiForecast, simulateTsunamiRetraction,
    simulateNankai, simulateKohatsu,
  ])
  // IconNav の onTabChange。手動タブ切替は抑制タイマーをリセットして即時反映する。
  // 表示中のタブをもう一度押した場合はタブ切替ではなく、パネルの折りたたみをトグルする
  // （地図を全画面で見るための操作。特に画面の狭いスマホ向け）。
  const handleTabChange = useCallback((tab: TabId) => {
    if (tab === activeTabRef.current) {
      setPanelCollapsed(c => !c)
      return
    }
    if (tab === 'realtime') {
      realtimeTabSuppressedUntilRef.current = 0
      log.info('[tab] → realtime (手動選択)')
      setActiveTab('realtime')
    } else {
      log.info(`[tab] → ${tab} (手動選択)`)
      setActiveTabNonRealtime(tab)
    }
  }, [setActiveTabNonRealtime])

  // パネル境界のつまみ操作。ドラッグ中（Change）は state だけを更新して追従性を保ち、
  // 指を離した時点（Commit）で設定へ保存する。折りたたみ中にドラッグされた場合は
  // 「引き出す」操作とみなして展開する。
  const handlePanelRatioChange = useCallback((ratio: number) => {
    setPanelCollapsed(false)
    setPanelRatio(ratio)
  }, [])
  const handlePanelRatioCommit = useCallback((ratio: number) => {
    setPanelCollapsed(false)
    setPanelRatio(ratio)
    updateSetting('panelRatio', ratio)
  }, [updateSetting])
  const togglePanelCollapsed = useCallback(() => setPanelCollapsed(c => !c), [])

  const scenarioTest = useTestScenarios(loadReplayEvents)

  const { points: quakeHeatPoints } = useQuakeHeatmap(settings.showQuakeHeatmap, debouncedApiKey, earthquakes)

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

  // TTS 読み辞書をアプリ起動時に事前ロードする（VOICEVOX 有効・無効に関わらず）。
  // ここで揃えておけば読み上げ時に待たされない。失敗しても読み上げは句区切りなしで成立するが、
  // 「なぜ句区切りが効かないのか」を後から追えるようログは残す。
  useEffect(() => {
    loadTtsPhraseBreakDict().catch((err) => {
      // 起動時に 1 回だけなので、他の生成データローダと同じ warn で残す
      // （読み上げ時の再試行は繰り返されうるため voicevox.ts 側は debug）。
      log.warn('[data] tts-phrase-break-dict 事前ロード失敗（読み上げの句区切りが効かない）', err)
    })
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

  // filter は毎回新規配列を返すため useMemo で参照を安定化する
  // （EarthquakeTab / TsunamiTab へ props として渡すため。毎レンダー新配列を渡すと
  // shallow compare で常に不一致となり React.memo が実質無効化される）。
  // 遠地地震は国外の地震を伝える情報で国内震度を持たない（maxScale は常に -1）。
  // 「最低表示震度」は国内の小さい地震を一覧から省く設定なので、震度で比べようがない
  // 遠地地震まで巻き添えで消えないよう対象外にする（M7 以上でしか発表されない情報のため）。
  const filteredEarthquakes = useMemo(
    () => earthquakes.filter(q =>
      settings.minDisplayScale < 0
      || q.issue.type === '遠地地震'
      || q.earthquake.maxScale >= settings.minDisplayScale
    ),
    [earthquakes, settings.minDisplayScale],
  )

  const latest = filteredEarthquakes[0] ?? null
  // キャンセル表示中のカードは選択対象から除外する（フォールバック用）
  const latestNonCancelled = filteredEarthquakes.find(q => !q.cancelledAt) ?? null
  // 選択中の地震: selectedQuakeId はカードの eventKey。eventKey は続報でも変わらないため、
  // 電文が更新されても選択は同じカードに追従する（以前は earthquake.time を選択 ID にしていたが、
  // VXSE51→52/53 で時刻が 1 分ずれる問題に加え、同じ分に起きた別の地震と衝突していた）。
  // 該当カードが消えている・取消表示中の場合はキャンセル除外の最新にフォールバックする。
  const selectedQuake = (() => {
    if (!selectedQuakeId) return latestNonCancelled
    return filteredEarthquakes.find(q => quakeEventKey(q) === selectedQuakeId && !q.cancelledAt)
      ?? latestNonCancelled
  })()
  // 地図に表示中の LPGM（バッジクリックでトグル）
  const activeLpgm = activeLpgmEventId ? (lpgmByEventId.get(activeLpgmEventId) ?? null) : null

  // 選択中の地震カードがキャンセル状態になったら即座に選択解除する
  useEffect(() => {
    if (!selectedQuakeId) return
    const selected = filteredEarthquakes.find(q => quakeEventKey(q) === selectedQuakeId)
    if (selected?.cancelledAt) {
      setSelectedQuakeId(null)
    }
  }, [filteredEarthquakes, selectedQuakeId])

  // cancelledAt（10秒表示中）の EEW は地図・挙動系から除外する
  const activeEEWsNoCancelled = useMemo(
    () => new Map([...activeEEWs].filter(([, v]) => !v.cancelledAt)),
    [activeEEWs],
  )
  // cancelledAt 除外済みのアクティブ EEW が1件以上あるか（S波カウントダウン等が参照する）
  const hasActiveEEW = activeEEWsNoCancelled.size > 0
  // 強震モニタ検知エンジン（useKyoshinDetectorV2）の EEW 連動緩和専用。震源要素が確定した（単独点処理=
  // 仮定震源要素でない）EEW のみを見る。severity（Warning/Forecast）は推定震度の大小を示す軸に過ぎず、
  // 予報級でも震度3〜4相当は普通にありうるため使わない。condition==='仮定震源要素' は 1 観測点のみの
  // データで震源を仮決めした速報で、震源・マグニチュード・推定震度の誤差が大きい（RealtimeTab・ttsText
  // が「単独点処理のため」として推定震度・マグニチュード等を非表示にするのと同じ判断基準）。
  // hasActiveEEW をそのまま使うと単独点処理由来の速報1件だけで全国規模の確定緩和が発動し、単点ノイズ
  // 由来の誤 confirmed を EEW 経由で再導入しかねないため区別する。
  const hasActiveNonAssumedEEW = useMemo(
    () => [...activeEEWsNoCancelled.values()].some((eew) => eew.earthquake.condition !== '仮定震源要素'),
    [activeEEWsNoCancelled],
  )

  // 地図・パネルへ渡す EEW 配列は参照を安定させる。JSX 内で Array.from を直接呼ぶと毎レンダー
  // 新しい配列になり、psWave の 100ms tick 等で App が再レンダーするたびに useEewLayerData の
  // eewAreaFills（useMemo）が中身同一のまま再計算され、EEW 区域塗りが同一ジオメトリを冗長に
  // setData → geojson-vt 再タイル化 → 連続自己再描画（weak GPU でのカクつき要因）を招く。
  // useMemo で EEW データが実際に変わったときだけ配列を作り直す。
  const eewsForMap = useMemo(() => Array.from(activeEEWsNoCancelled.values()), [activeEEWsNoCancelled])
  const eewsForPanel = useMemo(() => Array.from(activeEEWs.values()), [activeEEWs])

  // EEW カード経由で選択したLPGMは、次報で長周期地震動階級（地域別lgIntTo優先）が
  // なくなった場合や EEW 解除時に自動的に選択解除する
  useEffect(() => {
    if (!activeLpgmEventId || activeLpgmSource !== 'eew') return
    const eew = activeEEWsNoCancelled.get(activeLpgmEventId)
    if (!eew || eewMaxLpgmClass(eew) < 1) {
      setActiveLpgmEventId(null)
      setActiveLpgmSource(null)
    }
  }, [activeEEWs, activeLpgmEventId, activeLpgmSource])

  // ブラウザ通知: 新しい地震が設定震度以上なら通知
  // 重複抑止は eventKey で行う（earthquake.time では、同じ分に起きた 2 件目の地震が
  // 「通知済み」と誤判定されて通知が出ない）。
  const lastNotifiedIdRef = useRef<string | null>(null)
  useEffect(() => {
    const latestQuake = earthquakes[0]
    if (!latestQuake) return
    if (settings.notifyMinScale < 0) return
    const notifyKey = quakeEventKey(latestQuake)
    if (notifyKey === lastNotifiedIdRef.current) return
    if (latestQuake.earthquake.maxScale < settings.notifyMinScale) return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    lastNotifiedIdRef.current = notifyKey
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
  // 常時表示する地図の内容は mapTab（設定タブ中は直前のタブ）に応じて切り替える。
  // mapTab から MapMode への写像は kyoshinSubIndices の分岐（PERF-1）でも使うため
  // ここ 1 箇所で導出し、下流はこれを参照する（マッピング重複を避ける）。
  const mapMode: MapMode =
    mapTab === 'tsunami' ? 'tsunami' : mapTab === 'realtime' ? 'kyoshin' : 'quake'

  // 津波発表中フラグ（解除済みでない津波情報があるか。Forecast＝若干の海面変動も含む）とバッジ用グレード
  // tsunamiGrade は色分け用のため MajorWarning/Warning/Watch のみ（Forecast は除外）
  // cancelledAt（10秒表示中）は解除表示に切り替わっているため非アクティブ扱いにする（EEW・地震カードと同じ扱い）
  const tsunamiGrade = tsunamiOverallGrade(tsunamis)
  const tsunamiActive = tsunamis.some(t => !t.cancelled && !t.cancelledAt)

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
      log.info(`[tsunami] 発表検出 grade=${tsunamiGrade}`)
    } else if (prevTsunamiActiveRef.current && !tsunamiActive) {
      log.info('[tsunami] 解除検出 (tsunamiActive: true→false)')
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
        log.info(`[tab] → realtime (アイドル復帰・EEW中または揺れ検知中 idleRevertSec=${settings.idleRevertSec})`)
        setActiveTab('realtime')
      } else {
        log.info(`[tab] → ${defaultTabRef.current} (アイドル復帰 idleRevertSec=${settings.idleRevertSec})`)
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
  // リプレイの取得・世代管理は useReplayController に集約している（非同期の完了順序に
  // 依存する状態機械のため、単体でテストできる形に切り出した）。
  // 時計への反映（setClockReplayOffset）は上の useEffect が replayTimeOffset を見て行う。
  // 取得元はバリアントで変わる。DMDSS 版は DMDATA のアーカイブから当時の電文をまとめて取り、
  // standard 版は P2PQuake の日付指定クエリで地震情報・津波を取る（P2PQuake には EEW を
  // 過去日付で引く口が無いため、standard 版のリプレイ中の EEW は強震モニタ由来の検出が担う）。
  //
  // API キーはここだけ生の値を渡す。リプレイはユーザーがボタンを押した時点でしか通信せず、
  // キー入力に連動して自動で走ることがないため、遅らせる必要がない
  //（むしろ押した瞬間の最新値を使いたい）。
  const fetchReplayEvents = useCallback(
    (from: Date, to: Date) => isDmdss
      ? fetchDmdataReplayEvents(settings.dmdataApiKey, from, to)
      : fetchP2PReplayEvents(from, to),
    [settings.dmdataApiKey],
  )
  const clearReplayCacheForVariant = useCallback(
    () => { if (isDmdss) clearReplayCache(); else clearP2PReplayCache() },
    [],
  )
  const replay = useReplayController({
    fetchEvents: fetchReplayEvents,
    clearCache: clearReplayCacheForVariant,
    timeOffset: replayTimeOffset,
    setTimeOffset: setReplayTimeOffset,
    resetState,
    resetTracking,
    restorePreWindowTracking,
    loadReplayEvents,
  })

  // DMDSS版: Yahoo hypoInfo からのEEW検出は不要（DMDATAが直接配信するため）
  const kyoshin = useKyoshinRealtime(true, {
    onEEWEvent: isDmdss ? undefined : injectEvent,
    timeOffset: replayTimeOffset,
  })
  // 強震モニタの揺れ検知は V2 エンジン（純粋コア step）で行う。
  // 検知結果は音・自動タブ切替・自動フィット・地図オーバーレイ・リアルタイムタブのカードを駆動する。
  const kyoshinV2 = useKyoshinDetectorV2(kyoshin.sites, kyoshin.indices, kyoshin.dataTime, kyoshin.sitesSiteConfigId, kyoshin.indicesSiteConfigId, true, hasActiveNonAssumedEEW)
  // siteConfigId 切替直後の一時的な「新 indices・旧 sites」状態では sites[i] と indices[i] を
  // 位置対応で使う下流（描画・タブ表示・派生ビュー）でも誤ペアリングが起きるため、両者の
  // siteConfigId が揃うまで空配列にゲートする。sitelist の非同期取得が完了した次フレームで
  // 元の実データに戻る（切替頻度は年数回、非表示時間はネットワーク往復 1 回分）。
  const kyoshinSitesGated = kyoshin.sitesSiteConfigId != null
    && kyoshin.sitesSiteConfigId === kyoshin.indicesSiteConfigId
    ? kyoshin.sites : EMPTY_SITES
  const kyoshinIndicesGated = kyoshin.sitesSiteConfigId != null
    && kyoshin.sitesSiteConfigId === kyoshin.indicesSiteConfigId
    ? kyoshin.indices : EMPTY_INDICES
  // V2 検知イベント → 表示状態（confirmed/candidate・検知点・候補点）へ変換する
  const kyoshinView = useMemo(
    () =>
      deriveKyoshinView(
        kyoshinV2.detections,
        kyoshinSitesGated,
        kyoshinIndicesGated,
        kyoshinV2.recentOnsetKeys,
      ),
    [kyoshinV2.detections, kyoshinSitesGated, kyoshinIndicesGated, kyoshinV2.recentOnsetKeys],
  )
  // 検知点マーカーが描く点列そのものを検知カードにも渡す（地図とカードで数える集合を構造的に揃える。
  // 以前はカード側でも同じ計算を組み立てていたが、同一の結果になることに頼ると片方の変更で黙って
  // 食い違う。詳細は docs/spec/kyoshin-detection-spec.md §8）。
  const kyoshinDetectedPoints = useMemo(
    () => [...kyoshinView.detectedMarkerPoints, ...kyoshinView.unconfirmedPoints],
    [kyoshinView],
  )
  // 震度0ドット表示専用: 検知エンジンが学習した慢性ノイズ床でフィルタする（震度1+表示には手を入れない）
  // PERF-1: kyoshin モード以外では KyoshinSubThreshold レイヤーが表示されないため、
  // 他モードのとき filterSubThresholdIndices の毎秒 1725 点走査をスキップする
  // （`undefined` を返せば JapanMapGL 側で kyoshinIndices にフォールバックする）。
  const kyoshinSubIndices = useMemo(
    () => (mapMode === 'kyoshin'
      ? filterSubThresholdIndices(kyoshinSitesGated, kyoshinIndicesGated, kyoshinV2.floors)
      : undefined),
    [mapMode, kyoshinSitesGated, kyoshinIndicesGated, kyoshinV2.floors],
  )
  // タイマーコールバック内から最新の confirmed 値を参照する ref（宣言はコンポーネント冒頭・代入はここ）
  kyoshinDetectedRef.current = kyoshinView.confirmed

  // 警報級の状況（EEW 発報中・津波発表中・揺れ検知中）が立ち上がったときの保険。
  // 通常はタブ切替（setActiveTab ラッパー）が展開を担うが、リアルタイムタブへの自動移動が
  // 抑制されている間（realtimeTabSuppressedUntilRef）はタブ切替自体が起きないため、
  // 状況の変化そのものからも展開できるようにしておく。
  const alertActive = hasActiveEEW || tsunamiActive || kyoshinView.confirmed
  useEffect(() => {
    if (alertActive) setPanelCollapsed(false)
  }, [alertActive])

  // EEWデータから P波・S波半径を自前計算（100ms更新でスムーズ拡張、標準版・DMDSS版共通）
  // eewsForMap（activeEEWsNoCancelled の配列）と同一内容のため使い回して二重 useMemo を避ける。
  const psWave = usePsWaveCalc(eewsForMap, replayTimeOffset)

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
    confirmed: kyoshinView.confirmed,
    candidate: kyoshinView.candidate,
    candidateMaxIndex: kyoshinView.candidateMaxIndex,
    confirmedShocks: kyoshinView.confirmedShocks,
    dataTime: kyoshin.dataTime,
    settings,
    title,
    activeEEWsRef,
    defaultTabRef,
    setActiveTab,
    revertToDefaultTab,
  })

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
    // 画面いっぱいの高さは h-dvh（100dvh）で取る。dvh はブラウザ UI の出入りに追従するため、
    // iOS Safari でツールバーが出ている間もナビが画面外へ押し出されない。
    // 画面端の safe-area は端に接する要素が各自で避ける（root では扱わない）。
    // 規則と端ごとの担当は docs/spec/architecture-spec.md
    // 「画面いっぱいへの広がりとセーフエリア」に集約している。
    <div className="flex flex-col h-dvh bg-app text-white overflow-hidden">
      {/* 地図(左) | パネル | アイコンナビ(右端)。
          side ブレークポイント未満（スマホ縦など）は縦積み(地図上・つまみ・パネル・ナビ下)になり、
          パネルの高さは --panel-ratio（つまみのドラッグで可変・折りたたみ時 0）で決まる。
          side 以上（PC・スマホ横）は左右分割で、パネル幅は固定。 */}
      <div
        className="flex-1 overflow-hidden flex flex-col side:flex-row"
        style={{ '--panel-ratio': panelCollapsed ? 0 : panelRatio } as CSSProperties}
      >
        {/* 常時表示の地図エリア（タブに応じて内容を切替） */}
        <div className="relative flex-1 min-h-0">
          <MapView
            mode={mapMode}
            quake={mapQuake}
            tsunamis={tsunamis}
            observations={latestTsunamiObservations}
            lpgm={activeLpgm ?? undefined}
            iconScale={settings.mapIconScale}
            showBathymetry={settings.showBathymetry}
            showActiveFaults={settings.showActiveFaults}
            activeFaultOpacity={settings.activeFaultOpacity}
            heatPoints={quakeHeatPoints}
            showPlateBoundaries={settings.showPlateBoundaries}
            kyoshinSites={kyoshinSitesGated}
            kyoshinIndices={kyoshinIndicesGated}
            kyoshinSubIndices={kyoshinSubIndices}
            kyoshinPsWave={psWave}
            eews={eewsForMap}
            detectedPoints={kyoshinView.detectedPoints}
            detectedMarkerPoints={kyoshinView.detectedMarkerPoints}
            candidatePoints={kyoshinView.candidatePoints}
            unconfirmedPoints={kyoshinView.unconfirmedPoints}
            candidateId={kyoshinView.candidateId}
            eewLpgmEventId={activeLpgmSource === 'eew' ? activeLpgmEventId : null}
            focusObsName={focusedObsName}
            obsUpdateStatus={obsUpdateStatus}
            quakeSelectionTick={quakeSelectionTick}
          />
          {/* 地図左上に重ねる情報の置き場。上から更新時刻・生成データの取得状況。
              z-[99999]: 区域集約震度バッジ（QuakeRegionFillGL）は el.style.zIndex = scale*1000 で、
              scale は JMA 震度階級の数値コード（震度7 = 70）まであるため最大 70000 まで積む。
              それより確実に高い値にして常に最前面に出す。 */}
          <div
            className="absolute z-[99999] pointer-events-none flex flex-col items-start gap-1"
            style={{
              top: 'max(0.5rem, env(safe-area-inset-top, 0px))',
              left: 'max(0.5rem, env(safe-area-inset-left, 0px))',
            }}
          >
            <MapUpdateTime lastUpdate={overlayUpdateTime} error={overlayError} />
            <MapDataStatus />
          </div>
          <SpecialInfoBanner nankai={nankai} kohatsu={kohatsu} />
        </div>

        {/* 地図とパネルの境界（縦積み時のみ）。ドラッグで高さ比率を変え、タップで折りたたむ。 */}
        <PanelResizeHandle
          ratio={panelRatio}
          collapsed={panelCollapsed}
          onRatioChange={handlePanelRatioChange}
          onRatioCommit={handlePanelRatioCommit}
          onToggleCollapse={togglePanelCollapsed}
        />

        {/* パネル（タブに応じて内容を切替）。縦積み時は --panel-ratio 由来の高さ + スクロール。
            折りたたみ時は縦積みなら高さ（--panel-ratio=0）、左右分割なら幅が 0 になり地図が全画面になる。
            各タブを absolute で重ねて visibility で切り替えることで、スクロール位置をタブごとに独立管理する。
            折りたたみを含め display:none（hidden クラス）を使わないのは、scrollTop がリセットされるため。
            左右分割時の幅は `w-panel` / `w-panel-narrow`（tailwind.config.js で定義）。24rem/20rem から
            2rem ずつ広げてある。地震カードの震度バッジを正方形（従来 80px 幅 → カード高さと同じ
            約 112px）にした分、本文カラムが痩せないようにするため。 */}
        <div className={`flex-shrink-0 h-[calc(var(--panel-ratio)*100%)] overflow-hidden side:h-auto side:flex-none border-border relative ${
          panelCollapsed ? 'side:w-0 side:border-l-0' : 'side:w-panel sideNarrow:w-panel-narrow side:border-l'
        }`}>
          <div className={`${TAB_SCROLLER_CLASS}${activeTab !== 'earthquake' ? ' invisible pointer-events-none' : ''}`}>
            <EarthquakeTab
              earthquakes={filteredEarthquakes}
              selectedId={selectedQuake ? quakeEventKey(selectedQuake) : null}
              onSelect={selectQuakeFromCard}
              isLoading={isLoading}
              isLoadingMore={isLoadingMore}
              hasMore={hasMore}
              onLoadMore={loadMoreEarthquakes}
              error={error}
              lpgmByEventId={lpgmByEventId}
              activeLpgmEventId={activeLpgmEventId}
              onToggleLpgm={toggleLpgmFromEarthquake}
            />
          </div>
          <div className={`${TAB_SCROLLER_CLASS}${activeTab !== 'realtime' ? ' invisible pointer-events-none' : ''}`}>
            <RealtimeTab
              eews={eewsForPanel}
              kyoshinV2Detections={kyoshinV2.detections}
              kyoshinDetectedPoints={kyoshinDetectedPoints}
              swaveArrival={swaveArrival}
              activeLpgmEventId={activeLpgmEventId}
              onToggleLpgm={toggleLpgmFromEew}
              onDeactivateLpgm={deactivateLpgm}
            />
          </div>
          <div className={`${TAB_SCROLLER_CLASS}${activeTab !== 'tsunami' ? ' invisible pointer-events-none' : ''}`}>
            <TsunamiTab
              tsunamis={tsunamis}
              earthquakes={filteredEarthquakes}
              onEarthquakeLink={linkTsunamiToEarthquake}
              onObservationClick={focusTsunamiObs}
              focusedDistrict={focusedDistrict}
              obsUpdateStatus={obsUpdateStatus}
            />
          </div>
          <div className={`${TAB_SCROLLER_CLASS}${activeTab !== 'telegrams' ? ' invisible pointer-events-none' : ''}`}>
            <TelegramTab telegramLog={telegramLog} onClear={clearTelegramLog} />
          </div>
          <div className={`${TAB_SCROLLER_CLASS}${activeTab !== 'settings' ? ' invisible pointer-events-none' : ''}`}>
            <SettingsTab
              settings={settings}
              onUpdate={updateSetting}
              dmdataConnectionStatus={connectionStatus}
              onTest={testHandlers}
              kyoshinTimeOffset={replayTimeOffset}
              kyoshinInputDateTime={kyoshinInputDateTime}
              onSetKyoshinInputDateTime={setKyoshinInputDateTime}
              replayIsFetching={replay.isFetching}
              replayError={replay.error}
              onStartReplay={replay.start}
              onStopReplay={replay.stop}
              scenarioTest={scenarioTest}
            />
          </div>
        </div>

        {/* アイコンナビ（一番外側＝右端 / 縦積み時は最下部） */}
        <IconNav
          activeTab={activeTab}
          onTabChange={handleTabChange}
          panelCollapsed={panelCollapsed}
          tsunamiGrade={tsunamiGrade}
          eewLevel={computeEEWLevel(activeEEWsNoCancelled)}
        />
      </div>
    </div>
  )
}
