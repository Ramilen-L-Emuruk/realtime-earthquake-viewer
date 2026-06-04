import { useState } from 'react'
import { Header } from './components/Header'
import { TabBar, type TabId } from './components/TabBar'
import { EEWBanner } from './components/EEWBanner'
import { EarthquakeTab } from './components/EarthquakeTab'
import { RealtimeTab } from './components/RealtimeTab'
import { TsunamiTab } from './components/TsunamiTab'
import { useEarthquakes } from './hooks/useEarthquakes'
import { useWebhookAlert } from './hooks/useWebhookAlert'

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>('earthquake')
  const { earthquakes, tsunamis, activeEEW, connectionStatus, lastUpdate, isLoading, error } =
    useEarthquakes()
  const { isActive: haAlertActive, dismiss: dismissHaAlert } = useWebhookAlert()

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab)
    if (tab === 'earthquake' && haAlertActive) dismissHaAlert()
  }

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
          <EarthquakeTab earthquakes={earthquakes} isLoading={isLoading} error={error} />
        )}
        {activeTab === 'realtime' && <RealtimeTab />}
        {activeTab === 'tsunami' && <TsunamiTab tsunamis={tsunamis} />}
      </div>
    </div>
  )
}
