import { describe, it, expect } from 'vitest'
import { escapeHtml, twoLinePopupHtml, badgeHtml } from './popupHtml'
import { contrastRatio } from '../../../utils/contrast'
import { INTENSITY_COLORS } from '../../../utils/intensity'

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

  // EEW の「上限を定めない予想震度」で 2 文字を超えるラベルが入るようになった。
  // 折り返すと狭い親の中で「4以」「上」と縦に割れる（実機で確認済み）。
  it('ラベルを折り返さない', () => {
    expect(badgeHtml('4以上', '#f5e600')).toContain('white-space:nowrap')
  })

  // 白固定だと震度4（黄）で 1.30:1 まで落ちるため、文字色は塗り色から決めている。
  it('明るい塗りでは黒文字、暗い塗りでは白文字になる', () => {
    expect(badgeHtml('4', '#f5e600')).toContain('color:#000000')
    expect(badgeHtml('7', '#9d0099')).toContain('color:#ffffff')
  })

  it('全震度で AA（4.5:1）を満たす文字色が選ばれる', () => {
    for (const bg of Object.values(INTENSITY_COLORS)) {
      const fg = badgeHtml('x', bg).match(/color:(#[0-9a-f]{6})/)![1]
      expect(contrastRatio(bg, fg)!).toBeGreaterThanOrEqual(4.5)
    }
  })
})
