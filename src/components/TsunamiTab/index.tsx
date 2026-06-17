import type { JMATsunami, TsunamiArea, TsunamiObservation } from '../../types/earthquake'
import { formatTsunamiGrade, formatDateTime, formatTime } from '../../utils/formatters'

interface Props {
  tsunamis: JMATsunami[]
}

function TsunamiAreaRow({ area }: { area: TsunamiArea }) {
  const gradeInfo = formatTsunamiGrade(area.grade)
  return (
    <div className="flex items-center gap-3 py-2 border-b border-border last:border-0">
      <span
        className="flex-shrink-0 text-xs font-bold px-2 py-1 rounded"
        style={{ backgroundColor: gradeInfo.bg, color: gradeInfo.color }}
      >
        {gradeInfo.text}
      </span>
      <div className="flex-1 min-w-0">
        <span className="text-white text-sm font-medium">{area.name}</span>
        {area.firstHeight && (
          <div className="text-xs text-secondary mt-0.5">
            {area.firstHeight.arrivalTime
              ? `到達予想: ${area.firstHeight.arrivalTime}`
              : area.firstHeight.condition}
          </div>
        )}
      </div>
      {area.maxHeight && (
        <span className="text-xs text-secondary flex-shrink-0">
          {area.maxHeight.description}
        </span>
      )}
      {area.immediate && (
        <span className="text-xs text-red-400 font-bold flex-shrink-0 animate-pulse">
          到達中
        </span>
      )}
    </div>
  )
}

function TsunamiObservationRow({ obs }: { obs: TsunamiObservation }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-border last:border-0">
      <div className="flex-1 min-w-0">
        <span className="text-white text-sm font-medium">{obs.name}</span>
        {obs.arrivalTime && (
          <div className="text-xs text-secondary mt-0.5">
            到達: {formatTime(obs.arrivalTime).slice(0, 5)}{obs.initial ? `（${obs.initial}）` : ''}
          </div>
        )}
      </div>
      {obs.height && (
        <span className="text-xs text-secondary flex-shrink-0">{obs.height.description}</span>
      )}
    </div>
  )
}

function TsunamiCard({ tsunami }: { tsunami: JMATsunami }) {
  const majorWarnings = tsunami.areas.filter(a => a.grade === 'MajorWarning')
  const warnings = tsunami.areas.filter(a => a.grade === 'Warning')
  const watches = tsunami.areas.filter(a => a.grade === 'Watch')

  return (
    <div className="bg-card rounded-lg border border-border overflow-hidden mb-3">
      <div className="px-3 py-2 bg-panel flex items-center justify-between">
        <span className="text-white font-bold text-sm">津波情報</span>
        <span className="text-secondary text-xs">{formatDateTime(tsunami.time)}</span>
      </div>

      <div className="divide-y divide-border">
        {majorWarnings.length > 0 && (
          <div className="px-3 py-2">
            <p className="text-xs font-bold text-purple-400 mb-1">大津波警報</p>
            {majorWarnings.map((area, i) => (
              <TsunamiAreaRow key={`major-${i}`} area={area} />
            ))}
          </div>
        )}
        {warnings.length > 0 && (
          <div className="px-3 py-2">
            <p className="text-xs font-bold text-red-400 mb-1">津波警報</p>
            {warnings.map((area, i) => (
              <TsunamiAreaRow key={`warn-${i}`} area={area} />
            ))}
          </div>
        )}
        {watches.length > 0 && (
          <div className="px-3 py-2">
            <p className="text-xs font-bold text-orange-400 mb-1">津波注意報</p>
            {watches.map((area, i) => (
              <TsunamiAreaRow key={`watch-${i}`} area={area} />
            ))}
          </div>
        )}
        {tsunami.observations && tsunami.observations.length > 0 && (
          <div className="px-3 py-2">
            <p className="text-xs font-bold text-blue-400 mb-1">沖合観測</p>
            {tsunami.observations.map((obs, i) => (
              <TsunamiObservationRow key={`obs-${i}`} obs={obs} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function TsunamiTab({ tsunamis }: Props) {
  const active = tsunamis.filter(t => !t.cancelled)

  if (active.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-4">
        <div className="w-16 h-16 rounded-full bg-green-900 flex items-center justify-center">
          <span className="text-3xl">🌊</span>
        </div>
        <div className="text-center">
          <p className="text-green-400 font-bold">津波情報はありません</p>
          <p className="text-secondary text-sm mt-1">現在、津波警報・注意報は発表されていません。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-3">
      <div className="mb-3 p-3 bg-red-900/50 rounded-lg border border-red-700">
        <p className="text-red-300 font-bold text-sm">
          ⚠️ 津波情報発令中
        </p>
        <p className="text-red-400 text-xs mt-1">
          海岸や河川から直ちに離れてください。
        </p>
      </div>

      {active.map(t => (
        <TsunamiCard key={t.id} tsunami={t} />
      ))}
    </div>
  )
}
