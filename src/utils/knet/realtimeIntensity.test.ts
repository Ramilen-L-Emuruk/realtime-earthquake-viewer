import { describe, expect, test } from 'vitest'
import {
  REALTIME_FILTER_GAIN,
  REALTIME_JUDGE_WINDOW_SEC,
  RealtimeIntensityCalculator,
  computeRealtimeIntensityTimeSeries,
  isStableStage,
  realtimeFilterStages,
  type BiquadCoefficients,
} from './realtimeIntensity'
import { calcSeismicIntensity, jmaFilterGain } from './seismicIntensity'

/** 6 段＋ゲインの振幅特性（ディジタル。周波数 f Hz）。 */
function cascadeGain(stages: BiquadCoefficients[], f: number, sampleRateHz: number): number {
  const w = (2 * Math.PI * f) / sampleRateHz
  const mag = (b0: number, b1: number, b2: number): number =>
    Math.hypot(b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), -b1 * Math.sin(w) - b2 * Math.sin(2 * w))
  let g = REALTIME_FILTER_GAIN
  for (const c of stages) g *= mag(c.b0, c.b1, c.b2) / mag(c.a0, c.a1, c.a2)
  return g
}

/** 区間だけ揺れる 2 成分の正弦波（3 成分目は 0）。 */
function burst(opts: { f: number; amp: number; fromSec: number; toSec: number; totalSec: number; hz: number }) {
  const n = Math.round(opts.totalSec * opts.hz)
  const ns: number[] = []
  const ew: number[] = []
  const ud: number[] = []
  for (let i = 0; i < n; i++) {
    const t = i / opts.hz
    const on = t >= opts.fromSec && t < opts.toSec ? 1 : 0
    ns.push(opts.amp * on * Math.sin(2 * Math.PI * opts.f * t))
    ew.push(0.5 * opts.amp * on * Math.cos(2 * Math.PI * opts.f * t))
    ud.push(0)
  }
  return { ns, ew, ud }
}

describe('係数（功刀ほか 2013 Appendix A）', () => {
  // 1・2 段目は 1 次 2 つの積としてここで掛け合わせている。論文の展開済みの式と
  // 一致することを確かめる —— 掛け合わせの取り違え（添字の入れ違い）を捕まえる。
  const hz = 100
  const dt = 1 / hz
  const [s1, s2] = realtimeFilterStages(hz)

  test('1 段目は論文 A11 の展開と一致する', () => {
    const wa1 = 2 * Math.PI * 0.45
    const wa2 = 2 * Math.PI * 7.0
    expect(s1.a0).toBeCloseTo(8 / dt ** 2 + (4 * wa1 + 2 * wa2) / dt + wa1 * wa2, 6)
    expect(s1.a1).toBeCloseTo(2 * wa1 * wa2 - 16 / dt ** 2, 6)
    expect(s1.a2).toBeCloseTo(8 / dt ** 2 - (4 * wa1 + 2 * wa2) / dt + wa1 * wa2, 6)
    expect(s1.b0).toBeCloseTo(4 / dt ** 2 + (2 * wa2) / dt, 6)
    expect(s1.b1).toBeCloseTo(-8 / dt ** 2, 6)
    expect(s1.b2).toBeCloseTo(4 / dt ** 2 - (2 * wa2) / dt, 6)
  })

  test('2 段目は論文 A12 の展開と一致する（β0・β2 の ω は ω_a3 として読む）', () => {
    // 論文は β0・β2 を `8.5ω_a2` と印刷しているが、A9・A10 から導くと ω_a3 になる。
    const wa3 = 2 * Math.PI * 7.0
    expect(s2.a0).toBeCloseTo(16 / dt ** 2 + (17 * wa3) / dt + wa3 ** 2, 6)
    expect(s2.a1).toBeCloseTo(2 * wa3 ** 2 - 32 / dt ** 2, 6)
    expect(s2.a2).toBeCloseTo(16 / dt ** 2 - (17 * wa3) / dt + wa3 ** 2, 6)
    expect(s2.b0).toBeCloseTo(4 / dt ** 2 + (8.5 * wa3) / dt + wa3 ** 2, 6)
    expect(s2.b1).toBeCloseTo(2 * wa3 ** 2 - 8 / dt ** 2, 6)
    expect(s2.b2).toBeCloseTo(4 / dt ** 2 - (8.5 * wa3) / dt + wa3 ** 2, 6)
  })
})

describe('振幅特性', () => {
  // 正: 主要な帯域で気象庁のフィルタに沿う。論文はアナログの設計で 0.1〜50 Hz に
  // 0.974〜1.029 倍と報告している。毎秒 100 回のディジタルでは 10 Hz までがその範囲に入る。
  test.each([0.1, 0.2, 0.5, 1, 2, 5, 10])('毎秒 100 回・%s Hz で気象庁フィルタの 0.974〜1.029 倍に収まる', (f) => {
    const ratio = cascadeGain(realtimeFilterStages(100), f, 100) / jmaFilterGain(f)
    expect(ratio).toBeGreaterThanOrEqual(0.974)
    expect(ratio).toBeLessThanOrEqual(1.029)
  })

  // 対照: ナイキストに近い帯域では双線形変換の歪みで離れる（論文も「高周波数領域でゆがむ」と
  // 書いている）。ここが外れることを固定しておかないと、上の範囲の主張が広がって見える。
  test('毎秒 100 回・30 Hz では気象庁フィルタから大きく離れる', () => {
    const ratio = cascadeGain(realtimeFilterStages(100), 30, 100) / jmaFilterGain(30)
    expect(ratio).toBeGreaterThan(1.5)
  })
})

describe('安定性', () => {
  test('毎秒 100 回では 6 段とも安定', () => {
    expect(realtimeFilterStages(100).every(isStableStage)).toBe(true)
  })

  // 安全弁: 低いサンプリング周波数では発散する。発散した出力は有限のまま大きくなるので、
  // 作る時点で止めないと「揺れの大きな地震」と区別が付かない。
  test('毎秒 60 回では作る時点で止める', () => {
    expect(() => new RealtimeIntensityCalculator(60)).toThrow(/発散/)
  })
})

describe('気象庁の計測震度との対応', () => {
  // 論文の主張は「リアルタイム震度の最大値が計測震度に対応する」。
  test.each([
    [0.5, 50],
    [1, 20],
    [3, 100],
    [8, 300],
  ])('%s Hz・%s gal の揺れで、最大値が気象庁の手順と 0.05 以内', (f, amp) => {
    const hz = 100
    const { ns, ew, ud } = burst({ f, amp, fromSec: 5, toSec: 15, totalSec: 30, hz })
    const series = computeRealtimeIntensityTimeSeries(ns, ew, ud, hz, 1)
    const max = Math.max(...series.map((p) => p.intensity ?? -Infinity))
    const jma = calcSeismicIntensity(ns, ew, ud, hz)
    expect(jma).not.toBeNull()
    expect(Math.abs(max - (jma as number))).toBeLessThan(0.05)
  })
})

describe('60 秒の窓', () => {
  const hz = 100
  const { ns, ew, ud } = burst({ f: 1, amp: 50, fromSec: 5, toSec: 10, totalSec: 90, hz })
  const series = computeRealtimeIntensityTimeSeries(ns, ew, ud, hz, 1)
  const at = (sec: number): number => series.find((p) => p.tSec === sec)?.intensity ?? -Infinity
  const peak = Math.max(...series.map((p) => p.intensity ?? -Infinity))

  test('揺れが止んでも、窓の中にある間は最大値を保つ', () => {
    expect(at(60)).toBeCloseTo(peak, 6)
  })

  test('揺れた区間が窓から出ると下がる', () => {
    // 揺れは 10 秒で止むので、その 60 秒後（70 秒）を過ぎれば窓に残らない。
    expect(at(75)).toBeLessThan(peak - 2)
  })

  test('窓の長さは論文の 60 秒', () => {
    expect(REALTIME_JUDGE_WINDOW_SEC).toBe(60)
  })
})

describe('直流（重力）', () => {
  // 正: 静止した基板の値（重力が 1 軸に約 980 gal 乗る）を渡しても、立ち上がりの段差が
  // 震度として出ない。出れば 60 秒の窓に入ったまま 1 分間居座る。
  test('980 gal の直流と弱いノイズだけなら、震度は 0.5 未満に収まる', () => {
    const hz = 100
    const calc = new RealtimeIntensityCalculator(hz)
    let seed = 1
    const noise = (): number => {
      seed = (seed * 16807) % 2147483647
      return (seed / 2147483647 - 0.5) * 0.6
    }
    for (let i = 0; i < 30 * hz; i++) calc.push(3 + noise(), -2 + noise(), 980 + noise())
    const got = calc.intensity()
    expect(got).not.toBeNull()
    expect(got as number).toBeLessThan(0.5)
  })

  // 正: 直流を 1 サンプルで推定すると、そのサンプルのノイズが段差になって 60 秒居座る
  // （自作地震計の実記録で、区間の頭だけ 0.89・平常時 0.36 だった）。1 秒の平均で推定する。
  test('最初のサンプルがノイズで外れていても、区間の頭で震度が跳ねない', () => {
    const hz = 100
    const calc = new RealtimeIntensityCalculator(hz)
    let seed = 7
    const noise = (): number => {
      seed = (seed * 16807) % 2147483647
      return (seed / 2147483647 - 0.5) * 0.6
    }
    // 1 サンプル目だけ 3 gal ずれている（実機のノイズの最大と同じ桁）。
    calc.push(3, 3, 983)
    for (let i = 1; i < 30 * hz; i++) calc.push(noise(), noise(), 980 + noise())
    expect(calc.intensity() as number).toBeLessThan(0.5)
  })

  // 対照: 本当に揺れていれば、区間の頭でも拾う（直流の推定は揺れを消さない）。
  test('区間の頭から揺れていても、その揺れは震度に出る', () => {
    const hz = 100
    const { ns, ew, ud } = burst({ f: 2, amp: 50, fromSec: 0, toSec: 10, totalSec: 20, hz })
    const series = computeRealtimeIntensityTimeSeries(ns, ew, ud, hz, 1)
    const max = Math.max(...series.map((p) => p.intensity ?? -Infinity))
    expect(max).toBeGreaterThan(3.5)
  })

  // 安全弁: 数でない値を通すとフィルタの状態が恒久的に NaN になり、以後ずっと null を返す。
  test('有限でないサンプルは受け取らずに止め、それまでの状態は壊さない', () => {
    const calc = new RealtimeIntensityCalculator(100)
    for (let i = 0; i < 300; i++) calc.push(Math.sin(i / 3) * 20, 0, 0)
    const before = calc.intensity()
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => calc.push(bad, 0, 0)).toThrow(/有限/)
    }
    expect(calc.sampleCount).toBe(300)
    expect(calc.intensity()).toBe(before)
  })

  test('判定に足りるだけ溜まるまでは null', () => {
    const calc = new RealtimeIntensityCalculator(100)
    for (let i = 0; i < 10; i++) calc.push(1, 1, 1)
    expect(calc.intensity()).toBeNull()
  })
})
