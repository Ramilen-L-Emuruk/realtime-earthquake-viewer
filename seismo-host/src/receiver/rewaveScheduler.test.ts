import { describe, expect, it } from 'vitest'

import { RewaveScheduler } from './rewaveScheduler'

const OPTIONS = { padMs: 2_000, settleMs: 3_000, maxWaitMs: 10_000, maxSpanMs: 180_000 }
const T = 1_790_000_000_000

describe('RewaveScheduler', () => {
  it('正: 取り戻しが落ち着いたら、取り戻した範囲に余白を足して 1 件渡し、覚えから外す', () => {
    const s = new RewaveScheduler(OPTIONS)
    s.note('st', T + 10_000, T + 10_300, T + 20_000)
    s.note('st', T + 12_000, T + 12_300, T + 21_000)
    expect(s.take(T + 23_999)).toBeNull()
    expect(s.take(T + 24_000)).toEqual({ stationId: 'st', fromMs: T + 8_000, toMs: T + 14_300 })
    expect(s.take(T + 30_000)).toBeNull()
    expect(s.waiting).toBe(0)
  })

  it('正: 観測点にまだ欠けが残っていても、取り戻した分は待たずに渡す（後で取り戻した分はまた渡す）', () => {
    // 電子レンジの干渉の最中: 取り戻しは合間に少しずつ届き、欠けはずっと残る。
    const s = new RewaveScheduler(OPTIONS)
    s.note('st', T, T + 300, T)
    expect(s.take(T + 3_000)).toEqual({ stationId: 'st', fromMs: T - 2_000, toMs: T + 2_300 })
    // 同じ区間を後でもう一度取り戻した（別のセンサーの分）。**また渡す**（控えは後から書いた方を採る）。
    s.note('st', T + 100, T + 400, T + 20_000)
    expect(s.take(T + 23_000)).toEqual({ stationId: 'st', fromMs: T - 1_900, toMs: T + 2_400 })
  })

  it('安全弁: 取り戻しが続いて落ち着かなくても、最初に取り戻してから上限が来たら渡す', () => {
    const s = new RewaveScheduler(OPTIONS)
    // 2 秒おきに取り戻しが届き続ける（落ち着きの 3 秒に届かない）。
    for (let t = 0; t < 10_000; t += 2_000) s.note('st', T + t, T + t + 300, T + t)
    expect(s.take(T + 9_999)).toBeNull()
    expect(s.take(T + 10_000)).toEqual({ stationId: 'st', fromMs: T - 2_000, toMs: T + 8_300 + 2_000 })
  })

  it('対照: 落ち着きも上限もまだなら渡さない', () => {
    const s = new RewaveScheduler(OPTIONS)
    s.note('st', T, T + 300, T)
    expect(s.take(T + 2_999)).toBeNull()
    expect(s.waiting).toBe(1)
  })

  it('安全弁: 長すぎる区間は頭から区切って渡し、残りは継ぎ目なく次の回へ回す', () => {
    const s = new RewaveScheduler(OPTIONS)
    s.note('st', T, T + 400_000, T)
    const first = s.take(T + 10_000)
    expect(first).toEqual({ stationId: 'st', fromMs: T - 2_000, toMs: T - 2_000 + 180_000 })
    const second = s.take(T + 10_000)
    expect(second?.fromMs).toBe(first?.toMs)
    const third = s.take(T + 10_000)
    expect(third?.toMs).toBe(T + 402_000)
    expect(s.take(T + 10_000)).toBeNull()
  })

  it('最初に取り戻した観測点から順に渡す（観測点ごとに別に覚える）', () => {
    const s = new RewaveScheduler(OPTIONS)
    s.note('b', T + 5_000, T + 5_300, T + 1_000)
    s.note('a', T, T + 300, T)
    expect(s.take(T + 10_000)?.stationId).toBe('a')
    expect(s.take(T + 10_000)?.stationId).toBe('b')
  })

  it('読めない範囲は覚えない', () => {
    const s = new RewaveScheduler(OPTIONS)
    s.note('st', Number.NaN, T, T)
    s.note('st', T + 10, T, T)
    expect(s.waiting).toBe(0)
  })
})
