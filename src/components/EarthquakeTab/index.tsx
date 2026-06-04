import type { JMAQuake } from '../../types/earthquake'
import { EarthquakeCard } from './EarthquakeCard'
import { JapanMap } from '../Map/JapanMap'

interface Props {
  earthquakes: JMAQuake[]
  isLoading: boolean
  error: string | null
}

export function EarthquakeTab({ earthquakes, isLoading, error }: Props) {
  const latest = earthquakes[0] ?? null

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-secondary text-sm">データを取得中...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-red-400 text-sm mb-2">データの取得に失敗しました</p>
          <p className="text-secondary text-xs">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
      {/* Map section */}
      <div className="h-56 lg:h-auto lg:w-1/2 flex-shrink-0">
        <JapanMap quake={latest} />
      </div>

      {/* Earthquake list */}
      <div className="flex-1 overflow-y-auto">
        {earthquakes.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-secondary text-sm">地震情報はありません</p>
          </div>
        ) : (
          <div className="p-3 space-y-2">
            {earthquakes.map((quake, i) => (
              <EarthquakeCard key={quake.id} quake={quake} isLatest={i === 0} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
