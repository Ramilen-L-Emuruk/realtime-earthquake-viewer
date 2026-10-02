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
  retryBaseMs: 5_000,
  retryMaxMs: 60_000,
  giveUpAfterMs: 20 * 60_000,
  maxGaps: 100,
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

  it('失敗したら間隔を倍々に空け、上限で頭打ちにする', () => {
    const b = book()
    feed(b, S, [0, 60], 0)
    const t0 = 10_000
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

  it('古すぎる欠けは諦めて「取り戻せなかった」に数える', () => {
    const b = book({ giveUpAfterMs: 60_000 })
    feed(b, S, [0, 60], 0)
    expect(b.nextDue(60_001)).toBeNull()
    expect(b.snapshot().pendingGaps).toBe(0)
    expect(b.snapshot().unrecoverableSamples).toEqual({ 'gave-up': 30 })
  })

  it('欠けの数が上限を超えたら、いちばん古いものから捨てて数える', () => {
    const b = book({ maxGaps: 2 })
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
})
