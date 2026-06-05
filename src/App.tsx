import { useState, useEffect, useRef } from 'react'
import { Header } from './components/Header'
import { TabBar, type TabId } from './components/TabBar'
import { EEWBanner } from './components/EEWBanner'
import { JapanMap, type MapMode } from './components/Map/JapanMap'
import { EarthquakeTab } from './components/EarthquakeTab'
import { RealtimeTab } from './components/RealtimeTab'
import { TsunamiTab } from './components/TsunamiTab'
import { SettingsTab } from './components/SettingsTab'
import { useEarthquakes } from './hooks/useEarthquakes'
import { useWebhookAlert } from './hooks/useWebhookAlert'
import { useSettings } from './hooks/useSettings'
import { useKyoshinRealtime } from './hooks/useKyoshinRealtime'
import { getIntensityLabel } from './utils/intensity'
import { formatMagnitude } from './utils/formatters'
import { playAlertSound, unlockAudio, type AlertSoundType } from './utils/alertSound'
import type { P2PQuakeEvent } from './types/earthquake'

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>('earthquake')
  const [selectedQuakeId, setSelectedQuakeId] = useState<string | null>(null)
  const { settings, updateSetting } = useSettings()

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

  // 強震モニタ（リアルタイムタブ表示中のみ Yahoo データをポーリング）
  const kyoshin = useKyoshinRealtime(activeTab === 'realtime')

  // 常時表示する地図の内容はタブに応じて切り替える
  const mapMode: MapMode =
    activeTab === 'tsunami' ? 'tsunami' : activeTab === 'realtime' ? 'kyoshin' : 'quake'
  const mapQuake = activeTab === 'earthquake' ? selectedQuake : latest

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

      <EEWBanner eew={activeEEW} />
      <Header connectionStatus={connectionStatus} lastUpdate={lastUpdate} />
      <TabBar
        activeTab={activeTab}
        onTabChange={handleTabChange}
        tsunamiActive={tsunamis.some(t => !t.cancelled)}
      />

      <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
        {/* 常時表示の地図エリア（タブに応じて内容を切替）。モバイルでは高さ可変。 */}
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
          />
        </div>

        {/* 右パネル（タブに応じて内容を切替） */}
        {/* モバイル(縦積み)では固定高さ + overflow-y-auto でスクロール。地図側を可変にする。 */}
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
          {activeTab === 'realtime' && <RealtimeTab eew={activeEEW} />}
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
      </div>
    </div>
  )
}
