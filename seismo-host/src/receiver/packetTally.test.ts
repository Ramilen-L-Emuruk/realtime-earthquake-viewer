import { describe, expect, it } from 'vitest'

import { OVERFLOW_KEY, PacketTally, formatTally } from './packetTally'
import type { TallyEvent } from './packetTally'

const BOARD = 'mac:AA:BB:CC:DD:EE:FF'
const SOURCE = '192.168.0.51'

function feed(tally: PacketTally, events: readonly TallyEvent[]): void {
  for (const e of events) tally.record(e)
}

describe('PacketTally', () => {
  it('読み取りの失敗は送信元、通ったあとは基板へ数える', () => {
    const tally = new PacketTally()
    feed(tally, [
      { kind: 'received', source: SOURCE },
      { kind: 'parse-failed', source: SOURCE, reason: 'header-unreadable' },
      { kind: 'received', source: SOURCE },
      { kind: 'accepted', board: BOARD },
      { kind: 'reading', board: BOARD },
    ])

    const snap = tally.snapshotTotal()
    // **ヘッダが読めていないパケットは基板が判らない。** 送信元の表にだけ出る。
    expect(snap.sources.get(SOURCE)?.received).toBe(2)
    expect(snap.sources.get(SOURCE)?.parseFailed.get('header-unreadable')).toBe(1)
    expect(snap.boards.get(SOURCE)).toBeUndefined()

    // 通ったあとはアドレスで数えない（DHCP で変わると同じ基板が別の行に分かれる）。
    expect(snap.boards.get(BOARD)?.accepted).toBe(1)
    expect(snap.boards.get(BOARD)?.readings).toBe(1)
    expect(snap.sources.get(BOARD)).toBeUndefined()
  })

  it('生データを残せなかった件数は送信元の表へ数える', () => {
    // **読み取りより前の出来事なので、まだ誰の基板か判らない。**
    const tally = new PacketTally()
    feed(tally, [
      { kind: 'received', source: SOURCE },
      { kind: 'raw-unsaved', source: SOURCE, reason: 'backpressure' },
      { kind: 'received', source: SOURCE },
      { kind: 'raw-unsaved', source: SOURCE, reason: 'no-stream' },
      { kind: 'raw-unsaved', source: SOURCE, reason: 'no-stream' },
    ])

    const snap = tally.snapshotTotal()
    expect(snap.sources.get(SOURCE)?.rawUnsaved.get('backpressure')).toBe(1)
    expect(snap.sources.get(SOURCE)?.rawUnsaved.get('no-stream')).toBe(2)
    expect(snap.boards.size).toBe(0)
    expect(formatTally(snap)).toEqual([
      `送信元 ${SOURCE} 届いた=2 残せず: no-stream=2 backpressure=1`,
    ])
  })

  it('分母を数える（落とした件数だけでは意味が決まらない）', () => {
    const tally = new PacketTally()
    feed(tally, [
      { kind: 'received', source: SOURCE },
      { kind: 'received', source: SOURCE },
      { kind: 'rate-limited', source: SOURCE },
      { kind: 'accepted', board: BOARD },
      { kind: 'dropped', board: BOARD, reason: 'duplicate' },
    ])

    const snap = tally.snapshotTotal()
    // 届いた件数は**上限を掛ける前**の値。掛けたあとだと分母が上限そのものになる。
    expect(snap.sources.get(SOURCE)?.received).toBe(2)
    expect(snap.sources.get(SOURCE)?.rateLimited).toBe(1)
    expect(snap.boards.get(BOARD)?.accepted).toBe(1)
    expect(snap.boards.get(BOARD)?.dropped.get('duplicate')).toBe(1)
  })

  it('区間の切れ目・震度の見送り・締めくくりの失敗・追い出しも数える', () => {
    const tally = new PacketTally()
    feed(tally, [
      { kind: 'segment-started', board: BOARD, reason: 'seq-gap' },
      { kind: 'segment-started', board: BOARD, reason: 'seq-gap' },
      { kind: 'intensity-skipped', board: BOARD, reason: 'axis-count' },
      { kind: 'close-failed', board: BOARD },
      { kind: 'evicted', board: BOARD },
    ])

    const b = tally.snapshotTotal().boards.get(BOARD)
    expect(b?.segmentsStarted.get('seq-gap')).toBe(2)
    expect(b?.intensitySkipped.get('axis-count')).toBe(1)
    expect(b?.closeFailures).toBe(1)
    expect(b?.evicted).toBe(1)
  })

  // 2026-10-01 に足した切れ目（→ `timebase/segmenter.ts` の `'timebase-jump'`）。
  // **数えることに意味がある切れ目でしてよ** —— 起動のたびに 1 本ずつ立つのが正常な姿で
  // （基板は時計が合う前から送り始める）、それ以上増えていれば時刻が飛び続けている。
  it('時刻が飛んだ切れ目も数え、要約の行に出す', () => {
    const tally = new PacketTally()
    feed(tally, [
      { kind: 'segment-started', board: BOARD, reason: 'timebase-jump' },
      { kind: 'segment-started', board: BOARD, reason: 'timebase-jump' },
      { kind: 'segment-started', board: BOARD, reason: 'seq-gap' },
    ])

    const b = tally.snapshotTotal().boards.get(BOARD)
    expect(b?.segmentsStarted.get('timebase-jump')).toBe(2)
    // **要約の行にも出ること。** 数えていても出ていなければ気づけない。
    expect(formatTally(tally.snapshotTotal()).join('\n')).toContain('timebase-jump=2')
  })

  it('鍵の上限に達したら「その他」へ合算し、合計は保たれる', () => {
    const tally = new PacketTally({ maxKeys: 2 })
    feed(tally, [
      { kind: 'received', source: 'a' },
      { kind: 'received', source: 'b' },
      { kind: 'received', source: 'c' },
      { kind: 'received', source: 'd' },
    ])

    const sources = tally.snapshotTotal().sources
    expect([...sources.keys()].sort()).toEqual([OVERFLOW_KEY, 'a', 'b'].sort())
    expect(sources.get(OVERFLOW_KEY)?.received).toBe(2)
    // **内訳は失うが合計は正しい。** 捨てる作りだと届いた件数そのものが減る。
    let total = 0
    for (const s of sources.values()) total += s.received
    expect(total).toBe(4)
  })

  it('既にある鍵は上限に達しても引ける（途中から内訳を失わない）', () => {
    const tally = new PacketTally({ maxKeys: 1 })
    feed(tally, [
      { kind: 'received', source: 'a' },
      { kind: 'received', source: 'b' },
      { kind: 'received', source: 'a' },
    ])

    const sources = tally.snapshotTotal().sources
    expect(sources.get('a')?.received).toBe(2)
    expect(sources.get(OVERFLOW_KEY)?.received).toBe(1)
  })

  it('窓は空になり、累計は残る', () => {
    const tally = new PacketTally()
    tally.record({ kind: 'received', source: SOURCE })

    expect(tally.takeWindow().sources.get(SOURCE)?.received).toBe(1)
    // 2 度目は空。**呼び出し側に 2 本を書かせない**ための作りなので、
    // 窓を取っても累計は減らない。
    expect(tally.takeWindow().sources.size).toBe(0)
    expect(tally.snapshotTotal().sources.get(SOURCE)?.received).toBe(1)

    tally.record({ kind: 'received', source: SOURCE })
    expect(tally.takeWindow().sources.get(SOURCE)?.received).toBe(1)
    expect(tally.snapshotTotal().sources.get(SOURCE)?.received).toBe(2)
  })

  it('取り出した値はあとの数え上げで書き換わらない', () => {
    const tally = new PacketTally()
    tally.record({ kind: 'parse-failed', source: SOURCE, reason: 'empty' })
    const snap = tally.snapshotTotal()

    tally.record({ kind: 'parse-failed', source: SOURCE, reason: 'empty' })
    expect(snap.sources.get(SOURCE)?.parseFailed.get('empty')).toBe(1)
  })
})

describe('formatTally', () => {
  it('何も起きていなければ行を返さない', () => {
    expect(formatTally(new PacketTally().snapshotTotal())).toEqual([])
  })

  it('0 件の理由は出さず、理由の並びは宣言した順になる', () => {
    const tally = new PacketTally()
    feed(tally, [
      { kind: 'received', source: SOURCE },
      // わざと宣言の順と逆に入れる。並びが入れた順だと、続けて出す要約の行が毎回動く。
      { kind: 'parse-failed', source: SOURCE, reason: 'sample-not-integer' },
      { kind: 'parse-failed', source: SOURCE, reason: 'empty' },
    ])

    const lines = formatTally(tally.snapshotTotal())
    expect(lines).toEqual([`送信元 ${SOURCE} 届いた=1 読めず: empty=1 sample-not-integer=1`])
  })

  it('上限で落とした件数は 0 なら出さない', () => {
    const tally = new PacketTally()
    tally.record({ kind: 'received', source: SOURCE })
    expect(formatTally(tally.snapshotTotal())[0]).toBe(`送信元 ${SOURCE} 届いた=1`)

    tally.record({ kind: 'rate-limited', source: SOURCE })
    expect(formatTally(tally.snapshotTotal())[0]).toBe(`送信元 ${SOURCE} 届いた=1 上限で落とした=1`)
  })

  it('基板の行は通した件数と震度の件数を必ず出す', () => {
    const tally = new PacketTally()
    feed(tally, [
      { kind: 'accepted', board: BOARD },
      { kind: 'segment-started', board: BOARD, reason: 'stream-start' },
      { kind: 'dropped', board: BOARD, reason: 'scale-out-of-range' },
    ])

    expect(formatTally(tally.snapshotTotal())).toEqual([
      `基板 ${BOARD} 通した=1 震度=0 落とした: scale-out-of-range=1 切れ目: stream-start=1`,
    ])
  })

  it('「その他」の行は最後に置き、残りは名前順に並べる', () => {
    const tally = new PacketTally({ maxKeys: 2 })
    feed(tally, [
      { kind: 'received', source: 'b' },
      { kind: 'received', source: 'a' },
      { kind: 'received', source: 'z' },
    ])

    expect(formatTally(tally.snapshotTotal())).toEqual([
      '送信元 a 届いた=1',
      '送信元 b 届いた=1',
      `送信元 ${OVERFLOW_KEY} 届いた=1`,
    ])
  })
})
