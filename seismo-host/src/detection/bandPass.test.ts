import { describe, expect, it } from 'vitest'

import { BandPass } from './bandPass'

const FS = 100

/** 正弦波を通し、助走を捨てた後半の振幅（RMS × √2）を返す。 */
function gainAt(hz: number): number {
  const f = new BandPass(5, 10, FS)
  const n = FS * 20
  let sumsq = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    const y = f.step(Math.sin((2 * Math.PI * hz * i) / FS))
    if (i >= n / 2) {
      sumsq += y * y
      count++
    }
  }
  return Math.sqrt(sumsq / count) * Math.SQRT2
}

describe('BandPass', () => {
  it('帯域の中心（√(5×10) ≈ 7.1 Hz）はほぼそのまま通す', () => {
    expect(gainAt(Math.sqrt(50))).toBeGreaterThan(0.95)
  })

  it('帯域の端では約 −6 dB（2 段重ねのため）', () => {
    expect(gainAt(5)).toBeGreaterThan(0.4)
    expect(gainAt(5)).toBeLessThan(0.6)
    expect(gainAt(10)).toBeGreaterThan(0.4)
    expect(gainAt(10)).toBeLessThan(0.6)
  })

  it('建物の揺れの帯（1 Hz）と細かい振動（30 Hz）は 1 割未満まで落とす', () => {
    expect(gainAt(1)).toBeLessThan(0.1)
    expect(gainAt(30)).toBeLessThan(0.1)
  })

  it('直流（重力）は通さない', () => {
    const f = new BandPass(5, 10, FS)
    let last = 0
    for (let i = 0; i < FS * 10; i++) last = f.step(980)
    expect(Math.abs(last)).toBeLessThan(1e-6)
  })

  it('不正な帯域は作る時点で投げる（ナイキストを超える・上下が逆）', () => {
    expect(() => new BandPass(5, 60, FS)).toThrow()
    expect(() => new BandPass(10, 5, FS)).toThrow()
    expect(() => new BandPass(0, 5, FS)).toThrow()
  })
})
