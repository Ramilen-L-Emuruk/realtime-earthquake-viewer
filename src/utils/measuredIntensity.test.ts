import { describe, it, expect } from 'vitest'

import { getIntensityColor } from './intensity'
import { kyoshinIndexToJma, kyoshinIntensityColor } from './kyoshinIntensity'
import { intensityGradeColor, measuredIntensityToGrade, SHINDO0_COLOR } from './measuredIntensity'

describe('measuredIntensityToGrade', () => {
  // 気象庁の階級表が定めるのは「計測震度 0.5 未満 = 震度0」だけで、**下限は無い**。
  // 静穏時のホストは負の計測震度を返す（`2*log10(a)+0.94` で a < 0.34 gal）ので、
  // ここを弾くと平常時の自作地震計が階級を持たない行になる。
  it('負の計測震度も震度0（階級表に下限は無い）', () => {
    expect(measuredIntensityToGrade(-0.001)?.label).toBe('0')
    expect(measuredIntensityToGrade(-3)?.label).toBe('0')
  })

  // **非有限値は震度7 に落ちてはならない。** 比較だけで振り分ける形は `NaN` が
  // すべての `<` を素通りするので、最後の枝（震度7）に着地する。値が壊れたときに
  // いちばん強い階級が出るのを塞ぐ。
  it('非有限値は null（NaN が震度7 へ落ちない）', () => {
    expect(measuredIntensityToGrade(Number.NaN)).toBeNull()
    expect(measuredIntensityToGrade(Number.POSITIVE_INFINITY)).toBeNull()
    expect(measuredIntensityToGrade(Number.NEGATIVE_INFINITY)).toBeNull()
  })

  it('境目の値は上の階級へ入る', () => {
    const cases: readonly [number, string][] = [
      [0.0, '0'],
      [0.499, '0'],
      [0.5, '1'],
      [1.499, '1'],
      [1.5, '2'],
      [2.5, '3'],
      [3.5, '4'],
      [4.5, '5弱'],
      [5.0, '5強'],
      [5.5, '6弱'],
      [6.0, '6強'],
      [6.5, '7'],
      [9.9, '7'],
    ]
    for (const [value, label] of cases) {
      expect(measuredIntensityToGrade(value)?.label, `計測震度 ${value}`).toBe(label)
    }
  })

  // 震度0 と震度1 は `scale` が同値（10）になる。**段が上がったかの判定に
  // `scale` を使うと震度0→1 を取りこぼす**ので、`rank` を分けて持っている。
  it('震度0 と震度1 は scale が同値で rank だけが違う', () => {
    expect(measuredIntensityToGrade(0.2)).toEqual({ label: '0', scale: 10, rank: 0 })
    expect(measuredIntensityToGrade(1.0)).toEqual({ label: '1', scale: 10, rank: 1 })
  })
})

describe('intensityGradeColor', () => {
  it('震度0 だけ灰色（気象庁配色に震度0 の色が無いため）', () => {
    const zero = measuredIntensityToGrade(0.2)
    expect(zero).not.toBeNull()
    expect(intensityGradeColor(zero!)).toBe(SHINDO0_COLOR)
  })

  it('震度1 以上は気象庁の震度配色', () => {
    const one = measuredIntensityToGrade(1.0)
    expect(one).not.toBeNull()
    expect(intensityGradeColor(one!)).toBe(getIntensityColor(10))
  })
})

// 表を `measuredIntensity.ts` へ移したので、強震モニタ側が同じ答えを返し続けることを
// ここで固定する（インデックス → 計測震度の掛け算だけがあちらの仕事）。
describe('kyoshinIndexToJma（表の移動で振る舞いが変わっていないこと）', () => {
  it('index 6 が震度0・index 20 が震度7・index 0 は null', () => {
    expect(kyoshinIndexToJma(0)).toBeNull() // 計測震度 -3.0
    expect(kyoshinIndexToJma(6)?.label).toBe('0') // 計測震度 0.0
    expect(kyoshinIndexToJma(20)?.label).toBe('7') // 計測震度 7.0
  })

  it('undefined と NaN は null', () => {
    expect(kyoshinIndexToJma(undefined)).toBeNull()
    expect(kyoshinIndexToJma(Number.NaN)).toBeNull()
  })

  it('色も従来どおり（震度0 は灰・震度1 以上は気象庁配色・震度0 未満は null）', () => {
    expect(kyoshinIntensityColor(0)).toBeNull()
    expect(kyoshinIntensityColor(6)).toBe(SHINDO0_COLOR)
    expect(kyoshinIntensityColor(20)).toBe(getIntensityColor(70))
  })
})
