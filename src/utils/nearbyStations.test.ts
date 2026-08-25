import { describe, it, expect } from 'vitest'
import {
  NEARBY_RADIUS_KM,
  nearbyKyoshinIndices,
  nearbyStationNames,
  nearbyRegionNames,
} from './nearbyStations'
import type { StationCoordsData } from './stationCoords'

// 東京駅を自宅とする。半径 30km の内外を作りやすい。
const HOME = { lat: 35.681, lng: 139.767 }

// 東京駅からの距離: 新宿 約 6km / 横浜 約 27km / 熊谷 約 60km / 父島 約 1000km
const SHINJUKU: [number, number] = [35.690, 139.700]
const YOKOHAMA: [number, number] = [35.466, 139.622]
const KUMAGAYA: [number, number] = [36.147, 139.389]
const CHICHIJIMA: [number, number] = [27.094, 142.192]

describe('nearbyKyoshinIndices', () => {
  it('半径内の観測点の添字だけを返す', () => {
    const sites = [SHINJUKU, KUMAGAYA, YOKOHAMA]
    expect(nearbyKyoshinIndices(sites, HOME)).toEqual([0, 2])
  })

  it('半径外しかなければ空を返す（呼び出し側が「位置なし」へ倒せる）', () => {
    expect(nearbyKyoshinIndices([KUMAGAYA, CHICHIJIMA], HOME)).toEqual([])
  })

  it('離島では遠くの本土を拾わない（K 点方式との違い）', () => {
    // 父島を自宅にすると、本土の点は 1000km 先。近い順に K 点を採る方式なら本土が入ってしまう。
    const home = { lat: CHICHIJIMA[0], lng: CHICHIJIMA[1] }
    expect(nearbyKyoshinIndices([SHINJUKU, YOKOHAMA, KUMAGAYA], home)).toEqual([])
  })

  it('半径を広げれば拾う範囲も広がる', () => {
    expect(nearbyKyoshinIndices([KUMAGAYA], HOME, 100)).toEqual([0])
  })

  it('欠けた要素があっても他の点の判定を止めない', () => {
    const sites = [undefined as unknown as [number, number], SHINJUKU]
    expect(nearbyKyoshinIndices(sites, HOME)).toEqual([1])
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

describe('NEARBY_RADIUS_KM', () => {
  it('既定の半径は 30km（欠測耐性と精度の折り合い）', () => {
    expect(NEARBY_RADIUS_KM).toBe(30)
  })
})
