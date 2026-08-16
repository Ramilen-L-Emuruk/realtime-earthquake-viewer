import { describe, it, expect } from 'vitest'
import { isValidLpgmClass, getLpgmClassLabel, getLpgmClassColor } from './lpgm'

describe('isValidLpgmClass', () => {
  it('階級 1〜4 を受け入れる', () => {
    for (const v of [1, 2, 3, 4]) expect(isValidLpgmClass(v)).toBe(true)
  })

  it('範囲外の値を弾く', () => {
    for (const v of [0, -1, 5, 99]) expect(isValidLpgmClass(v)).toBe(false)
  })

  it('非整数・特殊値を弾く', () => {
    for (const v of [1.5, NaN, Infinity, -Infinity]) expect(isValidLpgmClass(v)).toBe(false)
  })

  // 型検査が及ばない経路（実地震シナリオ JSON・as キャスト）を守るための関数なので、
  // 実行時に型どおりでない値が来ても誤って通さないことを固定する。
  it('型を迂回した文字列・null・undefined を弾く', () => {
    for (const v of ['1', 'toString', null, undefined]) {
      expect(isValidLpgmClass(v as unknown as number)).toBe(false)
    }
  })
})

describe('getLpgmClassLabel', () => {
  it('階級 1〜4 はそのままラベル化する', () => {
    expect(getLpgmClassLabel(1)).toBe('階級1')
    expect(getLpgmClassLabel(4)).toBe('階級4')
  })

  // 以前はフォールバックが無く、壊れた入力がそのまま「階級99」として地図ラベルに出ていた。
  it('範囲外の値は「階級不明」にフォールバックする', () => {
    for (const v of [0, 5, 99, NaN]) expect(getLpgmClassLabel(v)).toBe('階級不明')
  })
})

describe('getLpgmClassColor', () => {
  it('範囲外の値はグレーにフォールバックする', () => {
    expect(getLpgmClassColor(99)).toBe('#9ca3af')
  })
})
