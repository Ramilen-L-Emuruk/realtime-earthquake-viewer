// 取り戻した区間の知らせを受けて、下部の波形の穴を `/waves` から埋める係のテスト（#597）。
//
// **形は 3 種を対にする**（正・対照・安全弁。CLAUDE.md「検証」）。

import { describe, expect, it, vi } from 'vitest'

import { SeismoWaveBuffer, type SeismoWaveChunk } from '../utils/seismoWaveBuffer'
import type { WaveSamplesResult } from './seismoWaveSamples'
import { SeismoWaveRefiller } from './seismoWaveRefill'

function chunk(firstSampleMs: number, value = 0, length = 30): SeismoWaveChunk {
  const axis = Array.from({ length }, () => value)
  return { firstSampleMs, msPerSample: 10, gal: [axis, axis, axis], memberCount: axis.map(() => 3) }
}

/** 1000 ms から 3 まとまり、真ん中（1300〜1590 ms）が届かなかった入れ物。 */
function withHole(): SeismoWaveBuffer {
  const buffer = new SeismoWaveBuffer(60)
  buffer.push(chunk(1000))
  buffer.push(chunk(1600))
  return buffer
}

function ok(chunks: SeismoWaveChunk[]): WaveSamplesResult {
  return {
    kind: 'ok',
    samples: {
      stationKnown: true,
      filesFailed: 0,
      skippedBytes: 0,
      truncated: false,
      chunks: chunks.map((c) => ({
        firstSampleMs: c.firstSampleMs,
        msPerSample: c.msPerSample,
        gal: [Float32Array.from(c.gal[0]), Float32Array.from(c.gal[1]), Float32Array.from(c.gal[2])],
        memberCount: Float32Array.from(c.memberCount),
      })),
    },
  }
}

/** 待っている取得を全部片付ける。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

describe('SeismoWaveRefiller', () => {
  it('正: 知らせの範囲に穴があれば、穴の範囲だけを取って埋める', async () => {
    const buffer = withHole()
    const fetchSamples = vi.fn(async () => ok([chunk(1300, 7)]))
    const filled: number[] = []
    const refiller = new SeismoWaveRefiller({
      bufferOf: () => buffer,
      fetchSamples,
      signal: new AbortController().signal,
      delayMs: 3000,
      onFilled: (_id, r) => filled.push(r.filled),
      onSkipped: () => {},
      onError: (_id, e) => { throw e },
    })

    refiller.notice({ stationId: 'home', fromMs: 0, toMs: 10_000 })
    await settle()

    // **取るのは穴の範囲だけ**（知らせの範囲は作り直しの区間で、穴より広い）。
    expect(fetchSamples).toHaveBeenCalledTimes(1)
    expect(fetchSamples.mock.calls[0]).toEqual([{ stationId: 'home', fromMs: 1300, toMs: 1600 }])
    expect(filled).toEqual([30])
    expect(buffer.holesIn(0, 10_000)).toBeNull()
  })

  it('対照: 知らせの範囲に穴が無ければ取りに行かない', async () => {
    const buffer = withHole()
    const fetchSamples = vi.fn(async () => ok([]))
    const refiller = new SeismoWaveRefiller({
      bufferOf: (id) => (id === 'home' ? buffer : null),
      fetchSamples,
      signal: new AbortController().signal,
      delayMs: 3000,
      onFilled: () => {},
      onSkipped: () => {},
      onError: (_id, e) => { throw e },
    })

    // 穴（1300〜1590 ms）より後だけを作り直した知らせ。
    refiller.notice({ stationId: 'home', fromMs: 1600, toMs: 5000 })
    // 波形を抱えていない観測点の知らせ。
    refiller.notice({ stationId: 'other', fromMs: 0, toMs: 5000 })
    await settle()

    expect(fetchSamples).not.toHaveBeenCalled()
  })

  it('安全弁: 取りに行っている最中の知らせは捨てずに、取り終えてから範囲をまとめて取り直す', async () => {
    const buffer = withHole()
    let release: (r: WaveSamplesResult) => void = () => {}
    const fetchSamples = vi
      .fn<(p: { stationId: string; fromMs: number; toMs: number }) => Promise<WaveSamplesResult>>()
      // 1 回目は途中までしか埋められない（1300〜1390 ms だけ返す）。
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
      .mockImplementation(async () => ok([chunk(1400, 5, 20)]))
    const refiller = new SeismoWaveRefiller({
      bufferOf: () => buffer,
      fetchSamples,
      signal: new AbortController().signal,
      delayMs: 3000,
      onFilled: () => {},
      onSkipped: () => {},
      onError: (_id, e) => { throw e },
    })

    refiller.notice({ stationId: 'home', fromMs: 1300, toMs: 1400 })
    await settle()
    // 取りに行っている最中に、残りを作り直した知らせが 2 件届く。
    refiller.notice({ stationId: 'home', fromMs: 1400, toMs: 1500 })
    refiller.notice({ stationId: 'home', fromMs: 1500, toMs: 1600 })
    await settle()
    // **同じ観測点へ並行して取りに行かない。**
    expect(fetchSamples).toHaveBeenCalledTimes(1)

    release(ok([chunk(1300, 9, 10)]))
    await settle()

    // 2 件はまとめて 1 回で取る。
    expect(fetchSamples).toHaveBeenCalledTimes(2)
    expect(fetchSamples.mock.calls[1]).toEqual([{ stationId: 'home', fromMs: 1400, toMs: 1600 }])
    expect(buffer.holesIn(0, 10_000)).toBeNull()
  })

  it('安全弁: 取得が失敗しても次の知らせでは取りに行く（止まったままにしない）', async () => {
    const buffer = withHole()
    const fetchSamples = vi
      .fn<(p: { stationId: string; fromMs: number; toMs: number }) => Promise<WaveSamplesResult>>()
      .mockResolvedValueOnce({ kind: 'unreachable', detail: 'x' })
      .mockResolvedValueOnce(ok([chunk(1300, 1)]))
    const refiller = new SeismoWaveRefiller({
      bufferOf: () => buffer,
      fetchSamples,
      signal: new AbortController().signal,
      delayMs: 3000,
      onFilled: () => {},
      onSkipped: () => {},
      onError: (_id, e) => { throw e },
    })

    refiller.notice({ stationId: 'home', fromMs: 0, toMs: 10_000 })
    await settle()
    expect(buffer.holesIn(0, 10_000)).not.toBeNull()

    refiller.notice({ stationId: 'home', fromMs: 0, toMs: 10_000 })
    await settle()
    expect(buffer.holesIn(0, 10_000)).toBeNull()
  })

  it('安全弁: 打ち切った後の知らせでは取りに行かない', async () => {
    const buffer = withHole()
    const fetchSamples = vi.fn(async () => ok([chunk(1300)]))
    const ctrl = new AbortController()
    const refiller = new SeismoWaveRefiller({
      bufferOf: () => buffer,
      fetchSamples,
      signal: ctrl.signal,
      delayMs: 3000,
      onFilled: () => {},
      onSkipped: () => {},
      onError: (_id, e) => { throw e },
    })

    ctrl.abort()
    refiller.notice({ stationId: 'home', fromMs: 0, toMs: 10_000 })
    await settle()

    expect(fetchSamples).not.toHaveBeenCalled()
  })
})

describe('SeismoWaveRefiller.schedule', () => {
  /** 10000 ms から 1 まとまりだけ届いた入れ物（起動直後の形）。 */
  function justStarted(retainSec = 60): SeismoWaveBuffer {
    const buffer = new SeismoWaveBuffer(retainSec)
    buffer.push(chunk(10_000))
    return buffer
  }

  function refillerOf(
    buffer: SeismoWaveBuffer,
    fetchSamples: (p: { stationId: string; fromMs: number; toMs: number }) => Promise<WaveSamplesResult>,
    results: { filled: number; prepended: number }[] = [],
    signal: AbortSignal = new AbortController().signal,
  ): SeismoWaveRefiller {
    return new SeismoWaveRefiller({
      bufferOf: (id) => (id === 'home' ? buffer : null),
      fetchSamples,
      signal,
      delayMs: 3000,
      onFilled: (_id, r) => results.push({ filled: r.filled, prepended: r.prepended }),
      onSkipped: () => {},
      onError: (_id, e) => { throw e },
    })
  }

  it('正: 待ってから、抱えている長さの空きぶんだけ最も古いサンプルの手前を取って継ぎ足す', async () => {
    vi.useFakeTimers()
    try {
      // 1 秒しか抱えない入れ物（100 サンプル・空き 70）。**取る長さは入れ物が決める**（60 秒を決め打ちしない）。
      const buffer = justStarted(1)
      const fetchSamples = vi.fn(async () => ok([chunk(9000, 7, 100)]))
      const results: { filled: number; prepended: number }[] = []
      const refiller = refillerOf(buffer, fetchSamples, results)

      refiller.schedule('home', { fromMs: Number.NEGATIVE_INFINITY, toMs: 10_000 })
      await settle()
      expect(fetchSamples).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(3000)
      await settle()

      expect(fetchSamples.mock.calls).toEqual([[{ stationId: 'home', fromMs: 9300, toMs: 10_000 }]])
      expect(results).toEqual([{ filled: 0, prepended: 70 }])
      expect(buffer.snapshot()?.firstSampleMs).toBe(9300)
    } finally {
      vi.useRealTimers()
    }
  })

  it('正: 押し出しの途中にできた穴（ホストの控えにはある）も、待ってから取って埋める', async () => {
    vi.useFakeTimers()
    try {
      const buffer = withHole()
      // 空きで継ぎ足さないよう、範囲は穴の前後だけにする。
      const fetchSamples = vi.fn(async () => ok([chunk(1300, 7)]))
      const results: { filled: number; prepended: number }[] = []
      const refiller = refillerOf(buffer, fetchSamples, results)

      refiller.schedule('home', { fromMs: 1290, toMs: 1600 })
      await vi.advanceTimersByTimeAsync(3000)
      await settle()

      expect(fetchSamples.mock.calls).toEqual([[{ stationId: 'home', fromMs: 1300, toMs: 1600 }]])
      expect(results).toEqual([{ filled: 30, prepended: 0 }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('安全弁: 取りに行っている間に入れ物が作り直されたら、継ぎ足しは見送る（記録へ残す）', async () => {
    vi.useFakeTimers()
    try {
      const buffer = justStarted()
      const skipped: string[] = []
      const fetchSamples = vi.fn(async () => {
        // 取りに行っている最中に、時刻が飛んで起点から作り直された。
        buffer.push(chunk(500_000))
        return ok([chunk(9700, 7)])
      })
      const results: { filled: number; prepended: number }[] = []
      const refiller = new SeismoWaveRefiller({
        bufferOf: (id) => (id === 'home' ? buffer : null),
        fetchSamples,
        signal: new AbortController().signal,
        delayMs: 3000,
        onFilled: (_id, r) => results.push({ filled: r.filled, prepended: r.prepended }),
        onSkipped: (_id, why) => skipped.push(why),
        onError: (_id, e) => { throw e },
      })

      refiller.schedule('home', { fromMs: Number.NEGATIVE_INFINITY, toMs: 10_000 })
      await vi.advanceTimersByTimeAsync(3000)
      await settle()

      expect(fetchSamples).toHaveBeenCalledTimes(1)
      expect(skipped).toEqual(['restarted'])
      expect(results).toEqual([])
      // 作り直した後の入れ物へ、遠い過去の値を穴ごと継ぎ足していない。
      expect(buffer.snapshot()?.firstSampleMs).toBe(500_000)
      expect(buffer.tally.gapSamples).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('対照: 抱える長さが埋まって古い側が押し出されただけなら、穴埋めは見送らない', async () => {
    // 1.5 秒（150 サンプル）しか抱えない入れ物に穴を作り、取りに行っている間に新しいまとまりで
    // 古い側（1000〜1290 ms）だけを押し出す。穴（1300〜1590 ms）は窓に残る。
    const buffer = new SeismoWaveBuffer(1.5)
    buffer.push(chunk(1000))
    buffer.push(chunk(1600))
    buffer.push(chunk(1900))
    const fetchSamples = vi.fn(async () => {
      buffer.push(chunk(2200))
      buffer.push(chunk(2500))
      return ok([chunk(1300, 7)])
    })
    const results: number[] = []
    const refiller = new SeismoWaveRefiller({
      bufferOf: () => buffer,
      fetchSamples,
      signal: new AbortController().signal,
      delayMs: 3000,
      onFilled: (_id, r) => results.push(r.filled),
      onSkipped: (_id, why) => { throw new Error(`見送った: ${why}`) },
      onError: (_id, e) => { throw e },
    })

    refiller.notice({ stationId: 'home', fromMs: 0, toMs: 10_000 })
    await settle()

    expect(results).toEqual([30])
    expect(buffer.holesIn(0, 10_000)).toBeNull()
  })

  it('正: 何もせずに終えた理由を記録へ渡す（入れ物が無い・取る物が無い）', async () => {
    vi.useFakeTimers()
    try {
      const buffer = justStarted(1)
      buffer.prepend([chunk(9300, 0, 70)])
      const skipped: string[] = []
      const fetchSamples = vi.fn(async () => ok([]))
      const refiller = new SeismoWaveRefiller({
        bufferOf: (id) => (id === 'home' ? buffer : null),
        fetchSamples,
        signal: new AbortController().signal,
        delayMs: 3000,
        onFilled: () => {},
        onSkipped: (id, why) => skipped.push(`${id}:${why}`),
        onError: (_id, e) => { throw e },
      })

      refiller.notice({ stationId: 'shed', fromMs: 0, toMs: 10_000 })
      refiller.schedule('home', { fromMs: Number.NEGATIVE_INFINITY, toMs: 10_000 })
      await vi.advanceTimersByTimeAsync(3000)
      await settle()

      expect(fetchSamples).not.toHaveBeenCalled()
      expect(skipped).toEqual(['shed:no-buffer', 'home:nothing-to-do'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('対照: 待っている間に重ねて予約しても、まとめて 1 回だけ取りに行く', async () => {
    vi.useFakeTimers()
    try {
      const buffer = new SeismoWaveBuffer(60)
      buffer.push(chunk(1000))
      buffer.push(chunk(1600))
      buffer.push(chunk(2200))
      const fetchSamples = vi.fn(async () => ok([]))
      const refiller = refillerOf(buffer, fetchSamples)

      refiller.schedule('home', { fromMs: 1290, toMs: 1600 })
      await vi.advanceTimersByTimeAsync(1000)
      refiller.schedule('home', { fromMs: 1890, toMs: 2200 })
      await vi.advanceTimersByTimeAsync(2000)
      await settle()

      // 2 つの穴（1300〜1590・1900〜2190 ms）を覆う 1 回。
      expect(fetchSamples.mock.calls).toEqual([[{ stationId: 'home', fromMs: 1300, toMs: 2200 }]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('対照: 空きも穴も無ければ取りに行かない', async () => {
    vi.useFakeTimers()
    try {
      const buffer = justStarted(1)
      buffer.prepend([chunk(9300, 0, 70)])
      const fetchSamples = vi.fn(async () => ok([]))
      const refiller = refillerOf(buffer, fetchSamples)

      refiller.schedule('home', { fromMs: Number.NEGATIVE_INFINITY, toMs: 10_000 })
      await vi.advanceTimersByTimeAsync(3000)
      await settle()

      expect(fetchSamples).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('安全弁: 待っている間に繋ぎを切ったら取りに行かない', async () => {
    vi.useFakeTimers()
    try {
      const ctrl = new AbortController()
      const fetchSamples = vi.fn(async () => ok([]))
      const refiller = refillerOf(justStarted(), fetchSamples, [], ctrl.signal)

      refiller.schedule('home', { fromMs: Number.NEGATIVE_INFINITY, toMs: 10_000 })
      ctrl.abort()
      await vi.advanceTimersByTimeAsync(3000)
      await settle()

      expect(fetchSamples).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
