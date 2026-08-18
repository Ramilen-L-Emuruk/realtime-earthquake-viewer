import { describe, it, expect } from 'vitest'
import { contrastRatio, readableTextColor, TEXT_ON_FILL_LIGHT, TEXT_ON_FILL_DARK } from './contrast'
import { INTENSITY_COLORS } from './intensity'
import { SHINDO0_COLOR } from './kyoshinIntensity'
import { getLpgmClassColor } from './lpgm'

/** WCAG AA・通常サイズの文字（14pt 太字／18pt 未満）に要求されるコントラスト比。 */
const AA_NORMAL = 4.5

describe('contrastRatio', () => {
  it('白と黒が理論上限の 21:1 になる', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
  })

  it('同色は 1:1 になる', () => {
    expect(contrastRatio('#f5e600', '#f5e600')).toBeCloseTo(1, 10)
  })

  it('引数の順序で結果が変わらない', () => {
    expect(contrastRatio('#ef4444', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#ef4444')!, 10)
  })

  it('#rgb 短縮形を #rrggbb と同じに解釈する', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5)
  })

  it('解釈できない色は null を返す', () => {
    for (const v of ['rgba(0,0,0,0.5)', 'red', '#12345', '', '#gggggg']) {
      expect(contrastRatio(v, '#ffffff')).toBeNull()
    }
  })
})

describe('readableTextColor', () => {
  it('明るい背景には黒、暗い背景には白を選ぶ', () => {
    expect(readableTextColor('#f5e600')).toBe(TEXT_ON_FILL_DARK)  // 震度4（黄）
    expect(readableTextColor('#9d0099')).toBe(TEXT_ON_FILL_LIGHT) // 震度7（紫）
  })

  // 白 4.46 / 黒 4.71 と僅差で、明度しきい値の決め打ちでは選択を誤る色。
  it('中間輝度の震度6弱（#f00000）で黒を選ぶ', () => {
    expect(readableTextColor('#f00000')).toBe(TEXT_ON_FILL_DARK)
  })

  // これは想定外の値が来たときの最終防波堤であり、「`rgba()` を渡してよい」という意味ではない。
  // 白へ倒すと明るい塗りでは AA を割るため、新しい呼び出し元を足すときは
  // #rrggbb（震度・長周期の配色）以外がここへ到達しないことを確認すること。
  it('解釈できない値では白へフォールバックする', () => {
    for (const v of ['rgba(42,42,42,0.6)', 'transparent', '']) {
      expect(readableTextColor(v)).toBe(TEXT_ON_FILL_LIGHT)
    }
  })
})

// 配色そのものは気象庁の仕様で固定されているため変更できない。文字色の自動選択だけで
// 全階級が AA を満たすことが、このバッジ群のアクセシビリティの前提になっている。
// 配色を触った場合はここが落ちるので、色を変えるなら文字色の担保も見直すこと。
describe('震度配色に対する文字色の自動選択', () => {
  const palette: Record<string, string> = { ...INTENSITY_COLORS, 震度0: SHINDO0_COLOR }

  for (const [scale, bg] of Object.entries(palette)) {
    it(`scale=${scale}（${bg}）が AA ${AA_NORMAL}:1 を満たす`, () => {
      const fg = readableTextColor(bg)
      expect(contrastRatio(bg, fg)!).toBeGreaterThanOrEqual(AA_NORMAL)
    })
  }

  it('白固定では複数の階級が AA を割る（自動選択が必要な理由）', () => {
    const failing = Object.values(INTENSITY_COLORS).filter(
      bg => contrastRatio(bg, TEXT_ON_FILL_LIGHT)! < AA_NORMAL
    )
    expect(failing.length).toBeGreaterThan(0)
  })
})

// 長周期地震動階級も同じ仕組みでバッジを描いている（lpgmIcons.ts・badgeHtml）。
// 震度と別のパレットなので、震度側が通っていてもこちらは保証されない。
describe('長周期地震動階級の配色に対する文字色の自動選択', () => {
  for (const cls of [1, 2, 3, 4]) {
    it(`階級${cls} が AA ${AA_NORMAL}:1 を満たす`, () => {
      const bg = getLpgmClassColor(cls)
      expect(contrastRatio(bg, readableTextColor(bg))!).toBeGreaterThanOrEqual(AA_NORMAL)
    })
  }

  it('階級不明のフォールバック色でも AA を満たす', () => {
    const bg = getLpgmClassColor(99)
    expect(contrastRatio(bg, readableTextColor(bg))!).toBeGreaterThanOrEqual(AA_NORMAL)
  })
})
