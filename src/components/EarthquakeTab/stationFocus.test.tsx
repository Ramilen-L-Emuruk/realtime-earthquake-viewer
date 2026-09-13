// @vitest-environment jsdom
//
// 地震カードの観測点の行を押したら、その地点を地図の寄り先として渡すこと
// （→ docs/spec/quake-spec.md §8「観測点の行をクリックしたときの寄り先」）。
//
// **押せるかどうかと寄り先は、同じ引き当てから出す。** 別々に解決すると、片方だけが引けた
// ときに「押せるのに動かない」（またはその逆）になる。座標表に無い観測点が押せる見た目に
// ならないことも、ここで併せて固定する。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import type { StationCoordsData } from '../../utils/stationCoords'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake, EarthquakePoint, JMAQuakeCity } from '../../types/earthquake'
import { findIntensityRow, openIntensityRows } from '../../test-utils/intensityRow'

// `vi.mock` のファクトリより先に評価させる（巻き上げられるため、通常の定数は参照できない）。
const f = vi.hoisted(() => {
  const PREF = '岩手県'
  const AREA = '岩手県沿岸北部'
  const CITY = '普代村'
  /** 座標表にある観測点。 */
  const KNOWN = '普代村第三セクター'
  /**
   * 座標表に無い観測点。**廃止された地点を含む過去の電文を再生すると実際に現れる**
   * （現行の一覧に無い観測点は `unlisted` が拾うが、そこにも無いものは残る）。
   */
  const UNKNOWN = '普代村銅屋'
  /**
   * 座標表では**別の県のキー**で登録されている観測点。行の県（電文の `City` 由来）と座標表の
   * キーが揃わない場合を表す。名前からの逆引きでのみ引ける。
   */
  const OTHER_PREF_STATION = '三戸町'
  const KNOWN_POS: [number, number] = [40.02, 141.83]
  const OTHER_PREF_POS: [number, number] = [40.37, 141.26]
  const data: StationCoordsData = {
    stations: {
      [`${PREF}|${KNOWN}`]: [KNOWN_POS[0], KNOWN_POS[1], 0],
      [`青森県|${OTHER_PREF_STATION}`]: [OTHER_PREF_POS[0], OTHER_PREF_POS[1]],
    },
    areas: { [`${PREF}|${AREA}`]: [39.9, 141.9] },
    regionNames: [AREA],
  }
  return { PREF, AREA, CITY, KNOWN, UNKNOWN, OTHER_PREF_STATION, KNOWN_POS, OTHER_PREF_POS, data }
})

// 座標表は実行時に fetch で取りに行くため、テストでは読み込み済みの状態を与える。
vi.mock('../../hooks/useStationCoords', () => ({ useStationCoords: () => f.data }))

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

const EVENT_ID = '20240101161000'
const CITIES: JMAQuakeCity[] = [{ name: f.CITY, area: f.AREA, pref: f.PREF, scale: 30 }]

/** 実電文どおり、都道府県ロールアップ点・区域の点・観測点の 3 種を並べる。 */
const POINTS: EarthquakePoint[] = [
  { pref: f.PREF, addr: f.PREF, isArea: true, scale: 30 },
  { pref: '', addr: f.AREA, isArea: true, scale: 30 },
  { pref: '', addr: f.KNOWN, isArea: false, scale: 30, area: f.AREA, city: f.CITY },
  { pref: '', addr: f.UNKNOWN, isArea: false, scale: 30, area: f.AREA, city: f.CITY },
  { pref: '', addr: f.OTHER_PREF_STATION, isArea: false, scale: 30, area: f.AREA, city: f.CITY },
]

const QUAKE: JMAQuake = {
  kind: 'quake',
  id: `dmdata-quake-${EVENT_ID}-1`,
  eventId: EVENT_ID,
  time: '2024-01-01T07:24:00Z',
  issue: { source: 'テスト', time: '2024-01-01T07:24:00Z', type: '震源・震度情報', correct: 'なし' },
  earthquake: {
    time: '2024-01-01T07:10:00Z',
    hypocenter: { name: '岩手県沖', latitude: 40.0, longitude: 142.0, depth: 30, magnitude: 5.5 },
    maxScale: 30,
    domesticTsunami: 'なし',
  },
  points: POINTS,
  cities: CITIES,
}

/** 県 → 区域 → 市町村と開いて、観測点の行まで降りた状態で描く。 */
function renderOpened(onPointFocus: (position: [number, number]) => void) {
  render(
    <EarthquakeTab
      earthquakes={[QUAKE]}
      selectedId={quakeEventKey(QUAKE)}
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
      onPointFocus={onPointFocus}
    />,
  )
  openIntensityRows(f.PREF, f.AREA, f.CITY)
}

/** 行を押す。押せない行にも同じ操作を通す（そちらは何も起きないことを見るため）。 */
function clickRow(name: string): HTMLElement {
  const row = findIntensityRow(name)
  expect(row, `${name} の行が見つからない`).toBeTruthy()
  fireEvent.click(row!)
  return row!
}

describe('地震カードの観測点の行をクリックしたときの寄り先', () => {
  // 正: 座標を引ける観測点は押せて、その座標が寄り先として渡る。
  it('座標を引ける観測点を押すと、その地点が寄り先になる', () => {
    const onPointFocus = vi.fn()
    renderOpened(onPointFocus)

    const row = clickRow(f.KNOWN)

    expect(row.getAttribute('role')).toBe('button')
    expect(onPointFocus).toHaveBeenCalledWith(f.KNOWN_POS)
  })

  // 正: 同じ行を続けて押しても、そのたびに要求が立つ。
  // **地図側は `ts` で見分けている**（→ `FocusPointGL`）ので、ここで要求が 2 度届かないと
  // 「地図を動かしたあと同じ行を押しても戻らない」になる。
  it('同じ行を続けて押すと、そのたびに寄り先が立つ', () => {
    const onPointFocus = vi.fn()
    renderOpened(onPointFocus)

    clickRow(f.KNOWN)
    clickRow(f.KNOWN)

    expect(onPointFocus).toHaveBeenCalledTimes(2)
  })

  // 正: 行の県では引けない観測点も、観測点名からの逆引きで救う。
  // 行の県は電文の `City` 由来のことがあり（`makeAreaPrefResolver`）、座標表のキーと必ず
  // 揃うとは限らない。**この経路が死ぬと、地図に点が出ている観測点の行だけが押せなくなる。**
  it('行の県で引けない観測点は、観測点名からの逆引きで救う', () => {
    const onPointFocus = vi.fn()
    renderOpened(onPointFocus)

    const row = clickRow(f.OTHER_PREF_STATION)

    expect(row.getAttribute('role')).toBe('button')
    expect(onPointFocus).toHaveBeenCalledWith(f.OTHER_PREF_POS)
  })

  // 対照: 座標を引けない観測点は押せる見た目にしない（押しても何も起きない行を作らない）。
  it('座標を引けない観測点は押せる見た目にならない', () => {
    const onPointFocus = vi.fn()
    renderOpened(onPointFocus)

    const row = clickRow(f.UNKNOWN)

    // 行そのものは出る —— 座標を引けないことは、地点を一覧から落とす理由にならない。
    expect(row.getAttribute('role')).toBeNull()
    expect(onPointFocus).not.toHaveBeenCalled()
  })

  // 安全弁: 上位の段（県・区域・市町村）は開閉のままで、寄せに奪われていない。
  // 開閉と寄せを同じクリックへ同居させると、どちらを優先しても片方が押せなくなる。
  it('県・区域・市町村の行は開閉のままで、寄り先を立てない', () => {
    const onPointFocus = vi.fn()
    renderOpened(onPointFocus)

    // 開いた状態から押すので、ここでは畳まれる（開閉が働いている印）。
    clickRow(f.CITY)
    expect(findIntensityRow(f.KNOWN)).toBeUndefined()

    clickRow(f.AREA)
    clickRow(f.PREF)
    expect(onPointFocus).not.toHaveBeenCalled()
  })
})
