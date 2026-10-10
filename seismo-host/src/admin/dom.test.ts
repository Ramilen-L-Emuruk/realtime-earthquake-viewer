import { describe, expect, it } from 'vitest'
import { boardLabelHtml, escapeHtml, formatNumber } from './dom'

describe('boardLabelHtml', () => {
  it('正: 表示名があれば名前を出し、基板 Key はホバーへ回す', () => {
    expect(boardLabelHtml('mac:aabbccddeeff', '北の壁')).toBe('<span title="mac:aabbccddeeff">北の壁</span>')
  })

  it('対照: 表示名が無ければ基板 Key をそのまま出す', () => {
    expect(boardLabelHtml('mac:aabbccddeeff', null)).toBe('mac:aabbccddeeff')
    expect(boardLabelHtml('mac:aabbccddeeff', '')).toBe('mac:aabbccddeeff')
  })

  it('安全弁: 名前も基板 Key もエスケープする', () => {
    expect(boardLabelHtml('mac:"x"', '<b>')).toBe('<span title="mac:&quot;x&quot;">&lt;b&gt;</span>')
  })
})

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
