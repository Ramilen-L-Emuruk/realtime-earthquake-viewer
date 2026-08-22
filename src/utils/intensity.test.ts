import { describe, it, expect } from 'vitest'
import { isValidIntensityScale, INTENSITY_LABELS, getIntensityLabel, getIntensityLabelWithOrAbove, getIntensityColor } from './intensity'

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

// 上限を定めない予想震度（EEW の `to: "over"` / `scaleTo: 99`）に語を足す共有ヘルパー。
// 表示・読み上げが同じ形になるよう、付ける/付けないの境界はここだけで決める。
describe('getIntensityLabelWithOrAbove', () => {
  it('階級に「以上」を足す', () => {
    expect(getIntensityLabelWithOrAbove(40, true)).toBe('4以上')
    expect(getIntensityLabelWithOrAbove(55, true)).toBe('6弱以上')
  })

  it('フラグが立っていなければ足さない', () => {
    expect(getIntensityLabelWithOrAbove(40, false)).toBe('4')
  })

  it('未確定（-1）には足さない（「不明以上」を作らない）', () => {
    expect(getIntensityLabelWithOrAbove(-1, true)).toBe('不明')
  })

  it('震度スケール外の値にも足さない', () => {
    expect(getIntensityLabelWithOrAbove(25, true)).toBe('不明')
    // 0 は震度階級として持たない値。ラベルは「不明」で、語も付けない
    expect(getIntensityLabelWithOrAbove(0, true)).toBe('不明')
  })
})
