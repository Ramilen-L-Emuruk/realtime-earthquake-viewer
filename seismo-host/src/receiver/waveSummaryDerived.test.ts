import { describe, expect, it } from 'vitest'

import { calcSeismicIntensity } from '../../../src/utils/knet/seismicIntensity'
import { computeQuakeIntensity } from './quakeIntensity'
import type { ArchivedWaveChunk } from './waveArchive'
import { SUMMARY_FINE_MS, SummaryBuilder } from './waveSummary'
import {
  compositeGroupOf,
  compositeGroupsOf,
  compositeMasks,
  decodeDerivedPart,
  encodeDerivedPart,
  measuredTopK,
  peekDerivedHead,
  stationIntensityOf,
  type DerivedSummary,
} from './waveSummaryDerived'

const HOUR = Date.parse('2026-10-07T03:00:00.000Z')
const RAW = (axis: string): string => `FDSN:XX_A1B2_S1_H_N_${axis}`

function builderWith(channels: Record<string, { first: number; values: number[] }[]>): SummaryBuilder {
  const b = new SummaryBuilder({ fromMs: HOUR, toMs: HOUR + 3_600_000 })
  for (const [id, chunks] of Object.entries(channels)) {
    b.declare(id, { unit: 'count', ugPerLsb: 61 })
    for (const c of chunks) b.add(id, c.first, 10, c.values)
  }
  return b
}

function composites(b: SummaryBuilder) {
  const file = b.build(123)
  return compositeGroupsOf(file, (id) => b.chunksOf(id), b.sampleWindow)
}

describe('compositeGroupOf', () => {
  it('生データはセンサー、合成波形は観測点の札で束ねる', () => {
    expect(compositeGroupOf(RAW('Z'))).toBe('FDSN:XX_A1B2_S1')
    expect(compositeGroupOf('station/home-abc/X')).toBe('station/home-abc')
  })
  it('軸を名乗らない識別子は束ねない', () => {
    expect(compositeGroupOf('FDSN:XX')).toBeNull()
    expect(compositeGroupOf('station/X')).toBeNull()
  })
})

describe('compositeMasks', () => {
  it('2 軸以上の組を印の小さい順に並べる', () => {
    expect(compositeMasks(3)).toEqual([0b011, 0b101, 0b110, 0b111])
    expect(compositeMasks(2)).toEqual([0b11])
    expect(compositeMasks(1)).toEqual([])
  })
})

describe('compositeGroupsOf', () => {
  it('正: 各軸からその分の平均を引いて √Σ² の最大を 1 秒ごとに持つ（重力の乗った軸も 0 付近から）', () => {
    // X は 0 の周り、Z は 16384（重力）の周り。2 本目のサンプルで両方が振れる。
    const b = builderWith({
      [RAW('X')]: [{ first: HOUR, values: [0, 3, 0, 0] }],
      [RAW('Z')]: [{ first: HOUR, values: [16384, 16388, 16384, 16384] }],
    })
    const [g] = composites(b)
    expect(g!.key).toBe('FDSN:XX_A1B2_S1')
    expect(g!.axes).toEqual([RAW('X'), RAW('Z')])
    expect(g!.ugPerLsb).toBe(61)
    expect(g!.subsets.map((s) => s.mask)).toEqual([0b11])
    const fine = g!.subsets[0]!.fine
    expect(fine.firstBucket).toBe(HOUR / SUMMARY_FINE_MS)
    expect(Array.from(fine.n)).toEqual([4])
    // 平均は X 0.75・Z 16385。振れたサンプルは (3 − 0.75, 16388 − 16385) → √(2.25² + 3²) = 3.75
    expect(fine.max[0]).toBeCloseTo(3.75, 5)
    expect(g!.subsets[0]!.coarse.max[0]).toBeCloseTo(3.75, 5)
  })

  it('対照: 他の軸に同じ時刻の値が無いサンプルは合成に入れない（欠けた軸を 0 として足さない）', () => {
    const b = builderWith({
      [RAW('X')]: [{ first: HOUR, values: [1, 2, 3, 4] }],
      [RAW('Y')]: [{ first: HOUR + 20, values: [1, 1] }],
    })
    const fine = composites(b)[0]!.subsets[0]!.fine
    expect(Array.from(fine.n)).toEqual([2])
  })

  it('他の軸は刻みの半分以内にいちばん近い 1 点を使う（ずれた刻みも拾う）', () => {
    const b = builderWith({
      [RAW('X')]: [{ first: HOUR, values: [0, 0, 0] }],
      [RAW('Y')]: [{ first: HOUR + 4, values: [0, 0, 0] }],
    })
    expect(Array.from(composites(b)[0]!.subsets[0]!.fine.n)).toEqual([3])
  })

  it('3 軸なら 2 軸の組 3 つと 3 軸の組を持ち、組ごとに見えている軸だけで合成する', () => {
    const b = builderWith({
      [RAW('X')]: [{ first: HOUR, values: [0, 4, 0, 0] }],
      [RAW('Y')]: [{ first: HOUR, values: [0, 0, 0, 0] }],
      [RAW('Z')]: [{ first: HOUR, values: [0, 0, 0, 8] }],
    })
    const g = composites(b)[0]!
    const max = (mask: number): number => g.subsets.find((s) => s.mask === mask)!.fine.max[0]!
    expect(g.subsets.map((s) => s.mask)).toEqual([0b011, 0b101, 0b110, 0b111])
    // Y と Z だけ（X を隠した）なら X の振れは入らない。
    expect(max(0b110)).toBeCloseTo(Math.hypot(0, 8 - 2), 5)
    expect(max(0b011)).toBeCloseTo(Math.hypot(4 - 1, 0), 5)
  })

  it('安全弁: 分解能が食い違う軸の組は換算の係数を持たない', () => {
    const b = new SummaryBuilder({ fromMs: HOUR, toMs: HOUR + 3_600_000 })
    b.declare(RAW('X'), { unit: 'count', ugPerLsb: 61 })
    b.declare(RAW('Y'), { unit: 'count', ugPerLsb: 122 })
    b.add(RAW('X'), HOUR, 10, [0, 1])
    b.add(RAW('Y'), HOUR, 10, [0, 1])
    const file = b.build(1)
    expect(compositeGroupsOf(file, (id) => b.chunksOf(id), b.sampleWindow)[0]!.ugPerLsb).toBeNull()
  })

  it('1 軸しか無い記録は合成を作らない', () => {
    const b = builderWith({ [RAW('X')]: [{ first: HOUR, values: [0, 1] }] })
    expect(composites(b)).toEqual([])
  })
})

// ---- 震度 ----

const RATE = 100

function noise(n: number, seed: number, amp: number): Float32Array {
  let s = seed
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = (s / 0x7fffffff - 0.5) * amp
  }
  return out
}

/** 続いたまとまりの列（長さ `seconds` 秒・頭 `first`）。 */
function chunks(first: number, seconds: number, seed: number, amp = 2): ArchivedWaveChunk[] {
  const out: ArchivedWaveChunk[] = []
  const per = 30
  const total = seconds * RATE
  const x = noise(total, seed, amp)
  const y = noise(total, seed + 1, amp)
  const z = noise(total, seed + 2, amp)
  for (let i = 0; i < total; i += per) {
    const n = Math.min(per, total - i)
    out.push({
      firstSampleMs: first + i * 10,
      msPerSample: 10,
      gal: [x.slice(i, i + n), y.slice(i, i + n), z.slice(i, i + n)],
      dcGal: [0, 0, 0],
      memberCount: new Uint8Array(n).fill(2),
      revised: false,
    })
  }
  return out
}

const WINDOW = { fromMs: HOUR, toMs: HOUR + 3_600_000 + 600_000 }

/** 上位を全部束ねて K 番目から計測震度を出す（読み返しの口と同じ考え方）。 */
function measuredOf(level: { k: number; count: Uint16Array; values: Float32Array }): number | null {
  const all: number[] = []
  for (let i = 0; i < level.count.length; i += 1) for (let j = 0; j < level.count[i]!; j += 1) all.push(level.values[i * level.k + j]!)
  all.sort((a, b) => b - a)
  const a = all[level.k - 1]
  return a === undefined || !(a > 0) ? null : 2 * Math.log10(a) + 0.94
}

describe('stationIntensityOf', () => {
  it('正: 前の時が無ければ、1 分の段の上位を束ねた K 番目が範囲全体の計測震度と一致する', () => {
    const own = chunks(HOUR, 180, 7)
    const it = stationIntensityOf({ own, lead: [], window: WINDOW })!
    expect(it.measuredCoarse!.k).toBe(measuredTopK(RATE))
    expect(it.measuredCoarse!.k).toBe(30)
    const x: number[] = []
    const y: number[] = []
    const z: number[] = []
    for (const c of own) {
      x.push(...c.gal[0])
      y.push(...c.gal[1])
      z.push(...c.gal[2])
    }
    const exact = calcSeismicIntensity(x, y, z, RATE)!
    // 上位の値は f32 で持つので、その丸めの分（相対 1e-7 ほど）だけずれる。
    expect(measuredOf(it.measuredCoarse!)).toBeCloseTo(exact, 6)
    // 1 秒の段から束ねても同じ。
    expect(measuredOf(it.measuredFine!)).toBeCloseTo(exact, 6)
  })

  it('正: リアルタイム震度は 10 分以内の口（computeQuakeIntensity）と同じ値を 1 秒ごとに持つ', () => {
    const lead = chunks(HOUR - 60_000, 60, 3)
    const own = chunks(HOUR, 120, 4)
    const it = stationIntensityOf({ own, lead, window: WINDOW })!
    const direct = computeQuakeIntensity({ chunks: [...lead, ...own], fromMs: HOUR, toMs: HOUR + 120_000 })
    const fine = it.realtimeFine!
    for (const p of direct.realtimeSeries) {
      if (p.value === null) continue
      const i = Math.floor(p.atMs / SUMMARY_FINE_MS) - fine.firstBucket
      expect(fine.value[i]).toBeCloseTo(p.value, 5)
    }
    const firstMinute = direct.realtimeSeries.filter((p) => p.atMs < HOUR + 60_000).flatMap((p) => (p.value === null ? [] : [p.value]))
    expect(it.realtimeCoarse!.value[0]).toBeCloseTo(Math.max(...firstMinute), 5)
  })

  it('対照: 前の時のサンプルは計測震度の上位に積まない（前の時の要約に積んである）', () => {
    const lead = chunks(HOUR - 60_000, 60, 3, 50)
    const own = chunks(HOUR, 60, 4)
    const it = stationIntensityOf({ own, lead, window: WINDOW })!
    expect(it.measuredFine!.firstBucket).toBe(HOUR / SUMMARY_FINE_MS)
    let total = 0
    for (const c of it.measuredFine!.count) total += c
    expect(total).toBe(60 * 30)
  })

  it('安全弁: 前の時から通すと、頭の 1 分のリアルタイム震度が窓の埋まった値になる（前の時なしより低く出ない）', () => {
    const lead = chunks(HOUR - 60_000, 60, 3, 20)
    const own = chunks(HOUR, 60, 4, 20)
    const withLead = stationIntensityOf({ own, lead, window: WINDOW })!.realtimeCoarse!.value[0]!
    const without = stationIntensityOf({ own, lead: [], window: WINDOW })!.realtimeCoarse!.value[0]!
    expect(withLead).toBeGreaterThanOrEqual(without)
  })

  it('この時のまとまりが無ければ null', () => {
    expect(stationIntensityOf({ own: [], lead: chunks(HOUR - 60_000, 60, 1), window: WINDOW })).toBeNull()
  })

  it('途切れた所で通し直し、計測震度は途切れた両側の上位を合わせる', () => {
    const own = [...chunks(HOUR, 30, 5), ...chunks(HOUR + 60_000, 30, 6)]
    const it = stationIntensityOf({ own, lead: [], window: WINDOW })!
    expect(it.measuredCoarse!.count[0]).toBe(30)
    expect(it.measuredCoarse!.count[1]).toBe(30)
  })
})

// ---- 書き出しと読み込み ----

function sample(): DerivedSummary {
  const b = builderWith({
    [RAW('X')]: [{ first: HOUR, values: [0, 4, 0, 0] }],
    [RAW('Z')]: [{ first: HOUR, values: [16384, 16384, 16390, 16384] }],
  })
  const own = chunks(HOUR, 90, 9)
  return {
    sourceBytes: 4567,
    prevSourceBytes: 89,
    composites: composites(b),
    intensity: stationIntensityOf({ own, lead: [], window: WINDOW }),
  }
}

describe('encodeDerivedPart / decodeDerivedPart', () => {
  it('1 秒・1 分の部分を往復させる', () => {
    const d = sample()
    for (const part of ['derived-fine', 'derived-coarse'] as const) {
      const got = decodeDerivedPart(encodeDerivedPart(d, part), () => true)!
      expect(got.part).toBe(part)
      expect(got.sourceBytes).toBe(4567)
      expect(got.prevSourceBytes).toBe(89)
      const g = got.groups[0]!
      expect(g.key).toBe('FDSN:XX_A1B2_S1')
      expect(g.ugPerLsb).toBe(61)
      const want = part === 'derived-coarse' ? d.composites[0]!.subsets[0]!.coarse : d.composites[0]!.subsets[0]!.fine
      expect(Array.from(g.subsets[0]!.level.n)).toEqual(Array.from(want.n))
      expect(Array.from(g.subsets[0]!.level.max)).toEqual(Array.from(want.max))
      const ms = part === 'derived-coarse' ? d.intensity!.measuredCoarse! : d.intensity!.measuredFine!
      expect(got.intensity!.measured!.k).toBe(ms.k)
      expect(Array.from(got.intensity!.measured!.count)).toEqual(Array.from(ms.count))
      expect(got.intensity!.realtime).not.toBeNull()
    }
  })

  it('前の時が無いことを往復させる', () => {
    const d = { ...sample(), prevSourceBytes: null }
    expect(decodeDerivedPart(encodeDerivedPart(d, 'derived-coarse'), () => true)!.prevSourceBytes).toBeNull()
    expect(peekDerivedHead(encodeDerivedPart(d, 'derived-coarse'))).toEqual({ sourceBytes: 4567, prevSourceBytes: null })
  })

  it('通さない記録・震度は長さだけ確かめて飛ばす', () => {
    const got = decodeDerivedPart(encodeDerivedPart(sample(), 'derived-fine'), () => false, false)!
    expect(got.groups).toEqual([])
    expect(got.intensity).toBeNull()
  })

  it('#742 正: 版 1 で書いた要約は、作り直すかの判定では「無い」と見なす（1 分 PSD を新しい区間の置き方で作り直させる）', () => {
    const v1 = Buffer.from(encodeDerivedPart(sample(), 'derived-coarse'))
    v1.writeUInt8(1, 4)
    expect(peekDerivedHead(v1)).toBeNull()
  })

  it('#742 対照: 版 1 の要約も、作り直すまでの間は読める（画面の合成と震度の推移を空けない）', () => {
    const v1 = Buffer.from(encodeDerivedPart(sample(), 'derived-coarse'))
    v1.writeUInt8(1, 4)
    expect(decodeDerivedPart(v1, () => true)).not.toBeNull()
    // 書くのは新しい版。作り直した要約は判定を通る
    expect(peekDerivedHead(encodeDerivedPart(sample(), 'derived-coarse'))).not.toBeNull()
  })

  it('安全弁: 知らない版（先の版）は読まない', () => {
    const v9 = Buffer.from(encodeDerivedPart(sample(), 'derived-coarse'))
    v9.writeUInt8(9, 4)
    expect(peekDerivedHead(v9)).toBeNull()
    expect(decodeDerivedPart(v9, () => true)).toBeNull()
  })

  it('安全弁: 途中で切れた・目印が違う部分は読まない', () => {
    const buf = encodeDerivedPart(sample(), 'derived-fine')
    expect(decodeDerivedPart(buf.subarray(0, buf.length - 3), () => true)).toBeNull()
    const bad = Buffer.from(buf)
    bad.writeUInt32LE(0, 0)
    expect(decodeDerivedPart(bad, () => true)).toBeNull()
    expect(peekDerivedHead(bad)).toBeNull()
  })
})

describe('時の境目をまたぐまとまり', () => {
  it('前の時のファイルにある、時の頭をまたぐまとまりの後ろ半分は前の時の要約に積まれ、この時の要約には積まれない（ちょうど 1 回）', () => {
    // 前の時: 頭が H−150 ms で 30 サンプル（H+140 ms まで）。この時: H+150 ms から。
    const prevAll = chunks(HOUR - 3_600_000, 3600, 11)
    const crossing = chunks(HOUR - 150, 1, 12).slice(0, 1)
    const prev = [...prevAll.filter((c) => c.firstSampleMs + 30 * 10 <= HOUR - 150), ...crossing]
    const own = chunks(HOUR + 150, 60, 13)
    const prevWindow = { fromMs: HOUR - 3_600_000, toMs: HOUR + 600_000 }
    const before = stationIntensityOf({ own: prev, lead: [], window: prevWindow })!
    const after = stationIntensityOf({ own, lead: prev.slice(-200), window: WINDOW })!
    const second = HOUR / SUMMARY_FINE_MS
    const countAt = (lv: { firstBucket: number; count: Uint16Array }): number => lv.count[second - lv.firstBucket] ?? 0
    // H〜H+140 ms の 15 サンプルは前の時の要約に、H+150 ms 以降の 85 サンプルのうち上位 30 はこの時の要約に。
    expect(countAt(before.measuredFine!)).toBe(15)
    expect(countAt(after.measuredFine!)).toBe(30)
  })
})
