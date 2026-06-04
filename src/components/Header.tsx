import type { ConnectionStatus } from '../types/earthquake'
import { ConnectionStatus as ConnectionStatusIndicator } from './ConnectionStatus'

interface Props {
  connectionStatus: ConnectionStatus
  lastUpdate: Date | null
}

export function Header({ connectionStatus, lastUpdate }: Props) {
  return (
    <header className="flex items-center justify-between px-4 py-3 bg-panel border-b border-border flex-shrink-0">
      <div className="flex items-center gap-2">
        <svg
          className="w-7 h-7 text-red-500 flex-shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="2 12 6 12 8 6 10 18 12 10 14 15 16 12 22 12" />
        </svg>
        <h1 className="text-white font-bold text-base leading-tight">
          リアルタイム地震ビューアー
        </h1>
      </div>
      <div className="flex items-center gap-3">
        {lastUpdate && (
          <span className="hidden sm:block text-xs text-secondary">
            {lastUpdate.toLocaleTimeString('ja-JP')}
          </span>
        )}
        <ConnectionStatusIndicator status={connectionStatus} />
      </div>
    </header>
  )
}
