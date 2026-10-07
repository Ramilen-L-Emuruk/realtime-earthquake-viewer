import { describe, expect, it } from 'vitest'

import {
  BacklogBook,
  type BacklogBookOptions,
  type StreamRef,
  parseBacklogBookState,
  streamKey,
} from './backlogBook'

const S: StreamRef = { boardKey: 'mac:020000000001', bootId: '34b6e78f', sensorId: 'i2c0-68' }
const KEY = streamKey(S)
const ADDR = '192.0.2.41'

const OPTIONS: BacklogBookOptions = {
  settleMs: 2_000,
  holdMs: 25_000,
  retryUrgentMs: 1_000,
  retryBaseMs: 5_000,
  retryMaxMs: 60_000,
  giveUpAfterMs: 20 * 60_000,
  maxGaps: 100,
  maxSpanSamples: 900,
}

function book(options: Partial<BacklogBookOptions> = {}): BacklogBook {
  return new BacklogBook({ ...OPTIONS, ...options })
}

/** 1 まとまり 30 サンプルで、`seq` から並べて届ける。 */
function feed(b: BacklogBook, stream: StreamRef, seqs: number[], atMs: number): void {
  for (const firstSeq of seqs) b.notePacket({ stream, firstSeq, count: 30, address: ADDR, atMs })
}

describe('BacklogBook', () => {
  it('対照: 番号が続いていれば欠けは無い', () => {
    const b = book()
    feed(b, S, [0, 30, 60, 90], 1_000)
    expect(b.snapshot().pendingGaps).toBe(0)
    expect(b.nextDue(1_000_000)).toBeNull()
  })

  it('正: 番号が飛んだら、飛んだ範囲を欠けとして覚える', () => {
    const b = book()
    feed(b, S, [0, 30, 120], 1_000)
    const snap = b.snapshot()
    expect(snap.pendingGaps).toBe(1)
    expect(snap.pendingSamples).toBe(60)
    const due = b.nextDue(3_000)
    expect(due).toMatchObject({ key: KEY, from: 60, to: 120, address: ADDR })
  })

  it('安全弁: 遅れて届くパケットを待つ間（settleMs）は取りに行かない', () => {
    const b = book()
    feed(b, S, [0, 30, 120], 1_000)
    expect(b.nextDue(2_999)).toBeNull()
    expect(b.nextDue(3_000)).not.toBeNull()
  })

  it('遅れて届いたパケットが欠けを埋める（一部なら残りだけが残る）', () => {
    const b = book()
    feed(b, S, [0, 30, 150], 1_000)
    expect(b.snapshot().pendingSamples).toBe(90)
    feed(b, S, [90], 1_500)
    expect(b.snapshot().pendingGaps).toBe(2)
    expect(b.snapshot().pendingSamples).toBe(60)
    feed(b, S, [60, 120], 1_600)
    expect(b.snapshot().pendingGaps).toBe(0)
  })

  it('既に受けた範囲が重ねて届いても、欠けも次の番号も動かない', () => {
    const b = book()
    feed(b, S, [0, 30, 60], 1_000)
    feed(b, S, [30], 1_100)
    feed(b, S, [90], 1_200)
    expect(b.snapshot().pendingGaps).toBe(0)
  })

  it('安全弁: 起動 ID が違えば別の流れ。再起動で番号が 0 へ戻っても欠けにしない', () => {
    const b = book()
    feed(b, S, [0, 30, 60], 1_000)
    feed(b, { ...S, bootId: 'deadbeef' }, [0, 30], 2_000)
    expect(b.snapshot().pendingGaps).toBe(0)
  })

  it('安全弁: センサーが違えば別の流れ', () => {
    const b = book()
    feed(b, S, [0, 30], 1_000)
    feed(b, { ...S, sensorId: 'i2c0-69' }, [500], 1_000)
    expect(b.snapshot().pendingGaps).toBe(0)
  })

  it('取り戻した分と取り戻せなかった分を数え、欠けから外す', () => {
    const b = book()
    feed(b, S, [0, 150], 1_000)
    expect(b.recovered(KEY, 30, 90)).toBe(60)
    expect(b.unrecoverable(KEY, 90, 150, 'not-held')).toBe(60)
    const snap = b.snapshot()
    expect(snap.pendingGaps).toBe(0)
    expect(snap.recoveredSamples).toBe(60)
    expect(snap.unrecoverableSamples).toEqual({ 'not-held': 60 })
  })

  it('欠けていない範囲を「取り戻した」と言われても数えない', () => {
    const b = book()
    feed(b, S, [0, 60], 1_000)
    expect(b.recovered(KEY, 0, 30)).toBe(0)
    expect(b.recovered(KEY, 20, 40)).toBe(10)
    expect(b.snapshot().recoveredSamples).toBe(10)
  })

  it('正: 見つけてから holdMs の間に失敗したら、待ちを伸ばさず retryUrgentMs で訊き直す（基板の輪にあるうちに）', () => {
    const b = book()
    feed(b, S, [0, 60], 0)
    for (const t0 of [10_000, 12_000, 20_000]) {
      b.failed(KEY, 30, 60, t0)
      expect(b.nextDue(t0 + 999)).toBeNull()
      expect(b.nextDue(t0 + 1_000)).not.toBeNull()
    }
  })

  it('対照（従来の倍々を holdMs の後へ移した）: holdMs を過ぎてから失敗したら、過ぎてからの回数で倍々に空け、上限で頭打ちにする', () => {
    const b = book()
    feed(b, S, [0, 60], 0)
    // 若いうちの失敗は倍々の回数に数えない。
    for (let i = 0; i < 5; i++) b.failed(KEY, 30, 60, 10_000)
    const t0 = 30_000
    b.failed(KEY, 30, 60, t0)
    expect(b.nextDue(t0 + 4_999)).toBeNull()
    expect(b.nextDue(t0 + 5_000)).not.toBeNull()
    b.failed(KEY, 30, 60, t0)
    expect(b.nextDue(t0 + 9_999)).toBeNull()
    expect(b.nextDue(t0 + 10_000)).not.toBeNull()
    for (let i = 0; i < 10; i++) b.failed(KEY, 30, 60, t0)
    expect(b.nextDue(t0 + 59_999)).toBeNull()
    expect(b.nextDue(t0 + 60_000)).not.toBeNull()
  })

  it('安全弁: holdMs の境目ちょうどからは倍々の側へ移る', () => {
    const b = book()
    feed(b, S, [0, 60], 0)
    b.failed(KEY, 30, 60, 25_000)
    expect(b.nextDue(26_000)).toBeNull()
    expect(b.nextDue(30_000)).not.toBeNull()
  })

  it('正: 同じ流れの近い欠けは、いちばん古い欠けの頭から maxSpanSamples に収まる末尾まで 1 件で返す', () => {
    const b = book()
    // [30,60)・[90,120)・[150,180) が欠ける。
    feed(b, S, [0, 60, 120, 180], 0)
    expect(b.nextDue(10_000)).toMatchObject({ key: KEY, from: 30, to: 180 })
  })

  it('対照: maxSpanSamples を超える先の欠けは伸ばさない（次の回に回す）', () => {
    const b = book({ maxSpanSamples: 100 })
    feed(b, S, [0, 60, 120, 180], 0)
    // [30,180) は 150 サンプル。[90,120) までなら 90 に収まる。
    expect(b.nextDue(10_000)).toMatchObject({ from: 30, to: 120 })
  })

  it('対照: 別のセンサーの欠けは伸ばす先に入れない', () => {
    const b = book()
    feed(b, S, [0, 60], 0)
    feed(b, { ...S, sensorId: 'i2c0-69' }, [0, 60, 120], 0)
    expect(b.nextDue(10_000)).toMatchObject({ key: KEY, from: 30, to: 60 })
  })

  it('安全弁: 伸ばした範囲の途中にある受信済みの分は欠けに掛からない（書かずに捨てられるように）', () => {
    const b = book()
    feed(b, S, [0, 60, 120], 0)
    expect(b.overlapsGap(KEY, 60, 90)).toBe(false)
    expect(b.overlapsGap(KEY, 30, 60)).toBe(true)
    expect(b.overlapsGap(KEY, 80, 100)).toBe(true)
    expect(b.overlapsGap(streamKey({ ...S, sensorId: 'i2c0-69' }), 30, 60)).toBe(false)
  })

  it('正: nextDueWhere は通さない流れを飛ばし、次に古いものを返す（訊いている最中の基板を外す）', () => {
    const b = book()
    const other: StreamRef = { ...S, boardKey: 'mac:020000000002' }
    feed(b, S, [0, 60], 500)
    feed(b, other, [0, 60], 1_000)
    expect(b.nextDueWhere(10_000, (s) => s.boardKey !== S.boardKey)).toMatchObject({ key: streamKey(other) })
    expect(b.nextDueWhere(10_000, () => false)).toBeNull()
  })

  it('古すぎる欠けは諦めて「取り戻せなかった」に数える', () => {
    const b = book({ giveUpAfterMs: 60_000 })
    feed(b, S, [0, 60], 0)
    expect(b.nextDue(60_001)).toBeNull()
    expect(b.snapshot().pendingGaps).toBe(0)
    expect(b.snapshot().unrecoverableSamples).toEqual({ 'gave-up': 30 })
  })

  it('欠けの数が上限を超えたら、いちばん古いものから捨てて数える', () => {
    // 残った 2 件を 1 件にまとめないよう、伸ばす長さを 1 まとまりに絞る。
    const b = book({ maxGaps: 2, maxSpanSamples: 30 })
    feed(b, S, [0, 60, 120, 180], 1_000)
    const snap = b.snapshot()
    expect(snap.pendingGaps).toBe(2)
    expect(snap.unrecoverableSamples).toEqual({ 'too-many': 30 })
    expect(b.nextDue(10_000)).toMatchObject({ from: 90, to: 120 })
  })

  it('いちばん古い欠けから順に出す', () => {
    const b = book()
    feed(b, S, [0, 60], 1_000)
    feed(b, { ...S, sensorId: 'i2c0-69' }, [0, 60], 500)
    expect(b.nextDue(10_000)).toMatchObject({ key: streamKey({ ...S, sensorId: 'i2c0-69' }) })
  })

  it('通し番号が 32 bit を一周しても、欠けの範囲を正しく取る', () => {
    const b = book()
    const near = 0xffff_ffff - 29
    feed(b, S, [near], 1_000)
    feed(b, S, [30], 1_000)
    const due = b.nextDue(10_000)
    expect(due).toMatchObject({ from: 0, to: 30 })
    expect(b.snapshot().pendingSamples).toBe(30)
  })

  it('最新の送り元のアドレスで取りに行く（DHCP で変わっても追う）', () => {
    const b = book()
    feed(b, S, [0, 60], 1_000)
    b.notePacket({ stream: S, firstSeq: 90, count: 30, address: '192.0.2.170', atMs: 1_100 })
    expect(b.nextDue(10_000)).toMatchObject({ address: '192.0.2.170' })
  })

  describe('再起動をまたぐ', () => {
    it('正: 前の起動で最後に受けた番号から、再起動後の最初のパケットまでを欠けにする', () => {
      const before = book()
      feed(before, S, [0, 30, 60], 1_000)
      const state = parseBacklogBookState(JSON.stringify(before.toJSON()))
      expect(state).not.toBeNull()
      const after = book()
      after.restore(state!, 5_000)
      feed(after, S, [300], 6_000)
      expect(after.nextDue(9_000)).toMatchObject({ from: 90, to: 300 })
    })

    it('対照: 再起動のあいだに 1 つも欠けていなければ欠けにしない', () => {
      const before = book()
      feed(before, S, [0, 30], 1_000)
      const after = book()
      after.restore(before.toJSON(), 5_000)
      feed(after, S, [60], 6_000)
      expect(after.snapshot().pendingGaps).toBe(0)
    })

    it('安全弁: 基板も再起動していたら（起動 ID が違えば）前の番号から欠けを作らない', () => {
      const before = book()
      feed(before, S, [0, 30], 1_000)
      const after = book()
      after.restore(before.toJSON(), 5_000)
      feed(after, { ...S, bootId: 'deadbeef' }, [0], 6_000)
      expect(after.snapshot().pendingGaps).toBe(0)
    })

    it('取りに行く前の欠けも持ち越す', () => {
      const before = book()
      feed(before, S, [0, 90], 1_000)
      const after = book()
      after.restore(before.toJSON(), 5_000)
      expect(after.snapshot().pendingGaps).toBe(1)
      expect(after.nextDue(6_999)).toBeNull()
      expect(after.nextDue(7_000)).toMatchObject({ from: 30, to: 90, address: ADDR })
    })

    it('形の合わない中身は読まない', () => {
      expect(parseBacklogBookState('not json')).toBeNull()
      expect(parseBacklogBookState('{"version":2,"streams":[],"gaps":[]}')).toBeNull()
      expect(parseBacklogBookState('{"version":1,"streams":[{"boardKey":"mac:x"}],"gaps":[]}')).toBeNull()
      expect(parseBacklogBookState('{"version":1,"streams":[],"gaps":[{"from":"a"}]}')).toBeNull()
      expect(parseBacklogBookState('{"version":1,"streams":[],"gaps":[]}')).not.toBeNull()
    })
  })

  it('正: 長く黙った後に戻っても、その間の欠けを見つける（時間では忘れない）', () => {
    const b = book()
    feed(b, S, [0, 30], 0)
    // 2 時間後に 30 分ぶん（100 Hz × 1800 s）先の番号で戻る。
    feed(b, S, [180_060], 2 * 60 * 60_000)
    expect(b.snapshot().pendingGaps).toBe(1)
    expect(b.snapshot().pendingSamples).toBe(180_000)
  })

  it('正: 同じ基板・センサーの新しい起動が来たら、欠けの無い前の起動は片付ける', () => {
    const b = book()
    feed(b, S, [0, 30], 0)
    feed(b, { ...S, bootId: 'ffff0000' }, [0], 1_000)
    expect(b.toJSON().streams.map((s) => s.bootId)).toEqual(['ffff0000'])
  })

  it('対照: 別のセンサー・別の基板の流れは片付けない', () => {
    const b = book()
    feed(b, S, [0], 0)
    feed(b, { ...S, sensorId: 'i2c0-69' }, [0], 0)
    feed(b, { ...S, boardKey: 'mac:ffffffffffff' }, [0], 0)
    feed(b, { ...S, bootId: 'ffff0000' }, [0], 1_000)
    const left = b.toJSON().streams.map((s) => `${s.boardKey}|${s.bootId}|${s.sensorId}`).sort()
    expect(left).toEqual([
      `mac:020000000001|34b6e78f|i2c0-69`,
      `mac:020000000001|ffff0000|i2c0-68`,
      `mac:ffffffffffff|34b6e78f|i2c0-68`,
    ].sort())
  })

  it('安全弁: 欠けが残っている前の起動の流れは片付けない（基板のフラッシュから取りに行く）', () => {
    const b = book()
    feed(b, S, [0, 90], 0)
    feed(b, { ...S, bootId: 'ffff0000' }, [0], 1_000)
    expect(b.toJSON().streams.map((s) => s.bootId).sort()).toEqual(['34b6e78f', 'ffff0000'])
    expect(b.nextDue(10_000)).toMatchObject({ key: KEY, from: 30, to: 90 })
  })

  it('正: 持ち越した前の起動の番号は、新しい起動が来たら捨てる', () => {
    const before = book()
    feed(before, S, [0, 30], 0)
    const after = book()
    after.restore(before.toJSON(), 5_000)
    feed(after, { ...S, bootId: 'ffff0000' }, [0], 6_000)
    expect(after.toJSON().streams.map((s) => s.bootId)).toEqual(['ffff0000'])
    expect(after.snapshot().pendingGaps).toBe(0)
  })

  describe('pendingGapStarts（返事へ載せる「欠けがある」）', () => {
    it('対照: 欠けが無ければ空', () => {
      const b = book()
      feed(b, S, [0, 30, 60], 1_000)
      expect(b.pendingGapStarts(S.boardKey, S.bootId, 1_000)).toEqual([])
    })

    it('正: 欠けを見つけたらすぐ載せる（取りに行くまでの待ち settleMs の間も）', () => {
      const b = book()
      feed(b, S, [0, 30, 120], 1_000)
      expect(b.pendingGapStarts(S.boardKey, S.bootId, 1_000)).toEqual([{ sensorId: 'i2c0-68', from: 60 }])
    })

    it('正: センサーごとに、いちばん古い欠けの始まりを 1 つずつ。名前の順に並べる', () => {
      const b = book()
      const s69 = { ...S, sensorId: 'i2c0-69' }
      feed(b, s69, [0, 60, 150], 1_000)
      feed(b, S, [0, 90, 180], 1_000)
      expect(b.pendingGapStarts(S.boardKey, S.bootId, 1_000)).toEqual([
        { sensorId: 'i2c0-68', from: 30 },
        { sensorId: 'i2c0-69', from: 30 },
      ])
    })

    it('正: 番号が 32 bit を一周しても、古いほうを始まりにする', () => {
      const b = book()
      const near = 0xffff_ffff - 59
      // 欠けは [near+30, 0) と、一周した先の [30, 60)。数の上では後者のほうが小さい。
      feed(b, S, [near, (near + 60) >>> 0, (near + 120) >>> 0], 1_000)
      expect(b.pendingGapStarts(S.boardKey, S.bootId, 1_000)).toEqual([{ sensorId: 'i2c0-68', from: near + 30 }])
    })

    it('安全弁: 起動 ID が違う欠けは載せない（基板のメモリの輪にあるのはいまの起動の分だけ）', () => {
      const b = book()
      feed(b, S, [0, 90], 0)
      feed(b, { ...S, bootId: 'ffff0000' }, [0, 30], 1_000)
      expect(b.pendingGapStarts(S.boardKey, 'ffff0000', 1_000)).toEqual([])
    })

    it('安全弁: 別の基板の欠けは載せない', () => {
      const b = book()
      feed(b, { ...S, boardKey: 'mac:ffffffffffff' }, [0, 90], 1_000)
      expect(b.pendingGapStarts(S.boardKey, S.bootId, 1_000)).toEqual([])
    })

    it('安全弁: 取り戻した・取り戻せないと分かった欠けは載せない', () => {
      const b = book()
      feed(b, S, [0, 30, 120, 150, 240], 1_000)
      b.recovered(KEY, 60, 120)
      expect(b.pendingGapStarts(S.boardKey, S.bootId, 1_000)).toEqual([{ sensorId: 'i2c0-68', from: 180 }])
      b.unrecoverable(KEY, 180, 240, 'not-held')
      expect(b.pendingGapStarts(S.boardKey, S.bootId, 1_000)).toEqual([])
    })

    it('安全弁: 諦める年齢（giveUpAfterMs）を過ぎた欠けは載せない（帳面の中身は動かさない）', () => {
      const b = book()
      feed(b, S, [0, 90], 0)
      expect(b.pendingGapStarts(S.boardKey, S.bootId, OPTIONS.giveUpAfterMs)).toHaveLength(1)
      expect(b.pendingGapStarts(S.boardKey, S.bootId, OPTIONS.giveUpAfterMs + 1)).toEqual([])
      expect(b.snapshot().pendingGaps).toBe(1)
    })
  })
})
