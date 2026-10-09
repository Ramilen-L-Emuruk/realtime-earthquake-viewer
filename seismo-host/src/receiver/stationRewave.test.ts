import { describe, expect, it } from 'vitest'

import { parseSensorPacket } from '../protocol/parsePacket'
import type { StoredPacket } from './mseedPacketReader'
import type { StationConfig } from './stationConfig'
import { defaultAxes } from './stationConfigTypes'
import { REWAVE_LEAD_MS, REWAVE_YIELD_EVERY, rewaveStation } from './stationRewave'

/** 2026-10-01 12:30 JST。 */
const T0 = Date.UTC(2026, 9, 1, 3, 30, 0)
const MACS = ['020000000001', '020000000002', '020000000003'] as const
const BOOT = '63c9812e'
const SID = 'i2c0-68'
const PER = 30

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

/** 実機と同じ形の版 2 のパケット（30 サンプル・100 Hz）。 */
function stored(mac: string, q: number, lane: StoredPacket['lane'], rx: number, arrival: number): StoredPacket {
  const header = { v: 2, mac, bid: BOOT, sid: SID, st: 'MPU6050', ch: ['HN1', 'HN2', 'HN3'], ug: 61.0352, fs: 2, hz: 100, t: T0 + q * 10, q, c: PER, o: 0, ack: 1 }
  const rows = Array.from({ length: PER }, (_, i) => `${(q + i) % 7},${-((q + i) % 5)},16384`)
  const read = parseSensorPacket(`${JSON.stringify(header)}\n${rows.join('\n')}\n`)
  if (!read.ok) throw new Error(read.reason)
  return { packet: read.packet, lane, rx, arrival, source: '192.0.2.41:52440', ackRequested: true }
}

/**
 * 3 枚ぶん `seconds` 秒のパケット。`backlogFor` の基板の `[gapFrom, gapTo)` 秒は、取り戻した分
 * （遅れて受け取った）として作る。
 */
function packets(seconds: number, gap: { mac: string; fromSec: number; toSec: number } | null): StoredPacket[] {
  const out: StoredPacket[] = []
  let arrival = 0
  for (let q = 0; q < seconds * 100; q += PER) {
    for (const mac of MACS) {
      const sec = q / 100
      const inGap = gap !== null && mac === gap.mac && sec >= gap.fromSec && sec < gap.toSec
      out.push(stored(mac, q, inGap ? 'backlog' : 'live', T0 + q * 10 + (inGap ? 30_000 : 20), arrival++))
    }
  }
  return out
}

const noPause = (): Promise<void> => Promise.resolve()

/** 区間 `[fromMs, toMs)` の各サンプルに効いた本数。 */
function membersIn(chunks: Awaited<ReturnType<typeof rewaveStation>>['chunks'], fromMs: number, toMs: number): number[] {
  const out: number[] = []
  for (const c of chunks) {
    for (let i = 0; i < c.memberCount.length; i++) {
      const t = c.firstSampleMs + i * c.msPerSample
      if (t >= fromMs && t < toMs) out.push(c.memberCount[i]!)
    }
  }
  return out
}

describe('rewaveStation', () => {
  const FROM = T0 + REWAVE_LEAD_MS
  const TO = FROM + 3_000

  it('正: 取り戻した分も流すので、ライブで欠けた区間も全員が効いた合成になる', async () => {
    const r = await rewaveStation({
      stationId: 'station-1', fromMs: FROM, toMs: TO,
      packets: packets(70, { mac: MACS[1], fromSec: 60, toSec: 63 }), config: config(),
    }, noPause)
    const members = membersIn(r.chunks, FROM + 50, TO - 50)
    expect(members.length).toBeGreaterThan(250)
    expect(members.every((m) => m === 3)).toBe(true)
  })

  it('対照: 欠けた分が生データに無ければ、その区間は効いた本数が減ったまま', async () => {
    const all = packets(70, { mac: MACS[1], fromSec: 60, toSec: 63 })
    const r = await rewaveStation({
      stationId: 'station-1', fromMs: FROM, toMs: TO,
      packets: all.filter((p) => p.lane === 'live'), config: config(),
    }, noPause)
    const members = membersIn(r.chunks, FROM + 700, TO - 700)
    expect(members.length).toBeGreaterThan(100)
    expect(members.every((m) => m < 3)).toBe(true)
  })

  it('安全弁: 区間に掛からないまとまり・別の観測点のまとまりは返さない', async () => {
    const r = await rewaveStation({
      stationId: 'station-1', fromMs: FROM, toMs: TO, packets: packets(70, null), config: config(),
    }, noPause)
    expect(r.chunks.length).toBeGreaterThan(0)
    for (const c of r.chunks) {
      expect(c.stationId).toBe('station-1')
      const last = c.firstSampleMs + (c.gal[0].length - 1) * c.msPerSample
      expect(last >= FROM && c.firstSampleMs < TO).toBe(true)
    }
    const other = await rewaveStation({
      stationId: 'station-2', fromMs: FROM, toMs: TO, packets: packets(70, null), config: config(),
    }, noPause)
    expect(other.chunks).toEqual([])
  })

  it('安全弁: 同じまとまりが 2 度入っていたら 1 度だけ流し、捨てた数を返す', async () => {
    const base = packets(65, null)
    const twice = [...base, ...base.slice(0, 10).map((p) => ({ ...p, lane: 'backlog' as const }))]
    const r = await rewaveStation({ stationId: 'station-1', fromMs: FROM, toMs: TO, packets: twice, config: config() }, noPause)
    expect(r.duplicates).toBe(10)
    expect(r.fed).toBe(base.length)
  })

  it('正: 決まった数を流すごとに順番を譲る（受信の流れを止め続けない）', async () => {
    let paused = 0
    const input = packets(70, null)
    const r = await rewaveStation({ stationId: 'station-1', fromMs: FROM, toMs: TO, packets: input, config: config() }, async () => {
      paused += 1
    })
    expect(paused).toBe(Math.floor((r.fed - 1) / REWAVE_YIELD_EVERY))
    expect(paused).toBeGreaterThan(0)
  })
})
