import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readMseed3Records } from './mseed3Reader'
import { MseedRecorder } from './mseedRecorder'
import { mseedFilePath } from './mseedStore'
import { compareRawHour, rawCompareVerdict } from './rawCompare'
import type { NdjsonEnvelope, PacketsLine, RawCompareInput, RawCompareResult, UnreadableLine } from './rawCompare'

/** 2026-10-01 12:00 JST（03:00 UTC）。 */
const HOUR = Date.UTC(2026, 9, 1, 3, 0, 0)
const T = HOUR + 10 * 60_000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'raw-compare-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function payload(mac: string, sid: string, q: number, t: number, amp = 300): string {
  const header = { v: 2, mac, bid: '63c9812e', sid, st: 'MPU6050', ch: ['HN1', 'HN2', 'HN3'], ug: 61.0352, fs: 2, hz: 100, t, q, c: 10, o: 0 }
  const rows = Array.from({ length: 10 }, (_, i) => {
    const s = q + i
    return `${Math.round(amp * Math.sin(s / 7))},${Math.round(amp * Math.cos(s / 5))},${16000 + (s % 13)}`
  })
  return `${JSON.stringify(header)}\n${rows.join('\n')}\n`
}

/** 2 基板 × 2 センサーぶん、60 秒（600 パケット）を流す。読めないもの・取り戻した分も混ぜる。 */
function scenario(): NdjsonEnvelope[] {
  const out: NdjsonEnvelope[] = []
  for (let k = 0; k < 600; k++) {
    for (const mac of ['020000000001', '020000000003']) {
      for (const sid of ['i2c0-68', 'i2c1-68']) {
        const q = k * 10
        out.push({ rx: T + q * 10 + 3, src: '192.0.2.41:52440', raw: payload(mac, sid, q, T + q * 10) })
      }
    }
  }
  out.push({ rx: T + 1_000, src: '192.0.2.23:50274', raw: 'probe-from-workpc' })
  // 取り戻した分（同じ時の、少し前の番号）。
  for (let k = 0; k < 20; k++) {
    const q = 900_000 + k * 10
    out.push({ rx: T + 30_000, src: '192.0.2.41:52440', raw: payload('020000000001', 'i2c0-68', q, T - 60_000 + k * 100), via: 'backlog' })
  }
  return out
}

async function write(envs: readonly NdjsonEnvelope[]): Promise<void> {
  const r = new MseedRecorder({ dir, now: () => T + 3_600_000 })
  for (const e of envs) r.handle(e.src, e.raw, e.rx, e.via === 'backlog' ? 'backlog' : 'live')
  await r.close()
}

function readBack(envs: readonly NdjsonEnvelope[]): RawCompareInput {
  const records = readMseed3Records(new Uint8Array(readFileSync(mseedFilePath(dir, 'mseed', HOUR)!))).records
  const packets = gunzipSync(readFileSync(mseedFilePath(dir, 'packets', HOUR)!))
    .toString('utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as PacketsLine)
  const unreadable = readFileSync(mseedFilePath(dir, 'unreadable', HOUR)!, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as UnreadableLine)
  return { hourStartMs: HOUR, ndjson: envs, records, packets, unreadable }
}

describe('compareRawHour', () => {
  it('miniSEED と見出しから、全パケットを NDJSON どおりに組み立て直せる', async () => {
    const envs = scenario()
    await write(envs)
    const result = compareRawHour(readBack(envs))
    expect(result.examples).toEqual([])
    expect(result.ndjsonPackets).toBe(2400 + 20)
    expect(result.matched).toBe(2400 + 20)
    expect(result.mismatched).toBe(0)
    expect(result.onlyInNdjson).toBe(0)
    expect(result.onlyInMseed).toBe(0)
    expect(result.recordTimeMismatches).toBe(0)
    expect(result.sampleConflicts).toBe(0)
    expect(result.ndjsonUnreadable).toBe(1)
    expect(result.mseedUnreadable).toBe(1)
  })

  it('サンプルが 1 つ違えば、食い違いとして数えて例を出す', async () => {
    const envs = scenario()
    await write(envs)
    const tampered = envs.map((e, i) => (i === 100 ? { ...e, raw: e.raw.replace(/\n(-?\d+),/, '\n99999,') } : e))
    const result = compareRawHour(readBack(tampered))
    expect(result.mismatched).toBe(1)
    expect(result.examples.some((s) => s.includes('食い違い'))).toBe(true)
  })

  it('見出しが 1 行欠ければ、NDJSON にだけあるものとして数える', async () => {
    const envs = scenario()
    await write(envs)
    const input = readBack(envs)
    const result = compareRawHour({ ...input, packets: input.packets.slice(1) })
    expect(result.onlyInNdjson).toBe(1)
    expect(result.matched).toBe(2400 + 20 - 1)
  })

  it('レコードが欠ければ、そのサンプルを運んだパケットが食い違いになる', async () => {
    const envs = scenario()
    await write(envs)
    const input = readBack(envs)
    const result = compareRawHour({ ...input, records: input.records.slice(1) })
    expect(result.mismatched).toBeGreaterThan(0)
  })

  it('その時の外のパケットは数えない', async () => {
    const envs = scenario()
    await write(envs)
    const result = compareRawHour({ ...readBack(envs), hourStartMs: HOUR + 3_600_000 })
    expect(result.ndjsonPackets).toBe(0)
  })

  it('重なって届いたパケット（遅れて届いた分の流れへ入るもの）も、いま届いた分と同じく照らせる', async () => {
    const base = scenario()
    // 番号 500 のパケットが、ずっと後にもう一度届く。
    const again = base.find((e) => e.via === undefined && e.raw.includes('"q":500,') && e.raw.includes('020000000001') && e.raw.includes('i2c0-68'))!
    const envs = [...base.slice(0, 1000), { ...again, rx: again.rx! + 5_000 }, ...base.slice(1000)]
    await write(envs)
    const result = compareRawHour(readBack(envs))
    expect(result.examples).toEqual([])
    expect(result.matched).toBe(2400 + 20 + 1)
    expect(result.sampleConflicts).toBe(0)
  })
})

describe('rawCompareVerdict', () => {
  const clean: RawCompareResult = {
    ndjsonPackets: 10,
    mseedPackets: 10,
    matched: 10,
    mismatched: 0,
    onlyInNdjson: 0,
    onlyInMseed: 0,
    recordTimeMismatches: 0,
    sampleConflicts: 0,
    ndjsonUnreadable: 0,
    mseedUnreadable: 0,
    unplaceable: 0,
    examples: [],
  }
  const base = { result: clean, ndjsonFound: true, crcFailures: 0, decodeFailures: 0 }

  it('照らしたものが全部合えば 0', () => {
    expect(rawCompareVerdict(base)).toBe(0)
  })

  it('食い違いがあれば 1（検査値の不一致・読めなかったものの件数差も含む）', () => {
    expect(rawCompareVerdict({ ...base, result: { ...clean, onlyInMseed: 1 } })).toBe(1)
    expect(rawCompareVerdict({ ...base, crcFailures: 1 })).toBe(1)
    expect(rawCompareVerdict({ ...base, result: { ...clean, ndjsonUnreadable: 2, mseedUnreadable: 1 } })).toBe(1)
  })

  it('NDJSON が見つからなければ 2（何も照らしていないので「合った」と言わない）', () => {
    expect(rawCompareVerdict({ ...base, ndjsonFound: false, result: { ...clean, ndjsonPackets: 0, matched: 0, onlyInMseed: 0, mseedPackets: 0 } })).toBe(2)
  })

  it('その時のパケットが両方とも 0 件なら 2', () => {
    expect(rawCompareVerdict({ ...base, result: { ...clean, ndjsonPackets: 0, mseedPackets: 0, matched: 0 } })).toBe(2)
  })

  it('NDJSON が無くても miniSEED 側が壊れていれば 1（食い違いを先に見る）', () => {
    expect(rawCompareVerdict({ ...base, ndjsonFound: false, decodeFailures: 1 })).toBe(1)
  })
})
