import type { ConnectionStatus } from '../types/earthquake'

interface Props {
  status: ConnectionStatus
}

const STATUS_CONFIG = {
  connected: { color: 'bg-green-500', label: '接続中', pulse: false },
  connecting: { color: 'bg-yellow-500', label: '接続中...', pulse: true },
  disconnected: { color: 'bg-red-500', label: '切断', pulse: false },
} satisfies Record<ConnectionStatus, { color: string; label: string; pulse: boolean }>

export function ConnectionStatus({ status }: Props) {
  const config = STATUS_CONFIG[status]
  return (
    <div className="flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        {config.pulse && (
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full ${config.color} opacity-75`}
          />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${config.color}`} />
      </span>
      <span className="text-xs text-secondary">{config.label}</span>
    </div>
  )
}
