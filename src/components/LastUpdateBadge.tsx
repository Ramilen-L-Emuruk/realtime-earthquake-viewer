import { useState, useEffect } from 'react'
import type { ConnectionStatus } from '../types/earthquake'

interface Props {
  lastUpdate: Date | null
  connectionStatus: ConnectionStatus
}

const STALE_WARN_SEC = 5 * 60   // 5分: 黄色
const STALE_ERROR_SEC = 15 * 60 // 15分: 赤（接続中なのにデータ停止）

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

type Severity = 'normal' | 'warn' | 'error'

function getSeverity(connectionStatus: ConnectionStatus, elapsedSec: number): Severity {
  if (connectionStatus === 'disconnected') return 'error'
  if (connectionStatus === 'connecting') return 'warn'
  if (elapsedSec >= STALE_ERROR_SEC) return 'error'
  if (elapsedSec >= STALE_WARN_SEC) return 'warn'
  return 'normal'
}

const SEVERITY_STYLES: Record<Severity, { text: string; label: string; pulse: boolean }> = {
  normal: { text: 'text-secondary',  label: '',      pulse: false },
  warn:   { text: 'text-yellow-400', label: '遅延',   pulse: false },
  error:  { text: 'text-red-400',    label: '停止中', pulse: true  },
}

export function LastUpdateBadge({ lastUpdate, connectionStatus }: Props) {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const elapsedSec = lastUpdate ? Math.floor((nowMs - lastUpdate.getTime()) / 1000) : Infinity
  const severity = getSeverity(connectionStatus, elapsedSec)
  const { text, label, pulse } = SEVERITY_STYLES[severity]

  if (!lastUpdate) {
    return (
      <div className="flex flex-col items-end text-xs text-secondary">
        <span className="hidden sm:block">最終更新</span>
        <span>受信待機中…</span>
      </div>
    )
  }

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
      <span className="flex items-center gap-1">
        <span>{formatElapsed(elapsedSec)}</span>
        {label && <span className="font-bold">({label})</span>}
      </span>
    </div>
  )
}
