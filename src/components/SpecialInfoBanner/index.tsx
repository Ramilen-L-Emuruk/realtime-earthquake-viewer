import { useState } from 'react'
import type { JMANankai, JMAKohatsu } from '../../types/earthquake'

interface Props {
  nankai: JMANankai | null
  kohatsu: JMAKohatsu | null
}

function NankaiIcon() {
  return (
    <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    </svg>
  )
}

function KohatsuIcon() {
  return (
    <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function nankaiColors(kindName: string): { bg: string; border: string; badge: string } {
  if (kindName === '巨大地震警戒') return { bg: 'bg-red-900/95',    border: 'border-red-500',    badge: 'bg-red-500' }
  if (kindName === '巨大地震注意') return { bg: 'bg-orange-900/95', border: 'border-orange-400', badge: 'bg-orange-400' }
  return                                  { bg: 'bg-yellow-900/95', border: 'border-yellow-400', badge: 'bg-yellow-400' }
}

function formatExpire(isoTime: string): string {
  const d = new Date(isoTime)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mn = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mn}まで有効`
}

export function SpecialInfoBanner({ nankai, kohatsu }: Props) {
  if (!nankai && !kohatsu) return null

  return (
    <div className="absolute bottom-0 left-0 right-0 z-[1000] pointer-events-none">
      <div className="pointer-events-auto max-h-[40vh] overflow-y-auto">
        {nankai && <NankaiBanner nankai={nankai} />}
        {kohatsu && <KohatsuBanner kohatsu={kohatsu} />}
      </div>
    </div>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none" viewBox="0 0 24 24" stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  )
}

function NankaiBanner({ nankai }: { nankai: JMANankai }) {
  const [open, setOpen] = useState(false)
  const { bg, border, badge } = nankaiColors(nankai.kindName)

  return (
    <div className={`${bg} border-t-2 ${border}`}>
      <button
        className="w-full px-3 py-2 flex items-center gap-2 text-left"
        onClick={() => setOpen(v => !v)}
      >
        <NankaiIcon />
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-bold text-white px-1.5 py-0.5 rounded ${badge}`}>
            {nankai.kindName}
          </span>
          <span className="text-white text-sm font-bold leading-tight truncate">{nankai.headline}</span>
        </div>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div className="px-3 pb-2">
          {nankai.body && (
            <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mb-1">{nankai.body}</p>
          )}
          <p className="text-white/60 text-xs">
            発表: {new Date(nankai.reportDateTime).toLocaleString('ja-JP')}
          </p>
        </div>
      )}
    </div>
  )
}

function KohatsuBanner({ kohatsu }: { kohatsu: JMAKohatsu }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="bg-blue-900/95 border-t-2 border-blue-400">
      <button
        className="w-full px-3 py-2 flex items-center gap-2 text-left"
        onClick={() => setOpen(v => !v)}
      >
        <KohatsuIcon />
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-white px-1.5 py-0.5 rounded bg-blue-500 flex-shrink-0">
            後発地震注意
          </span>
          <span className="text-white text-sm font-bold leading-tight truncate">{kohatsu.headline}</span>
        </div>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div className="px-3 pb-2">
          {kohatsu.body && (
            <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mb-1">{kohatsu.body}</p>
          )}
          <p className="text-white/60 text-xs">
            発表: {new Date(kohatsu.reportDateTime).toLocaleString('ja-JP')}
            {' · '}{formatExpire(kohatsu.expireAt)}
          </p>
        </div>
      )}
    </div>
  )
}
