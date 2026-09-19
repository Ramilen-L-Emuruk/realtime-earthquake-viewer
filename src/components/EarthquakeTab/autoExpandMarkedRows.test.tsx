// @vitest-environment jsdom
//
// 印の付いた行を自動で開くこと（→ docs/spec/quake-spec.md §8「印の付いた行は自動で開く」）。
//
// **開く対象を決める純関数は `utils/autoExpandMarkedRows` 側で押さえてある。** ここで見るのは
// カードとの配線 —— とくに「カードを畳んでいる間に届いた印」を取りこぼさないこと。あちらは
// 行の木と印を渡せば答えが出るが、**カードが選択されていない間は行の木そのものが空**なので、
// 純関数のテストでは原理的に出ない穴がここにある。
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import { rowMarkKey, type QuakeCardMarks } from '../../utils/quakeUpdateMark'
import type { JMAQuake, EarthquakePoint } from '../../types/earthquake'
import { findIntensityRow } from '../../test-utils/intensityRow'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

const PREF = '石川県'
const AREA = '石川県能登'
const CITY = '輪島市'
const STATION = '輪島市鳳至町'

const POINTS: EarthquakePoint[] = [
  { pref: PREF, addr: PREF, isArea: true, scale: 70 },
  { pref: '', addr: AREA, isArea: true, scale: 70 },
  { pref: '', addr: STATION, isArea: false, scale: 70, area: AREA, city: CITY },
]

const QUAKE: JMAQuake = {
  kind: 'quake',
  id: 'dmdata-quake-20240101160610-1',
  eventId: '20240101160610',
  time: '2024-01-01T07:10:00Z',
  issue: { source: 'テスト', time: '2024-01-01T07:10:00Z', type: '震源・震度情報', correct: 'なし' },
  earthquake: {
    time: '2024-01-01T07:06:00Z',
    hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 16, magnitude: 7.6 },
    maxScale: 70,
    domesticTsunami: '警報等',
  },
  points: POINTS,
  cities: [{ name: CITY, area: AREA, pref: PREF, scale: 70, hasUnreceived: false }],
}

const KEY = quakeEventKey(QUAKE)

/** 観測点の行だけに印が付いた状態（県・区域には付けない —— 縦線は配下から持ち上がる）。 */
const marksOf = (...keys: string[]): ReadonlyMap<string, QuakeCardMarks> => new Map([[KEY, {
  facts: new Map(),
  rows: new Map(keys.map(k => [k, 'raised' as const])),
  markedAt: Date.now(),
}]])

const renderTab = (updateMarks: ReadonlyMap<string, QuakeCardMarks>, selectedId: string | null) => render(
  <EarthquakeTab
    earthquakes={[QUAKE]}
    selectedId={selectedId}
    onSelect={() => {}}
    isLoading={false}
    isLoadingMore={false}
    hasMore={false}
    onLoadMore={() => {}}
    error={null}
    historyLoss={createEmptyTelegramLoss()}
    loadMoreFailed={false}
    fetchThrottled={false}
    lpgmByEventId={new Map()}
    updateMarks={updateMarks}
    activeLpgmEventId={null}
    onToggleLpgm={() => {}}
    estimatedIntensity={null}
    distributionQuakeKey={null}
    onToggleDistribution={() => {}}
    unreceivedQuakeKey={null}
    onToggleUnreceived={() => {}}
    onFocusMap={() => {}}
    speakingTelegramTextSubject={null}
  />,
)

describe('印の付いた行の自動展開（カードとの配線）', () => {
  // 正: 押さずに観測点の行まで見えている（県 → 区域 → 市町村の 3 段が開く）。
  it('印の付いた観測点の行が、一度も押さずに見えている', () => {
    renderTab(marksOf(rowMarkKey.station(STATION)), KEY)
    expect(findIntensityRow(STATION)).toBeDefined()
    // 途中の段も開いている（開いたのは祖先で、観測点そのものではない）。
    expect(findIntensityRow(CITY)).toBeDefined()
  })

  // 対照: 印が無ければ畳んだまま。既定はどの段も閉じている。
  it('印が無ければ開かない', () => {
    renderTab(new Map(), KEY)
    expect(findIntensityRow(STATION)).toBeUndefined()
    expect(findIntensityRow(AREA)).toBeUndefined()
  })

  // 安全弁: **カードを畳んでいる間に届いた印でも、開いたときに効く。**
  //
  // 「この印は見た」の記録を選択とは無関係に進めると、畳んでいる間の再描画で記録だけが進み、
  // あとでカードを開いても印の参照は変わっていないので**一度も自動で開かない**。
  // 単一選択なので「別のカードを見ている間に続報が届く」という、いちばん効いてほしい場面。
  it('畳んでいる間に届いた印でも、カードを開けば展開される', () => {
    const marks = marksOf(rowMarkKey.station(STATION))
    const { rerender } = renderTab(marks, 'ほかの地震')
    // 畳んでいる間は行そのものが無い。
    expect(findIntensityRow(STATION)).toBeUndefined()

    // **印は同じ参照のまま**カードだけを開く（新しい報は届いていない）。
    rerender(
      <EarthquakeTab
        earthquakes={[QUAKE]}
        selectedId={KEY}
        onSelect={() => {}}
        isLoading={false}
        isLoadingMore={false}
        hasMore={false}
        onLoadMore={() => {}}
        error={null}
        historyLoss={createEmptyTelegramLoss()}
        loadMoreFailed={false}
        fetchThrottled={false}
        lpgmByEventId={new Map()}
        updateMarks={marks}
        activeLpgmEventId={null}
        onToggleLpgm={() => {}}
        estimatedIntensity={null}
        distributionQuakeKey={null}
        onToggleDistribution={() => {}}
        unreceivedQuakeKey={null}
        onToggleUnreceived={() => {}}
        onFocusMap={() => {}}
        speakingTelegramTextSubject={null}
      />,
    )
    expect(findIntensityRow(STATION)).toBeDefined()
  })
})
