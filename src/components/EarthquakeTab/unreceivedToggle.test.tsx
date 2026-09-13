// @vitest-environment jsdom
//
// 「震度を入手していない地点」をトグルへ畳んだこと（→ docs/spec/quake-spec.md §4）。
//
// かつては震度一覧の上に地点名のブロックを常に出していた。**中身は再掲**で（未入電の観測点は
// 震度一覧の 4 段入れ子の中にも入っている）、実測で 60 件のとき上下分割のパネル可視高の 142% を
// 占めていた。件数だけ常に見せ、地点名は押したときに出す形へ変えてある。
//
// ボタンは押した地震を選択したうえで追加表示を切り替える（App 側）。ここではタブの props で
// 開いた状態・閉じた状態を作り、出るもの／出ないものを固定する。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake, EarthquakePoint, JMAQuakeCity } from '../../types/earthquake'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

const EVENT_ID = '20220122011300'
const PREF = '宮崎県'
const AREA = '宮崎県北部平野部'
const CITY = '延岡市'
const UNRECEIVED_STATION = '延岡市北方町卯'
const OBSERVED_STATION = '延岡市大貫町'

const station = (over: Partial<EarthquakePoint> = {}): EarthquakePoint => ({
  pref: '', addr: OBSERVED_STATION, isArea: false, scale: 40, area: AREA, city: CITY, ...over,
})

const CITIES: JMAQuakeCity[] = [{ name: CITY, area: AREA, pref: PREF, scale: 40 }]

function makeQuake(points: EarthquakePoint[]): JMAQuake {
  return {
    kind: 'quake',
    id: `dmdata-quake-${EVENT_ID}-1`,
    eventId: EVENT_ID,
    time: '2022-01-21T16:15:00Z',
    issue: { source: 'テスト', time: '2022-01-21T16:15:00Z', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2022-01-21T16:08:00Z',
      hypocenter: { name: '日向灘', latitude: 32.7, longitude: 132.1, depth: 40, magnitude: 6.4 },
      maxScale: 55,
      domesticTsunami: 'なし',
    },
    points,
    cities: CITIES,
  }
}

const renderTab = (quake: JMAQuake, opts: { unreceivedOpen?: boolean } = {}) => render(
  <EarthquakeTab
    earthquakes={[quake]}
    selectedId={quakeEventKey(quake)}
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
    unreceivedQuakeKey={opts.unreceivedOpen ? quakeEventKey(quake) : null}
    onToggleUnreceived={() => {}}
  />
)

/** 未入電の地点と、同じ市町村で観測できた地点が混じる電文。 */
const MIXED: EarthquakePoint[] = [
  { pref: PREF, addr: PREF, isArea: true, scale: 40 },
  { pref: '', addr: AREA, isArea: true, scale: 40 },
  station(),
  station({ addr: UNRECEIVED_STATION, scale: 45, unreceived: true, nonJma: true }),
]

describe('未入電トグル', () => {
  // 正: 開くと地点名が出る。
  it('開くと地点名が出る', () => {
    renderTab(makeQuake(MIXED), { unreceivedOpen: true })
    expect(screen.getByText(`${UNRECEIVED_STATION}＊`)).toBeTruthy()
    // 県で区切る（どこの話かは見出しが示す）。
    expect(screen.getAllByText(PREF).length).toBeGreaterThan(0)
  })

  // 対照: 閉じているあいだは地点名を出さない。件数はボタンに出したままにする
  // （押さなくても「震度が届いていない地点がある」ことは分かる）。
  it('閉じているあいだは地点名を出さず、件数だけ見せる', () => {
    renderTab(makeQuake(MIXED))
    expect(screen.queryByText(`${UNRECEIVED_STATION}＊`)).toBeNull()
    expect(screen.getByText('1地点')).toBeTruthy()
    expect(screen.getByText('震度を入手していない地点')).toBeTruthy()
  })

  // 正: 開いているあいだは震度一覧と差し替える（同じ場所に 2 つ並べない）。
  it('開いているあいだは震度一覧を出さない', () => {
    const { rerender } = renderTab(makeQuake(MIXED))
    // 閉じているときは県の行（震度一覧の最上段）が出ている。
    expect(screen.getByText('震度4')).toBeTruthy()

    rerender(
      <EarthquakeTab
        earthquakes={[makeQuake(MIXED)]}
        selectedId={quakeEventKey(makeQuake(MIXED))}
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
        unreceivedQuakeKey={quakeEventKey(makeQuake(MIXED))}
        onToggleUnreceived={() => {}}
      />,
    )
    expect(screen.queryByText('震度4')).toBeNull()
  })

  // 安全弁: 未入電が 1 件も無い電文ではボタンを出さない（押しても何も出ないボタンを作らない）。
  it('未入電が無ければボタンを出さない', () => {
    const observedOnly: EarthquakePoint[] = [
      { pref: PREF, addr: PREF, isArea: true, scale: 40 },
      { pref: '', addr: AREA, isArea: true, scale: 40 },
      station(),
    ]
    renderTab(makeQuake(observedOnly))
    expect(screen.queryByText(/^震度を入手していない/)).toBeNull()
  })

  // 安全弁: 続報で未入電が 1 件も無くなったら、トグルが開いていても震度一覧へ戻る
  // （地図側の後始末は App が `closeUnreceivedOverlay` で行う）。
  it('未入電が無くなったら開いていても震度一覧へ戻る', () => {
    const allObserved: EarthquakePoint[] = [
      { pref: PREF, addr: PREF, isArea: true, scale: 40 },
      { pref: '', addr: AREA, isArea: true, scale: 40 },
      station(),
      station({ addr: UNRECEIVED_STATION, scale: 40, nonJma: true }),
    ]
    renderTab(makeQuake(allObserved), { unreceivedOpen: true })
    expect(screen.queryByText(/^震度を入手していない/)).toBeNull()
    expect(screen.getByText('震度4')).toBeTruthy()
  })

  // 安全弁: 単位は中身に合わせる。区域しか持たない電文（震度速報）では「地域」になる。
  it('区域だけの電文では単位が「地域」になる', () => {
    renderTab(makeQuake([
      { pref: PREF, addr: PREF, isArea: true, scale: 45 },
      { pref: '', addr: AREA, isArea: true, scale: 45, unreceived: true },
    ]))
    expect(screen.getByText('震度を入手していない地域')).toBeTruthy()
    expect(screen.getByText('1地域')).toBeTruthy()
  })
})
