import { describe, expect, it } from 'vitest'

import { MSEED3_HOST_LOG_SOURCE_ID, buildMseed3Record, buildMseed3TextRecord, mseed3LogSourceId, mseed3SourceId } from './mseed3Record'
import type { FusedWaveChunk } from './sensorFusion'
import { encodeSteim2 } from './steim2'
import { encodeWaveChunk } from './waveArchive'
import { SUMMARY_FINE_MS, type SummaryChannel } from './waveSummary'
import { stationWaveChannelId, summarizeMseedHour, summarizeWaveHour } from './waveSummarySources'

const HOUR_START = Date.parse('2026-10-07T03:00:00.000Z')
const BOARD = 'mac:02000000a1b2'
const SENSOR = 'S1'

function channel(file: { channels: readonly SummaryChannel[] }, id: string): SummaryChannel {
  const c = file.channels.find((ch) => ch.id === id)
  if (c === undefined) throw new Error(`channel ${id} が無い（${file.channels.map((x) => x.id).join(', ')}）`)
  return c
}

function waveRecord(channelCode: string, startMs: number, samples: number[], rateHz = 100): Uint8Array {
  const sid = mseed3SourceId(BOARD, SENSOR, channelCode)!
  const block = encodeSteim2(Int32Array.from(samples), 7)
  expect(block.sampleCount).toBe(samples.length)
  return buildMseed3Record({ sourceId: sid, startMs, sampleRateHz: rateHz, block })
}

function logRecord(startMs: number, body: Record<string, unknown>): Uint8Array {
  return buildMseed3TextRecord({ sourceId: mseed3LogSourceId(BOARD, SENSOR)!, startMs, text: JSON.stringify(body) })
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

describe('summarizeMseedHour', () => {
  it('波形のレコードをチャンネルごとに要約し、受信の記録から分解能を引く', () => {
    const buf = concat([
      logRecord(HOUR_START, { board: BOARD, sensor: SENSOR, channels: ['HNX', 'HNZ'], ugPerLsb: 61.0352 }),
      waveRecord('HNX', HOUR_START, new Array(100).fill(0).map((_, i) => i % 3)),
      waveRecord('HNZ', HOUR_START, new Array(100).fill(16384)),
      waveRecord('HNX', HOUR_START + 1000, new Array(50).fill(7)),
    ])
    const file = summarizeMseedHour(buf, HOUR_START)

    expect(file.sourceBytes).toBe(buf.length)
    expect(file.sourceProblems).toEqual({ skippedBytes: 0, badRecords: 0 })
    const x = channel(file, mseed3SourceId(BOARD, SENSOR, 'HNX')!)
    expect(x.unit).toBe('count')
    expect(x.ugPerLsb).toBe(61.0352)
    expect(x.fine.firstBucket).toBe(HOUR_START / SUMMARY_FINE_MS)
    expect(Array.from(x.fine.n)).toEqual([100, 50])
    expect(x.fine.max[0]).toBe(2)
    expect(x.fine.min[1]).toBe(7)
    const z = channel(file, mseed3SourceId(BOARD, SENSOR, 'HNZ')!)
    expect(z.fine.mean[0]).toBe(16384)
    // 受信の記録そのものはチャンネルにしない
    expect(file.channels.map((c) => c.id).some((id) => id.endsWith('L_O_G'))).toBe(false)
  })

  it('受信の記録が無いチャンネルも、分解能の分からないカウントとして要約する', () => {
    const buf = waveRecord('HNY', HOUR_START, [1, 2, 3])
    const y = channel(summarizeMseedHour(buf, HOUR_START), mseed3SourceId(BOARD, SENSOR, 'HNY')!)
    expect(y.unit).toBe('count')
    expect(y.ugPerLsb).toBeNull()
  })

  it('読めない受信の記録・ホストの受信の記録は要約に入れず、投げない', () => {
    const buf = concat([
      buildMseed3TextRecord({ sourceId: mseed3LogSourceId(BOARD, SENSOR)!, startMs: HOUR_START, text: '{壊れた' }),
      buildMseed3TextRecord({ sourceId: MSEED3_HOST_LOG_SOURCE_ID, startMs: HOUR_START, text: JSON.stringify({ why: 'bad' }) }),
      waveRecord('HNX', HOUR_START, [5]),
    ])
    const file = summarizeMseedHour(buf, HOUR_START)
    expect(file.channels).toHaveLength(1)
    expect(file.channels[0]!.ugPerLsb).toBeNull()
  })

  it('検査値が合わないレコードと、作りかけの末尾を不調として数える', () => {
    const good = waveRecord('HNX', HOUR_START, [1, 2, 3])
    const broken = waveRecord('HNX', HOUR_START + 1000, [4, 5, 6])
    broken[broken.length - 1] ^= 0xff // データ部を壊す（検査値が合わなくなる）
    const tail = waveRecord('HNX', HOUR_START + 2000, [7]).subarray(0, 30)
    const file = summarizeMseedHour(concat([good, broken, tail]), HOUR_START)
    expect(file.sourceProblems.badRecords).toBe(1)
    expect(file.sourceProblems.skippedBytes).toBe(30)
    expect(Array.from(channel(file, mseed3SourceId(BOARD, SENSOR, 'HNX')!).fine.n)).toEqual([3])
  })

  it('時計が合う前の時刻（1970 年）のレコードは要約へ入れずに数える', () => {
    const buf = concat([waveRecord('HNX', 5000, [1, 2]), waveRecord('HNX', HOUR_START, [3])])
    const file = summarizeMseedHour(buf, HOUR_START)
    expect(file.outOfWindowSamples).toBe(2)
    expect(Array.from(channel(file, mseed3SourceId(BOARD, SENSOR, 'HNX')!).fine.n)).toEqual([1])
  })
})

function fused(params: { firstSampleMs: number; ns: number[]; ew?: number[]; ud?: number[] }): FusedWaveChunk {
  const n = params.ns.length
  return {
    stationId: 'home',
    firstSampleIndex: 0,
    firstSampleMs: params.firstSampleMs,
    msPerSample: 10,
    gal: [params.ns, params.ew ?? params.ns, params.ud ?? params.ns],
    dcGal: [new Array(n).fill(0), new Array(n).fill(0), new Array(n).fill(980)],
    memberCount: new Array(n).fill(3),
  } as unknown as FusedWaveChunk
}

describe('summarizeWaveHour', () => {
  it('合成波形を 3 成分のチャンネルとして gal で要約する', () => {
    const buf = Buffer.concat([
      encodeWaveChunk(fused({ firstSampleMs: HOUR_START, ns: [1, 2, 3], ew: [4, 5, 6], ud: [-1, 0, 1] }), false)!,
    ])
    const file = summarizeWaveHour(buf, 'home', HOUR_START)
    expect(file.sourceBytes).toBe(buf.length)
    expect(file.channels.map((c) => c.id).sort()).toEqual(
      [stationWaveChannelId('home', 0), stationWaveChannelId('home', 1), stationWaveChannelId('home', 2)].sort(),
    )
    const ns = channel(file, stationWaveChannelId('home', 0))
    expect(ns.unit).toBe('gal')
    expect(ns.ugPerLsb).toBeNull()
    expect(ns.fine.max[0]).toBe(3)
    expect(channel(file, stationWaveChannelId('home', 1)).fine.min[0]).toBe(4)
  })

  it('作り直した分（印付き）が重なるライブの分より優先される', () => {
    const buf = Buffer.concat([
      encodeWaveChunk(fused({ firstSampleMs: HOUR_START, ns: [100, 100, 100] }), false)!,
      encodeWaveChunk(fused({ firstSampleMs: HOUR_START, ns: [1, 1, 1] }), true)!,
    ])
    const ns = channel(summarizeWaveHour(buf, 'home', HOUR_START), stationWaveChannelId('home', 0))
    expect(Array.from(ns.fine.n)).toEqual([3])
    expect(ns.fine.max[0]).toBe(1)
  })

  it('途中で切れた末尾を不調として数える', () => {
    const whole = encodeWaveChunk(fused({ firstSampleMs: HOUR_START, ns: [1, 2, 3] }), false)!
    const buf = Buffer.concat([whole, whole.subarray(0, 10)])
    expect(summarizeWaveHour(buf, 'home', HOUR_START).sourceProblems.skippedBytes).toBe(10)
  })

  it('観測点の識別子に区切り文字が入っていても、向きまで読み戻せる', () => {
    expect(stationWaveChannelId('a/b', 2)).toBe('station/a/b/Z')
  })
})
