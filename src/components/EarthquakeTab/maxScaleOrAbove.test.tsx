// @vitest-environment jsdom
//
// カードの最大震度に付く「以上」（→ docs/spec/quake-spec.md §4「震度5弱以上未入電」）。
//
// **語を本体と同じ大きさで並べると器から溢れる。** 最大震度は値を大きく出す欄なので、
// 「5弱」から「5弱以上」になると桁数が倍になり、開いた表示では横並びのラベルと競って
// 折り返し、畳んだ表示（7rem 角に固定）では収まらない。**語は縮められない**（気象庁の
// 表現をそのまま使う決まり）ので、本体より小さく添えることで受けている。
//
// 震度一覧の行は結合した 1 つの文字列（「震度5弱以上」）のままで、そちらは
// `unreceivedRowMark.test.tsx` が守っている。分けたのは最大震度の欄だけ。
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, within } from '@testing-library/react'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake, EarthquakePoint, IntensityScale } from '../../types/earthquake'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

const AREA = '石川県能登'
const UNRECEIVED_STATION = '羽咋市旭町'
const OBSERVED_STATION = '七尾市能登島向田町'

const station = (over: Partial<EarthquakePoint> = {}): EarthquakePoint => ({
  pref: '', addr: OBSERVED_STATION, isArea: false, scale: 45, area: AREA, ...over,
})

function makeQuake(maxScale: IntensityScale, points: EarthquakePoint[]): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20241126224709-1',
    eventId: '20241126224709',
    time: '2024-11-26T13:51:00Z',
    issue: { source: 'テスト', time: '2024-11-26T13:51:00Z', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2024-11-26T13:47:00Z',
      hypocenter: { name: '石川県西方沖', latitude: 37.1, longitude: 136.5, depth: 10, magnitude: 6.4 },
      maxScale,
      domesticTsunami: 'なし',
    },
    points,
  }
}

/** 最大震度と同じ階級（45）に未入電がある形。「以上」が付く。 */
const WITH_UNRECEIVED_AT_MAX: EarthquakePoint[] = [
  station(),
  station({ addr: UNRECEIVED_STATION, scale: 45, unreceived: true }),
]

/**
 * 未入電はあるが最大震度と階級が違う形。未入電は下限の 45 へ寄せてあるので、
 * 最大震度が 50（5強）以上の地震はここへ落ちる。
 */
const WITH_UNRECEIVED_BELOW_MAX: EarthquakePoint[] = [
  station({ scale: 50 }),
  station({ addr: UNRECEIVED_STATION, scale: 45, unreceived: true }),
]

/** 未入電が 1 件も無い形。 */
const WITHOUT_UNRECEIVED: EarthquakePoint[] = [station()]

/** `selected` で開いた表示・畳んだ表示を出し分ける（`EarthquakeCard` の `isSelected`）。 */
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
  />,
)

/** 最大震度の欄（「最大震度」のラベルと値を抱える器）。 */
const maxScaleBox = () => screen.getByText('最大震度').parentElement!

/** 値の本体（`font-black` を持つ span）。 */
const valueEl = () => maxScaleBox().querySelector('.font-black')!

describe('カードの最大震度に付く「以上」', () => {
  // 正: 階級が一致すれば語が出る。開いた表示・畳んだ表示の両方に要る
  // （畳んだカードだけを見ている利用者にも、もっと強い可能性があることを伝える）。
  it.each([
    ['開いた', true],
    ['畳んだ', false],
  ] as const)('%s表示で「以上」が出る', (_label, selected) => {
    renderTab(makeQuake(45, WITH_UNRECEIVED_AT_MAX), selected)
    expect(maxScaleBox().textContent).toContain('5弱')
    expect(within(maxScaleBox()).getByText('以上')).toBeTruthy()
  })

  // 対照: 未入電があっても最大震度と階級が違えば出ない。
  it.each([
    ['開いた', true],
    ['畳んだ', false],
  ] as const)('%s表示で、最大震度より低い階級の未入電では出ない', (_label, selected) => {
    renderTab(makeQuake(50, WITH_UNRECEIVED_BELOW_MAX), selected)
    expect(maxScaleBox().textContent).toContain('5強')
    expect(within(maxScaleBox()).queryByText('以上')).toBeNull()
  })

  // 対照: 未入電が無ければ出ない。
  it.each([
    ['開いた', true],
    ['畳んだ', false],
  ] as const)('%s表示で、未入電が無ければ出ない', (_label, selected) => {
    renderTab(makeQuake(45, WITHOUT_UNRECEIVED), selected)
    expect(maxScaleBox().textContent).toContain('5弱')
    expect(within(maxScaleBox()).queryByText('以上')).toBeNull()
  })

  // 安全弁: 語を本体と同じ要素・同じ大きさへ戻さないこと。**これが折り返しを防いでいる本体。**
  // 語が値の中へ素のテキストとして混ざると（`getIntensityLabelWithOrAbove` を欄へ直接使うと）
  // 大きさを分けられず、器から溢れる。
  //
  // **要素の親子関係は表示で違う**（開いた表示は本体の span の中へ入れ、畳んだ表示は値の下へ
  // 兄弟として置く）。**どちらであってもよい**ので、ここで見るのは「語だけを持つ独立した
  // 要素になっているか」だけ。
  it.each([
    ['開いた', true],
    ['畳んだ', false],
  ] as const)('%s表示で、「以上」は値の本体と別の要素で出す', (_label, selected) => {
    renderTab(makeQuake(45, WITH_UNRECEIVED_AT_MAX), selected)
    const orAbove = within(maxScaleBox()).getByText('以上')
    // 値の本体そのものではない（素のテキストとして混ざっていない）。
    expect(orAbove).not.toBe(valueEl())
    // その要素が抱えるのは語だけ（値を巻き込んでいない）。
    expect(orAbove.textContent).toBe('以上')
  })

  it.each([
    ['開いた', true],
    ['畳んだ', false],
  ] as const)('%s表示で、「以上」は本体より小さいフォントサイズを持つ', (_label, selected) => {
    renderTab(makeQuake(45, WITH_UNRECEIVED_AT_MAX), selected)
    const orAbove = within(maxScaleBox()).getByText('以上')
    // 語の要素が自前のフォントサイズ指定を持つこと。持たないと本体の大きさを継ぎ、
    // 桁数が倍になって器から溢れる（jsdom は寸法を計算しないので、指定の有無で押さえる）。
    expect(orAbove.className).toMatch(/\btext-(\[[^\]]+\]|xs|sm|base|lg|xl)/)
    // 本体と同じ指定ではないこと。
    const bodySize = (valueEl().className.match(/(?:^|\s)text-(?:\[[^\]]+\]|\w+)/g) ?? []).join(' ')
    const wordSize = (orAbove.className.match(/(?:^|\s)text-(?:\[[^\]]+\]|\w+)/g) ?? []).join(' ')
    expect(wordSize).not.toBe(bodySize)
  })
})
