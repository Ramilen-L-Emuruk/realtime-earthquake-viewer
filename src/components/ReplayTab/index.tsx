import { useState, useEffect } from 'react'
import type { JMAQuake } from '../../types/earthquake'
import type { KnetRecord, ReplaySpeed } from '../../types/replay'
import type { ReplayState } from '../../hooks/useReplay'
import { fetchEarthquakeList, buildReplaySession, buildReplaySessionFromKnet } from '../../services/replayData'
import { EventSelector } from './EventSelector'
import { PlayerControls } from './PlayerControls'
import { WaveformChart } from './WaveformChart'
import { KnetUpload } from './KnetUpload'
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
  const [sessionLoadMsg, setSessionLoadMsg] = useState('')

  useEffect(() => {
    fetchEarthquakeList(50)
      .then(list => { setEarthquakes(list); setIsListLoading(false) })
      .catch((err: unknown) => {
        setListError(err instanceof Error ? err.message : '取得失敗')
        setIsListLoading(false)
      })
  }, [])

  const handleSelectQuake = async (quake: JMAQuake) => {
    setSelectedQuakeId(quake.id)
    setIsSessionLoading(true)
    setSessionLoadMsg('データ取得中…')
    try {
      const session = await buildReplaySession(quake)
      replay.loadSession(session)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'セッション構築失敗')
    } finally {
      setIsSessionLoading(false)
      setSessionLoadMsg('')
    }
  }

  const handleKnetLoad = async (knet: KnetRecord) => {
    setIsSessionLoading(true)
    setSessionLoadMsg('P2PQuake から過去データを検索中… (最大30秒程度かかります)')
    try {
      const session = await buildReplaySessionFromKnet(knet)
      replay.loadSession(session)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'K-NET セッション構築失敗')
    } finally {
      setIsSessionLoading(false)
      setSessionLoadMsg('')
    }
  }

  // ── プレイヤービュー ──────────────────────────────────────────────────────
  if (replay.view === 'player' && replay.session && replay.currentTime) {
    const { session, currentTime, status, speed, activeQuake, activeEEW, activeTsunamis } = replay
    const titleName = session.quake
      ? session.quake.earthquake.hypocenter.name
      : session.knet
        ? `K-NET ${session.knet.stationCode}`
        : '不明'

    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 p-3 border-b border-border">
          <button
            onClick={replay.backToSelect}
            className="text-secondary hover:text-white text-xs flex items-center gap-1 shrink-0"
          >
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2}>
              <polyline points="15 18 9 12 15 6" />
            </svg>
            イベント選択
          </button>
          <span className="text-xs text-secondary truncate">{titleName}</span>
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

            {activeQuake && <EarthquakeCard quake={activeQuake} />}

            {activeTsunamis.map(t => (
              <div key={t.id} className="bg-blue-950/60 border border-blue-700 rounded-lg p-3 text-sm">
                <div className="text-blue-400 font-bold text-xs mb-1">津波情報</div>
                {t.areas.slice(0, 3).map((a, i) => (
                  <div key={i} className="text-white text-xs">{a.name} — {a.grade}</div>
                ))}
              </div>
            ))}

            {!activeEEW && !activeQuake && activeTsunamis.length === 0 && !session.knet && (
              <div className="text-center text-secondary text-sm py-4">
                ▶ 再生を開始すると情報が表示されます
              </div>
            )}
          </div>

          {/* K-NET 波形 */}
          {session.knet && session.knet.channels.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-secondary font-medium border-t border-border pt-2">
                強震波形 — {session.knet.stationCode}
                （{session.knet.stationLat.toFixed(4)}°N, {session.knet.stationLng.toFixed(4)}°E,
                  標高 {session.knet.stationHeightM} m）
              </div>
              {session.knet.channels.map((ch, i) => (
                <WaveformChart key={i} channel={ch} currentTime={currentTime} />
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── 選択ビュー ────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-border shrink-0">
        <h2 className="text-sm font-bold text-white">イベント再生</h2>
        <p className="text-xs text-secondary mt-0.5">過去の地震イベントを時系列で再生します</p>
      </div>

      {isSessionLoading ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 px-4 text-center">
          <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-secondary text-xs">{sessionLoadMsg}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* K-NET ファイルから再生 */}
          <div className="p-3 border-b border-border">
            <p className="text-xs text-secondary mb-2 font-medium">K-NET ファイルから再生</p>
            <KnetUpload onLoad={handleKnetLoad} />
          </div>

          {/* 最近の地震から選択 */}
          <div>
            <p className="text-xs text-secondary font-medium px-3 pt-3 pb-1">最近の地震から選択</p>
            <EventSelector
              earthquakes={earthquakes}
              selectedId={selectedQuakeId}
              isLoading={isListLoading}
              error={listError}
              onSelect={handleSelectQuake}
            />
          </div>
        </div>
      )}
    </div>
  )
}
