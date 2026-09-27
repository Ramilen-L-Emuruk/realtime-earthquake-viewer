import { describe, expect, it } from 'vitest'

import { StationHealthBook } from './stationHealth'

/** 差し替えられる時計。 */
function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
  }
}

describe('StationHealthBook', () => {
  it('震度が出た観測点を覚える', () => {
    const book = new StationHealthBook()
    book.noteReading({ stationId: 'garage', atMs: 1_000, intensity: 2.5 })

    const s = book.snapshot()[0]
    expect(s.stationId).toBe('garage')
    expect(s.lastIntensity).toBe(2.5)
    expect(s.lastReadingAtMs).toBe(1_000)
  })

  it('震度が出せなかった回でも、直前まで出ていた値を消さない', () => {
    const book = new StationHealthBook()
    book.noteReading({ stationId: 'garage', atMs: 1_000, intensity: 2.5 })
    book.noteReading({ stationId: 'garage', atMs: 2_000, intensity: null })

    const s = book.snapshot()[0]
    // 「時刻は進んでいるのに値が古い」組が、いま値を出せていない印になる
    expect(s.lastIntensity).toBe(2.5)
    expect(s.lastReadingAtMs).toBe(2_000)
  })

  it('震度を出せない理由を覚え、震度が出たら落とす', () => {
    const book = new StationHealthBook()
    book.noteSkip('garage', 'stream-rejected')
    expect(book.snapshot()[0].lastSkipReason).toBe('stream-rejected')

    book.noteReading({ stationId: 'garage', atMs: 1_000, intensity: 1 })
    // 直ったのに古い理由が居座ると、いつのものか読めなくなる
    expect(book.snapshot()[0].lastSkipReason).toBeNull()
  })

  it('理由が null（正常）のときは何も書き換えない', () => {
    const book = new StationHealthBook()
    book.noteSkip('garage', 'stream-rejected')
    // `FusionOutcome.intensitySkipReason` は駆動役の到着のたびに「いまの状態」を
    // 返すため、null を無条件に反映すると `noteReading` が置いた震度出た印より
    // 先にここが通ったとき、震度が出た事実のほうを消してしまう。
    book.noteSkip('garage', null)

    expect(book.snapshot()[0].lastSkipReason).toBe('stream-rejected')
  })

  it('締めくくりに失敗した回数と理由を覚える', () => {
    const book = new StationHealthBook()
    book.noteCloseFailure('garage', 'push が投げた')
    book.noteCloseFailure('garage', 'end が投げた')

    const s = book.snapshot()[0]
    expect(s.closeFailures).toBe(2)
    expect(s.lastCloseFailure).toBe('end が投げた')
  })

  it('上限に達したら、いちばん長く音沙汰の無いものを押し出して数える', () => {
    const t = clock()
    const book = new StationHealthBook({ maxStations: 2, now: t.now })
    book.noteReading({ stationId: 'a', atMs: 1_000, intensity: 1 })
    t.advance(1_000)
    book.noteReading({ stationId: 'b', atMs: 1_000, intensity: 1 })
    t.advance(1_000)
    // 1 つ目に触れ直すと、押し出される順が入れ替わる
    book.noteReading({ stationId: 'a', atMs: 2_000, intensity: 1 })
    t.advance(1_000)

    book.noteReading({ stationId: 'c', atMs: 1_000, intensity: 1 })

    expect(book.size).toBe(2)
    expect(book.evictions).toBe(1)
    expect(book.snapshot().map((s) => s.stationId).sort()).toEqual(['a', 'c'])
  })

  it('音沙汰の新しい順に返す（黙ったものが末尾へ寄る）', () => {
    const t = clock()
    const book = new StationHealthBook({ now: t.now })
    book.noteReading({ stationId: 'a', atMs: 1_000, intensity: 1 })
    t.advance(1_000)
    book.noteReading({ stationId: 'b', atMs: 1_000, intensity: 1 })
    t.advance(1_000)
    book.noteReading({ stationId: 'c', atMs: 1_000, intensity: 1 })

    expect(book.snapshot().map((s) => s.stationId)).toEqual(['c', 'b', 'a'])
  })

  it('駆動役が生きている限り、合成が恒久的に壊れていても lastPacketMs は動き続ける', () => {
    // **`lastReadingAtMs`（震度が出た時刻）の代わりにはならない。** 合成が壊れて
    // 震度が二度と出なくなっても、駆動役からの到着ごとに `noteSkip` は呼ばれ続ける
    // ので、`lastPacketMs` だけは進む——これが無いと、観測点が丸ごと沈黙したのか
    // 駆動役は生きているが合成だけ壊れているのかを `/status` から見分けられない。
    const t = clock()
    const book = new StationHealthBook({ now: t.now })
    book.noteReading({ stationId: 'garage', atMs: 1_000, intensity: 2.5 })
    const first = book.snapshot()[0].lastPacketMs

    t.advance(5_000)
    book.noteSkip('garage', 'stream-rejected')

    expect(book.snapshot()[0].lastPacketMs).toBe(first + 5_000)
    // 震度そのものは、壊れる前に出ていた値のまま残る。
    expect(book.snapshot()[0].lastIntensity).toBe(2.5)
  })

  it('まだ何も届いていない観測点は数に入らない', () => {
    const book = new StationHealthBook()
    expect(book.size).toBe(0)
    expect(book.snapshot()).toEqual([])
  })
})
