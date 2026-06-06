import { useState, useEffect } from 'react'
import type { JMAQuake } from '../../types/earthquake'
import type { ReplaySpeed } from '../../types/replay'
import type { ReplayState } from '../../hooks/useReplay'
import { fetchEarthquakeList, buildReplaySession } from '../../services/replayData'
import { EventSelector } from './EventSelector'
import { PlayerControls } from './PlayerControls'
import { EarthquakeCard } from '../EarthquakeTab/EarthquakeCard'

interface Props {
  replay: ReplayState & {
    loadSession: (s: import('../../types/replay').ReplaySession) => void
    play: () => void
    pause: () => void
    seek: (t: Date) => void
    setSpeed: (s: ReplaySpeed) => void
    reset: () => void
    backToSelect: () => void
  }
}

export function ReplayTab({ replay }: Props) {
  const [earthquakes, setEarthquakes] = useState<JMAQuake[]>([])
  const [isListLoading, setIsListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedQuakeId, setSelectedQuakeId] = useState<string | null>(null)
  const [isSessionLoading, setIsSessionLoading] = useState(false)

  useEffect(() => {
    fetchEarthquakeList(50)
      .then(list => {
        setEarthquakes(list)
        setIsListLoading(false)
      })
      .catch((err: unknown) => {
        setListError(err instanceof Error ? err.message : '取得失敗')
        setIsListLoading(false)
      })
  }, [])

  const handleSelectQuake = async (quake: JMAQuake) => {
    setSelectedQuakeId(quake.id)
    setIsSessionLoading(true)
    try {
      const session = await buildReplaySession(quake)
      replay.loadSession(session)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'セッション構築失敗')
    } finally {
      setIsSessionLoading(false)
    }
  }

  if (replay.view === 'player' && replay.session && replay.currentTime) {
    const { session, currentTime, status, speed, activeQuake, activeEEW, activeTsunamis } = replay

    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 p-3 border-b border-border">
          <button
            onClick={replay.backToSelect}
            className="text-secondary hover:text-white text-xs flex items-center gap-1"
          >
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2}>
              <polyline points="15 18 9 12 15 6" />
            </svg>
            イベント選択
          </button>
          <span className="text-xs text-secondary truncate">
            {session.quake.earthquake.hypocenter.name}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <PlayerControls
            session={session}
            currentTime={currentTime}
            isPlaying={status === 'playing'}
            speed={speed}
            onPlay={replay.play}
            onPause={replay.pause}
            onSeek={replay.seek}
            onSetSpeed={replay.setSpeed}
            onReset={replay.reset}
          />

          <div className="space-y-2">
            {activeEEW && (
              <div className="bg-red-950/60 border border-red-700 rounded-lg p-3 text-sm">
                <div className="text-red-400 font-bold text-xs mb-1">緊急地震速報</div>
                <div className="text-white font-medium">{activeEEW.earthquake.hypocenter.name}</div>
                <div className="text-secondary text-xs">
                  M{activeEEW.earthquake.hypocenter.magnitude.toFixed(1)}
                  {activeEEW.issue?.serial && ` 第${activeEEW.issue.serial}報`}
                </div>
              </div>
            )}

            {activeQuake && (
              <EarthquakeCard quake={activeQuake} />
            )}

            {activeTsunamis.map(t => (
              <div key={t.id} className="bg-blue-950/60 border border-blue-700 rounded-lg p-3 text-sm">
                <div className="text-blue-400 font-bold text-xs mb-1">津波情報</div>
                {t.areas.slice(0, 3).map((a, i) => (
                  <div key={i} className="text-white text-xs">{a.name} — {a.grade}</div>
                ))}
              </div>
            ))}

            {!activeEEW && !activeQuake && activeTsunamis.length === 0 && (
              <div className="text-center text-secondary text-sm py-4">
                ▶ 再生を開始すると情報が表示されます
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-border">
        <h2 className="text-sm font-bold text-white">イベント再生</h2>
        <p className="text-xs text-secondary mt-0.5">過去の地震イベントを時系列で再生します</p>
      </div>
      {isSessionLoading ? (
        <div className="flex items-center justify-center flex-1 text-secondary text-sm">
          データ取得中…
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <EventSelector
            earthquakes={earthquakes}
            selectedId={selectedQuakeId}
            isLoading={isListLoading}
            error={listError}
            onSelect={handleSelectQuake}
          />
        </div>
      )}
    </div>
  )
}
