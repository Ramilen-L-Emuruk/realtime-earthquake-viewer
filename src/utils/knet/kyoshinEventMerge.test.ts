import { describe, expect, test } from 'vitest'
import { buildGlobalStationRegistry, buildEventFrames, mergeEvents, type EventResult } from './kyoshinEventMerge'

function makeEvent(originTimeJst: string, stations: { code: string; lat: number; lon: number; points: { epochSec: number; intensity: number | null }[] }[]): EventResult {
  const stationSeries = stations.map((s) => ({ stationCode: s.code, latitude: s.lat, longitude: s.lon, points: s.points }))
  const peakIntensity = Math.max(...stationSeries.flatMap((s) => s.points.map((p) => p.intensity ?? -Infinity)))
  return { originTimeJst, stationSeries, peakIntensity }
}

describe('buildGlobalStationRegistry', () => {
  test('正: 複数イベントの観測点をstationCodeで名寄せする', () => {
    const events = [
      makeEvent('20180906030800', [
        { code: 'AAA', lat: 1, lon: 1, points: [] },
        { code: 'BBB', lat: 2, lon: 2, points: [] },
      ]),
      makeEvent('20181005090000', [
        { code: 'BBB', lat: 999, lon: 999, points: [] }, // 2件目のイベントにも登場（初出の座標を優先）
        { code: 'CCC', lat: 3, lon: 3, points: [] },
      ]),
    ]
    const { stationOrder, siteCoords } = buildGlobalStationRegistry(events)
    expect(stationOrder).toEqual(['AAA', 'BBB', 'CCC'])
    expect(siteCoords).toEqual([[1, 1], [2, 2], [3, 3]])
  })

  test('対照: 観測点が1件も重複しない場合は単純に連結される', () => {
    const events = [
      makeEvent('e1', [{ code: 'X', lat: 0, lon: 0, points: [] }]),
      makeEvent('e2', [{ code: 'Y', lat: 0, lon: 0, points: [] }]),
    ]
    expect(buildGlobalStationRegistry(events).stationOrder).toEqual(['X', 'Y'])
  })
})

describe('buildEventFrames', () => {
  test('正: 観測点ごとの震度をグローバルなsite indexの位置へ配置する', () => {
    const event = makeEvent('e1', [
      { code: 'A', lat: 0, lon: 0, points: [{ epochSec: 100, intensity: 4.5 }, { epochSec: 101, intensity: 5.0 }] },
      { code: 'B', lat: 0, lon: 0, points: [{ epochSec: 100, intensity: 3.0 }, { epochSec: 101, intensity: null }] },
    ])
    // グローバル登録では B が index 0, A が index 1（呼び出し側の統合順を模す）
    const stationIndexOf = new Map([['B', 0], ['A', 1]])
    const frames = buildEventFrames(event, stationIndexOf, 2, 1)

    expect(frames).toHaveLength(2)
    expect(frames[0].time).toBe(new Date(100_000).toISOString())
    expect(frames[0].indices[0]).toBeGreaterThanOrEqual(0) // B: 3.0 → 有効な震度
    expect(frames[0].indices[1]).toBeGreaterThanOrEqual(0) // A: 4.5 → 有効な震度
    expect(frames[1].indices[0]).toBe(-1) // B: intensity=null → 欠測
    expect(frames[1].indices[1]).toBeGreaterThanOrEqual(0) // A: 5.0 → 有効な震度
  })

  test('安全弁: 観測点間でepochSecの範囲がずれていても、全体の最小〜最大を1フレームずつ埋める', () => {
    const event = makeEvent('e1', [
      { code: 'A', lat: 0, lon: 0, points: [{ epochSec: 10, intensity: 1.0 }] },
      { code: 'B', lat: 0, lon: 0, points: [{ epochSec: 13, intensity: 1.0 }] },
    ])
    const stationIndexOf = new Map([['A', 0], ['B', 1]])
    const frames = buildEventFrames(event, stationIndexOf, 2, 1)
    expect(frames.map((f) => f.time)).toEqual([10, 11, 12, 13].map((s) => new Date(s * 1000).toISOString()))
    // t=10ではAのみ値がある。Bはこの観測点がまだ記録開始前のため欠測。
    expect(frames[0].indices).toEqual([frames[0].indices[0], -1])
    // t=13ではBのみ値がある。
    expect(frames[3].indices).toEqual([-1, frames[3].indices[1]])
  })
})

describe('mergeEvents', () => {
  test('正: 離れた複数イベントのフレームを時刻順に連結し、間の期間はフレームを作らない（スパース）', () => {
    // 本震と1ヶ月後の余震を模す。間の期間（数百万秒）に1秒刻みでフレームを作ると
    // ファイルサイズが破綻するため、両イベントの実際の記録範囲だけがフレームになることを確認する。
    const mainshock = makeEvent('mainshock', [
      { code: 'A', lat: 0, lon: 0, points: [{ epochSec: 1000, intensity: 6.0 }, { epochSec: 1001, intensity: 6.5 }] },
    ])
    const aftershock = makeEvent('aftershock', [
      { code: 'A', lat: 0, lon: 0, points: [{ epochSec: 3_000_000, intensity: 4.0 }] },
      { code: 'B', lat: 1, lon: 1, points: [{ epochSec: 3_000_000, intensity: 3.5 }] }, // 本震には無かった新規観測点
    ])

    const { stationOrder, siteCoords, frames } = mergeEvents([mainshock, aftershock], 1)

    expect(stationOrder).toEqual(['A', 'B'])
    expect(siteCoords).toEqual([[0, 0], [1, 1]])
    // 本震2フレーム + 余震1フレーム = 3件。間の約3000日ぶんは作らない。
    expect(frames).toHaveLength(3)
    expect(frames.map((f) => f.time)).toEqual([
      new Date(1000_000).toISOString(),
      new Date(1001_000).toISOString(),
      new Date(3_000_000_000).toISOString(),
    ])
    // 余震のフレームでは、本震にしか登場しなかった観測点Aの分もindices配列に含まれる
    // （このフレームの時点でAは欠測扱いではなく、余震での実測値=4.0相当が入る）
    expect(frames[2].indices).toHaveLength(2)
  })

  test('対照: イベントを--originの指定順と逆に渡しても時刻順に並び替えられる', () => {
    const later = makeEvent('later', [{ code: 'A', lat: 0, lon: 0, points: [{ epochSec: 200, intensity: 3.0 }] }])
    const earlier = makeEvent('earlier', [{ code: 'A', lat: 0, lon: 0, points: [{ epochSec: 100, intensity: 3.0 }] }])
    const { frames } = mergeEvents([later, earlier], 1)
    expect(frames.map((f) => f.time)).toEqual([new Date(100_000).toISOString(), new Date(200_000).toISOString()])
  })
})
