// @vitest-environment jsdom
//
// 津波電文から借りた値に付く印（`※`）を、地震カードの該当する欄すべてに出すこと
// （→ docs/spec/quake-spec.md §8「借りた値の出どころ」）。
//
// **借りるのは震源要素と津波区分で、欄としては 5 つにまたがる** —— 震央地名・座標・
// マグニチュード・深さ・津波区分。印を 1 つ落としても型検査は通り、例外も出ない。
// 「どれが津波由来か分からない」という形で静かに崩れるので、5 か所そろっていることを
// ここで固定する。
//
// **説明は 1 行だけ**であることも固定する。欄ごとに「津波情報より」と書くと同じ語が並び、
// 実際に画面がそうなって読みにくかった（震源と津波区分で別々に出していた）。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake, BorrowedFromTsunami } from '../../types/earthquake'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

const EVENT_ID = '20240101161010'

/** 16:12 の津波警報から借りたときの出どころ。 */
const FROM_WARNING: BorrowedFromTsunami = {
  shortLabel: '津波情報',
  infoName: '津波警報・津波注意報・津波予報',
  reportTime: '2024-01-01T07:12:00Z',
}
/** 16:22 の津波情報から借りたときの出どころ（震源だけが続報で更新される形）。 */
const FROM_INFO: BorrowedFromTsunami = {
  shortLabel: '津波情報',
  infoName: '津波情報',
  reportTime: '2024-01-01T07:22:00Z',
}

/**
 * 震度速報のカード。**震源要素は津波から借りた値で埋める**（実電文の震度速報は震源を持たない）。
 * `over` で借り物の印だけを付け外しできる。
 */
function makeQuake(over: Partial<JMAQuake> = {}): JMAQuake {
  return {
    kind: 'quake',
    id: `dmdata-quake-${EVENT_ID}-1`,
    eventId: EVENT_ID,
    time: '2024-01-01T07:13:00Z',
    issue: { source: 'テスト', time: '2024-01-01T07:13:00Z', type: '震度速報', correct: 'なし' },
    earthquake: {
      time: '2024-01-01T07:10:00Z',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 0, magnitude: 7.6 },
      maxScale: 70,
      domesticTsunami: '警報等',
    },
    points: [
      { pref: '石川県', addr: '石川県', isArea: true, scale: 70 },
      { pref: '', addr: '石川県能登', isArea: true, scale: 70 },
    ],
    ...over,
  }
}

const renderTab = (quake: JMAQuake) => render(
  <EarthquakeTab
    earthquakes={[quake]}
    selectedId={quakeEventKey(quake)}
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
    updateMarks={new Map()}
    activeLpgmEventId={null}
    onToggleLpgm={() => {}}
    estimatedIntensity={null}
    distributionQuakeKey={null}
    onToggleDistribution={() => {}}
    unreceivedQuakeKey={null}
    onToggleUnreceived={() => {}}
    onFocusMap={() => {}}
    speakingTelegramTextSubject={null}
  />
)

/** カード内の `※` の総数（説明の行に付く 1 つを含む）。 */
const markCount = () => screen.getAllByText('※').length

describe('地震カードの「津波情報より」の印', () => {
  // 正: 震源と津波区分の両方を借りたら、5 つの欄すべてに印が出る。
  it('借りた欄すべてに印が出る（震央地名・座標・規模・深さ・津波区分）', () => {
    renderTab(makeQuake({ hypocenterSource: FROM_INFO, domesticTsunamiSource: FROM_WARNING }))
    // 5 欄ぶんの印。説明の行の `※` は本文に含まれるので `getAllByText('※')` には入らない。
    expect(markCount()).toBe(5)
  })

  // 正: 説明は 1 行だけ。欄ごとに書くと同じ語が並ぶ。
  it('説明は 1 行だけ出る', () => {
    renderTab(makeQuake({ hypocenterSource: FROM_INFO, domesticTsunamiSource: FROM_WARNING }))
    expect(screen.getAllByText('※ 津波情報より')).toHaveLength(1)
  })

  // 正: 借りた報が違っても説明は割らず、ホバーの説明に両方を出す。
  it('震源と津波区分で借りた報が違っても、説明は 1 行のまま（詳細はホバーへ）', () => {
    renderTab(makeQuake({ hypocenterSource: FROM_INFO, domesticTsunamiSource: FROM_WARNING }))
    const note = screen.getByText('※ 津波情報より')
    expect(note.getAttribute('title')).toContain('震源は16:22に発表された津波情報で伝えられました。')
    expect(note.getAttribute('title')).toContain('津波の有無は16:12に発表された津波警報・津波注意報・津波予報で伝えられました。')
  })

  // 対照: 震源だけを借りたときは、津波区分に印を付けない。
  it('震源だけ借りたら、津波区分には印が付かない', () => {
    renderTab(makeQuake({ hypocenterSource: FROM_INFO }))
    // 震央地名・座標・規模・深さの 4 つ。
    expect(markCount()).toBe(4)
    expect(screen.getByText('※ 津波情報より').getAttribute('title')).not.toContain('津波の有無')
  })

  // 対照: 津波区分だけを借りたときは、震源の欄に印を付けない。
  it('津波区分だけ借りたら、震源の欄には印が付かない', () => {
    renderTab(makeQuake({ domesticTsunamiSource: FROM_WARNING }))
    expect(markCount()).toBe(1)
    expect(screen.getByText('※ 津波情報より').getAttribute('title')).not.toContain('震源は')
  })

  // 安全弁: 借りていないカードには印も説明も出さない。自前の震源にまで印が付くと、
  // 気象庁が地震情報で伝えた値まで「津波由来」に見える。
  it('借りていないカードには印も説明も出ない', () => {
    renderTab(makeQuake())
    expect(screen.queryByText('※')).toBeNull()
    expect(screen.queryByText('※ 津波情報より')).toBeNull()
  })

  // 安全弁: 座標を読めず「震源調査中」へ倒れた借り物には、震央地名の印を付けない。
  // 付けるとその文言自体が津波から来たように読め、借りたはずなのに調査中という矛盾に見える。
  it('座標を読めなかった借り物では、「震源調査中」に印を付けない', () => {
    renderTab(makeQuake({
      hypocenterSource: FROM_INFO,
      earthquake: {
        ...makeQuake().earthquake,
        // 名前はあるが座標は位置不明のセンチネル（津波電文の座標を読めなかった形）。
        hypocenter: { name: '石川県能登地方', latitude: -200, longitude: -200, depth: 0, magnitude: 7.6 },
      },
    }))
    expect(screen.getByText('震源調査中').textContent).toBe('震源調査中')
    // 残るのは規模と深さの 2 つ（座標の行はそもそも出ない）。
    expect(markCount()).toBe(2)
  })

  // 安全弁: 等級を名乗らない（「津波警報より」と書くと大津波警報の地震で一段軽く見える。
  // → docs/spec/quake-spec.md §3）。
  it('画面に出す語は等級を名乗らない', () => {
    renderTab(makeQuake({ hypocenterSource: FROM_WARNING, domesticTsunamiSource: FROM_WARNING }))
    const note = screen.getByText('※ 津波情報より')
    expect(note.textContent).not.toContain('警報')
  })
})
