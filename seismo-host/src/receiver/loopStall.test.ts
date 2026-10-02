import { describe, expect, it } from 'vitest'

import { LoopStallBook } from './loopStall'

const TICK = 250
const THRESHOLD = 1000

function book(): LoopStallBook {
  return new LoopStallBook({ tickMs: TICK, thresholdMs: THRESHOLD })
}

describe('LoopStallBook', () => {
  it('最初の刻みは測らない（比べる相手が無い）', () => {
    const b = book()
    expect(b.tick(0, 1_000)).toBeNull()
    expect(b.snapshot().count).toBe(0)
  })

  it('刻みが閾値ぶん以上遅れたら、止まった区間として数える', () => {
    const b = book()
    b.tick(0, 1_000)
    // 予定は 250 ms 後。実際は 1250 ms 後 → 遅れは 1000 ms。
    const event = b.tick(1_250, 2_250)
    expect(event).toEqual({ endedAtMs: 2_250, stalledMs: 1_000 })
    const s = b.snapshot()
    expect(s.count).toBe(1)
    expect(s.totalMs).toBe(1_000)
    expect(s.longestMs).toBe(1_000)
    expect(s.last).toEqual({ endedAtMs: 2_250, stalledMs: 1_000 })
  })

  it('閾値の手前の遅れは数えない（対照）', () => {
    const b = book()
    b.tick(0, 1_000)
    expect(b.tick(1_249, 2_249)).toBeNull()
    expect(b.snapshot().count).toBe(0)
  })

  it('遅れは刻みの予定を引いた分（刻みそのものを止まったと数えない）', () => {
    const b = book()
    b.tick(0, 0)
    const event = b.tick(46_000, 46_000)
    // 45 秒止まって 46 秒後に刻んだ ＝ 予定の 250 ms を除いた 45750 ms。
    expect(event?.stalledMs).toBe(45_750)
  })

  it('最長と累計は区間ごとに積み上がり、直近は最後の区間を指す', () => {
    const b = book()
    b.tick(0, 0)
    b.tick(3_250, 3_250) // 3000
    b.tick(3_500, 3_500) // 平常
    b.tick(5_000, 5_000) // 1250
    const s = b.snapshot()
    expect(s.count).toBe(2)
    expect(s.totalMs).toBe(4_250)
    expect(s.longestMs).toBe(3_000)
    expect(s.last).toEqual({ endedAtMs: 5_000, stalledMs: 1_250 })
  })

  it('単調時計が戻ったり読めなかったりした刻みは測らず、次の刻みから測り直す（安全弁）', () => {
    const b = book()
    b.tick(10_000, 0)
    expect(b.tick(5_000, 1)).toBeNull()
    expect(b.tick(Number.NaN, 2)).toBeNull()
    // NaN の後は比べる相手が無いので、ここは起点になるだけ。
    expect(b.tick(6_000, 3)).toBeNull()
    expect(b.tick(6_250, 4)).toBeNull()
    expect(b.snapshot().count).toBe(0)
  })

  it('何も起きていなければ、最長と直近は「無い」を名乗る（0 で埋めない）', () => {
    const s = book().snapshot()
    expect(s).toEqual({ thresholdMs: THRESHOLD, count: 0, totalMs: 0, longestMs: null, last: null })
  })
})
