import { describe, expect, it } from 'vitest'
import type { SeismoWaveWindow } from './seismoWaveBuffer'
import {
  LIVE_QUIET_MEMORY_MS,
  measureWindowQuietLevel,
  QUIET_LEVEL_MIN_GAL,
  QUIET_SCALE_FALLBACK_GAL,
  QuietLevelMemory,
  quietScaledGal,
} from './seismoQuietScale'

/** 100 Hz・`seconds` 秒ぶんの窓。各成分を `+amp` と `-amp` の交互で埋める（1 秒ごとの振れの最大がちょうど `amp`）。 */
function windowOf(seconds: number, amp: readonly [number, number, number], firstSampleMs = 1_000_000): SeismoWaveWindow {
  const n = seconds * 100
  const gal = [0, 1, 2].map((a) => {
    const v = new Float32Array(n)
    for (let i = 0; i < n; i += 1) v[i] = i % 2 === 0 ? amp[a] : -amp[a]
    return v
  }) as unknown as [Float32Array, Float32Array, Float32Array]
  return { firstSampleMs, msPerSample: 10, gal, memberCount: new Float32Array(n).fill(3) }
}

describe('quietScaledGal', () => {
  // 正: IIS2ICLX を入れる前の物差し（1.32 gal）なら、詳細の窓と収まりは決め打ちだった値とほぼ同じになる。
  // カードは 2026-10-13 に倍率を 7.5 から 3 へ下げた（ユーザー承認）ので、決め打ちだった 10 gal には戻らない。
  it('入れる前の静かさなら、詳細の窓と収まりは以前の決め打ちの値に戻る', () => {
    expect(quietScaledGal('card', 1.32)).toBeCloseTo(3.96, 2)
    expect(quietScaledGal('detail', 1.32)).toBeCloseTo(1.98, 2)
    expect(quietScaledGal('settle', 1.32)).toBeCloseTo(3.04, 2)
  })

  // 正: 入れた後の物差し（0.19 gal）なら、同じ比で小さくなる。
  it('静かになった分だけ下限も下がる', () => {
    expect(quietScaledGal('card', 0.19)).toBeCloseTo(0.57, 3)
    expect(quietScaledGal('detail', 0.19)).toBeCloseTo(0.285, 3)
  })

  // 対照（2026-10-13）: カードは詳細の窓より高く置く（3 成分を重ねる・合成の 1 本で見るので、
  // 静かなときのノイズを枠いっぱいに広げない）。
  it('カードの下限は詳細の窓より高い', () => {
    expect(quietScaledGal('card', 0.19)).toBeGreaterThan(quietScaledGal('detail', 0.19))
  })

  // 安全弁: 測れなかったら決め打ちだった値（ノイズを枠いっぱいに広げない側）へ倒す。
  it('測れなければ決め打ちだった値を使う', () => {
    expect(quietScaledGal('card', null)).toBe(QUIET_SCALE_FALLBACK_GAL.card)
    expect(quietScaledGal('settle', Number.NaN)).toBe(QUIET_SCALE_FALLBACK_GAL.settle)
  })

  // 安全弁: 0 近くに縮んだ測り値で、下限が 0 へ潰れない。
  it('物差しが 0 でも下限は 0 にならない', () => {
    expect(quietScaledGal('card', 0)).toBeCloseTo(3 * QUIET_LEVEL_MIN_GAL)
  })
})

describe('measureWindowQuietLevel', () => {
  // 正: 1 秒ごとの振れの最大は振幅そのもの。3 成分のうち最大を返す。
  it('3 成分のうち最も大きい成分の振れを返す', () => {
    expect(measureWindowQuietLevel(windowOf(60, [0.2, 0.3, 0.1]))).toBeCloseTo(0.3, 2)
  })

  // 正: 測るのは末尾 30 秒だけ。手前に強い揺れがあっても引きずられない。
  it('末尾 30 秒より前の揺れは混ぜない', () => {
    const win = windowOf(60, [0.2, 0.2, 0.2])
    for (const axis of win.gal) for (let i = 0; i < 2000; i += 1) axis[i] = i % 2 === 0 ? 50 : -50
    expect(measureWindowQuietLevel(win)).toBeCloseTo(0.2, 2)
  })

  // 正: 値の無い成分（上を解けない観測点）を外して、残りの成分で測る。
  it('値の無い成分は外して測る', () => {
    const win = windowOf(60, [0.2, 0.25, 0])
    win.gal[2].fill(Number.NaN)
    expect(measureWindowQuietLevel(win)).toBeCloseTo(0.25, 2)
  })

  // 安全弁: 10 秒に満たなければ測らない（推測で下限を置かない）。
  it('値のある秒が 10 秒に満たなければ null', () => {
    expect(measureWindowQuietLevel(windowOf(5, [0.2, 0.2, 0.2]))).toBeNull()
  })
})

describe('QuietLevelMemory', () => {
  // 正: 揺れの最中に測った大きい値ではなく、直近 5 分でいちばん静かだった値を使う。
  it('直近 5 分の最小を返す', () => {
    const m = new QuietLevelMemory(QUIET_LEVEL_MIN_GAL)
    m.observe(0, 0.2)
    m.observe(60_000, 3.0)
    m.observe(120_000, 5.0)
    expect(m.current()).toBeCloseTo(0.2)
  })

  // 対照: 5 分より古い値は忘れる（揺れが長く続けば、いまの値へ移る）。
  it('5 分より前の値は使わない', () => {
    const m = new QuietLevelMemory(QUIET_LEVEL_MIN_GAL)
    m.observe(0, 0.2)
    m.observe(LIVE_QUIET_MEMORY_MS + 1, 3.0)
    expect(m.current()).toBeCloseTo(3.0)
  })

  // 安全弁: 時刻が覚えている長さより前へ戻ったら、別の時間の静かさを混ぜない。
  it('時刻が大きく戻ったら覚えていた値を捨てる', () => {
    const m = new QuietLevelMemory(QUIET_LEVEL_MIN_GAL)
    m.observe(10 * LIVE_QUIET_MEMORY_MS, 0.2)
    m.observe(0, 1.0)
    expect(m.current()).toBeCloseTo(1.0)
  })

  it('測れなかった回（null）は覚えない', () => {
    const m = new QuietLevelMemory(QUIET_LEVEL_MIN_GAL)
    m.observe(0, null)
    expect(m.current()).toBeNull()
  })

  // 安全弁: 値が張り付いた窓（0）を 1 回測っても、その後 5 分の下限を決めさせない。
  it('物差しの下限未満の値は覚えない', () => {
    const m = new QuietLevelMemory(QUIET_LEVEL_MIN_GAL)
    m.observe(0, 0.2)
    m.observe(1000, 0)
    m.observe(2000, QUIET_LEVEL_MIN_GAL / 2)
    expect(m.current()).toBeCloseTo(0.2)
  })
})
