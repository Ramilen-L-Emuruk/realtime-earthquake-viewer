// 波形の向きの表示状態。
//
// **固定するのは 3 つ** ——押した向きだけが反転すること・**変わらなければ同じ参照**
// （`useSyncExternalStore` が無限に再描画しないための前提）・購読が解けること。

import { afterEach, describe, expect, it } from 'vitest'

import { readWaveAxes, resetWaveAxes, toggleWaveAxis } from './useSeismoWaveAxes'

afterEach(() => {
  // モジュールの状態はテスト間で持ち越される。
  resetWaveAxes()
})

describe('useSeismoWaveAxes', () => {
  it('はじめは 3 つとも表示', () => {
    expect(readWaveAxes()).toEqual([true, true, true])
  })

  it('押した向きだけが反転する', () => {
    toggleWaveAxis(2)
    expect(readWaveAxes()).toEqual([true, true, false])
    toggleWaveAxis(2)
    expect(readWaveAxes()).toEqual([true, true, true])
  })

  it('範囲の外は黙って捨てる', () => {
    // **対照。** 配線の誤りで例外にしない（絵の凡例を押しただけで画面が落ちる）。
    const before = readWaveAxes()
    toggleWaveAxis(-1)
    toggleWaveAxis(3)
    toggleWaveAxis(1.5)
    expect(readWaveAxes()).toBe(before)
  })

  it('変わらなければ同じ参照を返す', () => {
    // **安全弁。** 毎回新しい配列を返すと `useSyncExternalStore` が無限に再描画する。
    expect(readWaveAxes()).toBe(readWaveAxes())
    resetWaveAxes()
    expect(readWaveAxes()).toBe(readWaveAxes())
  })

  it('全部表示へ戻せる', () => {
    toggleWaveAxis(0)
    toggleWaveAxis(1)
    resetWaveAxes()
    expect(readWaveAxes()).toEqual([true, true, true])
  })
})
