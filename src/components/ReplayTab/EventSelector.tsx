import type { JMAQuake } from '../../types/earthquake'
import { EarthquakeCard } from '../EarthquakeTab/EarthquakeCard'

interface Props {
  earthquakes: JMAQuake[]
  selectedId: string | null
  isLoading: boolean
  error: string | null
  onSelect: (quake: JMAQuake) => void
}

export function EventSelector({ earthquakes, selectedId, isLoading, error, onSelect }: Props) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32 text-secondary text-sm">
        読み込み中…
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex items-center justify-center h-32 text-red-400 text-sm px-4 text-center">
        {error}
      </div>
    )
  }
  if (earthquakes.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-secondary text-sm">
        地震データなし
      </div>
    )
  }

  return (
    <div className="space-y-2 p-3">
      <p className="text-xs text-secondary">再生するイベントを選択してください</p>
      {earthquakes.map((q, i) => (
        <EarthquakeCard
          key={q.id}
          quake={q}
          isLatest={i === 0}
          isSelected={q.id === selectedId}
          onSelect={() => onSelect(q)}
        />
      ))}
    </div>
  )
}
