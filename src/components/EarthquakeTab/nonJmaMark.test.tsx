// @vitest-environment jsdom
//
// 気象庁以外が運用する観測点の印（`＊`）を、地震カードの観測点名へ戻すこと
// （→ docs/spec/quake-spec.md §8「気象庁以外が運用する観測点」）。
//
// **電文の読み取りでは印を外している。** 座標表をはじめ、印の無い名前を鍵にしている先が
// いくつもあるため（一覧は上の仕様書の表）。戻すのは表示の側で、カードでは
// 3 か所ある —— 震度一覧の観測点の行・「震度を入手していない地点」・長周期地震動の
// 観測点の行。**どれか 1 つだけ直しても型検査は通り、壊れても例外は出ない**ので、
// 3 か所そろっていることをここで固定する。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake, JMALpgm, EarthquakePoint, JMAQuakeCity } from '../../types/earthquake'
// 地名と `＊` は右端を揃えるために別の要素へ分けてある（→ `IntensityRow`）。
// `getByText('〇〇＊')` では引けないので、行ごと見る。
import { intensityRowText as rowText, openIntensityRows } from '../../test-utils/intensityRow'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

const EVENT_ID = '20240101161000'
const PREF = '岩手県'
const AREA = '岩手県沿岸北部'
const CITY = '普代村'
/** 気象庁以外が運用する観測点（実電文で `＊` が付く地点）。 */
const NON_JMA_STATION = '普代村銅屋'
/** 同じ市町村にある気象庁の観測点。 */
const JMA_STATION = '普代村第三セクター'

const station = (over: Partial<EarthquakePoint> = {}): EarthquakePoint => ({
  pref: '', addr: JMA_STATION, isArea: false, scale: 30, area: AREA, city: CITY, ...over,
})

/**
 * 実電文どおり、都道府県ロールアップ点・区域の点・観測点の 3 種を並べる
 * （→ `EarthquakePoint`。この 3 種は `pref` の有無と `isArea` で見分けられている）。
 * 市町村の段は `cities` から立つので別に渡す。
 */
const upperRows = (scale: EarthquakePoint['scale']): EarthquakePoint[] => [
  { pref: PREF, addr: PREF, isArea: true, scale },
  { pref: '', addr: AREA, isArea: true, scale },
]
const CITIES: JMAQuakeCity[] = [{ name: CITY, area: AREA, pref: PREF, scale: 30 }]

function makeQuake(points: EarthquakePoint[], cities: JMAQuakeCity[] = CITIES): JMAQuake {
  return {
    kind: 'quake',
    id: `dmdata-quake-${EVENT_ID}-1`,
    eventId: EVENT_ID,
    time: '2024-01-01T07:24:00Z',
    issue: { source: 'テスト', time: '2024-01-01T07:24:00Z', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2024-01-01T07:10:00Z',
      hypocenter: { name: '石川県能登地方', latitude: 37.495, longitude: 137.27, depth: 16, magnitude: 7.6 },
      maxScale: 45,
      domesticTsunami: '警報等',
    },
    points,
    cities,
  }
}

const LPGM_BASE: JMALpgm = {
  id: `test-lpgm-${EVENT_ID}`,
  eventId: EVENT_ID,
  time: '2024-01-01T07:23:00Z',
  originTime: '2024-01-01T07:10:00Z',
  maxClass: 4,
  cancelled: false,
  points: [],
  regions: [],
}

const renderTab = (quake: JMAQuake, lpgm?: JMALpgm, opts: { unreceivedOpen?: boolean } = {}) => render(
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
    lpgmByEventId={lpgm ? new Map([[EVENT_ID, lpgm]]) : new Map()}
    updateMarks={new Map()}
    activeLpgmEventId={lpgm ? EVENT_ID : null}
    onToggleLpgm={() => {}}
    estimatedIntensity={null}
    distributionQuakeKey={null}
    onToggleDistribution={() => {}}
    unreceivedQuakeKey={opts.unreceivedOpen ? quakeEventKey(quake) : null}
    onToggleUnreceived={() => {}}
    onFocusMap={() => {}}
    speakingTelegramTextSubject={null}
  />
)


describe('地震カードの観測点名に付く「気象庁以外」の印', () => {
  // 正: 震度一覧の観測点の行に `＊` が出る。
  it('震度一覧の観測点の行に印が出る', () => {
    renderTab(makeQuake([
      ...upperRows(30),
      station({ addr: NON_JMA_STATION, nonJma: true }),
      station(),
    ]))

    openIntensityRows(PREF, AREA, CITY)

    expect(rowText(NON_JMA_STATION)).toContain(`${NON_JMA_STATION}＊`)
    // 対照: 気象庁の観測点には付かない。
    expect(rowText(JMA_STATION)).toContain(JMA_STATION)
    expect(rowText(JMA_STATION)).not.toContain('＊')
  })

  // 正: 「震度を入手していない地点」の一覧にも `＊` が出る。
  // **この一覧は同名の地点を 1 行へまとめる**ので、印の経路が震度一覧とは別にある。
  // 一覧は未入電トグルを開いたときに出る（→ `unreceivedOpen`）。
  it('「震度を入手していない地点」に印が出る', () => {
    renderTab(makeQuake([
      ...upperRows(45),
      station({ addr: NON_JMA_STATION, scale: 45, unreceived: true, nonJma: true }),
      station({ scale: 45, unreceived: true }),
    ]), undefined, { unreceivedOpen: true })

    expect(screen.getByText(`${NON_JMA_STATION}＊`)).toBeTruthy()
    expect(screen.getByText(JMA_STATION)).toBeTruthy()
    expect(screen.queryByText(`${JMA_STATION}＊`)).toBeNull()
  })

  // 正: 長周期地震動の観測点の行にも `＊` が出る。
  it('長周期地震動の観測点の行に印が出る', () => {
    renderTab(makeQuake([]), {
      ...LPGM_BASE,
      points: [
        { code: '1', name: NON_JMA_STATION, pref: PREF, area: AREA, lgInt: 4, nonJma: true },
        { code: '2', name: JMA_STATION, pref: PREF, area: AREA, lgInt: 3 },
      ],
    })

    openIntensityRows(PREF, AREA)

    expect(rowText(NON_JMA_STATION)).toContain(`${NON_JMA_STATION}＊`)
    expect(rowText(JMA_STATION)).toContain(JMA_STATION)
    expect(rowText(JMA_STATION)).not.toContain('＊')
  })

  // 安全弁: **印を県・区域・市町村の行へ広げていない。** 運用機関は観測点ごとの事実で、
  // 上の段へ持ち上げると「この区域は気象庁以外が測っている」という別のことを言ってしまう。
  it('県・区域・市町村の行には印を付けない', () => {
    renderTab(makeQuake([...upperRows(30), station({ addr: NON_JMA_STATION, nonJma: true })]))

    for (const label of [PREF, AREA, CITY]) {
      expect(screen.queryByText(`${label}＊`), label).toBeNull()
    }
  })
})
