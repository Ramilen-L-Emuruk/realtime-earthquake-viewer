// 波形へ引く P/S の到達線の、時刻の出し方。
//
// **固定するのは 3 つ** ——単位（秒とミリ秒を取り違えないこと）・順序（P が先）・
// **求まらない入力を弾くこと**（センチネルは有限値なので `Number.isFinite` をすり抜ける）。
// 走時そのものの正しさは `travelTime.test.ts` の担当。

import { describe, expect, it } from 'vitest'

import { computeWaveArrival } from './seismoWaveArrival'
import type { Hypocenter } from '../types/earthquake'

const ORIGIN_MS = new Date('2026-09-30T12:00:00+09:00').getTime()

function hypo(over: Partial<Hypocenter> = {}): Hypocenter {
  return {
    name: '能登半島沖',
    latitude: 37.5,
    longitude: 137.2,
    depth: 16,
    magnitude: 7.6,
    ...over,
  } as Hypocenter
}

/** 自宅の観測点に見立てた座標（東京・千代田区あたり）。 */
const HOME = { stationLat: 35.68, stationLon: 139.77 }

describe('computeWaveArrival', () => {
  it('P が先・S が後で、どちらも発生時刻より後に来る', () => {
    const got = computeWaveArrival({ originMs: ORIGIN_MS, hypocenter: hypo(), ...HOME })
    expect(got).not.toBeNull()
    expect(got!.pMs).toBeGreaterThan(ORIGIN_MS)
    expect(got!.sMs).toBeGreaterThan(got!.pMs)
  })

  it('単位はミリ秒（震源の真上で数秒のオーダーに収まる）', () => {
    // **秒とミリ秒の取り違えを捕まえる。** 深さ 16km の直上なら P は数秒で届く ——
    // 秒のまま足していれば 1000 分の 1、桁を間違えていれば 1000 倍になる。
    const got = computeWaveArrival({
      originMs: ORIGIN_MS,
      hypocenter: hypo(),
      stationLat: 37.5,
      stationLon: 137.2,
    })
    const pSec = (got!.pMs - ORIGIN_MS) / 1000
    expect(pSec).toBeGreaterThan(1)
    expect(pSec).toBeLessThan(10)
  })

  it('遠いほど遅く届く', () => {
    const near = computeWaveArrival({
      originMs: ORIGIN_MS,
      hypocenter: hypo(),
      stationLat: 37.0,
      stationLon: 137.5,
    })
    const far = computeWaveArrival({ originMs: ORIGIN_MS, hypocenter: hypo(), ...HOME })
    expect(far!.sMs).toBeGreaterThan(near!.sMs)
  })

  it('深さ不明（-1）の地震では線を引かない', () => {
    // **対照。** `0` は「ごく浅い」という有効値なので、そちらは通ること（次のテスト）。
    expect(
      computeWaveArrival({ originMs: ORIGIN_MS, hypocenter: hypo({ depth: -1 }), ...HOME }),
    ).toBeNull()
  })

  it('深さ 0（ごく浅い）は有効値として通す', () => {
    expect(
      computeWaveArrival({ originMs: ORIGIN_MS, hypocenter: hypo({ depth: 0 }), ...HOME }),
    ).not.toBeNull()
  })

  it('位置不明のセンチネル（-200）では線を引かない', () => {
    // **安全弁。** `-200` は有限値なので `Number.isFinite` では弾けない。
    expect(
      computeWaveArrival({
        originMs: ORIGIN_MS,
        hypocenter: hypo({ latitude: -200, longitude: -200 }),
        ...HOME,
      }),
    ).toBeNull()
  })

  it('観測点の座標をホストが持っていなければ線を引かない', () => {
    expect(
      computeWaveArrival({
        originMs: ORIGIN_MS,
        hypocenter: hypo(),
        stationLat: null,
        stationLon: null,
      }),
    ).toBeNull()
  })

  it('発生時刻が読めなければ線を引かない', () => {
    expect(computeWaveArrival({ originMs: NaN, hypocenter: hypo(), ...HOME })).toBeNull()
  })
})
