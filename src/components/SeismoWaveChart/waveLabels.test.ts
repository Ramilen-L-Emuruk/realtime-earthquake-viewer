import { describe, it, expect } from 'vitest'
import { formatScaleGal, formatWaveTally } from './waveLabels'

describe('formatScaleGal', () => {
  it('小さい値は小数 1 桁で出す（静穏時はここで動く）', () => {
    expect(formatScaleGal(0.5)).toBe('±0.5 gal')
    expect(formatScaleGal(2)).toBe('±2.0 gal')
  })

  it('大きい値は整数へ丸める', () => {
    expect(formatScaleGal(12.3)).toBe('±12 gal')
    expect(formatScaleGal(150.6)).toBe('±151 gal')
  })

  it('数として読めない値は出さない', () => {
    expect(formatScaleGal(NaN)).toBe('—')
    expect(formatScaleGal(Infinity)).toBe('—')
  })
})

describe('formatWaveTally', () => {
  // 対照: 常時「欠測 0」を出すと、本当に起きたときの変化が目に入らない。
  it('何も起きていなければ出さない', () => {
    expect(formatWaveTally({ gapSamples: 0, restarts: 0, droppedSamples: 0 })).toBe(null)
  })

  it('0 でないものだけを並べる', () => {
    expect(formatWaveTally({ gapSamples: 120, restarts: 0, droppedSamples: 0 })).toBe('欠測 120')
    expect(formatWaveTally({ gapSamples: 0, restarts: 2, droppedSamples: 0 })).toBe('引き直し 2')
    expect(formatWaveTally({ gapSamples: 0, restarts: 0, droppedSamples: 30 })).toBe('重複 30')
  })

  it('複数あれば並べて出す', () => {
    expect(formatWaveTally({ gapSamples: 120, restarts: 2, droppedSamples: 30 })).toBe(
      '欠測 120 / 引き直し 2 / 重複 30',
    )
  })
})
