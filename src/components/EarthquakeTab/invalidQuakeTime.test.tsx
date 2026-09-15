// @vitest-environment jsdom
//
// 地震カードの発生時刻が、日時として読めない値のときに何を出すか。
//
// `formatQuakeTime` は読めない値で `null` を返す（→ `utils/formatters.ts` の `readDateTime`）。
// **JSX へ素で埋めると `null` は何も描画されず、欄が黙って消える** —— 型検査も通ってしまう。
// ここはカードの主題（いつ起きた地震か）で、空欄にすると隣の種別バッジだけが残り、
// 時刻を読み落としたのか電文に無いのか利用者に分からない。語を出すことを固定する。
//
// **開いた表示と畳んだ表示の 2 か所にある。** 片方だけ直しても型検査は通り、例外も出ない。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake } from '../../types/earthquake'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

const EVENT_ID = '20240101161000'

function makeQuake(earthquakeTime: string): JMAQuake {
  return {
    kind: 'quake',
    id: `dmdata-quake-${EVENT_ID}-1`,
    eventId: EVENT_ID,
    time: '2024-01-01T07:24:00Z',
    issue: { source: 'テスト', time: '2024-01-01T07:24:00Z', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: earthquakeTime,
      hypocenter: { name: '石川県能登地方', latitude: 37.495, longitude: 137.27, depth: 16, magnitude: 7.6 },
      maxScale: 45,
      domesticTsunami: '警報等',
    },
    points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 45 }],
  }
}

const renderTab = (quake: JMAQuake, selected: boolean) => render(
  <EarthquakeTab
    earthquakes={[quake]}
    selectedId={selected ? quakeEventKey(quake) : null}
    onSelect={() => {}}
    isLoading={false}
    isLoadingMore={false}
    hasMore={false}
    onLoadMore={() => {}}
    error={null}
    lpgmByEventId={new Map()}
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

describe('地震カードの発生時刻が読めないとき', () => {
  // 対照: 読める値では従来どおりの表記。ガードが正常な値まで止めていないこと。
  it('読める値では従来どおり「◯月◯日 ◯:◯◯ごろ」を出す', () => {
    renderTab(makeQuake('2024-01-01T07:10:00Z'), true)
    expect(screen.getAllByText(/1月1日 \d{1,2}:\d{2}ごろ/).length).toBeGreaterThan(0)
    expect(screen.queryByText('発生時刻不明')).toBeNull()
  })

  // 正: 開いた表示（選択中のカード）で語を出す。
  it('開いた表示では「発生時刻不明」を出す', () => {
    renderTab(makeQuake('壊れた値'), true)
    expect(screen.getAllByText('発生時刻不明').length).toBeGreaterThan(0)
  })

  // 正: 畳んだ表示にも同じ語を出す。**2 か所あるのがこのテストの要**
  // （片方だけ直しても型検査は通り、例外も出ない）。
  it('畳んだ表示にも同じ語を出す', () => {
    renderTab(makeQuake('壊れた値'), false)
    expect(screen.getAllByText('発生時刻不明').length).toBeGreaterThan(0)
  })

  // 安全弁: `NaN` がそのまま画面へ出ない（これが元の症状）。
  it('NaN を画面に出さない', () => {
    const { container } = renderTab(makeQuake('壊れた値'), true)
    expect(container.textContent).not.toContain('NaN')
  })
})
