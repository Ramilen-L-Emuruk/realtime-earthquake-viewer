import { describe, expect, it } from 'vitest'

import { aicPick, onsetSnr, pickPhases } from './phasePicker'

function gaussian(seed: number): () => number {
  let s = seed >>> 0
  const uniform = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s + 1) / 4294967297
  }
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
}

/** `at` から先だけ振幅 `gain` 倍になる雑音。 */
function stepNoise(n: number, at: number, gain: number, seed = 3): number[] {
  const g = gaussian(seed)
  return Array.from({ length: n }, (_, i) => (i < at ? 1 : gain) * g())
}

describe('aicPick', () => {
  it('正: 振幅が切り替わる点を、数点の誤差で拾う', () => {
    const x = stepNoise(1000, 600, 4)
    const k = aicPick(x)!
    expect(Math.abs(k - 600)).toBeLessThanOrEqual(5)
  })

  it('探索の範囲（from〜to）の中だけを見る', () => {
    const x = stepNoise(1000, 600, 4)
    const k = aicPick(x, 0, 500)!
    expect(k).toBeGreaterThanOrEqual(0)
    expect(k).toBeLessThan(500)
  })

  it('窓が短すぎれば null', () => {
    expect(aicPick([1, 2, 3])).toBeNull()
  })
})

describe('onsetSnr', () => {
  it('前後の RMS の比を返す', () => {
    const x = [...Array(100).fill(1), ...Array(100).fill(3)]
    expect(onsetSnr(x, 100, 50, 50)).toBeCloseTo(3, 6)
  })

  it('前後どちらかが足りなければ null', () => {
    const x = Array(100).fill(1)
    expect(onsetSnr(x, 10, 50, 50)).toBeNull()
  })
})

describe('pickPhases', () => {
  const FS = 100
  const T0 = Date.UTC(2026, 9, 3, 4, 25, 0)
  const ms = (i: number): number => T0 + (i * 1000) / FS

  it('正: 引き金の近くの S と、その前の P を拾う（どちらも雑音の 4 倍）', () => {
    const n = FS * 50
    const sAt = FS * 40
    const pAt = FS * 30
    const horizontal = stepNoise(n, sAt, 4, 5).map(Math.abs)
    const vertical = stepNoise(n, pAt, 4, 7)
    const picks = pickPhases({ startMs: T0, msPerSample: 10, horizontal, vertical }, ms(sAt) + 500)
    expect(picks.s).not.toBeNull()
    expect(Math.abs(picks.s!.atMs - ms(sAt))).toBeLessThanOrEqual(100)
    expect(picks.p).not.toBeNull()
    expect(Math.abs(picks.p!.atMs - ms(pAt))).toBeLessThanOrEqual(100)
  })

  it('対照: P が雑音の 1.5 倍しか無ければ拾わない（SNR は残す）', () => {
    const n = FS * 50
    const sAt = FS * 40
    const horizontal = stepNoise(n, sAt, 4, 5).map(Math.abs)
    const vertical = stepNoise(n, FS * 30, 1.5, 7)
    const picks = pickPhases({ startMs: T0, msPerSample: 10, horizontal, vertical }, ms(sAt) + 500)
    expect(picks.s).not.toBeNull()
    expect(picks.p).toBeNull()
    expect(picks.pSnrTried).not.toBeNull()
    expect(picks.pSnrTried!).toBeLessThan(2)
  })

  it('安全弁: 雑音しか無い窓では S も P も拾わない', () => {
    const n = FS * 50
    const horizontal = stepNoise(n, n, 1, 5).map(Math.abs)
    const vertical = stepNoise(n, n, 1, 7)
    const picks = pickPhases({ startMs: T0, msPerSample: 10, horizontal, vertical }, ms(FS * 40))
    expect(picks.s).toBeNull()
    expect(picks.p).toBeNull()
  })
})
