import { describe, expect, it } from 'vitest'

import { predictMeasuredIntensity } from './eew'
import { haversineKm } from './geo'
import { judgeQuakeReach, USUAL_MARGIN, type ReachStation } from './seismoQuakeReach'
import type { Hypocenter } from '../types/earthquake'

// 架空の観測点（どこの家でもない丸めた座標）。
const STATION: ReachStation = { stationId: 'station-1', lat: 33.0, lon: 131.0, usualMeasured: -1.3 }

function hypo(overrides: Partial<Hypocenter> = {}): Hypocenter {
  return { name: '架空の震源', latitude: 33.7, longitude: 131.0, depth: 10, magnitude: 3.0, ...overrides } as Hypocenter
}

/** 震源から観測点までの予測。テストの境目を、実装と同じ式で求めておく。 */
function predicted(h: Hypocenter, s: ReachStation = STATION): number {
  return predictMeasuredIntensity(h.magnitude, h.depth, haversineKm(h.latitude, h.longitude, s.lat!, s.lon!))
}

describe('judgeQuakeReach', () => {
  // 正: 予測が「普段 − 余裕」を上回れば出す（2026-10-13 ユーザー承認の A・余裕 0.5）。
  it('予測が普段より 0.5 低い値を上回れば届く', () => {
    const h = hypo()
    const p = predicted(h)
    const s = { ...STATION, usualMeasured: p + USUAL_MARGIN - 0.01 }
    expect(judgeQuakeReach(h, [s])).toEqual({ kind: 'predicted', stationIds: ['station-1'], unknownStationIds: [] })
  })

  // 対照: 境目の手前（予測 ≦ 普段 − 余裕）では出さない。
  it('予測が普段より 0.5 低い値に届かなければ届かない', () => {
    const h = hypo()
    const p = predicted(h)
    const s = { ...STATION, usualMeasured: p + USUAL_MARGIN + 0.01 }
    expect(judgeQuakeReach(h, [s])).toEqual({ kind: 'predicted', stationIds: [], unknownStationIds: [] })
  })

  it('遠い地震は届かない', () => {
    const far = hypo({ latitude: 43.0, longitude: 145.0, magnitude: 4.0 })
    expect(judgeQuakeReach(far, [STATION])).toEqual({ kind: 'predicted', stationIds: [], unknownStationIds: [] })
  })

  // 安全弁: 普段が読めない間は下限を置かない（予測できる地震はすべて出す）。
  it('普段が読めなければ下限を置かない', () => {
    const far = hypo({ latitude: 43.0, longitude: 145.0, magnitude: 4.0 })
    const s = { ...STATION, usualMeasured: null }
    expect(judgeQuakeReach(far, [s])).toEqual({ kind: 'predicted', stationIds: ['station-1'], unknownStationIds: [] })
  })

  // 安全弁: 予測に要る値が欠けたら決めない（呼び出し側が気象庁の観測で判定する）。
  it.each([
    ['震央が判らない', { latitude: -200, longitude: -200 }],
    ['深さが判らない', { depth: -1 }],
    ['規模が判らない', { magnitude: -1 }],
    ['規模が数値でない', { magnitude: Number.NaN }],
  ] as const)('%s地震は予測しない', (_label, overrides) => {
    expect(judgeQuakeReach(hypo(overrides), [STATION])).toEqual({ kind: 'unknown' })
  })

  it('座標の無い観測点は予測できない側へ回す', () => {
    const noPos = { ...STATION, stationId: 'station-2', lat: null, lon: null }
    expect(judgeQuakeReach(hypo(), [STATION, noPos])).toEqual({
      kind: 'predicted',
      stationIds: ['station-1'],
      unknownStationIds: ['station-2'],
    })
  })

  it('座標のある観測点が 1 つも無ければ決めない', () => {
    const noPos = { ...STATION, lat: null, lon: null }
    expect(judgeQuakeReach(hypo(), [noPos])).toEqual({ kind: 'unknown' })
  })

  it('観測点ごとに判定する', () => {
    const near = STATION
    const far = { ...STATION, stationId: 'station-far', lat: 26.0, lon: 127.7 }
    expect(judgeQuakeReach(hypo({ magnitude: 4.0 }), [near, far])).toEqual({ kind: 'predicted', stationIds: ['station-1'], unknownStationIds: [] })
  })
})
