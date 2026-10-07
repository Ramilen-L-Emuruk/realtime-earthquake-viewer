import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MseedRecorder } from './mseedRecorder'
import { mseedFilePath } from './mseedStore'
import type { RewaveEvent } from './rewaveRunner'
import { RewaveRunner } from './rewaveRunner'
import { RewaveScheduler } from './rewaveScheduler'
import type { FusedWaveChunk } from './sensorFusion'
import type { StationConfig } from './stationConfig'
import { REWAVE_LEAD_MS, REWAVE_TAIL_MS } from './stationRewave'

/** 2026-10-01 12:30 JST。 */
const T0 = Date.UTC(2026, 9, 1, 3, 30, 0)
const MACS = ['020000000001', '020000000002', '020000000003'] as const
const SID = 'i2c0-68'
const IDENTITY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const

function config(): StationConfig {
  const entry = { sensorId: SID, enabled: true, rotation: IDENTITY, offset: [0, 0, 0] as const, sensitivity: [1, 1, 1] as const, noiseDensity: null }
  return {
    stations: [{ stationId: 'station-1', displayName: '観測点', lat: 35, lon: 135 }],
    boards: MACS.map((mac) => ({ boardKey: `mac:${mac}`, stationId: 'station-1', sensors: [entry] })),
  }
}

function payload(mac: string, q: number): string {
  const header = { v: 2, mac, bid: '63c9812e', sid: SID, st: 'MPU6050', ch: ['HN1', 'HN2', 'HN3'], ug: 61.0352, fs: 2, hz: 100, t: T0 + q * 10, q, c: 30, o: 0, ack: 1 }
  const rows = Array.from({ length: 30 }, (_, i) => `${(q + i) % 7},${-((q + i) % 5)},16384`)
  return `${JSON.stringify(header)}\n${rows.join('\n')}\n`
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rewave-runner-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * 3 枚で 70 秒ぶんを生データへ残す。2 枚目の 60〜63 秒はライブでは届かず、あとで取り戻した形にする。
 */
async function writeRaw(): Promise<MseedRecorder> {
  let now = T0
  const recorder = new MseedRecorder({ dir, now: () => now })
  const missed: string[] = []
  for (let q = 0; q < 7_000; q += 30) {
    now = T0 + q * 10 + 20
    for (const mac of MACS) {
      const sec = q / 100
      if (mac === MACS[1] && sec >= 60 && sec < 63) missed.push(payload(mac, q))
      else recorder.accept('192.0.2.41:52440', payload(mac, q), now)
    }
    recorder.tick(now)
  }
  for (const p of missed) await recorder.acceptRecovered('192.0.2.42:52440', p, now)
  return recorder
}

function harness(recorder: MseedRecorder, over: { config?: StationConfig | 'changed' | null; flushOk?: boolean } = {}) {
  const seen: Array<[number, number]> = []
  const scheduler = new RewaveScheduler({ padMs: 0, settleMs: 0, maxWaitMs: 300_000, maxSpanMs: 180_000 })
  const written: FusedWaveChunk[] = []
  const events: RewaveEvent[] = []
  const runner = new RewaveRunner({
    scheduler,
    hasPending: () => false,
    configThrough: (fromMs, toMs) => {
      seen.push([fromMs, toMs])
      return over.config === undefined ? config() : over.config
    },
    flush: async () => (over.flushOk === false ? false : recorder.flushForRead()),
    readHour: async (at) => {
      const path = mseedFilePath(dir, at)
      try {
        return path === null ? null : new Uint8Array(readFileSync(path))
      } catch {
        return null
      }
    },
    writeRevised: async (_stationId, chunks) => {
      written.push(...chunks)
      return { written: chunks.length, lost: 0, bad: 0 }
    },
    now: () => T0 + 120_000,
    pause: () => Promise.resolve(),
    onEvent: (e) => events.push(e),
  })
  return { scheduler, runner, written, events, seen }
}

describe('RewaveRunner', () => {
  const FROM = T0 + 60_000
  const TO = T0 + 63_000

  it('正: 取り戻した区間を生データから作り直し、全員が効いた合成を控えへ足す', async () => {
    const recorder = await writeRaw()
    const h = harness(recorder)
    h.scheduler.note('station-1', FROM, TO, T0)
    h.runner.tick()
    await h.runner.stop()
    expect(h.events.map((e) => e.kind)).toEqual(['rewaved'])
    const inWindow = h.written.flatMap((c) =>
      Array.from(c.memberCount).filter((_, i) => {
        const t = c.firstSampleMs + i * c.msPerSample
        return t >= FROM + 50 && t < TO - 50
      }),
    )
    expect(inWindow.length).toBeGreaterThan(250)
    expect(inWindow.every((m) => m === 3)).toBe(true)
    expect(h.runner.snapshot()).toMatchObject({ jobs: 1, skipped: {}, running: false, waiting: 0, rawIssues: 0 })
    // 設定は助走から後ろの余白までを通して訊く。
    expect(h.seen).toEqual([[FROM - REWAVE_LEAD_MS, TO + REWAVE_TAIL_MS]])
    await recorder.close()
  })

  it('安全弁: 生データの書き手が溜めた分を書き終えられなければ、作り直さない', async () => {
    const recorder = await writeRaw()
    const h = harness(recorder, { flushOk: false })
    h.scheduler.note('station-1', FROM, TO, T0)
    h.runner.tick()
    await h.runner.stop()
    expect(h.written).toEqual([])
    expect(h.runner.snapshot().skipped).toEqual({ 'flush-failed': 1 })
    await recorder.close()
  })

  it('安全弁: 区間の中で設定が変わっていたら、作り直さない', async () => {
    const recorder = await writeRaw()
    const h = harness(recorder, { config: 'changed' })
    h.scheduler.note('station-1', FROM, TO, T0)
    h.runner.tick()
    await h.runner.stop()
    expect(h.written).toEqual([])
    expect(h.runner.snapshot().skipped).toEqual({ 'config-changed': 1 })
    await recorder.close()
  })

  it('安全弁: 設定の履歴を読めていなければ、いまの設定で代わりに作らない', async () => {
    const recorder = await writeRaw()
    const h = harness(recorder, { config: null })
    h.scheduler.note('station-1', FROM, TO, T0)
    h.runner.tick()
    await h.runner.stop()
    expect(h.written).toEqual([])
    expect(h.runner.snapshot().skipped).toEqual({ 'config-unknown': 1 })
    await recorder.close()
  })

  it('対照: 生データの時の本が無ければ「無い」として数える（作ったことにしない）', async () => {
    const recorder = await writeRaw()
    const h = harness(recorder)
    h.scheduler.note('station-1', FROM + 24 * 3_600_000, TO + 24 * 3_600_000, T0)
    h.runner.tick()
    await h.runner.stop()
    expect(h.runner.snapshot().skipped).toEqual({ 'no-raw': 1 })
    await recorder.close()
  })

  it('安全弁: 止めたあとは新しく始めない', async () => {
    const recorder = await writeRaw()
    const h = harness(recorder)
    await h.runner.stop()
    h.scheduler.note('station-1', FROM, TO, T0)
    h.runner.tick()
    expect(h.runner.snapshot().running).toBe(false)
    expect(h.runner.snapshot().waiting).toBe(1)
    await recorder.close()
  })
})
