import { describe, it, expect } from 'vitest'

import { measuredIntensityToGrade } from './measuredIntensity'
import { formatMeasured, jmaMeasuredTenths } from './measuredIntensityRounding'

describe('jmaMeasuredTenths（気象庁の最後の手順）', () => {
  // 「計算された I の小数第３位を四捨五入し、小数第２位を切り捨てたものを計測震度とする」
  it('正: 小数第 2 位は切り捨てる（2.46 は 2.4。四捨五入なら 2.5 になる）', () => {
    expect(jmaMeasuredTenths(2.46)).toBe(24)
    expect(jmaMeasuredTenths(2.49)).toBe(24)
  })

  it('正: 小数第 3 位は四捨五入する（2.4951 は 2.50 を経て 2.5）', () => {
    expect(jmaMeasuredTenths(2.4951)).toBe(25)
  })

  it('対照: 第 3 位が 5 に届かなければ繰り上がらない（2.4949 は 2.4）', () => {
    expect(jmaMeasuredTenths(2.4949)).toBe(24)
  })

  // マイナスゼロを潰すときに `|| 0` と書くと、壊れた値まで 0（震度0・「0.0」）に化ける。
  it('安全弁: 数でない値は数でないまま返す', () => {
    expect(jmaMeasuredTenths(Number.NaN)).toBeNaN()
    expect(formatMeasured(Number.NaN)).not.toBe('0.0')
  })

  // 浮動小数で 10 を掛けて切り捨てると `2.3 * 10 = 22.999…` で 2.2 に落ちる。
  it('安全弁: ちょうど小数 1 桁の値は動かない（浮動小数の罠）', () => {
    for (let t = -30; t <= 75; t += 1) {
      expect(jmaMeasuredTenths(t / 10), `${t / 10}`).toBe(t)
    }
  })
})

describe('formatMeasured', () => {
  it('正: 気象庁の手順で小数 1 桁にする', () => {
    expect(formatMeasured(2.46)).toBe('2.4')
    expect(formatMeasured(2.4951)).toBe('2.5')
    expect(formatMeasured(0.06)).toBe('0.0')
  })

  // 静穏時のホストは `-0.04` のような値をよく返す。`"-0.0"` は表示が壊れたように見える。
  it('安全弁: マイナスゼロを出さない', () => {
    expect(formatMeasured(-0.04)).toBe('0.0')
    expect(formatMeasured(-0.001)).toBe('0.0')
  })

  it('対照: 0 を超えて負なら符号は残す（0 へ向けて切り捨てる）', () => {
    expect(formatMeasured(-0.15)).toBe('-0.1')
    expect(formatMeasured(-1.26)).toBe('-1.2')
  })
})

// **これがこの部品を置いた理由。** 数字と階級を別々の引き方で出すと、
// 2.495〜2.5 未満のような細い帯で「2.5・震度2」が出る。
describe('出した数字と階級は食い違わない', () => {
  it('-1.0〜7.5 を 0.0001 刻みで、数字から引いた階級と値から引いた階級が一致する', () => {
    for (let i = -10_000; i <= 75_000; i += 1) {
      const v = i / 10_000
      const fromValue = measuredIntensityToGrade(v)?.label
      const fromText = measuredIntensityToGrade(Number(formatMeasured(v)))?.label
      if (fromValue !== fromText) throw new Error(`${v}: 値から ${fromValue}・数字 ${formatMeasured(v)} から ${fromText}`)
    }
  })
})
