// @vitest-environment jsdom
//
// 波形グラフを出し入れする境界の回帰テスト。
//
// 固定するのは**余韻の数え方**。揺れが収まった瞬間に絵まで消えると、いちばん見たい
// 波形（立ち上がりから収束まで）を見られないまま終わる。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSeismoWaveVisibility } from './useSeismoWaveVisibility'
import type { SeismoWaveMode } from '../utils/seismoWaveTrigger'
import { NO_SCOPE } from '../utils/actionChecklistTrigger'

/** 震度1 を出している観測点（`intensity >= 0.5`）。 */
const SHAKING = [{ intensity: 1.2 }]
/** 静穏時の実機（負の計測震度）。 */
const QUIET = [{ intensity: -0.04 }]

function setup(mode: SeismoWaveMode, stations: readonly { intensity: number | null }[]) {
  return renderHook(
    (props: { mode: SeismoWaveMode; stations: readonly { intensity: number | null }[] }) =>
      useSeismoWaveVisibility({
        mode: props.mode,
        scope: NO_SCOPE,
        eews: [],
        detectedPoints: [],
        stations: props.stations,
      }),
    { initialProps: { mode, stations } },
  )
}

describe('useSeismoWaveVisibility', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('切っていれば揺れても出さない', () => {
    const h = setup('off', SHAKING)
    expect(h.result.current).toBe(false)
  })

  it('常に表示なら揺れていなくても出す', () => {
    const h = setup('always', QUIET)
    expect(h.result.current).toBe(true)
  })

  it('自動では、揺れていなければ出さない', () => {
    const h = setup('auto', QUIET)
    expect(h.result.current).toBe(false)
  })

  it('自動では、揺れたら出す', () => {
    const h = setup('auto', SHAKING)
    expect(h.result.current).toBe(true)
  })

  it('揺れが収まってからも余韻のあいだは出したままにする', () => {
    const h = setup('auto', SHAKING)
    expect(h.result.current).toBe(true)

    h.rerender({ mode: 'auto', stations: QUIET })
    expect(h.result.current).toBe(true)

    act(() => {
      vi.advanceTimersByTime(59_000)
    })
    expect(h.result.current).toBe(true)

    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(h.result.current).toBe(false)
  })

  // 正: 余韻を数え始めるのは「収まった時点」。成立した時点から数える形（成立時刻を控えて
  // 残りを引く）にすると、`triggered` が真のまま変わらない間は効果が走り直さないため
  // 起点が更新されず、**60 秒を超える揺れでは収まった瞬間に絵が消える**。
  it('60 秒を超えて揺れ続けても、収まってから余韻を数える', () => {
    const h = setup('auto', SHAKING)

    // 揺れている間に余韻ぶんを超えて時間が進む
    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    h.rerender({ mode: 'auto', stations: SHAKING })
    expect(h.result.current).toBe(true)

    // ここで収まる
    h.rerender({ mode: 'auto', stations: QUIET })
    act(() => {
      vi.advanceTimersByTime(59_000)
    })
    expect(h.result.current).toBe(true)

    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(h.result.current).toBe(false)
  })

  // 安全弁: 余韻の最中にもう一度揺れたら、そこから数え直す。
  it('余韻の最中に揺れ直したら数え直す', () => {
    const h = setup('auto', SHAKING)
    h.rerender({ mode: 'auto', stations: QUIET })
    act(() => {
      vi.advanceTimersByTime(59_000)
    })
    h.rerender({ mode: 'auto', stations: SHAKING })
    h.rerender({ mode: 'auto', stations: QUIET })
    act(() => {
      vi.advanceTimersByTime(59_000)
    })
    expect(h.result.current).toBe(true)
  })

  // 対照: 「常に表示」から「自動」へ戻したとき、揺れていない絵が余韻ぶん居座らない。
  it('常に表示から自動へ戻したら、揺れていなければすぐ消える', () => {
    const h = setup('always', QUIET)
    expect(h.result.current).toBe(true)
    h.rerender({ mode: 'auto', stations: QUIET })
    expect(h.result.current).toBe(false)
  })

  // 安全弁: 余韻の最中に切っても、待ちが残って後から出し直したりしない。
  it('余韻の最中に切ったら即座に消える', () => {
    const h = setup('auto', SHAKING)
    h.rerender({ mode: 'auto', stations: QUIET })
    expect(h.result.current).toBe(true)
    h.rerender({ mode: 'off', stations: QUIET })
    expect(h.result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    expect(h.result.current).toBe(false)
  })
})
