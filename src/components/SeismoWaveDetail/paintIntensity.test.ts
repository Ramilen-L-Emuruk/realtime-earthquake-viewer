import { describe, expect, it, vi } from 'vitest'

import { log } from '../../utils/logger'
import { intensityYRange, paintIntensitySeries } from './paintIntensity'

vi.mock('../../utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/logger')>()
  return { ...actual, log: { ...actual.log, error: vi.fn() } }
})

describe('paintIntensitySeries', () => {
  // 安全弁: 描けないことを黙らない（「推移が無い」と区別が付かなくなる）。間引くので 2 回目は書かない。
  it('2D コンテキストが取れなければ記録し、続けては書かない', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement
    const range = { fromMs: 0, toMs: 1000 }
    paintIntensitySeries(canvas, range, [], [])
    paintIntensitySeries(canvas, range, [], [])
    expect(log.error).toHaveBeenCalledTimes(1)
  })
})

describe('intensityYRange', () => {
  // 安全弁: 値が無くても幅を持つ（描く側が max - min で割る）。
  it('値が無ければ 0〜1.5', () => {
    expect(intensityYRange([])).toEqual({ min: 0, max: 1.5 })
  })

  // 対照: 静穏時の小さな値では上の下限（震度2 の境目）が効く。
  it('小さな値では上は 1.5 のまま', () => {
    expect(intensityYRange([0.2, 0.46])).toEqual({ min: 0, max: 1.5 })
  })

  // 正: 値が大きければ余白を足して 0.5 刻みへ切り上げる。
  it('大きな値では余白を足して切り上げる', () => {
    expect(intensityYRange([2.34])).toEqual({ min: 0, max: 3 })
  })

  it('負の値があれば下を広げる', () => {
    expect(intensityYRange([-0.3, 0.1])).toEqual({ min: -0.5, max: 1.5 })
  })

  it('有限でない値は無視する', () => {
    expect(intensityYRange([Number.NaN, Number.POSITIVE_INFINITY])).toEqual({ min: 0, max: 1.5 })
  })
})
