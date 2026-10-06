import { describe, expect, it } from 'vitest'

import type { SensorPacket } from '../protocol/types'
import { readMseed3Records } from './mseed3Reader'
import { ReceptionLog, unreadableRecord } from './receptionLog'
import type { LogRecord, ReceivedPacket } from './receptionLog'

/** 2026-10-01 12:30 JST。 */
const T = Date.UTC(2026, 9, 1, 3, 30, 0)
const HOUR = 3_600_000

function pkt(over: Partial<SensorPacket> = {}): SensorPacket {
  return {
    version: 2,
    boardKey: 'mac:020000000001',
    bootId: '63c9812e',
    sensorId: 'i2c0-68',
    sensorType: 'MPU6050',
    channels: ['HN1', 'HN2', 'HN3'],
    ugPerLsb: 61.0352,
    fullScaleG: 2,
    sampleRateHz: 100,
    firstSampleMs: T,
    firstSeq: 0,
    overflowCount: 0,
    samples: Array.from({ length: 30 }, () => [0, 0, 0]),
    ...over,
  }
}

function rec(over: Partial<ReceivedPacket> & { packet: SensorPacket }): ReceivedPacket {
  return {
    lane: 'live',
    rx: over.packet.firstSampleMs + 300,
    arrival: 0,
    at: over.packet.firstSampleMs + 300,
    source: '192.0.2.41:1',
    ackRequested: true,
    ...over,
  }
}

/** k 番目のパケット（30 サンプル・300 ms ごと）。 */
function nth(k: number, over: Partial<SensorPacket> = {}): SensorPacket {
  return pkt({ firstSeq: k * 30, firstSampleMs: T + k * 300, ...over })
}

function body(r: LogRecord): Record<string, unknown> {
  const [record] = readMseed3Records(r.bytes).records
  expect(record!.encoding).toBe(0)
  expect(record!.sampleRateHz).toBe(0)
  expect(record!.sourceId).toBe('FDSN:XX_00000001_I2C0-68_L_O_G')
  return JSON.parse(record!.text!) as Record<string, unknown>
}

describe('ReceptionLog', () => {
  it('続いて届いたパケットを 1 本にまとめ、差分で詰める', () => {
    const log = new ReceptionLog()
    log.push(rec({ packet: nth(0), arrival: 7 }))
    // 名乗った時刻が外挿より 2 ms 遅い・受け取りが 350 ms 後・間に別のセンサーが 2 つ・FIFO が 1 回あふれた。
    log.push(rec({ packet: nth(1, { firstSampleMs: T + 302, overflowCount: 1 }), rx: T + 650, arrival: 10, at: T + 650 }))
    // 番号が 30 飛んだ（取りこぼし）。
    log.push(rec({ packet: nth(3, { overflowCount: 1 }), rx: T + 1_200, arrival: 11, at: T + 1_200 }))
    const [r] = log.flushAll()
    expect(r!.packetCount).toBe(3)
    expect(body(r!)).toMatchObject({ seq: 0, time: T, received: T + 300, arrival: 7, overflow: 0 })
    expect(body(r!).packets).toEqual([
      [0, 30, 0, 0, 0, 0],
      [0, 30, 2, 350, 3, 1],
      [30, 30, 298, 550, 1, 0],
    ])
  })

  it('差分を前から足し直すと、元の番号・時刻・受け取った時刻・受付番号に戻る', () => {
    const log = new ReceptionLog()
    const sent = [0, 1, 2, 5, 6].map((k) =>
      rec({ packet: nth(k, { firstSampleMs: T + k * 300 + (k % 2) }), rx: T + k * 333, arrival: 100 + k * 3, at: T + k * 333 }),
    )
    for (const s of sent) log.push(s)
    const b = body(log.flushAll()[0]!)
    let q = b.seq as number
    let t = b.time as number
    let rx = b.received as number
    let n = b.arrival as number
    let c = 0
    const back = (b.packets as number[][]).map(([dq, cc, dt, drx, dn], i) => {
      if (i > 0) {
        q = q + c + dq!
        t = t + c * 10 + dt!
        rx = rx + drx!
        n = n + dn!
      }
      c = cc!
      return { q, t, rx, n }
    })
    expect(back).toEqual(sent.map((s) => ({ q: s.packet.firstSeq, t: s.packet.firstSampleMs, rx: s.rx, n: s.arrival })))
  })

  it('固定の値（換算係数・送信元・返事の要否）が変わったら切る', () => {
    const log = new ReceptionLog()
    log.push(rec({ packet: nth(0) }))
    expect(log.push(rec({ packet: nth(1, { ugPerLsb: 122.07 }) }))).toHaveLength(1)
    expect(log.push(rec({ packet: nth(2, { ugPerLsb: 122.07 }), source: '192.0.2.41:2' }))).toHaveLength(1)
    expect(log.push(rec({ packet: nth(3, { ugPerLsb: 122.07 }), source: '192.0.2.41:2', ackRequested: false }))).toHaveLength(1)
    // 同じ値が続く間は切らない（対照）。
    expect(log.push(rec({ packet: nth(4, { ugPerLsb: 122.07 }), source: '192.0.2.41:2', ackRequested: false }))).toHaveLength(0)
  })

  it('次の正時を越えたら切る（パケットが名乗る時刻で測る）', () => {
    const log = new ReceptionLog()
    const top = Math.ceil(T / HOUR) * HOUR
    log.push(rec({ packet: pkt({ firstSampleMs: top - 300 }) }))
    const out = log.push(rec({ packet: pkt({ firstSeq: 30, firstSampleMs: top }) }))
    expect(out).toHaveLength(1)
    expect(out[0]!.fileAtMs).toBe(top - 300)
    expect(log.flushAll()[0]!.fileAtMs).toBe(top)
  })

  it('区間が上限に達したら切る・パケット数が上限に達したら切る', () => {
    const byTime = new ReceptionLog({ maxHoldMs: 900 })
    byTime.push(rec({ packet: nth(0) }))
    byTime.push(rec({ packet: nth(1) }))
    expect(byTime.push(rec({ packet: nth(2) }))).toHaveLength(1)
    const byCount = new ReceptionLog({ maxPackets: 2 })
    byCount.push(rec({ packet: nth(0) }))
    expect(byCount.push(rec({ packet: nth(1) }))[0]!.packetCount).toBe(2)
  })

  it('受け取ってから上限の時間、次が来なければ書き出す', () => {
    const log = new ReceptionLog({ maxHoldMs: 30_000 })
    log.push(rec({ packet: nth(0), at: T }))
    expect(log.tick(T + 29_999)).toHaveLength(0)
    expect(log.tick(T + 30_000)).toHaveLength(1)
    expect(log.bufferedPackets).toBe(0)
  })

  it('届き方・起動ごとに別の流れにする', () => {
    const log = new ReceptionLog()
    log.push(rec({ packet: nth(0) }))
    // 取り戻した分は、届いたその場で 1 本になって出る（下の「正」）。
    const recovered = log.push(rec({ packet: nth(0), lane: 'backlog' }))
    log.push(rec({ packet: nth(0, { bootId: 'ffffffff' }) }))
    const lanes = [...recovered, ...log.flushAll()].map((r) => [body(r).lane, body(r).boot])
    expect(lanes).toEqual([
      ['backlog', '63c9812e'],
      ['live', '63c9812e'],
      ['live', 'ffffffff'],
    ])
  })

  it('正: 取り戻した分は溜めずに、パケット 1 つで 1 本にして返す', () => {
    // 書けたかをその場で確かめて欠けを外すため（`backlogFetcher.ts`）。
    const log = new ReceptionLog()
    const first = log.push(rec({ packet: nth(0), lane: 'backlog' }))
    const second = log.push(rec({ packet: nth(1), lane: 'backlog' }))
    expect(first.map((r) => r.packetCount)).toEqual([1])
    expect(second.map((r) => r.packetCount)).toEqual([1])
    // 1 本ごとに先頭から書き直す（前のパケットからの差分にしない）—— 1 本だけ書けなくても、
    // 残りの 1 本が単独で読める。
    expect(body(second[0]!)).toMatchObject({ lane: 'backlog', seq: 30, time: T + 300 })
    expect(body(second[0]!).packets).toEqual([[0, 30, 0, 0, 0, 0]])
    expect(log.bufferedPackets).toBe(0)
  })

  it('対照: いま届いた分は従来どおり溜める', () => {
    const log = new ReceptionLog()
    expect(log.push(rec({ packet: nth(0) }))).toHaveLength(0)
    expect(log.push(rec({ packet: nth(1) }))).toHaveLength(0)
    expect(log.bufferedPackets).toBe(2)
  })
})

describe('unreadableRecord', () => {
  it('ホストの受信の記録へ、中身を丸ごと 1 件 1 本で残す', () => {
    const r = unreadableRecord({ rx: T, arrival: 42, fileAtMs: T, source: 'a', lane: 'live', why: 'header-unreadable', raw: 'x\ny' })
    const [record] = readMseed3Records(r.bytes).records
    expect(record!.sourceId).toBe('FDSN:XX_HOST__L_O_G')
    expect(JSON.parse(record!.text!)).toEqual({
      received: T,
      arrival: 42,
      source: 'a',
      lane: 'live',
      why: 'header-unreadable',
      raw: 'x\ny',
    })
  })
})
