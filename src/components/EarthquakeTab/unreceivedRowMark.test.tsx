// @vitest-environment jsdom
//
// 震度一覧の行に付く未入電の印（→ docs/spec/quake-spec.md §4「震度5弱以上未入電」）。
//
// **「未入電」と「未入電あり」は意味が違う。** 前者はその行の震度そのものが届いていないこと、
// 後者はその範囲に未入電の地点があること（行の値は観測できている）。かつては後者しか出して
// おらず、**事実を持っている観測点の行が黙って、範囲の行だけが喋っていた** —— 観測点の行は
// 「震度5弱以上」としか出ず、なぜ「以上」なのかが読み取れなかった。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake, EarthquakePoint, JMAQuakeCity } from '../../types/earthquake'
import { findIntensityRow, intensityRowText } from '../../test-utils/intensityRow'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

const PREF = '大分県'
const AREA = '大分県中部'
const CITY = '別府市'
const UNRECEIVED_STATION = '別府市鶴見'
const OBSERVED_STATION = '別府市天間'

const station = (over: Partial<EarthquakePoint> = {}): EarthquakePoint => ({
  pref: '', addr: OBSERVED_STATION, isArea: false, scale: 40, area: AREA, city: CITY, ...over,
})

const CITIES: JMAQuakeCity[] = [{ name: CITY, area: AREA, pref: PREF, scale: 40, hasUnreceived: true }]

function makeQuake(points: EarthquakePoint[]): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20220122011300-1',
    eventId: '20220122011300',
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
    lpgmByEventId={new Map()}
    activeLpgmEventId={null}
    onToggleLpgm={() => {}}
    estimatedIntensity={null}
    distributionQuakeKey={null}
    onToggleDistribution={() => {}}
    unreceivedQuakeKey={null}
    onToggleUnreceived={() => {}}
  />,
)

/** 震度一覧は既定でどの段も畳んでいる。上から順に開く。 */
function openRows(...labels: string[]) {
  for (const label of labels) {
    const row = screen.getAllByRole('button')
      .find(el => el.tagName === 'DIV' && el.textContent?.includes(label))
    expect(row, `${label} の行が見つからない`).toBeTruthy()
    fireEvent.click(row!)
  }
}

/** 県 → 区域 → 市町村と開いて観測点の行まで降りる。 */
const openDownToStations = () => openRows(PREF, AREA, CITY)

// 行の引き方は 2 つのテストファイルで共有する（→ `test-utils/intensityRow`）。
// **地名は完全一致で引く** —— 部分一致だと「大分県」が「大分県中部」の行にも当たる。
const rowEl = findIntensityRow
const rowText = intensityRowText

const MIXED: EarthquakePoint[] = [
  { pref: PREF, addr: PREF, isArea: true, scale: 40 },
  { pref: '', addr: AREA, isArea: true, scale: 40 },
  station(),
  station({ addr: UNRECEIVED_STATION, scale: 45, unreceived: true }),
]

describe('震度一覧の未入電の印', () => {
  // 正: 行自身が未入電なら「未入電」。
  it('未入電の観測点の行に「未入電」が出る', () => {
    renderTab(makeQuake(MIXED))
    openDownToStations()
    expect(rowText(UNRECEIVED_STATION)).toContain('未入電')
    // 「以上」の語も併せて出る（なぜ「以上」なのかを印が説明する）。
    expect(rowText(UNRECEIVED_STATION)).toContain('震度5弱以上')
  })

  // 対照: 観測できた行には出ない。
  it('観測できた観測点の行には出ない', () => {
    renderTab(makeQuake(MIXED))
    openDownToStations()
    expect(rowText(OBSERVED_STATION)).not.toContain('未入電')
  })

  // 安全弁: 配下にあるだけの行は「未入電あり」のまま。範囲の話と地点の話を混ぜない。
  it('配下に未入電がある行は「未入電あり」のまま', () => {
    renderTab(makeQuake(MIXED))
    expect(rowText(PREF)).toContain('未入電あり')
  })

  // 安全弁: 県・区域の行は**積み上げの値**なので「未入電」と断定しない。
  //
  // 標準版（P2PQuake）は区域のロールアップ点を持たないため、区域の値は配下の観測点から
  // 積み上がる。積み上げは震度の大小で決まるので、**観測できた震度3 と未入電（下限 45）が
  // 混在すると未入電が勝つ**。そこで「未入電」と書くと、届いている観測値を無かったことにする。
  it('観測値と未入電が混在する区域・県は「未入電あり」にする', () => {
    // 観測点を市町村へ紐付けない（標準版は市町村を配信しないので、観測点は区域の直下に付く
    // → docs/spec/quake-spec.md §5「観測点がどの市町村・区域に属するか」）。
    const mixedRollup: EarthquakePoint[] = [
      station({ addr: OBSERVED_STATION, scale: 30, city: undefined }),
      station({ addr: UNRECEIVED_STATION, scale: 45, unreceived: true, city: undefined }),
    ]
    renderTab(makeQuake(mixedRollup))
    openRows(PREF)
    for (const name of [PREF, AREA]) {
      const text = rowText(name)
      // 値は未入電から来ているので「以上」は付く（上限が定まらないことは伝える）。
      expect(text, name).toContain('震度5弱以上')
      // ただし断定はしない。
      expect(text, name).toContain('未入電あり')
      expect(text.replace('未入電あり', ''), name).not.toContain('未入電')
    }
  })

  // 安全弁: 印は**震度の側**へ置く。地名の側へ戻さない。
  //
  // 地名の右端を行ごとに揃えるための配置。地名と同じ流れに置くと、揃えるためにいちばん長い
  // 「未入電あり」ぶん（5 文字・約 3.75rem）の枠を全行で空けることになり、狭い画面では
  // **印を持たない行まで地名が折り返す**（実測: 幅 320px で 47 行中 7 行）。
  it('印は震度の側に置き、地名の枠へ入れない', () => {
    renderTab(makeQuake(MIXED))
    const row = rowEl(PREF)
    expect(row, '県の行が見つからない').toBeTruthy()
    expect(row!.children[0].textContent).toContain('未入電あり')
    expect(row!.children[1].textContent).not.toContain('未入電')
  })

  // 安全弁: `＊` は地名と別の枠に出す（同じ理由。地名の右端が 1 文字ぶんずれるのを防ぐ）。
  it('＊ は地名と別の枠に出す', () => {
    renderTab(makeQuake([
      { pref: PREF, addr: PREF, isArea: true, scale: 40 },
      { pref: '', addr: AREA, isArea: true, scale: 40 },
      station({ nonJma: true }),
    ]))
    openDownToStations()
    const row = rowEl(OBSERVED_STATION)
    expect(row, '観測点の行が見つからない').toBeTruthy()
    // 地名の枠は名前だけ。行全体では名前の直後に ＊ が続く。
    expect(row!.children[1].children[0].textContent).toBe(OBSERVED_STATION)
    expect(row!.textContent).toContain(`${OBSERVED_STATION}＊`)
  })

  // 安全弁: 両方が立つ行でも印は 1 つだけ（「未入電 未入電あり」と重ねない）。
  it('観測点の行に「未入電あり」を重ねない', () => {
    renderTab(makeQuake(MIXED))
    openDownToStations()
    const text = rowText(UNRECEIVED_STATION)
    expect(text).toContain('未入電')
    expect(text).not.toContain('未入電あり')
  })
})
