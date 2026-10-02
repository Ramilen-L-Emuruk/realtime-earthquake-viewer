import { describe, expect, it } from 'vitest'

import { BoardClockBook, lastSampleMsOf } from './boardClock'

const T0 = Date.UTC(2026, 9, 2, 3, 0, 0)

/** 末尾のサンプルが `last` を名乗る 30 サンプル（100Hz）のパケット。 */
function packetEndingAt(last: number) {
  return { firstSampleMs: last - 290, sampleRateHz: 100, samples: new Array(30).fill([0, 0, 0]) }
}

describe('lastSampleMsOf', () => {
  it('先頭の時刻とサンプル数と周波数から、末尾のサンプルの時刻を出す', () => {
    expect(lastSampleMsOf({ firstSampleMs: 1000, sampleRateHz: 100, samples: new Array(30) })).toBe(1290)
  })

  it('1 サンプルなら先頭と末尾は同じ', () => {
    expect(lastSampleMsOf({ firstSampleMs: 1000, sampleRateHz: 100, samples: new Array(1) })).toBe(1000)
  })

  it('サンプルが無い・周波数が正の有限値でないなら出せない', () => {
    expect(lastSampleMsOf({ firstSampleMs: 1000, sampleRateHz: 100, samples: [] })).toBeNull()
    expect(lastSampleMsOf({ firstSampleMs: 1000, sampleRateHz: 0, samples: new Array(30) })).toBeNull()
    expect(lastSampleMsOf({ firstSampleMs: 1000, sampleRateHz: Number.NaN, samples: new Array(30) })).toBeNull()
  })
})

describe('BoardClockBook', () => {
  it('窓を閉じるまでは値を出さない', () => {
    const book = new BoardClockBook({ windowMs: 60_000 })
    book.note('mac:aa', T0, packetEndingAt(T0 - 50))
    const [row] = book.snapshot().boards
    expect(row?.offsetMs).toBeNull()
    expect(row?.windowEndMs).toBeNull()
  })

  it('閉じた窓の最小値を、基板が遅れている向きを正として出す', () => {
    const book = new BoardClockBook({ windowMs: 60_000 })
    // 届くまでの時間は揺れるので、いちばん小さい値が時計のずれに近い。
    book.note('mac:aa', T0, packetEndingAt(T0 - 1400))
    book.note('mac:aa', T0 + 300, packetEndingAt(T0 + 300 - 1310))
    book.note('mac:aa', T0 + 600, packetEndingAt(T0 + 600 - 1500))
    // 窓の長さを過ぎたパケットが前の窓を閉じる（このパケットは次の窓に入る）。
    book.note('mac:aa', T0 + 60_000, packetEndingAt(T0 + 60_000 - 9999))
    const [row] = book.snapshot().boards
    expect(row?.offsetMs).toBe(1310)
    expect(row?.packets).toBe(3)
    expect(row?.windowEndMs).toBe(T0 + 60_000)
    // **最後に受け取った時刻は窓に関わらず毎回進む**（黙ったかの判定はこちらで見る）。
    expect(row?.lastPacketMs).toBe(T0 + 60_000)
  })

  it('窓が閉じる前から、最後に受け取った時刻は持つ', () => {
    const book = new BoardClockBook({ windowMs: 60_000 })
    book.note('mac:aa', T0, packetEndingAt(T0 - 50))
    book.note('mac:aa', T0 + 300, packetEndingAt(T0 + 300 - 50))
    expect(book.snapshot().boards[0]?.lastPacketMs).toBe(T0 + 300)
  })

  it('基板の時計が進んでいれば負になる', () => {
    const book = new BoardClockBook({ windowMs: 1000 })
    book.note('mac:aa', T0, packetEndingAt(T0 + 200))
    book.note('mac:aa', T0 + 1000, packetEndingAt(T0 + 1000))
    expect(book.snapshot().boards[0]?.offsetMs).toBe(-200)
  })

  it('基板ごとに別に測る', () => {
    const book = new BoardClockBook({ windowMs: 1000 })
    book.note('mac:aa', T0, packetEndingAt(T0 - 30))
    book.note('mac:bb', T0, packetEndingAt(T0 - 800))
    book.note('mac:aa', T0 + 1000, packetEndingAt(T0))
    book.note('mac:bb', T0 + 1000, packetEndingAt(T0))
    const rows = book.snapshot().boards
    expect(rows.map((r) => [r.boardKey, r.offsetMs])).toEqual([
      ['mac:aa', 30],
      ['mac:bb', 800],
    ])
  })

  it('次の窓が閉じたら、値はその窓のものへ入れ替わる（前の窓の最小値を引きずらない）', () => {
    const book = new BoardClockBook({ windowMs: 1000 })
    book.note('mac:aa', T0, packetEndingAt(T0 - 20))
    book.note('mac:aa', T0 + 1000, packetEndingAt(T0 + 1000 - 700))
    book.note('mac:aa', T0 + 2000, packetEndingAt(T0 + 2000))
    expect(book.snapshot().boards[0]?.offsetMs).toBe(700)
  })

  it('時計が合う前の時刻（1970 年）を名乗るパケットは測らない', () => {
    // **区間の側に別の警告がある**（`buildTimebaseEpochWarning`）。ここで 56 年のずれとして
    // 出すと、同じ事実に警告が 2 つ付くうえ、合ったあとの最初の窓まで巨大な値が残る。
    const book = new BoardClockBook({ windowMs: 1000 })
    book.note('mac:aa', T0, packetEndingAt(5_000))
    book.note('mac:aa', T0 + 1000, packetEndingAt(6_000))
    expect(book.snapshot().boards).toEqual([])
  })

  it('壊れた受信時刻・末尾の時刻は測らない', () => {
    const book = new BoardClockBook({ windowMs: 1000 })
    book.note('mac:aa', Number.NaN, packetEndingAt(T0))
    book.note('mac:aa', T0, { firstSampleMs: T0, sampleRateHz: 0, samples: new Array(30) })
    expect(book.snapshot().boards).toEqual([])
  })

  it('覚えていられる数を超えたら、いちばん長く届いていない基板を押し出して数える', () => {
    const book = new BoardClockBook({ windowMs: 1000, maxBoards: 2 })
    book.note('mac:aa', T0, packetEndingAt(T0))
    book.note('mac:bb', T0 + 1, packetEndingAt(T0))
    book.note('mac:aa', T0 + 2, packetEndingAt(T0))
    book.note('mac:cc', T0 + 3, packetEndingAt(T0))
    const snap = book.snapshot()
    expect(snap.boards.map((r) => r.boardKey)).toEqual(['mac:aa', 'mac:cc'])
    expect(snap.evictions).toBe(1)
  })
})
