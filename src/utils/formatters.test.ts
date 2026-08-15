import { describe, it, expect } from 'vitest'
import { formatDepth, formatMagnitude } from './formatters'
import { getMagnitudeColor, getDepthColor } from './intensity'

// 規模・深さの色は文字表示（formatMagnitude / formatDepth）と同じ判定で「不明」を弾く必要がある。
// NaN は比較演算がすべて false になるため、ガードが無いと最終行（M7 以上＝紫）に落ちて
// 「不明」の文字の隣に最も深刻な色が付く、という文字と色の矛盾が起きる。
describe('色付けの不明ガード', () => {
  const UNKNOWN = '#666666'

  it('規模 NaN・負値は不明色（M7 以上の紫に落ちない）', () => {
    expect(getMagnitudeColor(Number.NaN)).toBe(UNKNOWN)
    expect(getMagnitudeColor(-1)).toBe(UNKNOWN)
    expect(getMagnitudeColor(7.4)).not.toBe(UNKNOWN)
  })

  it('深さ NaN・負値は不明色、0 は「ごく浅い」の色', () => {
    expect(getDepthColor(Number.NaN)).toBe(UNKNOWN)
    expect(getDepthColor(-1)).toBe(UNKNOWN)
    expect(getDepthColor(0)).not.toBe(UNKNOWN)
  })
})

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
