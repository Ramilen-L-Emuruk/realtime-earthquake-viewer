import { useState, useCallback } from 'react'
import type { TelegramLogEntry } from '../../types/earthquake'

const HEAD_TYPE_LABEL: Record<string, string> = {
  VXSE43: 'EEW警報',
  VXSE45: 'EEW予報',
  VXSE51: '震度速報',
  VXSE52: '震源情報',
  VXSE53: '震源・震度',
  VXSE61: '顕著な地震の震源要素更新のお知らせ',
  VTSE41: '津波情報',
  VTSE51: '津波観測',
  VTSE52: '津波観測詳細',
  VXSE62: '長周期',
  '551': '地震情報',
  '552': '津波情報',
  '556': 'EEW',
  '9611': 'P検知',
}

const KIND_LABEL: Record<string, string> = {
  eew: 'EEW',
  quake: '地震',
  tsunami: '津波',
  lpgm: '長周期',
  detection: '検知',
}

const STATUS_BADGE: Record<TelegramLogEntry['status'], { label: string; className: string }> = {
  parsed:   { label: '✓', className: 'text-green-400' },
  filtered: { label: '⊘', className: 'text-secondary' },
  error:    { label: '✗', className: 'text-red-400' },
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

type SourceFilter = 'all' | 'dmdss' | 'p2pquake'
type KindFilter = 'all' | 'eew' | 'quake' | 'tsunami' | 'lpgm' | 'detection' | 'filtered' | 'error'

interface Props {
  telegramLog: TelegramLogEntry[]
  onClear: () => void
}

export function TelegramTab({ telegramLog, onClear }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [copied, setCopied] = useState<string | null>(null)

  const filtered = telegramLog.filter(entry => {
    if (sourceFilter !== 'all' && entry.source !== sourceFilter) return false
    if (kindFilter === 'all') return true
    if (kindFilter === 'filtered') return entry.status === 'filtered'
    if (kindFilter === 'error') return entry.status === 'error'
    return entry.kind === kindFilter
  })

  const handleCopy = useCallback((entry: TelegramLogEntry) => {
    const json = JSON.stringify(
      entry.rawHead !== undefined ? { head: entry.rawHead, body: entry.rawBody } : entry.rawBody,
      null,
      2,
    )
    navigator.clipboard.writeText(json).then(() => {
      setCopied(entry.id)
      setTimeout(() => setCopied(id => id === entry.id ? null : id), 1500)
    }).catch(() => {})
  }, [])

  const toggleExpand = useCallback((id: string) => {
    setExpandedId(prev => prev === id ? null : id)
  }, [])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <span className="text-sm font-medium text-white">
          電文ログ
          <span className="ml-2 text-xs text-secondary">({filtered.length} / {telegramLog.length})</span>
        </span>
        <button
          onClick={onClear}
          className="text-xs text-secondary hover:text-white transition-colors px-2 py-1 rounded hover:bg-white/5"
        >
          クリア
        </button>
      </div>

      <div className="flex gap-2 px-4 py-2 border-b border-border flex-shrink-0">
        <select
          value={sourceFilter}
          onChange={e => setSourceFilter(e.target.value as SourceFilter)}
          className="flex-1 text-xs bg-card border border-border rounded px-2 py-1 text-secondary focus:text-white focus:outline-none"
        >
          <option value="all">全ソース</option>
          <option value="dmdss">DMDSS</option>
          <option value="p2pquake">P2PQuake</option>
        </select>
        <select
          value={kindFilter}
          onChange={e => setKindFilter(e.target.value as KindFilter)}
          className="flex-1 text-xs bg-card border border-border rounded px-2 py-1 text-secondary focus:text-white focus:outline-none"
        >
          <option value="all">全種別</option>
          <option value="eew">EEW</option>
          <option value="quake">地震</option>
          <option value="tsunami">津波</option>
          <option value="lpgm">長周期</option>
          <option value="detection">P検知</option>
          <option value="filtered">スキップ</option>
          <option value="error">エラー</option>
        </select>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-secondary">
            {telegramLog.length === 0 ? '電文を待機中...' : 'フィルタ条件に一致なし'}
          </div>
        ) : (
          <ul>
            {filtered.map(entry => {
              const badge = STATUS_BADGE[entry.status]
              const isExpanded = expandedId === entry.id
              const typeLabel = HEAD_TYPE_LABEL[entry.headType] ?? entry.headType
              const kindLabel = entry.kind ? KIND_LABEL[entry.kind] : null
              const sourceLabel = entry.source === 'dmdss' ? 'DM' : 'P2'

              return (
                <li key={entry.id} className="border-b border-border last:border-b-0">
                  <button
                    onClick={() => toggleExpand(entry.id)}
                    className="w-full text-left px-4 py-2 hover:bg-white/5 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-xs font-mono flex-shrink-0 w-3 ${badge.className}`}>{badge.label}</span>
                      <span className="text-xs text-secondary font-mono flex-shrink-0">{formatTime(entry.receivedAt)}</span>
                      <span className="text-xs font-mono bg-white/10 rounded px-1 flex-shrink-0 text-secondary">{sourceLabel}</span>
                      <span className="text-xs font-mono text-white flex-shrink-0">{entry.headType}</span>
                      <span className="text-xs text-secondary truncate">
                        {entry.isTest ? '訓練' : (kindLabel ? `${kindLabel} · ` : '') + typeLabel}
                      </span>
                    </div>
                    {entry.errorMessage && (
                      <div className="text-xs text-red-400 mt-0.5 pl-5 truncate">{entry.errorMessage}</div>
                    )}
                  </button>

                  {isExpanded && (
                    <div className="px-4 pb-3">
                      <div className="flex justify-end mb-1">
                        <button
                          onClick={e => { e.stopPropagation(); handleCopy(entry) }}
                          className="text-xs text-secondary hover:text-white transition-colors px-2 py-0.5 rounded hover:bg-white/5"
                        >
                          {copied === entry.id ? 'コピー済み' : 'コピー'}
                        </button>
                      </div>
                      <pre className="text-xs font-mono text-secondary bg-black/30 rounded p-2 overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
                        {JSON.stringify(
                          entry.rawHead !== undefined ? { head: entry.rawHead, body: entry.rawBody } : entry.rawBody,
                          null,
                          2,
                        )}
                      </pre>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
