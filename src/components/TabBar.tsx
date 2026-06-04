export type TabId = 'earthquake' | 'realtime' | 'tsunami'

interface Tab {
  id: TabId
  label: string
  icon: string
}

const TABS: Tab[] = [
  { id: 'earthquake', label: '地震情報', icon: '🌏' },
  { id: 'realtime', label: 'リアルタイム', icon: '📡' },
  { id: 'tsunami', label: '津波情報', icon: '🌊' },
]

interface Props {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  tsunamiActive: boolean
}

export function TabBar({ activeTab, onTabChange, tsunamiActive }: Props) {
  return (
    <nav className="flex bg-panel border-b border-border flex-shrink-0">
      {TABS.map(tab => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`
            flex-1 flex flex-col items-center gap-0.5 py-2.5 px-2 text-xs font-medium
            transition-colors relative
            ${activeTab === tab.id
              ? 'text-white border-b-2 border-blue-500'
              : 'text-secondary hover:text-white'
            }
          `}
        >
          <span className="text-lg leading-none">{tab.icon}</span>
          <span>{tab.label}</span>
          {tab.id === 'tsunami' && tsunamiActive && (
            <span className="absolute top-1.5 right-3 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          )}
        </button>
      ))}
    </nav>
  )
}
