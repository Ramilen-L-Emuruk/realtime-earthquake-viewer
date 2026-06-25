import { useState, useCallback } from 'react'
import { zipSync } from 'fflate'
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

function buildDownloadPayload(entry: TelegramLogEntry): unknown {
  return entry.rawHead !== undefined ? { head: entry.rawHead, body: entry.rawBody } : entry.rawBody
}

function triggerDownload(json: string, filename: string) {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const filtered = telegramLog.filter(entry => {
    if (sourceFilter !== 'all' && entry.source !== sourceFilter) return false
    if (kindFilter === 'all') return true
    if (kindFilter === 'filtered') return entry.status === 'filtered'
    if (kindFilter === 'error') return entry.status === 'error'
    return entry.kind === kindFilter
  })

  const allFilteredSelected = filtered.length > 0 && filtered.every(e => selectedIds.has(e.id))

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      const allIds = filtered.map(e => e.id)
      const allSelected = allIds.every(id => prev.has(id))
      if (allSelected) {
        const next = new Set(prev)
        allIds.forEach(id => next.delete(id))
        return next
      }
      const next = new Set(prev)
      allIds.forEach(id => next.add(id))
      return next
    })
  }, [filtered])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const handleCopy = useCallback((entry: TelegramLogEntry) => {
    const json = JSON.stringify(buildDownloadPayload(entry), null, 2)
    navigator.clipboard.writeText(json).then(() => {
      setCopied(entry.id)
      setTimeout(() => setCopied(id => id === entry.id ? null : id), 1500)
    }).catch(() => {})
  }, [])

  const handleDownload = useCallback((entry: TelegramLogEntry) => {
    const json = JSON.stringify(buildDownloadPayload(entry), null, 2)
    const ts = entry.receivedAt.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
    const source = entry.source === 'dmdss' ? 'DMDSS' : 'P2PQuake'
    triggerDownload(json, `${source}_${entry.headType}_${ts}.json`)
  }, [])

  const handleDownloadSelected = useCallback(() => {
    const entries = telegramLog.filter(e => selectedIds.has(e.id))
    if (entries.length === 0) return
    const payload = entries.map(e => ({
      source: e.source,
      headType: e.headType,
      receivedAt: e.receivedAt.toISOString(),
      ...(e.rawHead !== undefined ? { head: e.rawHead, body: e.rawBody } : { body: e.rawBody }),
    }))
    const json = JSON.stringify(payload, null, 2)
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
    triggerDownload(json, `telegrams_${entries.length}件_${ts}.json`)
  }, [telegramLog, selectedIds])

  const handleDownloadZip = useCallback(() => {
    const entries = telegramLog.filter(e => selectedIds.has(e.id))
    if (entries.length === 0) return
    const enc = new TextEncoder()
    const files: Record<string, Uint8Array> = {}
    const usedNames = new Map<string, number>()
    for (const e of entries) {
      const json = JSON.stringify(buildDownloadPayload(e), null, 2)
      const source = e.source === 'dmdss' ? 'DMDSS' : 'P2PQuake'
      const ts = e.receivedAt.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
      const base = `${source}_${e.headType}_${ts}.json`
      const count = usedNames.get(base) ?? 0
      usedNames.set(base, count + 1)
      const filename = count === 0 ? base : `${base.replace('.json', '')}_${count + 1}.json`
      files[filename] = enc.encode(json)
    }
    const zipped = zipSync(files)
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
    const blob = new Blob([zipped], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `telegrams_${entries.length}件_${ts}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }, [telegramLog, selectedIds])

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

      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0 bg-white/5">
          <span className="text-xs text-white">{selectedIds.size}件選択中</span>
          <div className="flex gap-1">
            <button
              onClick={handleDownloadSelected}
              className="text-xs text-white bg-white/15 hover:bg-white/25 transition-colors px-3 py-1 rounded"
            >
              JSON
            </button>
            <button
              onClick={handleDownloadZip}
              className="text-xs text-white bg-white/15 hover:bg-white/25 transition-colors px-3 py-1 rounded"
            >
              ZIP
            </button>
            <button
              onClick={clearSelection}
              className="text-xs text-secondary hover:text-white transition-colors px-2 py-1 rounded hover:bg-white/5"
            >
              選択解除
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-secondary">
            {telegramLog.length === 0 ? '電文を待機中...' : 'フィルタ条件に一致なし'}
          </div>
        ) : (
          <>
            <div className="flex items-center px-4 py-1.5 border-b border-border bg-black/20">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={toggleSelectAll}
                  className="accent-white w-3 h-3"
                />
                <span className="text-xs text-secondary">全選択</span>
              </label>
            </div>
            <ul>
              {filtered.map(entry => {
                const badge = STATUS_BADGE[entry.status]
                const isExpanded = expandedId === entry.id
                const isSelected = selectedIds.has(entry.id)
                const typeLabel = HEAD_TYPE_LABEL[entry.headType] ?? entry.headType
                const kindLabel = entry.kind ? KIND_LABEL[entry.kind] : null
                const sourceLabel = entry.source === 'dmdss' ? 'DM' : 'P2'

                return (
                  <li key={entry.id} className={`border-b border-border last:border-b-0 ${isSelected ? 'bg-white/5' : ''}`}>
                    <div className="flex items-start">
                      <label
                        className="flex items-center px-3 py-3 cursor-pointer flex-shrink-0"
                        onClick={e => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(entry.id)}
                          className="accent-white w-3 h-3"
                        />
                      </label>
                      <div className="flex-1 min-w-0">
                        <button
                          onClick={() => toggleExpand(entry.id)}
                          className="w-full text-left px-2 py-2 hover:bg-white/5 transition-colors"
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
                          <div className="px-2 pb-3">
                            <div className="flex justify-end gap-1 mb-1">
                              <button
                                onClick={e => { e.stopPropagation(); handleDownload(entry) }}
                                className="text-xs text-secondary hover:text-white transition-colors px-2 py-0.5 rounded hover:bg-white/5"
                              >
                                ダウンロード
                              </button>
                              <button
                                onClick={e => { e.stopPropagation(); handleCopy(entry) }}
                                className="text-xs text-secondary hover:text-white transition-colors px-2 py-0.5 rounded hover:bg-white/5"
                              >
                                {copied === entry.id ? 'コピー済み' : 'コピー'}
                              </button>
                            </div>
                            <pre className="text-xs font-mono text-secondary bg-black/30 rounded p-2 overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
                              {JSON.stringify(buildDownloadPayload(entry), null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
