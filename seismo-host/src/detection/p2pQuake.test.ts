import { describe, expect, it } from 'vitest'

import { parseP2pQuakeItem, parseP2pQuakeList, parseP2pTime } from './p2pQuake'

/** P2PQuake の地震情報（code 551）の形。値は 2026-10-03 13:26 の実物から。 */
function item(overrides: { time?: string; lat?: number; lon?: number; depth?: number; mag?: number; issue?: string } = {}) {
  return {
    code: 551,
    issue: { type: overrides.issue ?? 'DetailScale' },
    earthquake: {
      time: overrides.time ?? '2026/10/03 13:26:00',
      maxScale: 20,
      hypocenter: {
        name: '熊本県天草・芦北地方',
        latitude: overrides.lat ?? 32.5,
        longitude: overrides.lon ?? 130.5,
        depth: overrides.depth ?? 0,
        magnitude: overrides.mag ?? 3.5,
      },
    },
  }
}

describe('parseP2pTime', () => {
  it('日本時間の文字列を unix ミリ秒へ', () => {
    expect(parseP2pTime('2026/10/03 13:26:05')).toBe(Date.UTC(2026, 9, 3, 4, 26, 5))
  })

  it('形が違えば null', () => {
    expect(parseP2pTime('2026-10-03T13:26:05+09:00')).toBeNull()
  })
})

describe('parseP2pQuakeItem', () => {
  it('震源と発生時刻を読む。秒が 00 なら分単位として幅を 60 秒にする', () => {
    const q = parseP2pQuakeItem(item())!
    expect(q.originMs).toBe(Date.UTC(2026, 9, 3, 4, 26, 0))
    expect(q.originPrecisionMs).toBe(60_000)
    expect(q.depthKm).toBe(0)
    expect(q.magnitude).toBe(3.5)
    expect(q.maxScale).toBe(20)
  })

  it('秒まであれば幅は 1 秒', () => {
    expect(parseP2pQuakeItem(item({ time: '2026/10/03 13:26:05' }))!.originPrecisionMs).toBe(1_000)
  })

  it('深さ・規模の -1（不明）は null にする —— 深さ 0（ごく浅い）と混ぜない', () => {
    const q = parseP2pQuakeItem(item({ depth: -1, mag: -1 }))!
    expect(q.depthKm).toBeNull()
    expect(q.magnitude).toBeNull()
  })

  it('震源未確定（緯度 -200）・地震情報以外は null', () => {
    expect(parseP2pQuakeItem(item({ lat: -200, lon: -200 }))).toBeNull()
    expect(parseP2pQuakeItem({ ...item(), code: 556 })).toBeNull()
    expect(parseP2pQuakeItem(null)).toBeNull()
  })
})

describe('parseP2pQuakeList', () => {
  it('同じ地震の報（震源・各地の震度）は 1 件にまとめる', () => {
    const { quakes, unreadable } = parseP2pQuakeList([
      item({ issue: 'Destination' }),
      item({ issue: 'DetailScale' }),
      item({ time: '2026/10/03 13:24:00', mag: 3.0 }),
    ])
    expect(quakes).toHaveLength(2)
    expect(quakes.map((q) => q.magnitude)).toEqual([3.0, 3.5])
    expect(unreadable).toBe(0)
  })

  it('地震情報なのに読めないものは数える。震度速報（震源未確定）と他の種別は数えない', () => {
    const { quakes, unreadable } = parseP2pQuakeList([
      item({ lat: -200, lon: -200 }),
      { code: 556 },
      { code: 551, earthquake: { time: 'こわれた' } },
    ])
    expect(quakes).toHaveLength(0)
    expect(unreadable).toBe(1)
  })

  it('配列でなければ空', () => {
    expect(parseP2pQuakeList({})).toEqual({ quakes: [], unreadable: 0 })
  })
})
