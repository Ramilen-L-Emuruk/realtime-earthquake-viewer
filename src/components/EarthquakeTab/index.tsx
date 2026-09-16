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
  /** 一覧の行をクリックしたときに、その場所へ地図を寄せる（1 点でも範囲でも）。 */
  onFocusMap: (positions: LatLng[]) => void
  /**
   * いま気象庁が書いた文を読み上げている主題（読んでいなければ null）。
   * 長周期の補足を読み上げているあいだ、そのカードの補足を開く。
   *
   * **任意にしない。** 渡し忘れても画面が動かないだけで例外もログも出ないので、
   * 型検査で止める唯一の機会がここ（→ audio-tts-spec.md §6）。
   */
  speakingTelegramTextSubject: string | null
}

// 地震情報タブの右パネル。地震カードの一覧を表示し、クリックで地図表示対象を選択する。
// 地図そのものは App が常時表示する。
// React.memo 化の理由と props 参照安定性の要件は docs/spec/architecture-spec.md 参照。
export const EarthquakeTab = memo(function EarthquakeTab({ earthquakes, selectedId, onSelect, isLoading, isLoadingMore, hasMore, onLoadMore, error, lpgmByEventId, activeLpgmEventId, onToggleLpgm, estimatedIntensity, distributionQuakeKey, onToggleDistribution, unreceivedQuakeKey, onToggleUnreceived, onFocusMap, speakingTelegramTextSubject }: Props) {
  // **1 件も無いときだけ読み込み中の画面にする。**
  // DMDSS 版の初回は電文本体の取得が配信元の上限に合わせて直列化されるため、全件が揃うのは
  // 数分後になる（→ `docs/spec/data-sources-spec.md` §2「取得の間隔を空ける」）。取得側は
  // 取れた分から順に流しているので、`isLoading` だけで覆うと**その間ずっとスピナーのままになり、
  // 逐次に出す仕組みが画面へ一度も現れない**。
  if (isLoading && earthquakes.length === 0) {
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
          onFocusMap={onFocusMap}
          speakingTelegramTextSubject={speakingTelegramTextSubject}
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
        // 「すべての履歴」とは書かない。**止まる理由はバリアントで違う**（`useEarthquakes` の
        // `hasMore` の決め方 2 箇所）。DMDSS 版は遡れる日数の上限に達したときで、それより古い
        // 地震が無いことを意味しない（アーカイブは実測で 135 日以上残る）。標準版は配信元の
        // 応答が要求件数を下回ったとき＝その窓を使い切ったとき。
        // どちらも「これ以上は遡れない」ことは共通なので、文言は 1 つで足りる。
        <p className="text-center text-xs text-secondary py-2">これ以上は遡れません</p>
      )}
    </div>
  )
})
