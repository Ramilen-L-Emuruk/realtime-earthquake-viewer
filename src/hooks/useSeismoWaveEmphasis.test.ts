// 強調の切り替え状態。既定が「強調する」であること・押すと反転すること・後始末で戻ること。

import { afterEach, describe, expect, it } from 'vitest'

import { readWaveEmphasis, resetWaveEmphasis, toggleWaveEmphasis } from './useSeismoWaveEmphasis'

afterEach(() => {
  resetWaveEmphasis()
})

describe('useSeismoWaveEmphasis', () => {
  it('はじめは強調する（2026-10-03 のユーザー判断）', () => {
    expect(readWaveEmphasis()).toBe(true)
  })

  it('押すと反転し、もう一度押すと戻る', () => {
    toggleWaveEmphasis()
    expect(readWaveEmphasis()).toBe(false)
    toggleWaveEmphasis()
    expect(readWaveEmphasis()).toBe(true)
  })

  it('後始末で既定へ戻る', () => {
    toggleWaveEmphasis()
    resetWaveEmphasis()
    expect(readWaveEmphasis()).toBe(true)
  })
})
