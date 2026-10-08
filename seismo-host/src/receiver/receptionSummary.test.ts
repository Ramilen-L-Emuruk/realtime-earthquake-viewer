import { describe, expect, it } from 'vitest'

import { MSEED3_HOST_LOG_SOURCE_ID, buildMseed3Record, buildMseed3TextRecord, mseed3SourceId } from './mseed3Record'
import { readMseed3Records } from './mseed3Reader'
import {
  UNREADABLE_ITEMS_MAX,
  decodeReceptionSummary,
  encodeReceptionSummary,
  mergeSpans,
  sensorOfSourceId,
  summarizeReception,
} from './receptionSummary'
import { encodeSteim2 } from './steim2'

const BOARD = 'mac:02000000a1b2'
const T0 = Date.parse('2026-10-07T03:00:00.000Z')

function wave(ch: string, startMs: number, n: number, lane: 'live' | 'backlog' | 'late', questionable = false): Uint8Array {
  const mark = lane === 'backlog' ? { r: 1 } : lane === 'late' ? { l: 1 } : {}
  return buildMseed3Record({
    sourceId: mseed3SourceId(BOARD, 'S1', ch)!,
    startMs,
    sampleRateHz: 100,
    block: encodeSteim2(Int32Array.from({ length: n }, () => 1), 7),
    extraHeaders: JSON.stringify({ Seismo: { b: 'boot', q: 0, ...mark } }),
    timeQuestionable: questionable,
  })
}

function hostLog(atMs: number, body: string): Uint8Array {
  return buildMseed3TextRecord({ sourceId: MSEED3_HOST_LOG_SOURCE_ID, startMs: atMs, text: body })
}

function summarize(parts: Uint8Array[]) {
  const buf = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let at = 0
  for (const p of parts) {
    buf.set(p, at)
    at += p.length
  }
  return summarizeReception(readMseed3Records(buf).records, buf.length)
}

describe('sensorOfSourceId', () => {
  it('波形の識別子から向きを外す', () => {
    expect(sensorOfSourceId(mseed3SourceId(BOARD, 'S1', 'HNZ')!)).toBe(mseed3SourceId(BOARD, 'S1', 'HNZ')!.replace(/_H_N_Z$/, ''))
  })
})

describe('mergeSpans', () => {
  it('並べ直して、隙間が 1 秒以内なら繋ぐ（重なりも繋ぐ）', () => {
    expect(
      mergeSpans([
        { fromMs: 5000, toMs: 6000 },
        { fromMs: 0, toMs: 1000 },
        { fromMs: 1800, toMs: 2500 },
        { fromMs: 2400, toMs: 3000 },
      ]),
    ).toEqual([
      { fromMs: 0, toMs: 3000 },
      { fromMs: 5000, toMs: 6000 },
    ])
  })
})

describe('summarizeReception', () => {
  it('取り戻した分・遅れた分・時刻の疑わしい分をセンサーごとの区間にし、3 軸を 1 本へ重ねる', () => {
    const got = summarize([
      wave('HNX', T0, 100, 'live'),
      wave('HNX', T0 + 1000, 100, 'backlog'),
      wave('HNY', T0 + 1000, 100, 'backlog'),
      wave('HNZ', T0 + 1000, 100, 'backlog'),
      // 1 秒より離れた取り戻しは別の区間
      wave('HNX', T0 + 4000, 100, 'backlog'),
      wave('HNX', T0 + 6000, 50, 'late'),
      wave('HNX', T0 + 7000, 50, 'live', true),
    ])
    expect(got.sensors).toHaveLength(1)
    const s = got.sensors[0]!
    expect(s.sensor).toBe(sensorOfSourceId(mseed3SourceId(BOARD, 'S1', 'HNX')!))
    expect(s.backlog).toEqual([
      { fromMs: T0 + 1000, toMs: T0 + 2000 },
      { fromMs: T0 + 4000, toMs: T0 + 5000 },
    ])
    expect(s.late).toEqual([{ fromMs: T0 + 6000, toMs: T0 + 6500 }])
    expect(s.questionable).toEqual([{ fromMs: T0 + 7000, toMs: T0 + 7500 }])
  })

  it('ふつうに届いただけのセンサーは出さない', () => {
    expect(summarize([wave('HNX', T0, 100, 'live')]).sensors).toEqual([])
  })

  it('読めなかったパケットを数え、理由と時刻を残す（中身そのものは残さない）', () => {
    const got = summarize([
      hostLog(T0 + 5, JSON.stringify({ received: T0 + 5, arrival: 3, source: '192.0.2.1:1', lane: 'live', why: 'bad-magic', raw: 'xxxx' })),
      hostLog(T0 + 9, JSON.stringify({ received: null, arrival: 4, source: '192.0.2.1:1', lane: 'backlog', why: 'x'.repeat(500), raw: '' })),
      hostLog(T0 + 10, 'not json'),
    ])
    expect(got.unreadable.count).toBe(2)
    expect(got.unreadable.items[0]).toEqual({ atMs: T0 + 5, rxMs: T0 + 5, lane: 'live', why: 'bad-magic' })
    expect(got.unreadable.items[1]!.rxMs).toBeNull()
    expect(got.unreadable.items[1]!.why).toHaveLength(200)
    expect(JSON.stringify(got)).not.toContain('192.0.2.1')
    expect(got.unreadableLogs).toBe(1)
  })

  it('読めなかったパケットは件数を全部数え、残すのは上限まで', () => {
    const parts = Array.from({ length: UNREADABLE_ITEMS_MAX + 3 }, (_, i) =>
      hostLog(T0 + i, JSON.stringify({ received: T0 + i, arrival: i, source: 's', lane: 'live', why: 'w', raw: '' })),
    )
    const got = summarize(parts)
    expect(got.unreadable.count).toBe(UNREADABLE_ITEMS_MAX + 3)
    expect(got.unreadable.items).toHaveLength(UNREADABLE_ITEMS_MAX)
  })
})

describe('encodeReceptionSummary / decodeReceptionSummary', () => {
  it('書いたものをそのまま読み戻す', () => {
    const got = summarize([
      wave('HNX', T0, 100, 'backlog'),
      hostLog(T0, JSON.stringify({ received: T0, arrival: 1, source: 's', lane: 'live', why: 'w', raw: '' })),
    ])
    expect(decodeReceptionSummary(encodeReceptionSummary(got))).toEqual(got)
  })

  it('版・欄の形が違えば読まない', () => {
    const good = JSON.parse(encodeReceptionSummary(summarize([wave('HNX', T0, 100, 'backlog')]))) as Record<string, unknown>
    expect(decodeReceptionSummary(JSON.stringify({ ...good, version: 2 }))).toBeNull()
    expect(decodeReceptionSummary(JSON.stringify({ ...good, sensors: [{ sensor: 'a', backlog: [{ fromMs: 'x', toMs: 1 }], late: [], questionable: [] }] }))).toBeNull()
    expect(decodeReceptionSummary(JSON.stringify({ ...good, unreadable: { count: 1, items: [{ atMs: 1, rxMs: null, lane: 'other', why: '' }] } }))).toBeNull()
    expect(decodeReceptionSummary('{')).toBeNull()
  })
})
