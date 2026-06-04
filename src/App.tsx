import { useState, useEffect, useRef } from 'react'
import { Header } from './components/Header'
import { TabBar, type TabId } from './components/TabBar'
import { EEWBanner } from './components/EEWBanner'
import { EarthquakeTab } from './components/EarthquakeTab'
import { RealtimeTab } from './components/RealtimeTab'
import { TsunamiTab } from './components/TsunamiTab'
import { SettingsTab } from './components/SettingsTab'
import { useEarthquakes } from './hooks/useEarthquakes'
import { useWebhookAlert } from './hooks/useWebhookAlert'
import { useSettings } from './hooks/useSettings'
import { getIntensityLabel } from './utils/intensity'
import { formatMagnitude } from './utils/formatters'

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>('earthquake')
  const { settings, updateSetting } = useSettings()
  const { earthquakes, tsunamis, activeEEW, connectionStatus, lastUpdate, isLoading, error } =
    useEarthquakes()
  const { isActive: haAlertActive, dismiss: dismissHaAlert } =
    useWebhookAlert(settings.webhookServerUrl)

  // ブラウザ通知: 新しい地震が設定震度以上なら通知
  const lastNotifiedIdRef = useRef<string | null>(null)
  useEffect(() => {
    const latest = earthquakes[0]
    if (!latest) return
    if (settings.notifyMinScale < 0) return
    if (latest.id === lastNotifiedIdRef.current) return
    if (latest.earthquake.maxScale < settings.notifyMinScale) return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    lastNotifiedIdRef.current = latest.id
    const scale = getIntensityLabel(latest.earthquake.maxScale)
    new Notification('地震情報', {
      body: `${latest.earthquake.hypocenter.name} 最大震度${scale} ${formatMagnitude(latest.earthquake.hypocenter.magnitude)}`,
      icon: '/icons/icon.svg',
      tag: latest.id,
    })
  }, [earthquakes, settings.notifyMinScale])

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab)
    if (tab === 'earthquake' && haAlertActive) dismissHaAlert()
  }

  const filteredEarthquakes = earthquakes
    .filter(q => settings.minDisplayScale < 0 || q.earthquake.maxScale >= settings.minDisplayScale)
    .slice(0, settings.maxEarthquakeList)

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

      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'earthquake' && (
          <EarthquakeTab earthquakes={filteredEarthquakes} isLoading={isLoading} error={error} />
        )}
        {activeTab === 'realtime' && <RealtimeTab />}
        {activeTab === 'tsunami' && <TsunamiTab tsunamis={tsunamis} />}
        {activeTab === 'settings' && (
          <SettingsTab settings={settings} onUpdate={updateSetting} />
        )}
      </div>
    </div>
  )
}
