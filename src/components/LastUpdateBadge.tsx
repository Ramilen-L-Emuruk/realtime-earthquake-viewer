import { useState, useEffect } from 'react'
import type { ConnectionStatus } from '../types/earthquake'

interface Props {
  lastUpdate: Date | null
  connectionStatus: ConnectionStatus
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分前`
  return `${Math.floor(minutes / 60)}時間前`
}

function formatDatetime(date: Date): string {
  const y = date.getFullYear()
  const M = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${y}/${M}/${d} ${h}:${m}:${s}`
}

const CONNECTION_STYLES: Record<ConnectionStatus, { text: string; pulse: boolean }> = {
  connected:    { text: 'text-secondary',  pulse: false },
  connecting:   { text: 'text-yellow-400', pulse: false },
  disconnected: { text: 'text-red-400',    pulse: true  },
}

export function LastUpdateBadge({ lastUpdate, connectionStatus }: Props) {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const { text, pulse } = CONNECTION_STYLES[connectionStatus]

  if (!lastUpdate) {
    return (
      <div className={`flex flex-col items-end text-xs ${text}`}>
        <span className="hidden sm:block">最終更新</span>
        <span>受信待機中…</span>
      </div>
    )
  }

  const elapsedSec = Math.floor((nowMs - lastUpdate.getTime()) / 1000)

  return (
    <div className={`flex flex-col items-end text-xs ${text} ${pulse ? 'animate-pulse' : ''}`}>
      {/* デスクトップ: 日付+時刻 */}
      <span className="hidden sm:block font-mono tracking-tight">
        {formatDatetime(lastUpdate)}
      </span>
      {/* モバイル: 時刻のみ */}
      <span className="sm:hidden font-mono">
        {lastUpdate.toLocaleTimeString('ja-JP')}
      </span>
      <span>{formatElapsed(elapsedSec)}</span>
    </div>
  )
}
