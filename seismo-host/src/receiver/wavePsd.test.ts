import { describe, expect, it } from 'vitest'

import { PSD_BIN_COUNT, PSD_BIN_EDGES_HZ, PSD_HOP, PSD_NFFT, minutePsd, welchPsd } from './wavePsd'

const T0 = Date.parse('2026-10-07T03:00:00.000Z')
const FS = 100
const MS = 1000 / FS

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** 正規分布に近い乱数（12 個の一様乱数の和）。分散 1。 */
function gaussian(r: () => number): number {
  let s = 0
  for (let i = 0; i < 12; i += 1) s += r()
  return s - 6
}

function sine(n: number, hz: number, amp: number, offset = 0): Float64Array {
  return Float64Array.from({ length: n }, (_, i) => offset + amp * Math.sin((2 * Math.PI * hz * i) / FS))
}

/** 区画ごとの PSD を周波数で積分したもの（＝分散の推定）。 */
function integrate(power: ArrayLike<number>): number {
  let s = 0
  for (let b = 0; b < PSD_BIN_COUNT; b += 1) {
    const p = power[b]!
    if (Number.isFinite(p)) s += p * (PSD_BIN_EDGES_HZ[b + 1]! - PSD_BIN_EDGES_HZ[b]!)
  }
  return s
}

function binOf(hz: number): number {
  for (let b = 0; b < PSD_BIN_COUNT; b += 1) if (hz >= PSD_BIN_EDGES_HZ[b]! && hz < PSD_BIN_EDGES_HZ[b + 1]!) return b
  return -1
}

describe('PSD_BIN_EDGES_HZ', () => {
  it('0.1〜50 Hz を対数で等分する', () => {
    expect(PSD_BIN_EDGES_HZ).toHaveLength(PSD_BIN_COUNT + 1)
    expect(PSD_BIN_EDGES_HZ[0]).toBeCloseTo(0.1, 9)
    expect(PSD_BIN_EDGES_HZ[PSD_BIN_COUNT]).toBeCloseTo(50, 9)
    const r0 = PSD_BIN_EDGES_HZ[1]! / PSD_BIN_EDGES_HZ[0]!
    const r1 = PSD_BIN_EDGES_HZ[30]! / PSD_BIN_EDGES_HZ[29]!
    expect(r1).toBeCloseTo(r0, 9)
  })
})

describe('welchPsd', () => {
  it('正弦波の力はその周波数の区画に集まり、積分すると分散（振幅²/2）に戻る', () => {
    const x = sine(6000, 5, 3, 16384) // 直流（重力のつもり）が乗っていても効かない
    const got = welchPsd(x, FS)
    expect(got.segments).toBe(Math.floor((6000 - PSD_NFFT) / PSD_HOP) + 1)
    let peak = 0
    for (let b = 1; b < PSD_BIN_COUNT; b += 1) if (got.power[b]! > got.power[peak]!) peak = b
    expect(peak).toBe(binOf(5))
    expect(integrate(got.power) / (9 / 2)).toBeGreaterThan(0.9)
    expect(integrate(got.power) / (9 / 2)).toBeLessThan(1.1)
  })

  it('白色雑音の PSD は平らで、片側 PSD ＝ 2σ²/fs になる', () => {
    const r = seeded(7)
    const x = Float64Array.from({ length: 60_000 }, () => 2 * gaussian(r))
    const got = welchPsd(x, FS)
    const expected = (2 * 4) / FS
    // 低い区画は FFT の線が 1 本未満しか入らずばらつくので、1 Hz から上を見る
    for (let b = binOf(1); b < binOf(45); b += 1) {
      expect(got.power[b]! / expected).toBeGreaterThan(0.75)
      expect(got.power[b]! / expected).toBeLessThan(1.25)
    }
  })

  it('ナイキスト周波数より上の区画は NaN（測れない）', () => {
    const got = welchPsd(sine(4096, 1, 1), 40) // 40 Hz で取ればナイキストは 20 Hz
    expect(got.power[binOf(30)]).toBeNaN()
    expect(Number.isFinite(got.power[binOf(10)]!)).toBe(true)
  })

  it('1 区間に満たない長さでは区間 0・すべて NaN', () => {
    const got = welchPsd(sine(PSD_NFFT - 1, 5, 1), FS)
    expect(got.segments).toBe(0)
    expect(Array.from(got.power).every((p) => Number.isNaN(p))).toBe(true)
  })
})

function chunks(x: Float64Array, startMs: number, per: number, msPerSample = MS): Array<{ firstSampleMs: number; msPerSample: number; values: Float64Array }> {
  const out = []
  for (let i = 0; i < x.length; i += per) {
    out.push({ firstSampleMs: startMs + i * msPerSample, msPerSample, values: x.subarray(i, Math.min(x.length, i + per)) })
  }
  return out
}

describe('minutePsd', () => {
  it('短いまとまり（レコード 5 秒ぶん）を繋いで、1 分ごとに Welch で平均する', () => {
    const x = sine(2 * 6000, 5, 2)
    const got = minutePsd(chunks(x, T0, 500))
    expect(got).not.toBeNull()
    expect(got!.firstMinute).toBe(T0 / 60_000)
    expect(got!.segments).toHaveLength(2)
    // 区間は中心の時刻でその分へ入れる。2 分ぶんの区間の総数は 1 本に繋げたときと同じ。
    expect(got!.segments[0]! + got!.segments[1]!).toBe(Math.floor((12_000 - PSD_NFFT) / PSD_HOP) + 1)
    const minute0 = got!.power.subarray(0, PSD_BIN_COUNT)
    expect(integrate(minute0) / 2).toBeGreaterThan(0.9)
    expect(integrate(minute0) / 2).toBeLessThan(1.1)
  })

  it('欠けを跨いで区間を作らない（届かなかった間を詰めると偽の周波数が出る）', () => {
    const a = sine(3000, 5, 1)
    const b = sine(3000, 5, 1)
    // 30 秒ぶん、10 秒空けてもう 30 秒ぶん。
    const got = minutePsd([...chunks(a, T0, 500), ...chunks(b, T0 + 40_000, 500)])!
    const perRun = Math.floor((3000 - PSD_NFFT) / PSD_HOP) + 1
    let total = 0
    for (const s of got.segments) total += s
    expect(total).toBe(perRun * 2)
  })

  it('名乗る刻みより実際の刻みが少し速くても（実測 0.16%）、レコードの継ぎ目を欠けと取り違えない', () => {
    // 5 秒（500 点）のレコードが、公称 10 ms・実際 9.984 ms で並ぶ。継ぎ目は公称で見積もった
    // 終わりより 8 ms 手前に来る。
    const x = sine(6000, 5, 1)
    const cs = []
    for (let i = 0; i < 12; i += 1) {
      cs.push({ firstSampleMs: T0 + i * 500 * 9.984, msPerSample: 10, values: x.subarray(i * 500, (i + 1) * 500) })
    }
    const got = minutePsd(cs)!
    let total = 0
    for (const s of got.segments) total += s
    expect(total).toBe(Math.floor((6000 - PSD_NFFT) / PSD_HOP) + 1)
  })

  it('パケット 1 つぶん（0.3 秒）の欠けでは繋がない', () => {
    const x = sine(3000, 5, 1)
    const cs = [
      { firstSampleMs: T0, msPerSample: 10, values: x.subarray(0, 1500) },
      { firstSampleMs: T0 + 15_000 + 300, msPerSample: 10, values: x.subarray(1500) },
    ]
    const got = minutePsd(cs)!
    let total = 0
    for (const s of got.segments) total += s
    expect(total).toBe((Math.floor((1500 - PSD_NFFT) / PSD_HOP) + 1) * 2)
  })

  it('刻みが変わったら繋がない', () => {
    const a = sine(3000, 5, 1)
    const b = sine(3000, 5, 1)
    const got = minutePsd([
      ...chunks(a, T0, 500, 10),
      ...chunks(b, T0 + 30_000, 500, 5),
    ])!
    let total = 0
    for (const s of got.segments) total += s
    const runA = Math.floor((3000 - PSD_NFFT) / PSD_HOP) + 1
    const runB = Math.floor((3000 - PSD_NFFT) / PSD_HOP) + 1
    expect(total).toBe(runA + runB)
  })

  it('順番が前後して渡されても、時刻で並べてから繋ぐ', () => {
    const x = sine(6000, 5, 1)
    const cs = chunks(x, T0, 500)
    cs.reverse()
    const got = minutePsd(cs)!
    expect(got.segments[0]).toBe(Math.floor((6000 - PSD_NFFT) / PSD_HOP) + 1)
  })

  it('区間を 1 つも作れない分は区間 0・NaN、何も作れなければ null', () => {
    expect(minutePsd(chunks(sine(500, 5, 1), T0, 500))).toBeNull()
    expect(minutePsd([])).toBeNull()
  })
})
