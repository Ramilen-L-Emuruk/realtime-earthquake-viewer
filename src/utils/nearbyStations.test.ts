import { describe, it, expect } from 'vitest'
import {
  NEARBY_RADIUS_KM,
  allRegionNames,
  allStationNames,
  nearbyKyoshinKeys,
  nearbyStationNames,
  nearbyRegionNames,
} from './nearbyStations'
import { computeSiteKeys } from './kyoshinDetector'
import type { StationCoordsData } from './stationCoords'

// 東京駅を自宅とする。半径 30km の内外を作りやすい。
const HOME = { lat: 35.681, lng: 139.767 }

// 東京駅からの距離: 新宿 約 6km / 横浜 約 27km / 熊谷 約 60km / 父島 約 1000km
const SHINJUKU: [number, number] = [35.690, 139.700]
const YOKOHAMA: [number, number] = [35.466, 139.622]
const KUMAGAYA: [number, number] = [36.147, 139.389]
const CHICHIJIMA: [number, number] = [27.094, 142.192]

describe('nearbyKyoshinKeys', () => {
  it('半径内の観測点のキーだけを返す', () => {
    const sites = [SHINJUKU, KUMAGAYA, YOKOHAMA]
    const keys = computeSiteKeys(sites)
    expect(nearbyKyoshinKeys(sites, HOME)).toEqual(new Set([keys[0], keys[2]]))
  })

  it('半径外しかなければ空を返す（呼び出し側が「位置なし」へ倒せる）', () => {
    expect(nearbyKyoshinKeys([KUMAGAYA, CHICHIJIMA], HOME)).toEqual(new Set())
  })

  it('離島では遠くの本土を拾わない（K 点方式との違い）', () => {
    // 父島を自宅にすると、本土の点は 1000km 先。近い順に K 点を採る方式なら本土が入ってしまう。
    const home = { lat: CHICHIJIMA[0], lng: CHICHIJIMA[1] }
    expect(nearbyKyoshinKeys([SHINJUKU, YOKOHAMA, KUMAGAYA], home)).toEqual(new Set())
  })

  it('半径を広げれば拾う範囲も広がる', () => {
    const sites = [KUMAGAYA]
    expect(nearbyKyoshinKeys(sites, HOME, 100)).toEqual(new Set(computeSiteKeys(sites)))
  })

  // 同一座標に複数の実体がある観測点が実在する（全 1725 点中 207 グループ・431 点）。キーの生成を
  // 検知エンジンと共有しているので、2 つ目以降も別のキーとして返る。座標だけで持つと片方が消える。
  it('同じ座標の観測点も別々のキーになる', () => {
    const sites = [SHINJUKU, SHINJUKU]
    const keys = computeSiteKeys(sites)
    expect(new Set(keys).size).toBe(2)
    expect(nearbyKyoshinKeys(sites, HOME)).toEqual(new Set(keys))
  })
})

const DATA: StationCoordsData = {
  stations: {
    '東京都|新宿区西新宿': [SHINJUKU[0], SHINJUKU[1], 0],
    '神奈川県|横浜市中区': [YOKOHAMA[0], YOKOHAMA[1], 1],
    '埼玉県|熊谷市桜町': [KUMAGAYA[0], KUMAGAYA[1], 2],
    '東京都|小笠原村父島': [CHICHIJIMA[0], CHICHIJIMA[1], 3],
  },
  areas: {},
  regionNames: ['東京都23区', '神奈川県東部', '埼玉県北部', '小笠原諸島'],
}

describe('nearbyStationNames', () => {
  it('半径内の観測点名だけを返す（県名は含めない）', () => {
    expect(nearbyStationNames(DATA, HOME)).toEqual(
      new Set(['新宿区西新宿', '横浜市中区']),
    )
  })

  it('半径外しかなければ空集合（位置なしへ倒す合図）', () => {
    const home = { lat: CHICHIJIMA[0], lng: CHICHIJIMA[1] }
    expect(nearbyStationNames(DATA, home)).toEqual(new Set(['小笠原村父島']))
  })
})

describe('nearbyRegionNames', () => {
  it('半径内の観測点が属する区域名を返す', () => {
    expect(nearbyRegionNames(DATA, HOME)).toEqual(new Set(['東京都23区', '神奈川県東部']))
  })

  it('区域名の一覧を持たない旧データでは空集合を返す（EEW 判定は成立しない）', () => {
    const legacy: StationCoordsData = { stations: DATA.stations, areas: {} }
    expect(nearbyRegionNames(legacy, HOME)).toEqual(new Set())
  })

  it('区域の添字を持たない観測点は飛ばす', () => {
    const partial: StationCoordsData = {
      stations: { '東京都|新宿区西新宿': [SHINJUKU[0], SHINJUKU[1]] },
      areas: {},
      regionNames: ['東京都23区'],
    }
    expect(nearbyRegionNames(partial, HOME)).toEqual(new Set())
  })
})

// 半径内の集合だけでは「近所が電文に載っていない」の意味が決まらない（載るほど揺れていないのか、
// 電文の粒度が索引と噛み合っていないのか）。全件版はその見分けに使う。
describe('全件版', () => {
  it('半径に関係なくすべての観測点名を返す', () => {
    expect(allStationNames(DATA)).toEqual(
      new Set(['新宿区西新宿', '横浜市中区', '熊谷市桜町', '小笠原村父島']),
    )
  })

  it('すべての区域名を返す', () => {
    expect(allRegionNames(DATA)).toEqual(
      new Set(['東京都23区', '神奈川県東部', '埼玉県北部', '小笠原諸島']),
    )
  })

  it('区域名を持たない古いデータでは空を返す', () => {
    const legacy = { ...DATA, regionNames: undefined } as StationCoordsData
    expect(allRegionNames(legacy)).toEqual(new Set())
  })
})

describe('NEARBY_RADIUS_KM', () => {
  it('既定の半径は 30km（欠測耐性と精度の折り合い）', () => {
    expect(NEARBY_RADIUS_KM).toBe(30)
  })
})
