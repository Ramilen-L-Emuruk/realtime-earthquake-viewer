import { describe, expect, it } from 'vitest'

import type { WaveSampleChunk } from '../../services/seismoWaveSamples'
import type { SampleSeries } from './sampleSeries'
import {
  buildSampleSeries,
  emphasizeValue,
  laneGeometry,
  maxAbsInRange,
  measureMagnitudeFloor,
  movingAverage,
  peakInRange,
  seriesRange,
  signedMovingAverages,
  valueTransform,
  vectorMagnitude,
  visibleIndexRange,
} from './sampleSeries'

const T0 = 1_790_000_000_000
const MS = 10

function chunk(startMs: number, values: number[]): WaveSampleChunk {
  const a = Float32Array.from(values)
  return {
    firstSampleMs: startMs,
    msPerSample: MS,
    gal: [a, Float32Array.from(values.map((x) => x / 2)), Float32Array.from(values.map(() => 0))],
    memberCount: Float32Array.from(values.map(() => 3)),
  }
}

describe('buildSampleSeries', () => {
  it('続いたまとまりは途切れを挟まず 1 本に繋ぐ（並びは時刻順）', () => {
    const s = buildSampleSeries([chunk(T0 + 30, [4, 5, 6]), chunk(T0, [1, 2, 3])])
    expect(Array.from(s.t)).toEqual([0, 10, 20, 30, 40, 50].map((d) => T0 + d))
    expect(Array.from(s.v[0])).toEqual([1, 2, 3, 4, 5, 6])
  })

  // 正: 届かなかった時間を一直線に結ばないよう、途切れに欠測を挟む。
  it('途切れには欠測を 1 つ挟む', () => {
    const s = buildSampleSeries([chunk(T0, [1, 2]), chunk(T0 + 200, [3, 4])])
    expect(s.length).toBe(5)
    expect(Number.isNaN(s.v[0][2])).toBe(true)
  })

  // 対照: 刻みのわずかな揺らぎは途切れと見なさない。
  it('刻みのわずかなずれは続きとして繋ぐ', () => {
    const s = buildSampleSeries([chunk(T0, [1, 2]), chunk(T0 + 21, [3])])
    expect(s.length).toBe(3)
    expect(Array.from(s.v[0])).toEqual([1, 2, 3])
  })

  // 安全弁: 2 分ずつ取った境目で同じまとまりが 2 度返っても、点を重ねない。
  it('重なった点は捨てる', () => {
    const s = buildSampleSeries([chunk(T0, [1, 2, 3]), chunk(T0, [1, 2, 3]), chunk(T0 + 30, [4])])
    expect(Array.from(s.v[0])).toEqual([1, 2, 3, 4])
  })

  it('空なら長さ 0 で範囲は null', () => {
    const s = buildSampleSeries([])
    expect(s.length).toBe(0)
    expect(seriesRange(s)).toBeNull()
  })
})

describe('visibleIndexRange', () => {
  it('範囲の外側の 1 点ずつも含める', () => {
    const s = buildSampleSeries([chunk(T0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])])
    expect(visibleIndexRange(s, { fromMs: T0 + 25, toMs: T0 + 55 })).toEqual({ start: 2, end: 7 })
  })
})

describe('emphasizeValue', () => {
  it('幅の内側は 0、外側は幅だけ寄せる（符号は保つ）', () => {
    expect(emphasizeValue(0.5, 0, 1)).toBe(0)
    expect(emphasizeValue(3, 0, 1)).toBe(2)
    expect(emphasizeValue(-3, 0, 1)).toBe(-2)
  })

  // 安全弁: 欠測を本物の 0 に化けさせない。
  it('非有限は非有限のまま', () => {
    expect(Number.isNaN(emphasizeValue(Number.NaN, 0, 1))).toBe(true)
  })
})

describe('maxAbsInRange', () => {
  it('範囲の中の成分ごとの最大（変換後）', () => {
    const s = buildSampleSeries([chunk(T0, [1, -8, 2, 20])])
    const t = valueTransform(null)
    expect(maxAbsInRange(s, { fromMs: T0, toMs: T0 + 20 }, t)).toEqual([8, 4, 0])
  })
})

describe('laneGeometry', () => {
  const s = buildSampleSeries([chunk(T0, Array.from({ length: 1000 }, (_, i) => Math.sin(i / 5)))])
  const transform = valueTransform(null)

  // 正: 寄せて 1 ピクセルの点が少なければ、点そのものを結ぶ（波の形が出る）。
  it('点が少なければ点を返す', () => {
    const g = laneGeometry({ series: s, values: s.v[0], range: { fromMs: T0, toMs: T0 + 1000 }, widthPx: 500, map: (v) => transform(0, v) })
    expect(g.kind).toBe('points')
  })

  // 対照: 広く見ていて点が多ければ、1 ピクセルごとの上下の端にする。
  it('点が多ければ包絡を返す', () => {
    const g = laneGeometry({ series: s, values: s.v[0], range: { fromMs: T0, toMs: T0 + 10_000 }, widthPx: 100, map: (v) => transform(0, v) })
    expect(g.kind).toBe('envelope')
    if (g.kind === 'envelope') {
      expect(g.min.length).toBe(100)
      expect(g.max[0]).toBeGreaterThan(g.min[0])
    }
  })
})

describe('vectorMagnitude', () => {
  it('各時刻の 3 成分の二乗和の平方根', () => {
    // chunk() は南北 x・東西 x/2・上下 0
    const s = buildSampleSeries([chunk(T0, [2, -4])])
    const m = vectorMagnitude(s, [true, true, true])
    // Float32Array に入るので 32 bit の精度で比べる
    expect(m[0]).toBeCloseTo(Math.sqrt(5), 5)
    expect(m[1]).toBeCloseTo(Math.sqrt(20), 5)
  })

  // 安全弁: 欠けた成分を 0 と見なして小さく描かない。
  it('1 成分でも欠けていれば NaN', () => {
    const c = chunk(T0, [1, 1])
    c.gal[2][1] = Number.NaN
    const m = vectorMagnitude(buildSampleSeries([c]), [true, true, true])
    expect(m[0]).toBeCloseTo(Math.sqrt(1.25), 5)
    expect(Number.isNaN(m[1])).toBe(true)
  })

  // 途切れ（buildSampleSeries が挟む欠測）も NaN のまま。
  it('途切れは NaN のまま', () => {
    const m = vectorMagnitude(buildSampleSeries([chunk(T0, [1]), chunk(T0 + 200, [1])]), [true, true, true])
    expect(Number.isNaN(m[1])).toBe(true)
  })
})

describe('vectorMagnitude（選んだ成分だけ）', () => {
  // 正: 消した成分は含めない（2026-10-05 のユーザー判断）。
  it('上下を消せば水平 2 成分の合成', () => {
    const c = chunk(T0, [3])
    c.gal[2][0] = 100
    expect(vectorMagnitude(buildSampleSeries([c]), [true, true, false])[0]).toBeCloseTo(Math.sqrt(9 + 2.25), 5)
  })

  it('1 成分だけならその振れの絶対値', () => {
    expect(vectorMagnitude(buildSampleSeries([chunk(T0, [-3])]), [true, false, false])[0]).toBe(3)
  })

  // 安全弁: 消した成分が欠けていても、選んだ成分で出す。
  it('消した成分の欠けは影響しない', () => {
    const c = chunk(T0, [2])
    c.gal[2][0] = Number.NaN
    expect(vectorMagnitude(buildSampleSeries([c]), [true, false, false])[0]).toBe(2)
  })
})

describe('movingAverage', () => {
  it('各時刻の前後の幅で平均する', () => {
    // 10 ms 刻み、幅 20 ms（前後 10 ms）
    const s = buildSampleSeries([chunk(T0, [0, 3, 6, 9])])
    expect(Array.from(movingAverage(s, s.v[0], 20))).toEqual([1.5, 3, 6, 7.5])
  })

  // 安全弁: 途切れ（NaN）は均した線でも切る。窓の中の NaN は平均に数えない。
  it('元が NaN の点は NaN のまま・窓の中の NaN は数えない', () => {
    const c = chunk(T0, [2, 4, 6])
    c.gal[0][1] = Number.NaN
    const s = buildSampleSeries([c])
    const m = movingAverage(s, s.v[0], 20)
    expect(m[0]).toBe(2)
    expect(Number.isNaN(m[1])).toBe(true)
    expect(m[2]).toBe(6)
  })
})

describe('peakInRange', () => {
  it('範囲の中の最大とその時刻（同じ値なら最初）', () => {
    const s = buildSampleSeries([chunk(T0, [1, 5, 2, 5, 9])])
    expect(peakInRange(s, s.v[0], { fromMs: T0, toMs: T0 + 30 })).toEqual({ value: 5, atMs: T0 + 10 })
  })

  it('値が無ければ null', () => {
    const s = buildSampleSeries([chunk(T0, [Number.NaN, Number.NaN])])
    expect(peakInRange(s, s.v[0], { fromMs: T0, toMs: T0 + 10 })).toBeNull()
  })
})

describe('signedMovingAverages', () => {
  // 正: 正側・負側を別々に平均する（そのまま平均すると 0 に潰れる）。
  it('正側と負側を分けて平均する', () => {
    // 10 ms 刻み、幅 40 ms（前後 20 ms）。中央の点の窓は 5 点 [2, -2, 4, -4, 6]
    const s = buildSampleSeries([chunk(T0, [2, -2, 4, -4, 6])])
    const { pos, neg } = signedMovingAverages(s, s.v[0], 40)
    expect(pos[2]).toBe(4)
    expect(neg[2]).toBe(-3)
  })

  // 対照: 片側に偏った動きでは 2 本の高さが食い違う。
  it('片側だけに振れれば反対側は 0', () => {
    const s = buildSampleSeries([chunk(T0, [1, 2, 3])])
    const { pos, neg } = signedMovingAverages(s, s.v[0], 40)
    expect(pos[1]).toBe(2)
    expect(neg[1]).toBe(0)
  })

  // 安全弁: 途切れは平均の線でも切る。
  it('元が NaN の点は NaN のまま', () => {
    const c = chunk(T0, [1, 2, 3])
    c.gal[0][1] = Number.NaN
    const s = buildSampleSeries([c])
    const { pos, neg } = signedMovingAverages(s, s.v[0], 40)
    expect(Number.isNaN(pos[1])).toBe(true)
    expect(Number.isNaN(neg[1])).toBe(true)
    expect(pos[0]).toBe(2)
  })
})

describe('measureMagnitudeFloor', () => {
  const ZERO = T0 + 30_000
  /** 0 の手前 30 秒、100 Hz。各秒の最大が `peak(秒)` になる。 */
  function quiet(seconds: number, peak: (sec: number) => number): SampleSeries {
    const values: number[] = []
    for (let i = 0; i < seconds * 100; i += 1) values.push(i % 100 === 50 ? peak(Math.floor(i / 100)) : 0.1)
    const start = ZERO - seconds * 1000
    const a = Float32Array.from(values)
    return buildSampleSeries([
      {
        firstSampleMs: start,
        msPerSample: 10,
        gal: [a, new Float32Array(a.length), new Float32Array(a.length)],
        memberCount: new Float32Array(a.length).fill(3),
      },
    ])
  }

  it('1 秒ごとの最大の中央値の 1.5 倍', () => {
    const s = quiet(30, (sec) => (sec % 2 === 0 ? 1 : 3))
    // 中央値は (1 + 3) / 2 = 2 → 3
    expect(measureMagnitudeFloor(s, vectorMagnitude(s, [true, true, true]), ZERO)).toBeCloseTo(3, 5)
  })

  it('下限は 0.2 gal', () => {
    const s = quiet(30, () => 0.05)
    expect(measureMagnitudeFloor(s, vectorMagnitude(s, [true, true, true]), ZERO)).toBeCloseTo(0.2, 5)
  })

  // 対照: ちょうど 10 秒あれば測る。
  it('値のある 1 秒がちょうど 10 なら測る', () => {
    const s = quiet(10, () => 1)
    expect(measureMagnitudeFloor(s, vectorMagnitude(s, [true, true, true]), ZERO)).toBeCloseTo(1.5, 5)
  })

  // 安全弁: 足りなければ測らない（推測で底を置かない）。
  it('値のある 1 秒が 10 に満たなければ null', () => {
    const s = quiet(9, () => 1)
    expect(measureMagnitudeFloor(s, vectorMagnitude(s, [true, true, true]), ZERO)).toBeNull()
  })
})
