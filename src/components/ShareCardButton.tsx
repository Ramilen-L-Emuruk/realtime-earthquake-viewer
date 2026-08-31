import type { ShareCardState } from '../hooks/useShareCard'

// 地図を画像にするボタン（地図の右下に重ねる）。処理の中身は useShareCard が持つ。

interface ShareCardButtonProps {
  state: ShareCardState
  onClick: () => void
}

const LABELS: Record<ShareCardState, string> = {
  idle: '地図を画像にして共有',
  working: '画像を作成中',
  error: '画像を作成できませんでした',
  copied: '画像を保存し、本文をコピーしました',
  copyFailed: '画像を保存しました（本文はコピーできませんでした）',
}

/** 状態に応じた枠と文字の色。押せるかどうか（hover・disabled）は状態によらず共通。 */
const TONES: Record<ShareCardState, string> = {
  idle: 'border-slate-600/80 text-slate-200',
  working: 'border-slate-600/80 text-slate-200',
  error: 'border-red-500/70 text-red-300',
  copied: 'border-emerald-500/70 text-emerald-300',
  copyFailed: 'border-amber-500/70 text-amber-300',
}

export function ShareCardButton({ state, onClick }: ShareCardButtonProps) {
  const label = LABELS[state]
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === 'working'}
      aria-label={label}
      title={label}
      className={`flex h-9 w-9 items-center justify-center rounded-md border bg-slate-900/80 backdrop-blur-sm transition-colors hover:bg-slate-800/90 disabled:opacity-60 ${TONES[state]}`}
    >
      <StateIcon state={state} className="h-5 w-5" />
    </button>
  )
}

/** 状態に応じたアイコン。 */
function StateIcon({ state, className }: { state: ShareCardState; className: string }) {
  if (state === 'working') return <SpinnerIcon className={className} />
  // 「作れなかった」と「本文だけ渡せなかった」は同じ印で、深刻さは色で分ける。
  if (state === 'error' || state === 'copyFailed') return <AlertIcon className={className} />
  if (state === 'copied') return <CheckIcon className={className} />
  return <ShareIcon className={className} />
}

function ShareIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="18" cy="5.5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="18.5" r="2.5" />
      <path d="m8.3 10.8 7.4-4M8.3 13.2l7.4 4" strokeLinecap="round" />
    </svg>
  )
}

function CheckIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function AlertIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 8v5" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}

function SpinnerIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`${className} animate-spin`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
    </svg>
  )
}
