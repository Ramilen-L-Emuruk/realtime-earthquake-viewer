import type { JMAQuake } from '../../types/earthquake'
import { EarthquakeCard } from './EarthquakeCard'

interface Props {
  earthquakes: JMAQuake[]
  selectedId: string | null
  onSelect: (id: string) => void
  isLoading: boolean
  isLoadingMore: boolean
  hasMore: boolean
  onLoadMore: () => void
  error: string | null
}

// 地震情報タブの右パネル。地震カードの一覧を表示し、クリックで地図表示対象を選択する。
// 地図そのものは App が常時表示する。
export function EarthquakeTab({ earthquakes, selectedId, onSelect, isLoading, isLoadingMore, hasMore, onLoadMore, error }: Props) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-secondary text-sm">データを取得中...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <div className="text-center">
          <p className="text-red-400 text-sm mb-2">データの取得に失敗しました</p>
          <p className="text-secondary text-xs">{error}</p>
        </div>
      </div>
    )
  }

  if (earthquakes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-secondary text-sm">地震情報はありません</p>
      </div>
    )
  }

  return (
    <div className="p-3 space-y-2">
      {earthquakes.map((quake, i) => (
        <EarthquakeCard
          key={quake.id}
          quake={quake}
          isLatest={i === 0}
          isSelected={quake.id === selectedId}
          onSelect={() => onSelect(quake.id)}
        />
      ))}
      {hasMore && (
        <button
          onClick={onLoadMore}
          disabled={isLoadingMore}
          className="w-full py-2.5 text-sm text-secondary hover:text-white bg-card border border-border hover:border-blue-600 rounded-lg transition-colors disabled:opacity-50"
        >
          {isLoadingMore ? '取得中…' : 'もっと見る'}
        </button>
      )}
      {!hasMore && earthquakes.length > 0 && (
        <p className="text-center text-xs text-secondary py-2">すべての履歴を表示しています</p>
      )}
    </div>
  )
}
