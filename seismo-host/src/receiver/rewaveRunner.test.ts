import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MseedRecorder } from './mseedRecorder'
import { mseedFilePath } from './mseedStore'
import type { RewaveEvent } from './rewaveRunner'
import { RewaveRunner, withCurrentNoiseDensity } from './rewaveRunner'
import { RewaveScheduler } from './rewaveScheduler'
import type { FusedWaveChunk } from './sensorFusion'
import type { StationConfig } from './stationConfig'
import { defaultAxes } from './stationConfigTypes'
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
  const entry = { sensorId: SID, enabled: true, axes: defaultAxes(3), noiseDensity: null }
  return {
    stations: [{ stationId: 'station-1', displayName: '観測点', lat: 35, lon: 135 }],
    boards: MACS.map((mac) => ({ boardKey: `mac:${mac}`, stationId: 'station-1', orientation: IDENTITY, sensors: [entry] })),
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

function harness(recorder: MseedRecorder, over: { config?: StationConfig | 'changed' | null; flushOk?: boolean; current?: StationConfig } = {}) {
  const seen: Array<[number, number]> = []
  let currentAsked = 0
  const scheduler = new RewaveScheduler({ padMs: 0, settleMs: 0, maxWaitMs: 10_000, maxSpanMs: 180_000 })
  const written: FusedWaveChunk[] = []
  const events: RewaveEvent[] = []
  const runner = new RewaveRunner({
    scheduler,
    configThrough: (fromMs, toMs) => {
      seen.push([fromMs, toMs])
      return over.config === undefined ? config() : over.config
    },
    currentConfig: () => {
      currentAsked += 1
      return over.current ?? config()
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
  return { scheduler, runner, written, events, seen, currentAsked: () => currentAsked }
}

describe('withCurrentNoiseDensity', () => {
  function withNoise(nd: (mac: string) => number | null): StationConfig {
    const base = config()
    return {
      ...base,
      boards: base.boards.map((b) => ({ ...b, sensors: b.sensors.map((s) => ({ ...s, noiseDensity: nd(b.boardKey) })) })),
    }
  }

  it('正: ノイズ密度だけをいまの設定から取る（当時は未設定でも）', () => {
    const historical = withNoise(() => null)
    const current = withNoise((mac) => (mac.endsWith('01') ? 15 : 270))
    const out = withCurrentNoiseDensity(historical, current)
    expect(out.boards.map((b) => b.sensors[0]!.noiseDensity)).toEqual([15, 270, 270])
  })

  it('対照: ノイズ密度以外（軸の向き・ゼロ点・有効かどうか・基板の向き）は当時のまま', () => {
    const historical = withNoise(() => null)
    const altered: StationConfig = {
      ...historical,
      boards: historical.boards.map((b) => ({
        ...b,
        orientation: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]],
        sensors: b.sensors.map((s) => ({ ...s, enabled: false, axes: defaultAxes(2), noiseDensity: 15 })),
      })),
    }
    const out = withCurrentNoiseDensity(historical, altered)
    for (let i = 0; i < out.boards.length; i++) {
      expect(out.boards[i]!.orientation).toBe(historical.boards[i]!.orientation)
      expect(out.boards[i]!.sensors[0]!.axes).toBe(historical.boards[i]!.sensors[0]!.axes)
      expect(out.boards[i]!.sensors[0]!.enabled).toBe(true)
      expect(out.boards[i]!.sensors[0]!.noiseDensity).toBe(15)
    }
  })

  it('安全弁: いまの設定に無いセンサーは当時の値のまま（外した台の重みを推し量らない）', () => {
    const historical = withNoise(() => 99)
    const current: StationConfig = { ...config(), boards: config().boards.slice(0, 1).map((b) => ({ ...b, sensors: b.sensors.map((s) => ({ ...s, noiseDensity: 15 })) })) }
    const out = withCurrentNoiseDensity(historical, current)
    expect(out.boards.map((b) => b.sensors[0]!.noiseDensity)).toEqual([15, 99, 99])
  })
})

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
    // 設定は助走から後ろの余白までを通して訊く（読む範囲は半開区間なので、照合はその終わりの 1 ミリ秒手前まで）。
    expect(h.seen).toEqual([[FROM - REWAVE_LEAD_MS, TO + REWAVE_TAIL_MS - 1]])
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

  it('正: 依頼された作り直し（noiseDensity: current）は、いまの設定を読んで重ねる', async () => {
    const recorder = await writeRaw()
    const h = harness(recorder)
    expect(h.scheduler.request('station-1', [{ fromMs: FROM, toMs: TO }], 'current')).toBe(true)
    h.runner.tick()
    await h.runner.stop()
    expect(h.events.map((e) => e.kind)).toEqual(['rewaved'])
    expect(h.currentAsked()).toBe(1)
    // いまの設定も未設定のまま（config() は全員 null）なので、未設定の数が載る。
    expect(h.events[0]).toMatchObject({ kind: 'rewaved', unsetNoiseDensity: 3, job: { origin: 'requested' } })
    // 依頼の分は別にも数える。
    expect(h.runner.snapshot()).toMatchObject({ jobs: 1, requested: { jobs: 1, skipped: {} } })
    await recorder.close()
  })

  it('正: いまの設定に全員のノイズ密度があれば、重ねた作り直しに未設定は残らない', async () => {
    const recorder = await writeRaw()
    const base = config()
    const current: StationConfig = {
      ...base,
      boards: base.boards.map((b) => ({ ...b, sensors: b.sensors.map((s) => ({ ...s, noiseDensity: 270 })) })),
    }
    const h = harness(recorder, { current })
    h.scheduler.request('station-1', [{ fromMs: FROM, toMs: TO }], 'current')
    h.runner.tick()
    await h.runner.stop()
    expect(h.events[0]).toMatchObject({ kind: 'rewaved', unsetNoiseDensity: 0 })
    await recorder.close()
  })

  it('対照: 取り戻した区間の作り直しは、いまの設定を読まない（当時の設定だけで組む）', async () => {
    const recorder = await writeRaw()
    const h = harness(recorder)
    h.scheduler.note('station-1', FROM, TO, T0)
    h.runner.tick()
    await h.runner.stop()
    expect(h.events.map((e) => e.kind)).toEqual(['rewaved'])
    expect(h.currentAsked()).toBe(0)
    // 取り戻しの分は依頼の数へ混ぜない。
    expect(h.runner.snapshot()).toMatchObject({ jobs: 1, requested: { jobs: 0, skipped: {} } })
    await recorder.close()
  })

  it('安全弁: 依頼の分が飛んだら、依頼の分の理由ごとの数にも載る', async () => {
    const recorder = await writeRaw()
    const h = harness(recorder)
    const day = 24 * 3_600_000
    h.scheduler.request('station-1', [{ fromMs: FROM + day, toMs: TO + day }], 'current')
    h.runner.tick()
    await h.runner.stop()
    expect(h.runner.snapshot().skipped).toEqual({ 'no-raw': 1 })
    expect(h.runner.snapshot().requested).toEqual({ jobs: 0, skipped: { 'no-raw': 1 } })
    await recorder.close()
  })

  it('対照: 取り戻しの分が飛んでも、依頼の分の数には載らない', async () => {
    const recorder = await writeRaw()
    const h = harness(recorder)
    const day = 24 * 3_600_000
    h.scheduler.note('station-1', FROM + day, TO + day, T0)
    h.runner.tick()
    await h.runner.stop()
    expect(h.runner.snapshot().skipped).toEqual({ 'no-raw': 1 })
    expect(h.runner.snapshot().requested).toEqual({ jobs: 0, skipped: {} })
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
