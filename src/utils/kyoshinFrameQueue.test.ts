import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFrameQueue } from './kyoshinFrameQueue'
import { log } from './logger'

// 記録の間引き（createLogThrottle）は検証対象なので本物を残し、出力だけ差し替える。
vi.mock('./logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logger')>()
  return { ...actual, log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

interface Frame {
  time: Date
  label: string
}

/** 基準時刻。秒だけずらしたフレームを作って順序を検証する。 */
const T0 = new Date('2026-08-19T12:00:00+09:00')

function at(offsetSec: number, label = `t${offsetSec}`): Frame {
  return { time: new Date(T0.getTime() + offsetSec * 1000), label }
}

describe('createFrameQueue', () => {
  beforeEach(() => {
    vi.mocked(log.warn).mockClear()
  })

  it('時刻が到来していないフレームは放出しない', () => {
    const q = createFrameQueue<Frame>()
    q.enqueue(at(5))
    expect(q.drainLatest(T0)).toBeNull()
    expect(q.size()).toBe(1)
  })

  it('時刻が到来したフレームを放出する', () => {
    const q = createFrameQueue<Frame>()
    q.enqueue(at(0))
    expect(q.drainLatest(T0)?.label).toBe('t0')
    expect(q.size()).toBe(0)
  })

  it('投入順が時刻順でなくても時刻順に並べ替えて放出する', () => {
    const q = createFrameQueue<Frame>()
    q.enqueue(at(2))
    q.enqueue(at(1))
    q.enqueue(at(3))
    // 1 と 2 だけ到来。最新（t2）が返り、t1 は捨てられる。
    expect(q.drainLatest(at(2).time)?.label).toBe('t2')
    // 残るのは未到来の t3 のみ
    expect(q.size()).toBe(1)
    expect(q.drainLatest(at(3).time)?.label).toBe('t3')
  })

  it('同時に到来した複数フレームのうち最新 1 件だけを返し、間は捨てる', () => {
    const q = createFrameQueue<Frame>()
    q.enqueue(at(0))
    q.enqueue(at(1))
    q.enqueue(at(2))
    expect(q.drainLatest(at(10).time)?.label).toBe('t2')
    expect(q.size()).toBe(0)
  })

  it('間引いたフレームがあることを記録に残す（黙って捨てない）', () => {
    const q = createFrameQueue<Frame>()
    q.enqueue(at(0))
    q.enqueue(at(1))
    q.enqueue(at(2))
    q.drainLatest(at(10).time)

    const skipWarns = vi.mocked(log.warn).mock.calls.filter(c => String(c[0]).includes('飛ばし'))
    expect(skipWarns).toHaveLength(1)
    expect(String(skipWarns[0][0])).toContain('2 件')
  })

  it('1 件ずつ流れる定常時は間引きの記録を出さない', () => {
    const q = createFrameQueue<Frame>()
    q.enqueue(at(0))
    q.drainLatest(at(0).time)
    q.enqueue(at(1))
    q.drainLatest(at(1).time)

    expect(vi.mocked(log.warn)).not.toHaveBeenCalled()
  })

  // 警告は「継続する障害を見失わない」ために間引きつつ出し続ける。壁時計を進めて挙動を確かめる。
  describe('警告の間引き', () => {
    const warnsFor = (keyword: string) =>
      vi.mocked(log.warn).mock.calls.filter(c => String(c[0]).includes(keyword)).length

    it('保持上限の超過は間引かれ、間隔を越えたら再度出る', () => {
      vi.useFakeTimers({ now: T0.getTime() })
      try {
        const q = createFrameQueue<Frame>(1)
        q.enqueue(at(1))
        q.enqueue(at(2))
        q.enqueue(at(3))
        expect(warnsFor('保持上限')).toBe(1)

        vi.advanceTimersByTime(60_000)
        q.enqueue(at(4))
        expect(warnsFor('保持上限')).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('不正なデータ時刻は間引かれ、間隔を越えたら再度出る', () => {
      vi.useFakeTimers({ now: T0.getTime() })
      try {
        const q = createFrameQueue<Frame>()
        const broken = { time: new Date('invalid'), label: 'broken' }
        q.enqueue(broken)
        q.enqueue(broken)
        expect(warnsFor('データ時刻が不正')).toBe(1)

        vi.advanceTimersByTime(60_000)
        q.enqueue(broken)
        expect(warnsFor('データ時刻が不正')).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('フレームの間引きは記録を埋めず、間引かれた件数は累計で持ち越す', () => {
      vi.useFakeTimers({ now: T0.getTime() })
      try {
        const q = createFrameQueue<Frame>()
        const skipWarns = () =>
          vi.mocked(log.warn).mock.calls.filter(c => String(c[0]).includes('飛ばし')).map(c => String(c[0]))

        // 3 巡ぶん間引く（各巡 1 件）。記録に残るのは 1 回目だけ。
        for (let round = 0; round < 3; round++) {
          q.enqueue(at(round * 10))
          q.enqueue(at(round * 10 + 1))
          q.drainLatest(at(round * 10 + 5).time)
        }
        expect(skipWarns()).toHaveLength(1)
        expect(skipWarns()[0]).toContain('計 1 件')

        // 間隔を越えた次の間引きで、抑制されていた 2 件ぶんも合わせて出る
        vi.advanceTimersByTime(60_000)
        q.enqueue(at(100))
        q.enqueue(at(101))
        q.drainLatest(at(105).time)
        expect(skipWarns()).toHaveLength(2)
        expect(skipWarns()[1]).toContain('計 3 件')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('同時刻のフレームは投入順の後のものが残る', () => {
    const q = createFrameQueue<Frame>()
    q.enqueue(at(0, 'first'))
    q.enqueue(at(0, 'second'))
    expect(q.drainLatest(T0)?.label).toBe('second')
  })

  it('時刻が不正なフレームは投入時に捨てる（放出条件が永久に偽になるのを防ぐ）', () => {
    const q = createFrameQueue<Frame>()
    q.enqueue({ time: new Date('invalid'), label: 'broken' })
    expect(q.size()).toBe(0)
    // 後続の正常なフレームは通常どおり放出できる
    q.enqueue(at(0))
    expect(q.drainLatest(T0)?.label).toBe('t0')
  })

  it('時計が不正な値のときは放出しない', () => {
    const q = createFrameQueue<Frame>()
    q.enqueue(at(0))
    expect(q.drainLatest(new Date('invalid'))).toBeNull()
    expect(q.size()).toBe(1)
  })

  it('保持上限を超えたら最も未来のフレームから捨てる', () => {
    const q = createFrameQueue<Frame>(3)
    q.enqueue(at(1))
    q.enqueue(at(2))
    q.enqueue(at(3))
    q.enqueue(at(4))
    expect(q.size()).toBe(3)
    // 先に再生する分（t1〜t3）が残り、最も未来の t4 が落ちる
    expect(q.drainLatest(at(100).time)?.label).toBe('t3')
  })

  it('上限に達した状態で過去寄りのフレームを入れると、未来側が押し出される', () => {
    const q = createFrameQueue<Frame>(2)
    q.enqueue(at(5))
    q.enqueue(at(6))
    q.enqueue(at(1))
    expect(q.size()).toBe(2)
    // t1 が入り、末尾の t6 が落ちる
    expect(q.drainLatest(at(5).time)?.label).toBe('t5')
    expect(q.size()).toBe(0)
  })

  it('clear で全て捨てる', () => {
    const q = createFrameQueue<Frame>()
    q.enqueue(at(0))
    q.enqueue(at(1))
    q.clear()
    expect(q.size()).toBe(0)
    expect(q.drainLatest(at(10).time)).toBeNull()
  })
})
