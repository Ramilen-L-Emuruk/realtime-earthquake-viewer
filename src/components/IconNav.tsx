import type { ReactNode } from 'react'

export type TabId = 'earthquake' | 'realtime' | 'tsunami' | 'settings'

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  width: 22,
  height: 22,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const ICONS: Record<TabId, ReactNode> = {
  // 地震情報: インフォメーション
  earthquake: (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12" y2="8" />
    </svg>
  ),
  // リアルタイム: 波形（脈波）
  realtime: (
    <svg {...ICON_PROPS}>
      <polyline points="2 12 6 12 9 4 13 20 16 12 22 12" />
    </svg>
  ),
  // 津波情報: 波
  tsunami: (
    <svg {...ICON_PROPS}>
      <path d="M2 9c1.8 0 1.8 2 3.5 2S7.3 9 9 9s1.8 2 3.5 2S14.3 9 16 9s1.8 2 3.5 2S21 9 22 9" />
      <path d="M2 15c1.8 0 1.8 2 3.5 2S7.3 15 9 15s1.8 2 3.5 2 1.8-2 3.5-2 1.8 2 3.5 2 1.2-2 2-2" />
    </svg>
  ),
  // 設定: 歯車
  settings: (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
}

const ITEMS: { id: TabId; label: string }[] = [
  { id: 'earthquake', label: '地震情報' },
  { id: 'realtime', label: 'リアルタイム' },
  { id: 'tsunami', label: '津波情報' },
  { id: 'settings', label: '設定' },
]

interface Props {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  tsunamiActive: boolean
}

// 縦並び（モバイルは横並び）のアイコンボタンによるナビゲーション。
export function IconNav({ activeTab, onTabChange, tsunamiActive }: Props) {
  return (
    <nav className="flex flex-row lg:flex-col items-center justify-center lg:justify-start gap-1 p-1.5 bg-panel border-t lg:border-t-0 lg:border-l border-border flex-shrink-0">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          onClick={() => onTabChange(item.id)}
          aria-label={item.label}
          aria-current={activeTab === item.id}
          title={item.label}
          className={`relative w-11 h-11 flex items-center justify-center rounded-lg transition-colors ${
            activeTab === item.id
              ? 'bg-white/15 text-white'
              : 'text-secondary hover:text-white hover:bg-white/5'
          }`}
        >
          {ICONS[item.id]}
          {item.id === 'tsunami' && tsunamiActive && (
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          )}
        </button>
      ))}
    </nav>
  )
}
