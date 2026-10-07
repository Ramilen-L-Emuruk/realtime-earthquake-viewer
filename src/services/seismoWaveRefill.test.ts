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
      onFilled: (_id, n) => filled.push(n),
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
      onFilled: () => {},
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
      onFilled: () => {},
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
      onFilled: () => {},
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
      onFilled: () => {},
      onError: (_id, e) => { throw e },
    })

    ctrl.abort()
    refiller.notice({ stationId: 'home', fromMs: 0, toMs: 10_000 })
    await settle()

    expect(fetchSamples).not.toHaveBeenCalled()
  })
})
