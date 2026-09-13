import { describe, it, expect, vi } from 'vitest'
import { createFirstSeenLogGate, createLogThrottle, createPerLabelLogGate } from './logger'

// 値の種類で間引くゲート（`createFirstSeenLogGate`）。時間で間引く `createLogThrottle` とは
// 用途が違う —— 同じ入力が何度も通る経路（表示の整形は再描画のたびに走る）では、時間間引きだと
// 壊れた値 1 つで出続けるため。
describe('createFirstSeenLogGate', () => {
  it('初めて見る値では記録する', () => {
    const gate = createFirstSeenLogGate(10, 60_000)
    const emit = vi.fn()
    gate('壊れた値', emit)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(false)
  })

  // 対照: 同じ値の 2 回目以降は鳴らない。これが無いと、再描画のたびに同じ行が積まれる。
  it('同じ値の 2 回目以降は鳴らない', () => {
    const gate = createFirstSeenLogGate(10, 60_000)
    const emit = vi.fn()
    gate('壊れた値', emit)
    gate('壊れた値', emit)
    gate('壊れた値', emit)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('値が違えばそれぞれ 1 回ずつ記録する', () => {
    const gate = createFirstSeenLogGate(10, 60_000)
    const emit = vi.fn()
    gate('壊れた値A', emit)
    gate('壊れた値B', emit)
    expect(emit).toHaveBeenCalledTimes(2)
  })

  // **安全弁: 上限に達しても黙らない。** ここを「上限で打ち切る」作りにすると、一度でも
  // 種類が溢れた時点でその検出が永久に死ぬ（しかも死んだ痕跡も残らない）。
  it('種類が上限を超えても、時間の間引きで出し続ける', () => {
    vi.useFakeTimers()
    try {
      const gate = createFirstSeenLogGate(2, 60_000)
      const emit = vi.fn()
      gate('値1', emit)
      gate('値2', emit)
      expect(emit).toHaveBeenCalledTimes(2)

      // 上限を超えた 3 つ目。時間間引きの 1 回目なので通る。
      gate('値3', emit)
      expect(emit).toHaveBeenCalledTimes(3)
      expect(emit).toHaveBeenLastCalledWith(true)

      // 間隔内の 4 つ目は間引かれる。
      gate('値4', emit)
      expect(emit).toHaveBeenCalledTimes(3)

      // 間隔が明ければまた出る（黙ったままにならない）。
      vi.advanceTimersByTime(60_001)
      gate('値5', emit)
      expect(emit).toHaveBeenCalledTimes(4)
      expect(emit).toHaveBeenLastCalledWith(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // 安全弁: 上限を超えたあとも、`Set` へは足さない（足すと上限の意味が無くなる）。
  // 外から `Set` は見えないので、「同じ値を繰り返しても時間間引きに従う」ことで確かめる。
  it('上限を超えたあとの値は覚えない（同じ値でも時間間引きに従う）', () => {
    vi.useFakeTimers()
    try {
      const gate = createFirstSeenLogGate(1, 60_000)
      const emit = vi.fn()
      gate('値1', emit)
      gate('値2', emit)
      expect(emit).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(60_001)
      // 覚えていれば 2 回目は鳴らないはず。覚えていないので、間隔が明けた分だけ鳴る。
      gate('値2', emit)
      expect(emit).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ラベルごとにゲートを分ける。**1 個を共有すると、ある種類で壊れた値が連発したときに
// 枠と間隔を食い尽くし、別の種類の異常が出るかどうかが偶然に左右される。**
describe('createPerLabelLogGate', () => {
  it('ラベルが違えば同じ値でもそれぞれ記録する', () => {
    const gate = createPerLabelLogGate(10, 60_000)
    const emit = vi.fn()
    gate('ラベルA', '同じ値', emit)
    gate('ラベルB', '同じ値', emit)
    expect(emit).toHaveBeenCalledTimes(2)
  })

  // 対照: 同じラベル・同じ値なら 1 回だけ（ゲートの性質を引き継いでいること）。
  it('同じラベルの同じ値は 1 回だけ', () => {
    const gate = createPerLabelLogGate(10, 60_000)
    const emit = vi.fn()
    gate('ラベルA', '同じ値', emit)
    gate('ラベルA', '同じ値', emit)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  // **安全弁: あるラベルで枠を使い切っても、別のラベルは影響を受けない。**
  it('あるラベルで上限に達しても、別のラベルは素で記録できる', () => {
    const gate = createPerLabelLogGate(2, 60_000)
    const emit = vi.fn()
    gate('ラベルA', '値1', emit)
    gate('ラベルA', '値2', emit)
    gate('ラベルA', '値3', emit)   // 上限超過。時間間引きの 1 回目なので通る
    emit.mockClear()
    gate('ラベルA', '値4', emit)   // 間隔内なので間引かれる
    expect(emit).not.toHaveBeenCalled()
    gate('ラベルB', '値4', emit)   // 別ラベルは枠が空いている
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(false)
  })
})

describe('createLogThrottle', () => {
  it('初回は通し、間隔内は間引く', () => {
    vi.useFakeTimers()
    try {
      const throttle = createLogThrottle(1000)
      const emit = vi.fn()
      throttle(emit)
      throttle(emit)
      expect(emit).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1001)
      throttle(emit)
      expect(emit).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
