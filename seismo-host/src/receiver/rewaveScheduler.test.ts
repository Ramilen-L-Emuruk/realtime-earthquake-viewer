import { describe, expect, it } from 'vitest'

import { RewaveScheduler } from './rewaveScheduler'

const OPTIONS = { padMs: 2_000, settleMs: 3_000, maxWaitMs: 300_000, maxSpanMs: 180_000 }
const T = 1_790_000_000_000
const none = (): boolean => false
const all = (): boolean => true

describe('RewaveScheduler', () => {
  it('正: 欠けが片付いて待ちを過ぎたら、取り戻した範囲に余白を足して 1 件渡し、覚えから外す', () => {
    const s = new RewaveScheduler(OPTIONS)
    s.note('st', T + 10_000, T + 10_300, T + 20_000)
    s.note('st', T + 12_000, T + 12_300, T + 21_000)
    expect(s.take(T + 23_999, none)).toBeNull()
    expect(s.take(T + 24_000, none)).toEqual({ stationId: 'st', fromMs: T + 8_000, toMs: T + 14_300 })
    expect(s.take(T + 30_000, none)).toBeNull()
    expect(s.waiting).toBe(0)
  })

  it('対照: 観測点の欠けが残っている間は渡さない', () => {
    const s = new RewaveScheduler(OPTIONS)
    s.note('st', T, T + 300, T)
    expect(s.take(T + 60_000, all)).toBeNull()
    expect(s.waiting).toBe(1)
  })

  it('安全弁: 欠けが片付かないまま長く続いたら、そこまでの分で作り直す', () => {
    const s = new RewaveScheduler(OPTIONS)
    s.note('st', T, T + 300, T)
    expect(s.take(T + 299_999, all)).toBeNull()
    expect(s.take(T + 300_000, all)).toMatchObject({ stationId: 'st' })
  })

  it('安全弁: 長すぎる区間は頭から区切って渡し、残りは継ぎ目なく次の回へ回す', () => {
    const s = new RewaveScheduler(OPTIONS)
    s.note('st', T, T + 400_000, T)
    const first = s.take(T + 10_000, none)
    expect(first).toEqual({ stationId: 'st', fromMs: T - 2_000, toMs: T - 2_000 + 180_000 })
    const second = s.take(T + 10_000, none)
    expect(second?.fromMs).toBe(first?.toMs)
    const third = s.take(T + 10_000, none)
    expect(third?.toMs).toBe(T + 402_000)
    expect(s.take(T + 10_000, none)).toBeNull()
  })

  it('最初に取り戻した観測点から順に渡す（観測点ごとに別に覚える）', () => {
    const s = new RewaveScheduler(OPTIONS)
    s.note('b', T + 5_000, T + 5_300, T + 1_000)
    s.note('a', T, T + 300, T)
    expect(s.take(T + 10_000, none)?.stationId).toBe('a')
    expect(s.take(T + 10_000, none)?.stationId).toBe('b')
  })

  it('読めない範囲は覚えない', () => {
    const s = new RewaveScheduler(OPTIONS)
    s.note('st', Number.NaN, T, T)
    s.note('st', T + 10, T, T)
    expect(s.waiting).toBe(0)
  })
})
