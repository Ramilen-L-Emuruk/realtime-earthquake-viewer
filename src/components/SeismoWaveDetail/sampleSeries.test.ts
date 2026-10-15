import { describe, expect, it } from 'vitest'

import type { WaveSampleChunk } from '../../services/seismoWaveSamples'
import {
  buildSampleSeries,
  laneGeometry,
  maxAbsInRange,
  movingAverage,
  peakInRange,
  seriesRange,
  signedMovingAverages,
  singleMemberColumns,
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

describe('maxAbsInRange', () => {
  it('範囲の中の成分ごとの最大（変換後）', () => {
    const s = buildSampleSeries([chunk(T0, [1, -8, 2, 20])])
    const t = (_a: number, v: number): number => v
    expect(maxAbsInRange(s, { fromMs: T0, toMs: T0 + 20 }, t)).toEqual([8, 4, 0])
  })
})

describe('laneGeometry', () => {
  const s = buildSampleSeries([chunk(T0, Array.from({ length: 1000 }, (_, i) => Math.sin(i / 5)))])
  const transform = (_a: number, v: number): number => v

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
    // chunk() は東西 x・南北 x/2・上下 0
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

describe('vectorMagnitude（並び全体で値の無い成分）', () => {
  // 上が解けない観測点（ホストが上だけ null を送る）。上を選んでいても段が空にならないように
  // （2026-10-13 ユーザー承認）。
  function withoutVertical(values: number[]): WaveSampleChunk {
    const c = chunk(T0, values)
    c.gal[2].fill(Number.NaN)
    return c
  }

  // 正: 並び全体で 1 点も値の無い成分は外し、残りの成分で合成する。
  it('上が 1 点も無ければ、上を選んでいても水平 2 成分の合成', () => {
    const m = vectorMagnitude(buildSampleSeries([withoutVertical([2, -4])]), [true, true, true])
    expect(m[0]).toBeCloseTo(Math.sqrt(4 + 1), 5)
    expect(m[1]).toBeCloseTo(Math.sqrt(16 + 4), 5)
  })

  // 対照: 一部でも値があれば外さない（点ごとに何成分の合成かを変えない）。欠けた点は描かない。
  it('上が一部の点にあれば外さず、欠けた点は NaN', () => {
    const c = chunk(T0, [1, 1, 1])
    c.gal[2][0] = 2
    c.gal[2][1] = Number.NaN
    c.gal[2][2] = Number.NaN
    const m = vectorMagnitude(buildSampleSeries([c]), [true, true, true])
    expect(m[0]).toBeCloseTo(Math.sqrt(1 + 0.25 + 4), 5)
    expect(Number.isNaN(m[1])).toBe(true)
    expect(Number.isNaN(m[2])).toBe(true)
  })

  // 安全弁: 外した後も、残した成分の欠け（途切れ）は NaN のまま。
  it('上を外しても、途切れは NaN のまま', () => {
    const s = buildSampleSeries([withoutVertical([1]), { ...withoutVertical([1]), firstSampleMs: T0 + 200 }])
    const m = vectorMagnitude(s, [true, true, true])
    expect(m[0]).toBeCloseTo(Math.sqrt(1.25), 5)
    expect(Number.isNaN(m[1])).toBe(true)
  })

  // 安全弁: 選んだ成分がどれも値を持たなければ、全点 NaN（0 に化けない）。
  it('選んだ成分がすべて値を持たなければ NaN', () => {
    const m = vectorMagnitude(buildSampleSeries([withoutVertical([1, 2])]), [false, false, true])
    expect(Array.from(m).every((v) => Number.isNaN(v))).toBe(true)
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

describe('singleMemberColumns（裏付けが 1 本しか無い区間の帯）', () => {
  /** 本数を指定したまとまり（値は 1 で揃える）。 */
  function withMembers(startMs: number, members: number[]): WaveSampleChunk {
    const a = Float32Array.from(members.map(() => 1))
    return { firstSampleMs: startMs, msPerSample: MS, gal: [a, a, a], memberCount: Float32Array.from(members) }
  }

  // 正: 本数は系列まで運ばれる（以前は繋ぐときに捨てていて、詳細の窓では帯を出せなかった）。
  it('系列は本数を持ち、途切れに挟んだ欠測は NaN', () => {
    const s = buildSampleSeries([withMembers(T0, [3, 1]), withMembers(T0 + 200, [2])])
    expect(Array.from(s.members.subarray(0, 2))).toEqual([3, 1])
    expect(Number.isNaN(s.members[2])).toBe(true)
    expect(s.members[3]).toBe(2)
  })

  // 正: 1 本以下のサンプルが掛かるピクセルだけ敷く（引いた絵: 1 ピクセルに 10 点）。
  it('引いた絵では、1 本のサンプルが入るピクセルだけを敷く', () => {
    const members = Array.from({ length: 100 }, (_, i) => (i >= 50 && i < 60 ? 1 : 3))
    const s = buildSampleSeries([withMembers(T0, members)])
    const out = singleMemberColumns(s, { fromMs: T0, toMs: T0 + 1000 }, 10)
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0])
  })

  // 正: 寄せて点がまばらでも、帯が櫛の歯にならない（前後の点との中点まで覆う）。
  it('寄せた絵でも、1 本の点の前後の中点まで切れ目なく敷く', () => {
    const s = buildSampleSeries([withMembers(T0, [3, 1, 1, 3])])
    // 1 点あたり 10 ピクセル（10 ms を 10 px）。1 本の点は 10 ms と 20 ms。
    const out = singleMemberColumns(s, { fromMs: T0, toMs: T0 + 30 }, 30)
    // 10 ms の点は 5〜15 ms、20 ms の点は 15〜25 ms を覆う。
    expect(Array.from(out).join('')).toBe('0'.repeat(5) + '1'.repeat(20) + '0'.repeat(5))
  })

  // 安全弁: 途切れの隣の 1 本の点が、値の無い時間（欠測）へ帯を張り出さない。
  it('途切れの隣の点は、欠測の側へ帯を張り出さない', () => {
    // 0・10 ms の 2 点（1 本）と、100・110 ms の 2 点（3 本）。間に欠測が挟まる（55 ms）。
    const s = buildSampleSeries([withMembers(T0, [1, 1]), withMembers(T0 + 100, [3, 3])])
    const out = singleMemberColumns(s, { fromMs: T0, toMs: T0 + 110 }, 110)
    // 10 ms の点は 5〜15 ms まで（欠測の 55 ms 側へは 5 ms だけ）。それより右は敷かない。
    expect(out.slice(16).every((x) => x === 0)).toBe(true)
    expect(out[14]).toBe(1)
  })

  // 対照: 裏付けが 2 本以上なら何も敷かない。
  it('裏付けが 2 本以上なら敷かない', () => {
    const s = buildSampleSeries([withMembers(T0, [2, 3, 2, 3])])
    expect(Array.from(singleMemberColumns(s, { fromMs: T0, toMs: T0 + 30 }, 30)).every((x) => x === 0)).toBe(true)
  })

  // 安全弁: 値の無いサンプル（3 成分とも欠測）は本数が 1 でも敷かない（カードの列と同じ）。
  it('値の無いサンプルは本数が 1 でも敷かない', () => {
    const nan = Float32Array.from([Number.NaN, Number.NaN])
    const c: WaveSampleChunk = { firstSampleMs: T0, msPerSample: MS, gal: [nan, nan, nan], memberCount: Float32Array.from([1, 1]) }
    const s = buildSampleSeries([c])
    expect(Array.from(singleMemberColumns(s, { fromMs: T0, toMs: T0 + 10 }, 10)).every((x) => x === 0)).toBe(true)
  })
})
