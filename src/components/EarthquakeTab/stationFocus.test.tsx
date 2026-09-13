// @vitest-environment jsdom
//
// 地震カードの観測点の行を押したら、その地点を地図の寄り先として渡すこと
// （→ docs/spec/quake-spec.md §8「観測点の行・区域名をクリックしたときの寄り先」）。
//
// **押せるかどうかと寄り先は、同じ引き当てから出す。** 別々に解決すると、片方だけが引けた
// ときに「押せるのに動かない」（またはその逆）になる。座標表に無い観測点が押せる見た目に
// ならないことも、ここで併せて固定する。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import type { StationCoordsData } from '../../utils/stationCoords'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake, JMALpgm, EarthquakePoint, JMAQuakeCity } from '../../types/earthquake'
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
  /** 区域の代表点（座標表は観測点と別の表に持つ）。 */
  const AREA_POS: [number, number] = [39.9, 141.9]
  /**
   * 未入電の観測点を 1 つも持たない区域。**区域の行が未入電の一覧に出るのはこの形だけ**
   * —— 観測点が覆う区域は二重に伝えないよう除かれる（→ `partitionUnreceivedPoints`）。
   */
  const BARE_AREA = '岩手県内陸北部'
  const BARE_AREA_POS: [number, number] = [39.7, 141.2]
  const data: StationCoordsData = {
    stations: {
      [`${PREF}|${KNOWN}`]: [KNOWN_POS[0], KNOWN_POS[1], 0],
      [`青森県|${OTHER_PREF_STATION}`]: [OTHER_PREF_POS[0], OTHER_PREF_POS[1]],
    },
    areas: { [`${PREF}|${AREA}`]: AREA_POS, [`${PREF}|${BARE_AREA}`]: BARE_AREA_POS },
    regionNames: [AREA],
  }
  /** 県・区域の境界（外接矩形だけが要るので 2 点で足りる）。 */
  const PREF_RINGS: [number, number][][] = [[[39.0, 141.0], [41.0, 142.0]]]
  const AREA_RINGS: [number, number][][] = [[[39.5, 141.5], [40.5, 141.9]]]
  /** 境界データを持たない県。**その県の地名は押せない**ことの対照に使う。 */
  const NO_BOUNDS_PREF = '青森県'
  return { PREF, AREA, CITY, KNOWN, UNKNOWN, OTHER_PREF_STATION, KNOWN_POS, OTHER_PREF_POS, AREA_POS,
    BARE_AREA, BARE_AREA_POS, PREF_RINGS, AREA_RINGS, NO_BOUNDS_PREF, data }
})

// 座標表は実行時に fetch で取りに行くため、テストでは読み込み済みの状態を与える。
vi.mock('../../hooks/useStationCoords', () => ({ useStationCoords: () => f.data }))
// 県・区域の境界も実行時は fetch で取る。**岩手県と沿岸北部だけ**を与え、青森県は与えない
// （境界を引けない行が押せないことの対照）。
vi.mock('../../hooks/usePrefectures', () => ({
  usePrefectures: () => ({ [f.PREF]: { label: [40, 141.5], room: [0, 0], rings: f.PREF_RINGS } }),
}))
vi.mock('../../hooks/useSubRegions', () => ({
  useSubRegions: () => ({ data: [{ name: f.AREA, label: [40, 141.7], room: [0, 0], rings: f.AREA_RINGS }], failed: false }),
}))

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
  { pref: f.NO_BOUNDS_PREF, addr: f.NO_BOUNDS_PREF, isArea: true, scale: 20 },
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

function renderCard(
  quake: JMAQuake,
  onFocusMap: (positions: [number, number][]) => void,
  opts: { unreceived?: boolean; lpgm?: JMALpgm } = {},
) {
  render(
    <EarthquakeTab
      earthquakes={[quake]}
      selectedId={quakeEventKey(quake)}
      onSelect={() => {}}
      isLoading={false}
      isLoadingMore={false}
      hasMore={false}
      onLoadMore={() => {}}
      error={null}
      lpgmByEventId={opts.lpgm ? new Map([[EVENT_ID, opts.lpgm]]) : new Map()}
      activeLpgmEventId={opts.lpgm ? EVENT_ID : null}
      onToggleLpgm={() => {}}
      estimatedIntensity={null}
      distributionQuakeKey={null}
      onToggleDistribution={() => {}}
      unreceivedQuakeKey={opts.unreceived ? quakeEventKey(quake) : null}
      onToggleUnreceived={() => {}}
      onFocusMap={onFocusMap}
    />,
  )
}

/** 県 → 区域 → 市町村と開いて、観測点の行まで降りた状態で描く。 */
function renderOpened(onFocusMap: (positions: [number, number][]) => void) {
  renderCard(QUAKE, onFocusMap)
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
    const onFocusMap = vi.fn()
    renderOpened(onFocusMap)

    const row = clickRow(f.KNOWN)

    expect(row.getAttribute('role')).toBe('button')
    expect(onFocusMap).toHaveBeenCalledWith([f.KNOWN_POS])
  })

  // 正: 同じ行を続けて押しても、そのたびに要求が立つ。
  // **地図側は `ts` で見分けている**（→ `FocusTargetGL`）ので、ここで要求が 2 度届かないと
  // 「地図を動かしたあと同じ行を押しても戻らない」になる。
  it('同じ行を続けて押すと、そのたびに寄り先が立つ', () => {
    const onFocusMap = vi.fn()
    renderOpened(onFocusMap)

    clickRow(f.KNOWN)
    clickRow(f.KNOWN)

    expect(onFocusMap).toHaveBeenCalledTimes(2)
  })

  // 正: 行の県では引けない観測点も、観測点名からの逆引きで救う。
  // 行の県は電文の `City` 由来のことがあり（`makeAreaPrefResolver`）、座標表のキーと必ず
  // 揃うとは限らない。**この経路が死ぬと、地図に点が出ている観測点の行だけが押せなくなる。**
  it('行の県で引けない観測点は、観測点名からの逆引きで救う', () => {
    const onFocusMap = vi.fn()
    renderOpened(onFocusMap)

    const row = clickRow(f.OTHER_PREF_STATION)

    expect(row.getAttribute('role')).toBe('button')
    expect(onFocusMap).toHaveBeenCalledWith([f.OTHER_PREF_POS])
  })

  // 対照: 座標を引けない観測点は押せる見た目にしない（押しても何も起きない行を作らない）。
  it('座標を引けない観測点は押せる見た目にならない', () => {
    const onFocusMap = vi.fn()
    renderOpened(onFocusMap)

    const row = clickRow(f.UNKNOWN)

    // 行そのものは出る —— 座標を引けないことは、地点を一覧から落とす理由にならない。
    expect(row.getAttribute('role')).toBeNull()
    expect(onFocusMap).not.toHaveBeenCalled()
  })

  // 安全弁: 上位の段（県・区域・市町村）は開閉のままで、寄せに奪われていない。
  // 開閉と寄せを同じクリックへ同居させると、どちらを優先しても片方が押せなくなる。
  it('県・区域・市町村の行は開閉のままで、寄り先を立てない', () => {
    const onFocusMap = vi.fn()
    renderOpened(onFocusMap)

    // 開いた状態から押すので、ここでは畳まれる（開閉が働いている印）。
    clickRow(f.CITY)
    expect(findIntensityRow(f.KNOWN)).toBeUndefined()

    clickRow(f.AREA)
    clickRow(f.PREF)
    expect(onFocusMap).not.toHaveBeenCalled()
  })
})

// ── 「震度を入手していない地点」の一覧 ──────────────────────────────────────────
// この一覧は震度一覧と差し替わる平らな並びで、行は地名の span だけ（開閉を持たない）。
// **観測点だけでなく区域も並ぶ** —— 地点を持たない電文（震度速報）は区域名でしか未入電を
// 伝えられないため（→ `partitionUnreceivedPoints`）。座標表は観測点と区域を別の表に持つので、
// 行がどちらを指すかで引き先が変わる。

/** 未入電の点を持つ地震。観測点（座標あり／なし）と区域を 1 つずつ並べる。 */
const UNRECEIVED_QUAKE: JMAQuake = {
  ...QUAKE,
  earthquake: { ...QUAKE.earthquake, maxScale: 45 },
  points: [
    { pref: f.PREF, addr: f.PREF, isArea: true, scale: 45 },
    { pref: '', addr: f.AREA, isArea: true, scale: 45 },
    { pref: '', addr: f.KNOWN, isArea: false, scale: 45, unreceived: true, area: f.AREA, city: f.CITY },
    { pref: '', addr: f.UNKNOWN, isArea: false, scale: 45, unreceived: true, area: f.AREA, city: f.CITY },
    { pref: '', addr: f.BARE_AREA, isArea: true, scale: 45, unreceived: true },
  ],
}

describe('「震度を入手していない地点」の地名をクリックしたときの寄り先', () => {
  // 正: 座標を引ける観測点は押せて、その座標が渡る。
  it('座標を引ける地点を押すと、その地点が寄り先になる', () => {
    const onFocusMap = vi.fn()
    renderCard(UNRECEIVED_QUAKE, onFocusMap, { unreceived: true })

    fireEvent.click(screen.getByText(f.KNOWN))

    expect(onFocusMap).toHaveBeenCalledWith([f.KNOWN_POS])
  })

  // 正: 区域の行は区域の代表点へ寄る。**観測点の表を引いても見つからない**ので、
  // 行が区域を指していることを持ち回していないとここで落ちる。
  it('区域の行は区域の代表点へ寄る', () => {
    const onFocusMap = vi.fn()
    renderCard(UNRECEIVED_QUAKE, onFocusMap, { unreceived: true })

    fireEvent.click(screen.getByText(f.BARE_AREA))

    expect(onFocusMap).toHaveBeenCalledWith([f.BARE_AREA_POS])
  })

  // 対照: 座標を引けない地点は押せる見た目にしない。
  it('座標を引けない地点は押せる見た目にならない', () => {
    const onFocusMap = vi.fn()
    renderCard(UNRECEIVED_QUAKE, onFocusMap, { unreceived: true })

    const el = screen.getByText(f.UNKNOWN)
    expect(el.getAttribute('role')).toBeNull()
    fireEvent.click(el)

    expect(onFocusMap).not.toHaveBeenCalled()
  })
})

// ── 長周期地震動の一覧 ────────────────────────────────────────────────────────
// 震度一覧から市町村を除いた 3 段（県 → 区域 → 観測点）。観測点の行は開閉を持たないので、
// 震度一覧の末端と同じ形で寄せられる。

const LPGM: JMALpgm = {
  id: `test-lpgm-${EVENT_ID}`,
  eventId: EVENT_ID,
  time: '2024-01-01T07:23:00Z',
  originTime: '2024-01-01T07:10:00Z',
  maxClass: 4,
  cancelled: false,
  regions: [],
  points: [
    { code: '1', name: f.KNOWN, pref: f.PREF, area: f.AREA, lgInt: 4 },
    { code: '2', name: f.UNKNOWN, pref: f.PREF, area: f.AREA, lgInt: 3 },
  ],
}

describe('長周期地震動の観測点の行をクリックしたときの寄り先', () => {
  // 正: 震度一覧と同じ引き当てで寄る（座標表は震度観測点と共通）。
  it('座標を引ける観測点を押すと、その地点が寄り先になる', () => {
    const onFocusMap = vi.fn()
    renderCard(QUAKE, onFocusMap, { lpgm: LPGM })
    openIntensityRows(f.PREF, f.AREA)

    const row = clickRow(f.KNOWN)

    expect(row.getAttribute('role')).toBe('button')
    expect(onFocusMap).toHaveBeenCalledWith([f.KNOWN_POS])
  })

  // 正: 県・区域も震度一覧と同じく地名の部分が押せる（段数の非対称を作らない）。
  it('県・区域の地名も押せる（震度一覧と揃える）', () => {
    const onFocusMap = vi.fn()
    renderCard(QUAKE, onFocusMap, { lpgm: LPGM })

    fireEvent.click(labelOf(f.PREF))
    expect(onFocusMap).toHaveBeenCalledWith([[39.0, 141.0], [41.0, 142.0]])

    openIntensityRows(f.PREF)
    fireEvent.click(labelOf(f.AREA))
    expect(onFocusMap).toHaveBeenLastCalledWith([[39.5, 141.5], [40.5, 141.9]])
  })

  // 対照: 座標を引けない観測点は押せない。**長周期地震動観測点は座標表に無いことがある**
  // （座標表は震度観測点の一覧から作る）ので、この経路は震度側より起きやすい。
  it('座標を引けない観測点は押せる見た目にならない', () => {
    const onFocusMap = vi.fn()
    renderCard(QUAKE, onFocusMap, { lpgm: LPGM })
    openIntensityRows(f.PREF, f.AREA)

    const row = clickRow(f.UNKNOWN)

    expect(row.getAttribute('role')).toBeNull()
    expect(onFocusMap).not.toHaveBeenCalled()
  })
})

// ── 上位 3 段（県・区域・市町村） ──────────────────────────────────────────────
// 行全体は開閉に使っているので、**寄せは地名の部分だけ**に置いてある。
// 県・区域は境界の外接矩形へ、市町村は境界データが無いので配下の観測点の範囲へ寄る。

/** 行の中の地名（上位 3 段ではここだけが寄せの当たり判定）。 */
function labelOf(name: string): HTMLElement {
  const row = findIntensityRow(name)
  expect(row, `${name} の行が見つからない`).toBeTruthy()
  // 地名は右端を揃えるための枠 span に包まれており、当たり判定はその内側にある。
  return row!.children[1].children[0].children[0] as HTMLElement
}

describe('県・区域・市町村の地名をクリックしたときの寄り先', () => {
  // 正: 県の地名を押すと県の範囲へ寄る。**外接矩形の 2 点**を渡す（境界の全頂点ではない）。
  it('県の地名を押すと県の範囲へ寄る', () => {
    const onFocusMap = vi.fn()
    renderOpened(onFocusMap)

    const label = labelOf(f.PREF)
    expect(label.getAttribute('role')).toBe('button')
    fireEvent.click(label)

    expect(onFocusMap).toHaveBeenCalledWith([[39.0, 141.0], [41.0, 142.0]])
  })

  // 正: 区域も同じく境界の外接矩形へ。
  it('区域の地名を押すと区域の範囲へ寄る', () => {
    const onFocusMap = vi.fn()
    renderOpened(onFocusMap)

    fireEvent.click(labelOf(f.AREA))

    expect(onFocusMap).toHaveBeenCalledWith([[39.5, 141.5], [40.5, 141.9]])
  })

  // 正: 市町村は境界データが無いので配下の観測点の範囲で代用する。
  // **座標を引けない観測点は混ぜない**（範囲が歪むため）。
  it('市町村の地名を押すと配下の観測点の範囲へ寄る', () => {
    const onFocusMap = vi.fn()
    renderOpened(onFocusMap)

    fireEvent.click(labelOf(f.CITY))

    expect(onFocusMap).toHaveBeenCalledWith(expect.arrayContaining([f.KNOWN_POS, f.OTHER_PREF_POS]))
    // 座標を引けない観測点（UNKNOWN）は入らない。
    expect(onFocusMap.mock.calls[0][0]).toHaveLength(2)
  })

  // 対照: 境界を引けない県の地名は押せる見た目にならない。
  it('境界を引けない県の地名は押せる見た目にならない', () => {
    const onFocusMap = vi.fn()
    renderOpened(onFocusMap)

    const label = labelOf(f.NO_BOUNDS_PREF)
    expect(label.getAttribute('role')).toBeNull()
    fireEvent.click(label)

    expect(onFocusMap).not.toHaveBeenCalled()
  })

  // 安全弁: 地名**以外**を押したときは開閉のまま（寄せに奪われていない）。
  it('地名以外の部分を押すと開閉する（寄り先は立たない）', () => {
    const onFocusMap = vi.fn()
    renderOpened(onFocusMap)

    // 行そのものを押す。開いた状態から押すので畳まれる。
    clickRow(f.CITY)
    expect(findIntensityRow(f.KNOWN)).toBeUndefined()
    expect(onFocusMap).not.toHaveBeenCalled()
  })
})

