import { describe, expect, it } from 'vitest'

import { RewaveScheduler, planRequestedRewave } from './rewaveScheduler'

const OPTIONS = { padMs: 2_000, settleMs: 3_000, maxWaitMs: 10_000, maxSpanMs: 180_000 }
const T = 1_790_000_000_000

describe('RewaveScheduler', () => {
  it('正: 取り戻しが落ち着いたら、取り戻した範囲に余白を足して 1 件渡し、覚えから外す', () => {
    const s = new RewaveScheduler(OPTIONS)
    s.note('st', T + 10_000, T + 10_300, T + 20_000)
    s.note('st', T + 12_000, T + 12_300, T + 21_000)
    expect(s.take(T + 23_999)).toBeNull()
    expect(s.take(T + 24_000)).toEqual({ stationId: 'st', fromMs: T + 8_000, toMs: T + 14_300, noiseDensity: 'historical', origin: 'backlog' })
    expect(s.take(T + 30_000)).toBeNull()
    expect(s.waiting).toBe(0)
  })

  it('正: 観測点にまだ欠けが残っていても、取り戻した分は待たずに渡す（後で取り戻した分はまた渡す）', () => {
    // 電子レンジの干渉の最中: 取り戻しは合間に少しずつ届き、欠けはずっと残る。
    const s = new RewaveScheduler(OPTIONS)
    s.note('st', T, T + 300, T)
    expect(s.take(T + 3_000)).toEqual({ stationId: 'st', fromMs: T - 2_000, toMs: T + 2_300, noiseDensity: 'historical', origin: 'backlog' })
    // 同じ区間を後でもう一度取り戻した（別のセンサーの分）。**また渡す**（控えは後から書いた方を採る）。
    s.note('st', T + 100, T + 400, T + 20_000)
    expect(s.take(T + 23_000)).toEqual({ stationId: 'st', fromMs: T - 1_900, toMs: T + 2_400, noiseDensity: 'historical', origin: 'backlog' })
  })

  it('安全弁: 取り戻しが続いて落ち着かなくても、最初に取り戻してから上限が来たら渡す', () => {
    const s = new RewaveScheduler(OPTIONS)
    // 2 秒おきに取り戻しが届き続ける（落ち着きの 3 秒に届かない）。
    for (let t = 0; t < 10_000; t += 2_000) s.note('st', T + t, T + t + 300, T + t)
    expect(s.take(T + 9_999)).toBeNull()
    expect(s.take(T + 10_000)).toEqual({ stationId: 'st', fromMs: T - 2_000, toMs: T + 8_300 + 2_000, noiseDensity: 'historical', origin: 'backlog' })
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
    expect(first).toEqual({ stationId: 'st', fromMs: T - 2_000, toMs: T - 2_000 + 180_000, noiseDensity: 'historical', origin: 'backlog' })
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

  describe('依頼された作り直し', () => {
    it('正: 積んだ順に 1 件ずつ、指定のノイズ密度の取り方で渡す', () => {
      const s = new RewaveScheduler(OPTIONS)
      expect(s.request('st', [{ fromMs: T, toMs: T + 100 }, { fromMs: T + 100, toMs: T + 200 }], 'current')).toBe(true)
      expect(s.requestedWaiting).toBe(2)
      expect(s.take(T)).toEqual({ stationId: 'st', fromMs: T, toMs: T + 100, noiseDensity: 'current', origin: 'requested' })
      expect(s.take(T)).toEqual({ stationId: 'st', fromMs: T + 100, toMs: T + 200, noiseDensity: 'current', origin: 'requested' })
      expect(s.take(T)).toBeNull()
    })

    it('正: 取り戻しの分が渡せる状態なら、そちらを先に渡す（いま見ている波形の穴を待たせない）', () => {
      const s = new RewaveScheduler(OPTIONS)
      s.request('st', [{ fromMs: T, toMs: T + 100 }], 'current')
      s.note('st', T + 50_000, T + 50_300, T + 50_000)
      expect(s.take(T + 60_000)?.noiseDensity).toBe('historical')
      expect(s.take(T + 60_000)?.noiseDensity).toBe('current')
    })

    it('安全弁: 前の依頼が残っていれば積まない（同じ範囲を二重に回さない）', () => {
      const s = new RewaveScheduler(OPTIONS)
      expect(s.request('st', [{ fromMs: T, toMs: T + 100 }], 'current')).toBe(true)
      expect(s.request('st', [{ fromMs: T, toMs: T + 100 }], 'current')).toBe(false)
      expect(s.requestedWaiting).toBe(1)
    })

    it('対照: 取り戻しの分は、依頼の指定に引きずられない', () => {
      const s = new RewaveScheduler(OPTIONS)
      s.request('st', [{ fromMs: T, toMs: T + 100 }], 'current')
      s.note('st', T, T + 100, T)
      expect(s.take(T + 10_000)).toMatchObject({ noiseDensity: 'historical', origin: 'backlog' })
    })
  })
})

describe('planRequestedRewave', () => {
  const LEAD = 60_000
  const TAIL = 5_000
  const SPAN = 180_000

  it('正: 設定変更が無ければ、頭から maxSpanMs ずつ隙間なく区切る', () => {
    const p = planRequestedRewave({ fromMs: T, toMs: T + 400_000, changeTimes: [], leadMs: LEAD, tailMs: TAIL, maxSpanMs: SPAN })
    expect(p.spans).toEqual([
      { fromMs: T, toMs: T + 180_000 },
      { fromMs: T + 180_000, toMs: T + 360_000 },
      { fromMs: T + 360_000, toMs: T + 400_000 },
    ])
    expect(p.skippedMs).toBe(0)
  })

  it('正: 設定変更の位置で割り、直前の余白と直後の助走だけを残す', () => {
    const c = T + 200_000
    const p = planRequestedRewave({ fromMs: T, toMs: T + 400_000, changeTimes: [c], leadMs: LEAD, tailMs: TAIL, maxSpanMs: SPAN })
    // 変更を跨ぐ区間は無い。
    for (const s of p.spans) expect(s.toMs <= c - TAIL || s.fromMs >= c + LEAD).toBe(true)
    expect(p.spans[0]).toEqual({ fromMs: T, toMs: T + 180_000 })
    expect(p.spans.at(-1)).toEqual({ fromMs: c + LEAD, toMs: T + 400_000 })
    expect(p.skippedMs).toBe(LEAD + TAIL)
  })

  it('対照: 範囲の手前の変更でも、助走に掛かるなら頭を後ろへずらす', () => {
    const p = planRequestedRewave({ fromMs: T, toMs: T + 100_000, changeTimes: [T - 10_000], leadMs: LEAD, tailMs: TAIL, maxSpanMs: SPAN })
    expect(p.spans).toEqual([{ fromMs: T + 50_000, toMs: T + 100_000 }])
    expect(p.skippedMs).toBe(50_000)
  })

  it('安全弁: 変更どうしが助走より近ければ、そのあいだは作らない（飛ばした長さとして数える）', () => {
    const p = planRequestedRewave({ fromMs: T, toMs: T + 100_000, changeTimes: [T + 10_000, T + 20_000], leadMs: LEAD, tailMs: TAIL, maxSpanMs: SPAN })
    expect(p.spans.every((s) => s.fromMs >= T + 20_000 + LEAD || s.toMs <= T + 10_000 - TAIL)).toBe(true)
    const covered = p.spans.reduce((a, s) => a + s.toMs - s.fromMs, 0)
    expect(covered + p.skippedMs).toBe(100_000)
  })

  it('安全弁: 読めない範囲は空で返す', () => {
    expect(planRequestedRewave({ fromMs: T, toMs: T, changeTimes: [], leadMs: LEAD, tailMs: TAIL, maxSpanMs: SPAN }).spans).toEqual([])
  })
})
