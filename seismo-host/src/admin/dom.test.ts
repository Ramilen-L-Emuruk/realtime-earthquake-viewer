import { describe, expect, it } from 'vitest'
import { escapeHtml, formatNumber } from './dom'

describe('escapeHtml', () => {
  it('5 種の特殊文字をすべてエスケープする', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })

  it('特殊文字を含まない文字列はそのまま返す', () => {
    expect(escapeHtml('東京ラボ')).toBe('東京ラボ')
  })

  it('XSS ペイロードをタグとして解釈されない形へ変える', () => {
    const payload = '<img src=x onerror=alert(1)>'
    const escaped = escapeHtml(payload)
    expect(escaped).not.toContain('<img')
    expect(escaped).toContain('&lt;img')
  })
})

describe('formatNumber', () => {
  it('数値はそのまま文字列化する', () => {
    expect(formatNumber(35.68)).toBe('35.68')
  })

  it('null は空文字列にする', () => {
    expect(formatNumber(null)).toBe('')
  })

  it('0 を空欄と混同しない（null との判別を明示の分岐で行う）', () => {
    expect(formatNumber(0)).toBe('0')
  })
})
