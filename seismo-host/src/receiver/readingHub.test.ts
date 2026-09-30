import { describe, expect, it } from 'vitest'

import type { IntensityReading, WaveChunk } from './intensityPipeline'
import { ReadingHub } from './readingHub'
import type { DetachReason, HubMessage, PairWant, Subscription, WaveWant } from './readingHub'
import type { SensorMemberRef, SensorPairDiff } from './sensorFusion'

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
const STATION_READING: HubMessage = {
  kind: 'station-reading',
  reading: { stationId: 'garage', atMs: 1_700_000_000_000, intensity: 2.1 },
}
const STATION_WAVE: HubMessage = {
  kind: 'station-wave',
  wave: {
    stationId: 'garage',
    driver: { boardKey: 'mac:aa', sensorId: 's0' },
    firstSampleIndex: 0,
    firstSampleMs: 1_700_000_000_000,
    msPerSample: 10,
    gal: [[1], [2], [3]],
    // 落とした直流（`gal` と足せば校正済み gal の重み付き平均になる値）。
    dcGal: [[0], [0], [980]],
    memberCount: [2],
  },
}

// センサー対の差分（#372）。**顔ぶれで配る種別**なので、梯子とは別に突き合わせる。
const MEMBER_A = { boardKey: 'mac:aa', sensorId: 's0' } as const
const MEMBER_B = { boardKey: 'mac:bb', sensorId: 's1' } as const
const MEMBER_C = { boardKey: 'mac:cc', sensorId: 's2' } as const

function pairDiff(a: SensorMemberRef, b: SensorMemberRef, stationId = 'garage'): SensorPairDiff {
  return {
    stationId,
    memberA: a,
    memberB: b,
    firstSampleIndex: 0,
    firstSampleMs: 1_700_000_000_000,
    msPerSample: 10,
    // 3 列目が null なのは、片方の値が揃わなかったサンプル（外挿しない）。
    diffGal: [[0.1], [0.2], [null]],
  }
}

const DIFF_AB: HubMessage = { kind: 'station-diff', diff: pairDiff(MEMBER_A, MEMBER_B) }
const DIFF_BA: HubMessage = { kind: 'station-diff', diff: pairDiff(MEMBER_B, MEMBER_A) }
const DIFF_AC: HubMessage = { kind: 'station-diff', diff: pairDiff(MEMBER_A, MEMBER_C) }
const DIFF_OTHER_STATION: HubMessage = {
  kind: 'station-diff',
  diff: pairDiff(MEMBER_A, MEMBER_B, 'attic'),
}
const WANT_AB: PairWant = { stationId: 'garage', a: MEMBER_A, b: MEMBER_B }

/** 受け取る相手。`take` を偽にすると詰まったふりをする。 */
function sink(options: { wave?: WaveWant; diff?: PairWant | null; take?: boolean } = {}) {
  const got: HubMessage[] = []
  const detached: DetachReason[] = []
  const self = {
    got,
    detached,
    take: options.take ?? true,
    wave: options.wave ?? 'none',
    diff: options.diff ?? null,
    subscription: null as Subscription | null,
    attach(hub: ReadingHub): Subscription | null {
      const s = hub.subscribe({
        wave: self.wave,
        diff: self.diff,
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
    const plain = sink({ wave: 'none' })
    const full = sink({ wave: 'all' })
    plain.attach(hub)
    full.attach(hub)

    hub.publish(READING)
    hub.publish(WAVE)

    expect(plain.got).toEqual([READING])
    expect(full.got).toEqual([READING, WAVE])
  })

  it('観測点ぶんの計測震度（合成）も、センサー単独の震度と同じく全員へ配る', () => {
    const hub = new ReadingHub()
    const plain = sink({ wave: 'none' })
    plain.attach(hub)

    hub.publish(STATION_READING)

    expect(plain.got).toEqual([STATION_READING])
  })

  it('正: 観測点ぶんの合成波形は、波形を欲しいと言った相手へ配る', () => {
    const hub = new ReadingHub()
    const full = sink({ wave: 'all' })
    full.attach(hub)

    hub.publish(STATION_WAVE)

    expect(full.got).toEqual([STATION_WAVE])
  })

  it('対照: 波形を欲しがっていない相手へは、センサー単独も合成も 1 件も配らない', () => {
    const hub = new ReadingHub()
    const plain = sink({ wave: 'none' })
    plain.attach(hub)

    hub.publish(WAVE)
    hub.publish(STATION_WAVE)
    hub.publish(READING)
    hub.publish(STATION_READING)

    // **震度の 2 種だけが届く。** 合成波形は 1 観測点ぶんでも毎秒およそ 15 KB あり、
    // 震度だけを見に来た相手（PWA の一覧・状態監視）へ流す理由が無い。
    expect(plain.got).toEqual([READING, STATION_READING])
  })

  it('安全弁: 合成波形を受け取れなかった相手は、捨てた件数に数えられる', () => {
    const hub = new ReadingHub()
    // 波形は欲しいが、いま受け取れない相手。
    const stuck = sink({ wave: 'all', take: false })
    stuck.attach(hub)

    hub.publish(STATION_WAVE)

    // **種別を足しても、詰まりの数え上げは同じ道を通る。** ここが 0 のままだと、
    // 合成波形だけが「配れなかったのに捨てた覚えが無い」状態になる。
    expect(hub.snapshot().dropped).toBe(1)
    expect(hub.snapshot().subscribers[0].dropped).toBe(1)
  })

  // 波形の粒度（#261 段 0）。地震ビューアーの PWA は観測点の合成 1 本だけを見るので、
  // センサー単独の波形（実測で毎秒およそ 65 KB）を押し付けない口が要る。
  it("正: 'station' を望んだ相手へは、観測点の合成波形を配る", () => {
    const hub = new ReadingHub()
    const onlyStation = sink({ wave: 'station' })
    onlyStation.attach(hub)

    hub.publish(STATION_WAVE)

    expect(onlyStation.got).toEqual([STATION_WAVE])
  })

  it("対照: 'station' を望んだ相手へは、センサー単独の波形を 1 件も配らない", () => {
    const hub = new ReadingHub()
    const onlyStation = sink({ wave: 'station' })
    onlyStation.attach(hub)

    hub.publish(WAVE)
    hub.publish(STATION_WAVE)
    hub.publish(READING)
    hub.publish(STATION_READING)

    // **`WAVE` が混ざっていないこと**がこの粒度を足した目的。混ざると、
    // 合成 1 本を見るだけの端末へ毎秒 65 KB が流れ続ける。
    expect(onlyStation.got).toEqual([STATION_WAVE, READING, STATION_READING])
  })

  it("安全弁: 'station' を足しても 'all' の相手はセンサー単独も受け取り続ける", () => {
    const hub = new ReadingHub()
    const full = sink({ wave: 'all' })
    full.attach(hub)

    hub.publish(WAVE)
    hub.publish(STATION_WAVE)

    // 管理コンソールの波形タブ（`?wave=1`）がここに乗っている。**狭めない。**
    expect(full.got).toEqual([WAVE, STATION_WAVE])
  })

  // センサー対の差分（#372）。**梯子ではなく顔ぶれで配る。** 全ペアぶん作られるので
  // （実機のセンサー 9 本なら 36 組・毎秒 240 KB（実測））、梯子へ載せると波形タブが
  // 黙ってその量を受けることになる。
  it('正: 頼んだ組の差分を配る', () => {
    const hub = new ReadingHub()
    const watcher = sink({ wave: 'all', diff: WANT_AB })
    watcher.attach(hub)

    hub.publish(DIFF_AB)

    expect(watcher.got).toEqual([DIFF_AB])
  })

  it('正: 頼んだ向きと逆でも同じ組として配る', () => {
    const hub = new ReadingHub()
    const watcher = sink({ wave: 'all', diff: WANT_AB })
    watcher.attach(hub)

    hub.publish(DIFF_BA)

    // **向きを厳しく見ない。** 設定でセンサーの並びが変わると `buildPairDiffs` が
    // 組み立てる向きも変わるので、厳しく見ると**何も届かなくなる**（繋がっているのに
    // 来ない、という最も気づきにくい形）。符号の反転は `memberA`/`memberB` から分かる。
    expect(watcher.got).toEqual([DIFF_BA])
  })

  it('正: 波形を頼んでいなくても、差分だけは届く', () => {
    const hub = new ReadingHub()
    const watcher = sink({ wave: 'none', diff: WANT_AB })
    watcher.attach(hub)

    hub.publish(DIFF_AB)
    hub.publish(WAVE)
    hub.publish(STATION_WAVE)

    // **差分は波形の梯子と直交している。** `'none'` が言うのは「波形は要らない」だけで、
    // 差分を頼んだかどうかは別に持つ。実機でもこの形で確かめた —— `?diff*` の 5 欄だけで
    // 繋ぐと差分が毎秒 3.35 件届き、波形は 1 件も来ない。
    expect(watcher.got).toEqual([DIFF_AB])
  })

  it('対照: 頼んでいない組の差分は 1 件も配らない', () => {
    const hub = new ReadingHub()
    const watcher = sink({ wave: 'all', diff: WANT_AB })
    watcher.attach(hub)

    hub.publish(DIFF_AC)
    hub.publish(DIFF_OTHER_STATION)

    // **観測点が違うだけの同じ顔ぶれも別物。** 観測点を見ないと、同じセンサーを
    // 2 つの観測点へ割り当てた設定で取り違える。
    expect(watcher.got).toEqual([])
  })

  it("対照: 差分を頼んでいない相手へは、'all' でも 1 件も配らない", () => {
    const hub = new ReadingHub()
    const full = sink({ wave: 'all' })
    full.attach(hub)

    hub.publish(DIFF_AB)
    hub.publish(WAVE)
    hub.publish(STATION_WAVE)

    // **ここが `WaveWant` の梯子へ載せなかった目的。** `'all'` に含めた瞬間、
    // 波形タブへ 36 組・毎秒 240 KB（実測） が黙って乗る。
    expect(full.got).toEqual([WAVE, STATION_WAVE])
  })

  it('安全弁: 差分を足しても、震度と波形の配り分けは変わらない', () => {
    const hub = new ReadingHub()
    const plain = sink({ wave: 'none' })
    const onlyStation = sink({ wave: 'station' })
    plain.attach(hub)
    onlyStation.attach(hub)

    hub.publish(DIFF_AB)
    hub.publish(READING)
    hub.publish(STATION_READING)
    hub.publish(WAVE)
    hub.publish(STATION_WAVE)

    expect(plain.got).toEqual([READING, STATION_READING])
    expect(onlyStation.got).toEqual([READING, STATION_READING, STATION_WAVE])
  })

  it('安全弁: 差分を受け取れなかった相手は、捨てた件数に数えられる', () => {
    const hub = new ReadingHub()
    const stuck = sink({ wave: 'all', diff: WANT_AB, take: false })
    stuck.attach(hub)

    hub.publish(DIFF_AB)

    // **種別を足しても、詰まりの数え上げは同じ道を通る**（`station-wave` と同じ理由）。
    expect(hub.snapshot().dropped).toBe(1)
    expect(hub.snapshot().subscribers[0].dropped).toBe(1)
  })

  it('頼んだ組を状態の口へ出す', () => {
    const hub = new ReadingHub()
    sink({ wave: 'all', diff: WANT_AB }).attach(hub)

    // **頼んだ顔ぶれが見えないと、届かない理由を外から切り分けられない。**
    // 設定が変わって組が無くなったときの症状は「1 件も来ない」だけなので、
    // `/status` の `pairDiffs` と見比べられるようにしておく。
    expect(hub.snapshot().subscribers[0].diff).toEqual(WANT_AB)
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
      wave: 'none',
      diff: null,
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
      wave: 'none',
      diff: null,
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
      wave: 'none',
      diff: null,
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
