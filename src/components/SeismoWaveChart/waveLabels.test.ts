import { describe, it, expect } from 'vitest'
import { formatEmphasizedScaleGal, formatScaleGal, formatWaveTally } from './waveLabels'

describe('formatScaleGal', () => {
  it('1 以上 10 未満は小数 1 桁で出す', () => {
    expect(formatScaleGal(2)).toBe('±2.0 gal')
    expect(formatScaleGal(1)).toBe('±1.0 gal')
  })

  // 正: 静かな観測点では縦が 1 gal を切るので、小数 2 桁まで出す。
  it('1 未満は小数 2 桁で出す（静穏時はここで動く）', () => {
    expect(formatScaleGal(0.5)).toBe('±0.50 gal')
    expect(formatScaleGal(0.076)).toBe('±0.08 gal')
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

describe('formatEmphasizedScaleGal', () => {
  it('潰した幅と縦の上端を並べる（桁の刻みは formatScaleGal と同じ）', () => {
    expect(formatEmphasizedScaleGal(1.34, 2.64)).toBe('±1.3〜±2.6 gal')
    expect(formatEmphasizedScaleGal(2, 15.4)).toBe('±2.0〜±15 gal')
  })

  // 対照: 静かな観測点の帯でも、幅と上端が同じ数字に潰れない。
  it('1 未満の幅と上端は 2 桁で並べ、同じ数字に潰さない', () => {
    expect(formatEmphasizedScaleGal(0.26, 0.336)).toBe('±0.26〜±0.34 gal')
  })

  it('数として読めない値は出さない', () => {
    expect(formatEmphasizedScaleGal(NaN, 2)).toBe('—')
    expect(formatEmphasizedScaleGal(1, Infinity)).toBe('—')
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
