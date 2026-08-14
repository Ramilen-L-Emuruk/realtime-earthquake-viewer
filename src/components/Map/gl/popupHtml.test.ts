import { describe, it, expect } from 'vitest'
import { escapeHtml, twoLinePopupHtml, badgeHtml } from './popupHtml'

describe('escapeHtml', () => {
  it('& を &amp; に変換する', () => {
    expect(escapeHtml('A & B')).toBe('A &amp; B')
  })

  it('< と > を &lt; / &gt; に変換する', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
  })

  it('" を &quot; に変換する（SEC-1）', () => {
    expect(escapeHtml('a"b')).toBe('a&quot;b')
  })

  it("' を &#39; に変換する（SEC-1）", () => {
    expect(escapeHtml("a'b")).toBe('a&#39;b')
  })

  it('全種混在の入力を全部エスケープする', () => {
    expect(escapeHtml(`<a href="/x?y=1&z=2">'test'</a>`))
      .toBe(`&lt;a href=&quot;/x?y=1&amp;z=2&quot;&gt;&#39;test&#39;&lt;/a&gt;`)
  })

  it('特殊文字を含まない入力はそのまま返す', () => {
    expect(escapeHtml('普通の日本語 abc123')).toBe('普通の日本語 abc123')
  })

  it('& が最初に処理される（二重エスケープの回避）', () => {
    // 順序に依存: & → &amp; の後で他の &lt; などが出ても、それらの & は再エスケープされない
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
})

describe('twoLinePopupHtml', () => {
  it('title と subtitle が両方エスケープされる', () => {
    const html = twoLinePopupHtml('A & B', '<danger>')
    expect(html).toContain('A &amp; B')
    expect(html).toContain('&lt;danger&gt;')
  })
})

describe('badgeHtml', () => {
  it('label がエスケープされる（color は既に信頼された hex 文字列のためエスケープ対象外）', () => {
    const html = badgeHtml('7"', '#f00')
    expect(html).toContain('7&quot;')
    expect(html).toContain('background:#f00')
  })
})
