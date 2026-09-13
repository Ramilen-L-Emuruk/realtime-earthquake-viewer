// @vitest-environment jsdom
//
// 震度が届いていない観測点（「震度５弱以上未入電」）を、地図のどの経路が数えるか。
//
// 未入電は下限の 45（5弱）へ寄せてあるだけの推定値で、観測値ではない。混ぜると、気象庁が
// 震度4 と発表している区域を 5弱 で塗るところまで行く（実電文で 12 区域あった。
// → docs/spec/quake-spec.md §4「震度5弱以上未入電」）。
//
// React を動かすため、このファイルだけ jsdom 環境で実行する（既定の node は変えない）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { JMAQuake, EarthquakePoint } from '../types/earthquake'
import type { SubRegion } from '../utils/subregions'
import type { StationCoordsData } from '../utils/stationCoords'

const PREF = '愛媛県'
const AREA = '愛媛県中予'

function sub(name: string, lat: number, lng: number): SubRegion {
  return {
    name,
    label: [lat, lng],
    room: [0.2, 0.2],
    rings: [[[lat + 0.2, lng - 0.2], [lat + 0.2, lng + 0.2], [lat - 0.2, lng + 0.2], [lat - 0.2, lng - 0.2]]],
  }
}

vi.mock('./useSubRegions', () => ({
  useSubRegions: () => ({ data: [sub(AREA, 33.8, 132.7)], failed: false }),
}))

// 観測点 2 つだけの座標テーブル。どちらも同じ区域（愛媛県中予）に属させる。
const COORDS: StationCoordsData = {
  stations: {
    [`${PREF}|観測できた点`]: [33.80, 132.70, 0],
    [`${PREF}|届かなかった点`]: [33.85, 132.75, 0],
  },
  areas: { [`${PREF}|${AREA}`]: [33.8, 132.7] },
  regionNames: [AREA],
}
vi.mock('./useStationCoords', () => ({ useStationCoords: () => COORDS }))

const { useQuakeLayerData } = await import('./useQuakeLayerData')
const { log } = await import('../utils/logger')

/** 区域集約が働くズーム（zoom <= aggregateMaxZoom）。 */
const AGGREGATED = { zoom: 5, aggregateMaxZoom: 8 }
/** 観測点ごとに描くズーム。 */
const ZOOMED_IN = { zoom: 10, aggregateMaxZoom: 8 }

function point(over: Partial<EarthquakePoint> & Pick<EarthquakePoint, 'addr'>): EarthquakePoint {
  return { pref: PREF, scale: 40, isArea: false, ...over }
}

function makeQuake(points: EarthquakePoint[]): JMAQuake {
  const time = '2026-09-13T03:00:00Z'
  return {
    kind: 'quake',
    id: `quake-${time}`,
    time,
    issue: { source: 'dmdata', time, type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time,
      hypocenter: { name: '日向灘', latitude: 32.7, longitude: 132.1, depth: 40, magnitude: 6.4 },
      maxScale: 45,
      domesticTsunami: 'なし',
    },
    points,
  }
}

function layers(points: EarthquakePoint[], view = AGGREGATED, unreceivedMode = false) {
  const { result } = renderHook(() =>
    useQuakeLayerData('quake', makeQuake(points), view, null, false, null, unreceivedMode))
  return result.current
}

/** 観測できた点（震度4）と、届かなかった点（未入電・下限 45）が同じ区域に混じる電文。 */
const MIXED: EarthquakePoint[] = [
  point({ addr: '観測できた点', scale: 40 }),
  point({ addr: '届かなかった点', scale: 45, unreceived: true }),
  // 電文自身が言っている区域の最大震度。気象庁は 4 と発表している。
  { pref: '', addr: AREA, scale: 40, isArea: true },
]

describe('未入電の点を地図のどの経路が数えるか', () => {
  // 正: 区域塗りは電文が言っている 4 のまま。未入電は押し上げない。
  it('区域塗りは未入電で押し上げられない', () => {
    expect(layers(MIXED).regionAggregates.map(a => [a.name, a.scale])).toEqual([[AREA, 40]])
  })

  // 対照: 観測できた震度なら、同じ経路がちゃんと押し上げる（未入電だけを外していることの確認）。
  // これが無いと「区域塗りが常に電文の区域点しか見ていない」実装でも上のテストが通ってしまう。
  it('観測できた震度なら区域塗りを押し上げる', () => {
    const points: EarthquakePoint[] = [
      point({ addr: '観測できた点', scale: 40 }),
      point({ addr: '届かなかった点', scale: 45 }),
      { pref: '', addr: AREA, scale: 40, isArea: true },
    ]
    expect(layers(points).regionAggregates.map(a => [a.name, a.scale])).toEqual([[AREA, 45]])
  })

  // 正: 区域の点そのものが未入電で届いた場合も数えない（パス2 側）。
  it('区域の点が未入電でも区域塗りを押し上げない', () => {
    const points: EarthquakePoint[] = [
      point({ addr: '観測できた点', scale: 40 }),
      { pref: '', addr: AREA, scale: 45, isArea: true, unreceived: true },
    ]
    expect(layers(points).regionAggregates.map(a => [a.name, a.scale])).toEqual([[AREA, 40]])
  })

  // 正: 観測値の丸バッジ（stationMarkers）と未入電の印（unreceivedMarkers）は排他。
  it('観測値のドットと未入電の印を取り違えない', () => {
    const { stationMarkers, unreceivedMarkers } = layers(MIXED, ZOOMED_IN)
    expect(stationMarkers.map(m => m.addr)).toEqual(['観測できた点'])
    expect(unreceivedMarkers.map(m => m.addr)).toEqual(['届かなかった点'])
    expect(unreceivedMarkers[0]?.unreceived).toBe(true)
  })

  // 正: 震源の吹き出しの都道府県別最大震度も、カードの県の行と同じ 4 になる。
  it('都道府県別最大震度は未入電で押し上げられない', () => {
    expect(layers(MIXED).prefIntensities).toEqual([{ pref: PREF, scale: 40, unreceived: false }])
  })

  // 正: 観測値が 1 件も無い県は、未入電として一覧に残す（カードは配下から積み上げて出すので、
  // ここで落とすと画面の中で食い違う）。
  it('観測値が無い県は未入電として都道府県別最大震度に残る', () => {
    const onlyUnreceived = [point({ addr: '届かなかった点', scale: 45, unreceived: true })]
    expect(layers(onlyUnreceived).prefIntensities)
      .toEqual([{ pref: PREF, scale: 45, unreceived: true }])
  })

  // 安全弁: 観測値がある県に未入電の値を足さない（1 県 1 行のまま）。
  it('観測値がある県は未入電で二重に並ばない', () => {
    expect(layers(MIXED).prefIntensities).toHaveLength(1)
  })

  // 安全弁: 未入電しか無い電文でも区域集約へ倒さない。
  // 「観測点 0 件」の判定が観測値だけを数えていると集約が維持され、区域塗りは（未入電を混ぜない
  // ので）空、観測点のドットも出ない、という形で地図から震度が丸ごと消える。
  it('未入電しか無い電文では区域集約へ倒さない', () => {
    const onlyUnreceived = [point({ addr: '届かなかった点', scale: 45, unreceived: true })]
    expect(layers(onlyUnreceived, ZOOMED_IN).aggregateByRegion).toBe(false)
  })

  // 安全弁: 観測点を 1 つも持たない電文（震度速報）は従来どおり集約を維持する。
  // 上の一件で「観測点 0 件」の判定を緩めすぎていないこと。
  it('区域しか持たない電文では集約を維持する', () => {
    const areaOnly: EarthquakePoint[] = [{ pref: '', addr: AREA, scale: 40, isArea: true }]
    expect(layers(areaOnly, ZOOMED_IN).aggregateByRegion).toBe(true)
  })
})

describe('未入電モードのカメラの寄り先', () => {
  // 正: 未入電の地点だけへ寄せる（観測点も震源も混ぜない）。
  it('未入電の地点だけを寄り先にする', () => {
    const fit = layers(MIXED, AGGREGATED, true).quakeFitPositions
    expect(fit).toEqual([[33.85, 132.75]])
  })

  // 対照: モードを開いていなければ従来どおり（区域の外接矩形＋震源）。
  it('開いていなければ従来の寄り先', () => {
    const fit = layers(MIXED).quakeFitPositions
    expect(fit.length).toBeGreaterThan(1)
  })

  // 安全弁: 未入電の地点を 1 つも地図へ置けないときは通常の寄り先へ落とす。
  // 空を返すとカメラが動かず、モードへ入ったこと自体が画面に出ない。
  it('置ける未入電が無ければ通常の寄り先へ落とす', () => {
    const noCoords: EarthquakePoint[] = [
      point({ addr: '観測できた点', scale: 40 }),
      // 座標表に無い観測点（廃止された点など）。
      point({ addr: '座標表に無い点', scale: 45, unreceived: true }),
      { pref: '', addr: AREA, scale: 40, isArea: true },
    ]
    const fit = layers(noCoords, AGGREGATED, true).quakeFitPositions
    expect(fit.length).toBeGreaterThan(1)
  })
})

describe('地図へ置けなかった未入電の地点', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  // 正: 座標表を引けない未入電の地点は、黙って落とさず記録する。
  // 未入電はこの印が地図上の唯一の表現で、カードの一覧には出るため、記録が無いと
  // 「地図とカードで地点の有無が食い違う」ことに誰も気づけない。
  it('座標表に無い未入電の地点は記録する', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    layers([
      point({ addr: '観測できた点', scale: 40 }),
      point({ addr: '座標表に無い点', scale: 45, unreceived: true }),
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toEqual({ names: ['座標表に無い点'] })
  })

  // 対照: 置けた地点は記録しない（毎回鳴ると他の警告が埋もれる）。
  it('置けた未入電の地点では記録しない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    layers(MIXED)
    expect(warn).not.toHaveBeenCalled()
  })

  // 安全弁: 観測値の点が置けなかったときは、この記録を鳴らさない。
  // 観測値は区域塗りや隣の点が残るので事情が違う（鳴らすと本題の未入電が埋もれる）。
  it('観測値の点が置けなくても記録しない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    layers([point({ addr: '座標表に無い点', scale: 40 })])
    expect(warn).not.toHaveBeenCalled()
  })
})
