import { useState, useEffect, useRef } from 'react'
import { Header } from './components/Header'
import { TabBar, type TabId } from './components/TabBar'
import { EEWBanner } from './components/EEWBanner'
import { JapanMap, type MapMode } from './components/Map/JapanMap'
import { EarthquakeTab } from './components/EarthquakeTab'
import { RealtimeTab } from './components/RealtimeTab'
import { KmoniMonitor } from './components/RealtimeTab/KmoniMonitor'
import { TsunamiTab } from './components/TsunamiTab'
import { SettingsTab } from './components/SettingsTab'
import { useEarthquakes } from './hooks/useEarthquakes'
import { useWebhookAlert } from './hooks/useWebhookAlert'
import { useSettings } from './hooks/useSettings'
import { getIntensityLabel } from './utils/intensity'
import { formatMagnitude } from './utils/formatters'

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>('earthquake')
  const [selectedQuakeId, setSelectedQuakeId] = useState<string | null>(null)
  const { settings, updateSetting } = useSettings()
  const {
    earthquakes, tsunamis, activeEEW, connectionStatus, lastUpdate, isLoading, error,
    simulateEarthquake, simulateEEW, simulateTsunami,
  } = useEarthquakes()
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

  // 常時表示する地図の内容はタブに応じて切り替える
  const mapMode: MapMode = activeTab === 'tsunami' ? 'tsunami' : 'quake'
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
        {/* 常時表示の地図エリア（タブに応じて内容を切替） */}
        <div className="relative h-64 lg:h-auto lg:flex-1 flex-shrink-0">
          <JapanMap mode={mapMode} quake={mapQuake} tsunamis={tsunamis} />
          {/* リアルタイムタブでは強震モニタ画像を地図に重ねて表示 */}
          {activeTab === 'realtime' && (
            <div className="absolute inset-0 z-[1000]">
              <KmoniMonitor />
            </div>
          )}
        </div>

        {/* 右パネル（タブに応じて内容を切替） */}
        <div className="lg:w-96 flex-shrink-0 overflow-y-auto border-t lg:border-t-0 lg:border-l border-border">
          {activeTab === 'earthquake' && (
            <EarthquakeTab
              earthquakes={filteredEarthquakes}
              selectedId={selectedQuake?.id ?? null}
              onSelect={setSelectedQuakeId}
              isLoading={isLoading}
              error={error}
            />
          )}
          {activeTab === 'realtime' && <RealtimeTab />}
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
