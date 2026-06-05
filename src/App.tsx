import { useState, useEffect, useRef } from 'react'
import { IconNav, type TabId } from './components/IconNav'
import { JapanMap, type MapMode } from './components/Map/JapanMap'
import { MapUpdateTime } from './components/MapUpdateTime'
import { EarthquakeTab } from './components/EarthquakeTab'
import { RealtimeTab } from './components/RealtimeTab'
import { TsunamiTab } from './components/TsunamiTab'
import { SettingsTab } from './components/SettingsTab'
import { useEarthquakes } from './hooks/useEarthquakes'
import { useWebhookAlert } from './hooks/useWebhookAlert'
import { useSettings } from './hooks/useSettings'
import { useKyoshinRealtime } from './hooks/useKyoshinRealtime'
import { useKyoshinDetection } from './hooks/useKyoshinDetection'
import { getIntensityLabel } from './utils/intensity'
import { formatMagnitude } from './utils/formatters'
import { playAlertSound, unlockAudio, type AlertSoundType } from './utils/alertSound'
import type { P2PQuakeEvent } from './types/earthquake'

export function App() {
  const { settings, updateSetting } = useSettings()
  const [activeTab, setActiveTab] = useState<TabId>(settings.defaultTab)
  const [selectedQuakeId, setSelectedQuakeId] = useState<string | null>(null)

  // 受信イベントの種別ごとに通知音を鳴らす（同種の連続発火はバースト抑制）
  const lastSoundAtRef = useRef<Record<AlertSoundType, number>>({
    earthquake: 0, eew: 0, tsunami: 0,
  })
  const handleLiveEvent = (event: P2PQuakeEvent) => {
    // 受信時に該当タブを自動表示（地震情報・津波情報・緊急地震速報）
    if (event.code === 551) {
      setActiveTab('earthquake')
    } else if (event.code === 552 && !event.cancelled) {
      setActiveTab('tsunami')
    } else if (event.code === 556 && !event.cancelled && !event.test) {
      // 緊急地震速報の発報時はリアルタイムタブ（強震モニタ＋予報円）を開く
      setActiveTab('realtime')
    }

    // 通知音
    if (!settings.soundEnabled) return
    let type: AlertSoundType | null = null
    if (event.code === 556) {
      if (!event.cancelled && !event.test) type = 'eew'
    } else if (event.code === 552) {
      if (!event.cancelled) type = 'tsunami'
    } else if (event.code === 551) {
      type = 'earthquake'
    }
    if (!type) return
    const now = Date.now()
    if (now - lastSoundAtRef.current[type] < 1500) return
    lastSoundAtRef.current[type] = now
    playAlertSound(type)
  }

  const {
    earthquakes, tsunamis, activeEEW, connectionStatus, lastUpdate, isLoading, error,
    simulateEarthquake, simulateEEW, simulateTsunami,
  } = useEarthquakes(handleLiveEvent)

  // UI 倍率: ルート要素の font-size を変えて rem ベースの UI 全体を拡大縮小する。
  // 倍率変更で地図コンテナ幅が変わるため、Leaflet の再計算用に resize を発火する。
  useEffect(() => {
    document.documentElement.style.fontSize = `${16 * settings.uiScale}px`
    window.dispatchEvent(new Event('resize'))
  }, [settings.uiScale])

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
  const { isActive: haAlertActive, dismiss: dismissHaAlert, testAlert } =
    useWebhookAlert(settings.webhookServerUrl)

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

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab)
    if (tab === 'earthquake' && haAlertActive) dismissHaAlert()
  }

  // 設定タブ表示中は、地図には直前に表示していたタブの内容をそのまま残す。
  const [lastContentTab, setLastContentTab] = useState<TabId>(settings.defaultTab)
  useEffect(() => {
    if (activeTab !== 'settings') setLastContentTab(activeTab)
  }, [activeTab])
  const mapTab = activeTab === 'settings' ? lastContentTab : activeTab

  // 津波発表中フラグ（解除済みでない津波情報があるか）
  const tsunamiActive = tsunamis.some(t => !t.cancelled)

  // アイドル復帰で戻すデフォルトタブ。津波優先トグル ON かつ津波発表中なら
  // 津波情報、それ以外は設定のデフォルトタブ。タイマー発火時に最新値を参照する
  // ため ref に保持する。
  const defaultTabRef = useRef<TabId>(settings.defaultTab)
  defaultTabRef.current =
    settings.tsunamiPriorityDefault && tsunamiActive ? 'tsunami' : settings.defaultTab

  // 設定秒数 情報更新（activeTab の自動切替・P2P 更新）もユーザー操作もなければ
  // デフォルトタブへ戻す。activeTab / lastUpdate の変化、および操作のたびにリセット。
  // idleRevertSec が 0 以下なら自動復帰は無効。
  useEffect(() => {
    if (settings.idleRevertSec <= 0) return
    const ms = settings.idleRevertSec * 1000
    let timer = window.setTimeout(() => setActiveTab(defaultTabRef.current), ms)
    const reset = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setActiveTab(defaultTabRef.current), ms)
    }
    window.addEventListener('pointerdown', reset)
    window.addEventListener('keydown', reset)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', reset)
      window.removeEventListener('keydown', reset)
    }
  }, [activeTab, lastUpdate, settings.idleRevertSec])

  // 強震モニタ（常時ポーリング: タブ非表示中も揺れ検知を継続する）
  const kyoshin = useKyoshinRealtime(true)
  const kyoshinDetection = useKyoshinDetection(kyoshin.sites, kyoshin.indices)

  // 揺れ検知時にリアルタイムタブを自動表示（false → true への遷移時のみ）
  const prevDetectedRef = useRef(false)
  useEffect(() => {
    if (kyoshinDetection.detected && !prevDetectedRef.current) {
      setActiveTab('realtime')
    }
    prevDetectedRef.current = kyoshinDetection.detected
  }, [kyoshinDetection.detected])

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
    <div className="flex flex-col h-screen bg-app text-white overflow-hidden">
      {haAlertActive && (
        <div className="flex-shrink-0 bg-blue-900 border-b-2 border-blue-500 px-4 py-2 flex items-center justify-between animate-slide-down">
          <span className="text-blue-200 text-sm font-medium">
            🏠 Home Assistant から地震アラートを受信しました
          </span>
          <button
            onClick={dismissHaAlert}
            className="text-blue-400 hover:text-white text-xs px-2 py-1 rounded"
          >
            閉じる
          </button>
        </div>
      )}

      {/* 地図(左) | パネル | アイコンナビ(右端)。モバイルは縦積み(地図上・パネル・ナビ下)。 */}
      <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
        {/* 常時表示の地図エリア（タブに応じて内容を切替） */}
        <div className="relative flex-1 min-h-0">
          <JapanMap
            mode={mapMode}
            quake={mapQuake}
            tsunamis={tsunamis}
            uiScale={settings.uiScale}
            kyoshinSites={kyoshin.sites}
            kyoshinIndices={kyoshin.indices}
            kyoshinPsWave={kyoshin.psWave}
            eew={activeEEW}
            detectedPoints={kyoshinDetection.points}
          />
          <MapUpdateTime lastUpdate={overlayUpdateTime} error={overlayError} />
        </div>

        {/* パネル（タブに応じて内容を切替）。モバイルは下部固定高さ + スクロール。 */}
        <div className="h-64 flex-shrink-0 overflow-y-auto lg:h-auto lg:flex-none lg:w-96 border-t lg:border-t-0 lg:border-l border-border">
          {activeTab === 'earthquake' && (
            <EarthquakeTab
              earthquakes={filteredEarthquakes}
              selectedId={selectedQuake?.id ?? null}
              onSelect={setSelectedQuakeId}
              isLoading={isLoading}
              error={error}
            />
          )}
          {activeTab === 'realtime' && (
            <RealtimeTab
              eew={activeEEW}
              kyoshinDetection={kyoshinDetection}
            />
          )}
          {activeTab === 'tsunami' && <TsunamiTab tsunamis={tsunamis} />}
          {activeTab === 'settings' && (
            <SettingsTab
              settings={settings}
              onUpdate={updateSetting}
              onTest={{
                earthquake: simulateEarthquake,
                eew: simulateEEW,
                tsunami: simulateTsunami,
                haAlert: testAlert,
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
            />
          )}
        </div>

        {/* アイコンナビ（一番外側＝右端 / モバイルは最下部） */}
        <IconNav
          activeTab={activeTab}
          onTabChange={handleTabChange}
          tsunamiActive={tsunamiActive}
        />
      </div>
    </div>
  )
}
