import { memo } from 'react'
import type { JMAQuake, JMALpgm, JMAEstimatedIntensity } from '../../types/earthquake'
import { EarthquakeCard } from './EarthquakeCard'
import { extractQuakeEventId, quakeEventKey } from '../../utils/quakeMerge'
import type { LatLng } from '../../utils/stationCoords'

interface Props {
  earthquakes: JMAQuake[]
  selectedId: string | null
  onSelect: (id: string) => void
  isLoading: boolean
  isLoadingMore: boolean
  hasMore: boolean
  onLoadMore: () => void
  error: string | null
  lpgmByEventId: ReadonlyMap<string, JMALpgm>
  activeLpgmEventId: string | null
  onToggleLpgm: (eventId: string) => void
  /** アプリが持っている最新の推計震度分布図（IXAC41）。どのカードのものかはカード側で引き当てる。 */
  estimatedIntensity: JMAEstimatedIntensity | null
  /** 震度分布モードを開いている地震の `eventKey`。 */
  distributionQuakeKey: string | null
  onToggleDistribution: (eventKey: string) => void
  /** 未入電の一覧を開いている地震の `eventKey`。 */
  unreceivedQuakeKey: string | null
  onToggleUnreceived: (eventKey: string) => void
  /** 観測点の行をクリックしたときに、その地点へ地図を寄せる。 */
  onPointFocus: (position: LatLng) => void
}

// 地震情報タブの右パネル。地震カードの一覧を表示し、クリックで地図表示対象を選択する。
// 地図そのものは App が常時表示する。
// React.memo 化の理由と props 参照安定性の要件は docs/spec/architecture-spec.md 参照。
export const EarthquakeTab = memo(function EarthquakeTab({ earthquakes, selectedId, onSelect, isLoading, isLoadingMore, hasMore, onLoadMore, error, lpgmByEventId, activeLpgmEventId, onToggleLpgm, estimatedIntensity, distributionQuakeKey, onToggleDistribution, unreceivedQuakeKey, onToggleUnreceived, onPointFocus }: Props) {
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
    <div className="p-2 space-y-1.5 roomy:p-3 roomy:space-y-2">
      {earthquakes.map((quake, i) => (
        <EarthquakeCard
          // QUAKE-4: 続報で id 末尾の serial が変わるたびに EarthquakeCard がリマウントされ、
          // isSelected の副作用（強制スクロール）が発火してユーザー操作を妨害する。
          // eventKey は続報でも変わらないため、React の key・選択判定の両方をこれで安定させる
          // （どちらも quakeEventKey に統一。earthquake.time は同じ分に起きた別の地震と衝突する）。
          key={quakeEventKey(quake)}
          quake={quake}
          isLatest={i === 0}
          isSelected={quakeEventKey(quake) === selectedId}
          onSelect={() => onSelect(quakeEventKey(quake))}
          lpgm={lpgmByEventId.get(extractQuakeEventId(quake) ?? '')}
          activeLpgmEventId={activeLpgmEventId}
          onToggleLpgm={onToggleLpgm}
          estimatedIntensity={estimatedIntensity}
          distributionActive={quakeEventKey(quake) === distributionQuakeKey}
          onToggleDistribution={() => onToggleDistribution(quakeEventKey(quake))}
          unreceivedActive={quakeEventKey(quake) === unreceivedQuakeKey}
          onToggleUnreceived={() => onToggleUnreceived(quakeEventKey(quake))}
          onPointFocus={onPointFocus}
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
})
