import { memo, type ReactNode } from 'react'

export type TabId = 'earthquake' | 'realtime' | 'tsunami' | 'settings' | 'telegrams'

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  // サイズは rem 指定（22px 相当）。width/height 属性の数値は px 固定で UI 倍率の外に出てしまい、
  // 倍率を上げてもナビのアイコンだけ元の大きさのまま取り残される。
  className: 'w-[1.375rem] h-[1.375rem]',
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
  // 電文ログ: ターミナル
  telegrams: (
    <svg {...ICON_PROPS}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
}

const ITEMS: { id: TabId; label: string }[] = [
  { id: 'earthquake', label: '地震情報' },
  { id: 'realtime', label: 'リアルタイム' },
  { id: 'tsunami', label: '津波情報' },
  { id: 'settings', label: '設定' },
  { id: 'telegrams', label: '電文ログ' },
]

const TSUNAMI_BADGE_COLOR: Record<string, string> = {
  MajorWarning: 'bg-purple-500',
  Warning:      'bg-red-500',
  Watch:        'bg-yellow-400',
}

const EEW_BADGE_COLOR: Record<number, string> = {
  2: 'bg-purple-500',
  1: 'bg-red-500',
  0: 'bg-yellow-400',
}

interface Props {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  /** パネルが折りたたまれているか（表示中タブのボタンの状態表示に使う）。 */
  panelCollapsed: boolean
  tsunamiGrade: 'MajorWarning' | 'Warning' | 'Watch' | null
  eewLevel: 0 | 1 | 2 | null
}

// アイコンボタンによるナビゲーション。左右分割時（side 以上）は右端で縦並び、
// 縦積み時（スマホ縦など）は最下部で横並びになる。
// 表示中のタブをもう一度押すとパネルの折りたたみをトグルする（挙動は App 側）。
// React.memo 化の理由と props 参照安定性の要件は docs/spec/architecture-spec.md 参照。
export const IconNav = memo(function IconNav({ activeTab, onTabChange, panelCollapsed, tsunamiGrade, eewLevel }: Props) {
  return (
    <nav
      className="flex flex-row side:flex-col items-center justify-center side:justify-start gap-1 p-1.5 bg-panel border-t side:border-t-0 side:border-l border-border flex-shrink-0"
      // 縦積み時は下端、左右分割時は右端に来るため、両方の safe-area を確保する
      // （横向き時の inset-bottom / 縦向き時の inset-right はいずれも 0 になるので相互に干渉しない）。
      style={{
        paddingBottom: 'max(0.375rem, env(safe-area-inset-bottom, 0px))',
        paddingRight: 'max(0.375rem, env(safe-area-inset-right, 0px))',
      }}
    >
      {ITEMS.map((item) => {
        const isActive = activeTab === item.id
        return (
          <button
            key={item.id}
            onClick={() => onTabChange(item.id)}
            // ボタン名（aria-label）は状態で変えない。折りたたみの状態は aria-expanded が伝える
            // 役割を持つため、名前まで変えると読み上げも DOM 検索も不安定になる。
            aria-label={item.label}
            aria-current={isActive}
            aria-expanded={isActive ? !panelCollapsed : undefined}
            title={isActive ? `${item.label}（もう一度押すとパネルを${panelCollapsed ? '開く' : '畳む'}）` : item.label}
            className={`relative w-11 h-11 flex items-center justify-center rounded-lg transition-colors ${
              isActive
                ? panelCollapsed
                  // 折りたたみ中は「選択中だが内容は非表示」であることを、塗りを弱めて示す。
                  ? 'bg-white/5 text-white/70'
                  : 'bg-white/15 text-white'
                : 'text-secondary hover:text-white hover:bg-white/5'
            }`}
          >
            {ICONS[item.id]}
            {item.id === 'tsunami' && tsunamiGrade !== null && (
              <span className={`absolute top-1 right-1 w-2 h-2 rounded-full ${TSUNAMI_BADGE_COLOR[tsunamiGrade]} animate-pulse`} />
            )}
            {item.id === 'realtime' && eewLevel !== null && (
              <span className={`absolute top-1 right-1 w-2 h-2 rounded-full ${EEW_BADGE_COLOR[eewLevel]} animate-pulse`} />
            )}
          </button>
        )
      })}
    </nav>
  )
})
