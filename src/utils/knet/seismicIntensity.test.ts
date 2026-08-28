import { describe, expect, test } from 'vitest'
import {
  applyJmaFilter,
  calcSeismicIntensityFromSynthesized,
  computeIntensityTimeSeries,
  jmaFilterGain,
  synthesize3Components,
} from './seismicIntensity'

function rms(values: number[]): number {
  return Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length)
}

function sineWave(freqHz: number, amplitude: number, sampleRateHz: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRateHz))
}

describe('jmaFilterGain', () => {
  test('f=0（直流成分）はゲイン0', () => {
    expect(jmaFilterGain(0)).toBe(0)
  })

  // 気象庁の公式フィルター式（FL・FH・FF）を手計算した値と照合する。
  // 数式の転記ミス（係数の桁・べき乗の取り違え等）を検出するための基準値。
  test('f=1Hz のゲインは手計算値と一致する', () => {
    expect(jmaFilterGain(1)).toBeCloseTo(0.996192, 3)
  })

  test('f=5Hz のゲインは手計算値と一致する', () => {
    expect(jmaFilterGain(5)).toBeCloseTo(0.410100, 3)
  })

  test('f=0.1Hz のゲインは手計算値と一致する（ローカットで低周波が強く減衰する）', () => {
    expect(jmaFilterGain(0.1)).toBeCloseTo(0.282217, 3)
  })
})

describe('applyJmaFilter', () => {
  test('正弦波を通すと jmaFilterGain(f) に応じた振幅になる', () => {
    const sampleRateHz = 100
    const n = 2048
    const freqHz = 2
    const amplitude = 100
    const signal = sineWave(freqHz, amplitude, sampleRateHz, n)

    const filtered = applyJmaFilter(signal, sampleRateHz)
    const expectedRms = (amplitude / Math.SQRT2) * jmaFilterGain(freqHz)

    // 端点のゼロ詰め・エッジ効果があるため、中央区間だけで比較する。
    const mid = filtered.slice(n / 4, (n * 3) / 4)
    expect(rms(mid)).toBeCloseTo(expectedRms, 0)
  })

  test('空配列を渡すと空配列を返す', () => {
    expect(applyJmaFilter([], 100)).toEqual([])
  })
})

describe('synthesize3Components', () => {
  test('3-4-0 のベクトル合成は5になる', () => {
    expect(synthesize3Components([3], [4], [0])).toEqual([5])
  })

  test('長さが異なる場合は最短に合わせる', () => {
    expect(synthesize3Components([3, 3], [4], [0, 0, 0])).toEqual([5])
  })
})

describe('calcSeismicIntensityFromSynthesized', () => {
  test('一定振幅 a が0.3秒以上続く場合、I = 2*log10(a) + 0.94 になる', () => {
    const sampleRateHz = 100
    const a = 50
    const synthesized = new Array(sampleRateHz).fill(a) // 1秒ぶん
    const intensity = calcSeismicIntensityFromSynthesized(synthesized, sampleRateHz)
    expect(intensity).toBeCloseTo(2 * Math.log10(a) + 0.94, 6)
  })

  test('データ長が0.3秒に満たない場合は null', () => {
    const sampleRateHz = 100
    const synthesized = new Array(10).fill(50) // 0.1秒ぶん
    expect(calcSeismicIntensityFromSynthesized(synthesized, sampleRateHz)).toBeNull()
  })

  test('全て0（無振動）の場合は null', () => {
    const sampleRateHz = 100
    const synthesized = new Array(sampleRateHz).fill(0)
    expect(calcSeismicIntensityFromSynthesized(synthesized, sampleRateHz)).toBeNull()
  })
})

describe('computeIntensityTimeSeries', () => {
  test('無振動区間の後に一定振幅の区間が来ると、その区間で震度が算出される', () => {
    const sampleRateHz = 100
    const quietSec = 10
    const shakeSec = 10
    const quiet = new Array(quietSec * sampleRateHz).fill(0)
    // 低周波の巨大な単一正弦波ではなく、フィルターを素直に通過する帯域（数Hz）の正弦波にする。
    const shake = sineWave(2, 200, sampleRateHz, shakeSec * sampleRateHz)
    const ns = [...quiet, ...shake]
    const ew = [...quiet, ...shake]
    const ud = [...quiet, ...shake]

    const points = computeIntensityTimeSeries(ns, ew, ud, sampleRateHz, { windowSec: 5, stepSec: 1 })

    const before = points.find((p) => p.tSec === 5)
    const after = points.find((p) => p.tSec === 18)
    expect(before?.intensity ?? -Infinity).toBeLessThan(0)
    expect(after?.intensity ?? -Infinity).toBeGreaterThan(3)
  })

  test('ウィンドウ長・ステップに応じた点数になる', () => {
    const sampleRateHz = 100
    const n = 10 * sampleRateHz
    const zeros = new Array(n).fill(0)
    const points = computeIntensityTimeSeries(zeros, zeros, zeros, sampleRateHz, { windowSec: 5, stepSec: 1 })
    expect(points.length).toBe(10)
    expect(points.every((p) => p.intensity === null)).toBe(true)
  })
})
