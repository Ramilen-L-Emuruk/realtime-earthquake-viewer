import type { ReplaySession, ReplaySpeed } from '../../types/replay'
import { REPLAY_SPEEDS } from '../../types/replay'

interface Props {
  session: ReplaySession
  currentTime: Date
  isPlaying: boolean
  speed: ReplaySpeed
  onPlay: () => void
  onPause: () => void
  onSeek: (time: Date) => void
  onSetSpeed: (speed: ReplaySpeed) => void
  onReset: () => void
}

function fmt(date: Date): string {
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtDate(date: Date): string {
  return date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' })
}

export function PlayerControls({
  session, currentTime, isPlaying, speed,
  onPlay, onPause, onSeek, onSetSpeed, onReset,
}: Props) {
  const total = session.endTime.getTime() - session.startTime.getTime()
  const elapsed = currentTime.getTime() - session.startTime.getTime()
  const progress = total > 0 ? elapsed / total : 0

  const handleSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const ratio = Number(e.target.value) / 1000
    const t = new Date(session.startTime.getTime() + ratio * total)
    onSeek(t)
  }

  return (
    <div className="bg-card border border-border rounded-lg p-3 space-y-3">
      {/* イベントマーカー付きスライダー */}
      <div className="space-y-1">
        <div className="relative">
          {/* イベントマーカー */}
          {session.events.map((ev, i) => {
            const ratio = total > 0
              ? (ev.time.getTime() - session.startTime.getTime()) / total
              : 0
            const color =
              ev.type === 'eew' ? '#ef4444' :
              ev.type === 'tsunami' ? '#3b82f6' : '#f59e0b'
            return (
              <div
                key={i}
                className="absolute top-0 -translate-x-1/2 w-0.5 h-2 rounded"
                style={{ left: `${ratio * 100}%`, backgroundColor: color }}
                title={`${ev.type}: ${fmt(ev.time)}`}
              />
            )
          })}
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(progress * 1000)}
            onChange={handleSlider}
            className="w-full mt-2 accent-blue-400 cursor-pointer"
          />
        </div>
        <div className="flex justify-between text-xs text-secondary">
          <span>{fmtDate(session.startTime)} {fmt(session.startTime)}</span>
          <span className="text-white font-mono">{fmt(currentTime)}</span>
          <span>{fmt(session.endTime)}</span>
        </div>
      </div>

      {/* イベント凡例 */}
      <div className="flex gap-3 text-xs text-secondary">
        <span><span className="inline-block w-2 h-2 rounded-sm bg-red-500 mr-1" />EEW</span>
        <span><span className="inline-block w-2 h-2 rounded-sm bg-yellow-500 mr-1" />地震</span>
        <span><span className="inline-block w-2 h-2 rounded-sm bg-blue-500 mr-1" />津波</span>
      </div>

      {/* 再生コントロール */}
      <div className="flex items-center gap-2">
        {/* リセット */}
        <button
          onClick={onReset}
          title="最初から"
          className="w-8 h-8 flex items-center justify-center text-secondary hover:text-white rounded"
        >
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2}>
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 .49-3.51" />
          </svg>
        </button>

        {/* 再生 / 一時停止 */}
        <button
          onClick={isPlaying ? onPause : onPlay}
          className="w-10 h-10 flex items-center justify-center bg-blue-600 hover:bg-blue-500 rounded-full text-white flex-shrink-0"
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          )}
        </button>

        {/* 再生速度 */}
        <div className="flex gap-1 flex-wrap">
          {REPLAY_SPEEDS.map(s => (
            <button
              key={s}
              onClick={() => onSetSpeed(s)}
              className={`px-2 py-1 text-xs rounded font-mono transition-colors ${
                speed === s
                  ? 'bg-blue-600 text-white'
                  : 'bg-panel text-secondary hover:text-white'
              }`}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
