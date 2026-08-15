import { describe, it, expect } from 'vitest'
import { isValidIntensityScale, INTENSITY_LABELS, getIntensityLabel, getIntensityColor } from './intensity'

describe('isValidIntensityScale', () => {
  it('震度階級に対応する値をすべて受け入れる', () => {
    for (const key of Object.keys(INTENSITY_LABELS)) {
      expect(isValidIntensityScale(Number(key))).toBe(true)
    }
  })

  it('震度未確定のセンチネル -1 を受け入れる', () => {
    expect(isValidIntensityScale(-1)).toBe(true)
  })

  it('中間値を弾く（2026-08-15 に混入した scaleTo:25 のような手打ちミス）', () => {
    for (const v of [15, 25, 35, 65]) {
      expect(isValidIntensityScale(v)).toBe(false)
    }
  })

  it('範囲外の値を弾く（旧「震度算出不能」コードの 99 を含む）', () => {
    for (const v of [0, 5, 71, 99, 1000, -2]) {
      expect(isValidIntensityScale(v)).toBe(false)
    }
  })

  it('数値でない特殊値を弾く', () => {
    for (const v of [NaN, Infinity, -Infinity, 1.5]) {
      expect(isValidIntensityScale(v)).toBe(false)
    }
  })

  // 型検査が及ばない経路（実地震シナリオ JSON・P2PQuake の as キャスト）を守るための関数なので、
  // 実行時に型どおりでない値が来ても誤って通さないことを固定する。
  it('型を迂回した文字列を弾く（継承プロパティ経由で真にならない）', () => {
    for (const v of ['toString', 'constructor', 'hasOwnProperty', '10', '-1']) {
      expect(isValidIntensityScale(v as unknown as number)).toBe(false)
    }
  })

  it('null / undefined を弾く', () => {
    expect(isValidIntensityScale(null as unknown as number)).toBe(false)
    expect(isValidIntensityScale(undefined as unknown as number)).toBe(false)
  })
})

describe('getIntensityLabel / getIntensityColor のフォールバック', () => {
  it('震度スケール外の値は「不明」と灰色になる', () => {
    expect(getIntensityLabel(25)).toBe('不明')
    expect(getIntensityColor(25)).toBe('#666666')
  })

  it('未確定の -1 も「不明」表示になる', () => {
    expect(getIntensityLabel(-1)).toBe('不明')
  })
})
