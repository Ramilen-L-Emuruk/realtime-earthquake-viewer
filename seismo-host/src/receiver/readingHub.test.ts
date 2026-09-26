import { describe, expect, it } from 'vitest'

import type { IntensityReading, WaveChunk } from './intensityPipeline'
import { ReadingHub } from './readingHub'
import type { DetachReason, HubMessage, Subscription } from './readingHub'

/** 差し替えられる時計。 */
function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
  }
}

function reading(overrides: Partial<IntensityReading> = {}): IntensityReading {
  return {
    streamKey: 'mac:aa|s0|boot1',
    segmentId: 1,
    boardKey: 'mac:aa',
    sensorId: 's0',
    atMs: 1_700_000_000_000,
    intensity: 1.23,
    timebaseNominalReason: null,
    timebaseResidualRmsMs: 3.1,
    ...overrides,
  }
}

function wave(overrides: Partial<WaveChunk> = {}): WaveChunk {
  return {
    streamKey: 'mac:aa|s0|boot1',
    segmentId: 1,
    boardKey: 'mac:aa',
    sensorId: 's0',
    channels: ['HN1', 'HN2', 'HN3'],
    firstSampleIndex: 0,
    firstSampleMs: 1_700_000_000_000,
    msPerSample: 10,
    timebaseNominalReason: null,
    gal: [[1], [2], [3]],
    ...overrides,
  }
}

const READING: HubMessage = { kind: 'reading', reading: reading() }
const WAVE: HubMessage = { kind: 'wave', wave: wave() }

/** 受け取る相手。`take` を偽にすると詰まったふりをする。 */
function sink(options: { wave?: boolean; take?: boolean } = {}) {
  const got: HubMessage[] = []
  const detached: DetachReason[] = []
  const self = {
    got,
    detached,
    take: options.take ?? true,
    wave: options.wave ?? false,
    subscription: null as Subscription | null,
    attach(hub: ReadingHub): Subscription | null {
      const s = hub.subscribe({
        wave: self.wave,
        deliver: (m) => {
          if (!self.take) return false
          got.push(m)
          return true
        },
        onDetach: (reason) => detached.push(reason),
      })
      self.subscription = s
      return s
    },
  }
  return self
}

describe('ReadingHub', () => {
  it('震度は全員へ、波形は欲しいと言った相手だけへ配る', () => {
    const hub = new ReadingHub()
    const plain = sink({ wave: false })
    const full = sink({ wave: true })
    plain.attach(hub)
    full.attach(hub)

    hub.publish(READING)
    hub.publish(WAVE)

    expect(plain.got).toEqual([READING])
    expect(full.got).toEqual([READING, WAVE])
  })

  it('上限に達したら新しいほうを断り、断った数を覚える', () => {
    const hub = new ReadingHub({ maxSubscribers: 2 })
    expect(sink().attach(hub)).not.toBeNull()
    expect(sink().attach(hub)).not.toBeNull()

    expect(sink().attach(hub)).toBeNull()
    expect(hub.snapshot().rejected).toBe(1)
    expect(hub.openCount).toBe(2)
  })

  it('切れば枠が空いて、次が入れる', () => {
    const hub = new ReadingHub({ maxSubscribers: 1 })
    const first = sink()
    first.attach(hub)
    expect(sink().attach(hub)).toBeNull()

    first.subscription?.close()

    expect(sink().attach(hub)).not.toBeNull()
    // **自分で切ったときは報せを返さない。** 呼び出し側は既に知っている。
    expect(first.detached).toEqual([])
  })

  it('2 度切っても壊れない', () => {
    const hub = new ReadingHub()
    const s = sink()
    s.attach(hub)

    s.subscription?.close()
    s.subscription?.close()

    expect(hub.openCount).toBe(0)
  })

  it('詰まっている相手のぶんは捨てて数える', () => {
    const hub = new ReadingHub()
    const stuck = sink({ take: false })
    stuck.attach(hub)

    hub.publish(READING)
    hub.publish(READING)

    const snap = hub.snapshot()
    expect(snap.dropped).toBe(2)
    expect(snap.delivered).toBe(0)
    expect(snap.subscribers[0].dropped).toBe(2)
  })

  it('詰まりが続いたら切る。**測るのは経過時間で、件数ではない**', () => {
    const t = clock()
    const hub = new ReadingHub({ stallMs: 30_000, now: t.now })
    const stuck = sink({ take: false })
    stuck.attach(hub)

    hub.publish(READING) // 詰まりの始まり
    t.advance(29_999)
    hub.publish(READING)
    expect(hub.openCount).toBe(1)

    t.advance(1)
    hub.publish(READING)

    expect(hub.openCount).toBe(0)
    expect(stuck.detached).toEqual(['stalled'])
    expect(hub.snapshot().stalled).toBe(1)
  })

  it('1 件でも通れば詰まりの計時はやり直す', () => {
    const t = clock()
    const hub = new ReadingHub({ stallMs: 10_000, now: t.now })
    const flaky = sink({ take: false })
    flaky.attach(hub)

    hub.publish(READING)
    t.advance(9_000)
    flaky.take = true
    hub.publish(READING)
    expect(hub.snapshot().subscribers[0].stalledSinceMs).toBeNull()

    // ここから数え直すので、前の 9 秒は効かない
    flaky.take = false
    hub.publish(READING)
    t.advance(9_000)
    hub.publish(READING)

    expect(hub.openCount).toBe(1)
  })

  it('渡す途中で投げた相手だけを切り、ほかへは配り続ける', () => {
    const hub = new ReadingHub()
    const broken = hub.subscribe({
      wave: false,
      deliver: () => {
        throw new Error('壊れた受け手')
      },
      onDetach: () => {},
    })
    expect(broken).not.toBeNull()
    const ok = sink()
    ok.attach(hub)

    hub.publish(READING)

    expect(ok.got).toEqual([READING])
    const snap = hub.snapshot()
    expect(snap.failed).toBe(1)
    expect(snap.lastFailure).toBe('壊れた受け手')
    expect(hub.openCount).toBe(1)
  })

  it('配っている最中に切られても、残りの相手を飛ばさない', () => {
    // 1 人目が配達の最中に自分を切る。**元の配列を直に回すと詰め直しで 2 人目が飛ぶ。**
    const hub = new ReadingHub()
    const a = sink()
    const b = sink()
    const c = sink()
    const subA: Subscription | null = hub.subscribe({
      wave: false,
      deliver: (m) => {
        a.got.push(m)
        subA?.close()
        return true
      },
      onDetach: () => {},
    })
    expect(subA).not.toBeNull()
    b.attach(hub)
    c.attach(hub)

    hub.publish(READING)

    expect(a.got).toEqual([READING])
    expect(b.got).toEqual([READING])
    expect(c.got).toEqual([READING])
  })

  it('報せ方が壊れていても外すことは済ませ、数えて次へ進む', () => {
    const hub = new ReadingHub({ stallMs: 0 })
    const rude = hub.subscribe({
      wave: false,
      deliver: () => false,
      onDetach: () => {
        throw new Error('報せが壊れた')
      },
    })
    expect(rude).not.toBeNull()
    const ok = sink()
    ok.attach(hub)

    hub.publish(READING)
    hub.publish(READING)

    expect(hub.openCount).toBe(1)
    expect(ok.got).toHaveLength(2)
    // **配達の失敗とは別の枠で数える。** 壊れているのは報せ方で、押し出しそのものでは
    // ない —— 混ぜると、状態の口を見た人が「向こうへ届いていない」と誤診する。
    expect(hub.snapshot().notifyFailed).toBe(1)
    expect(hub.snapshot().lastNotifyFailure).toBe('報せが壊れた')
    expect(hub.snapshot().failed).toBe(0)
    expect(hub.snapshot().lastFailure).toBeNull()
  })

  it('押し出しが壊れて切ったときは数に入れ、相手が閉じただけの回とは分ける', () => {
    const hub = new ReadingHub()
    const broken = sink().attach(hub)
    expect(broken).not.toBeNull()

    broken?.closeFailed('書き込みが壊れた')

    // **数に残らないと、詰まり・書き込み失敗を検知するための口が
    // まさにそれが起きた回だけ黙る**（見えるのは購読者が 1 つ減ったことだけ）。
    expect(hub.snapshot().failed).toBe(1)
    expect(hub.snapshot().lastFailure).toBe('書き込みが壊れた')
    expect(hub.openCount).toBe(0)

    // 相手が閉じただけの回は数えない —— 正常な終わり方なので、混ぜると
    // この数が常に増え続けて異常の印として読めなくなる。
    sink().attach(hub)?.close()
    expect(hub.snapshot().failed).toBe(1)
  })

  it('壊れて切ったあとに 2 度呼んでも数は増えない', () => {
    const hub = new ReadingHub()
    const s = sink().attach(hub)

    s?.closeFailed('1 回目')
    s?.closeFailed('2 回目')

    expect(hub.snapshot().failed).toBe(1)
    expect(hub.snapshot().lastFailure).toBe('1 回目')
  })

  it('closeAll で全部切れる（終わるときに server.close() が返るため）', () => {
    const hub = new ReadingHub()
    const a = sink()
    const b = sink()
    a.attach(hub)
    b.attach(hub)

    hub.closeAll()

    expect(hub.openCount).toBe(0)
    expect(a.detached).toHaveLength(1)
    expect(b.detached).toHaveLength(1)
  })

  it('正常終了の切断を「詰まった」と偽らない', () => {
    const hub = new ReadingHub()
    const a = sink()
    a.attach(hub)

    hub.closeAll()

    // 'stalled' で代用すると、再起動のたび事実と違う警告が接続の数だけ並ぶ
    expect(a.detached).toEqual(['shutdown'])
    expect(hub.snapshot().stalled).toBe(0)
  })

  it('誰も繋いでいなければ数え上げも動かない', () => {
    const hub = new ReadingHub()

    hub.publish(READING)
    hub.publish(WAVE)

    const snap = hub.snapshot()
    expect(snap.delivered).toBe(0)
    expect(snap.dropped).toBe(0)
    expect(snap.subscribers).toEqual([])
  })
})
