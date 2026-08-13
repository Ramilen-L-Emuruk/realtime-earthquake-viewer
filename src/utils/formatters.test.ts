import { describe, it, expect } from 'vitest'
import { formatDepth, formatMagnitude } from './formatters'

describe('formatDepth', () => {
  it('depth=0 は "ごく浅い"', () => {
    expect(formatDepth(0)).toBe('ごく浅い')
  })
  it('負値は "不明"', () => {
    expect(formatDepth(-1)).toBe('不明')
  })
  it('通常値は "Nkm"', () => {
    expect(formatDepth(50)).toBe('50km')
  })
  it('NaN は "不明"', () => {
    expect(formatDepth(Number.NaN)).toBe('不明')
  })
  it('undefined 相当（Number 変換 NaN）は "不明"', () => {
    expect(formatDepth(Number(undefined))).toBe('不明')
  })
  it('Infinity は "不明"', () => {
    expect(formatDepth(Number.POSITIVE_INFINITY)).toBe('不明')
  })
})

describe('formatMagnitude', () => {
  it('負値は "不明"', () => {
    expect(formatMagnitude(-1)).toBe('不明')
  })
  it('通常値は "M X.Y"', () => {
    expect(formatMagnitude(5.3)).toBe('M5.3')
  })
  it('NaN は "不明"', () => {
    expect(formatMagnitude(Number.NaN)).toBe('不明')
  })
  it('undefined 相当（Number 変換 NaN）は "不明"', () => {
    expect(formatMagnitude(Number(undefined))).toBe('不明')
  })
  it('Infinity は "不明"', () => {
    expect(formatMagnitude(Number.POSITIVE_INFINITY)).toBe('不明')
  })
})
