import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MseedStore, mseedFilePath } from './mseedStore'
import type { AssembledRecord } from './recordAssembler'

/** 2026-10-01 12:30 JST（03:30 UTC）。 */
const T = Date.UTC(2026, 9, 1, 3, 30, 0)
const HOUR = 3_600_000

let dir: string
let now = T

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mseed-store-'))
  now = T
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function record(fileAtMs: number, fill: number, n = 64): AssembledRecord {
  return {
    cut: 'full',
    sourceId: 'FDSN:XX_6525EAD0_I2C0-68_H_N_1',
    lane: 'live',
    bootId: '63c9812e',
    firstSeq: 0,
    startMs: fileAtMs,
    sampleRateHz: 100,
    sampleCount: 1,
    timeQuestionable: false,
    fileAtMs,
    bytes: new Uint8Array(n).fill(fill),
  }
}

function store(over: Partial<ConstructorParameters<typeof MseedStore>[0]> = {}): MseedStore {
  return new MseedStore({ dir, now: () => now, ...over })
}

function gunzipLines(path: string): unknown[] {
  return gunzipSync(readFileSync(path))
    .toString('utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

describe('mseedFilePath', () => {
  it('日本時間の日のディレクトリの下に、時ごとの名前で置く', () => {
    expect(mseedFilePath('/x', 'mseed', T)).toBe(join('/x', '2026-10-01', 'raw-2026-10-01T12.mseed3'))
    expect(mseedFilePath('/x', 'packets', T)).toBe(join('/x', '2026-10-01', 'raw-2026-10-01T12.packets.ndjson.gz'))
    expect(mseedFilePath('/x', 'unreadable', T)).toBe(join('/x', '2026-10-01', 'raw-2026-10-01T12.unreadable.ndjson'))
  })

  it('時刻として表せない値には名前を作らない', () => {
    expect(mseedFilePath('/x', 'mseed', Number.NaN)).toBeNull()
  })
})

describe('MseedStore', () => {
  it('レコードを、その時の本へ届いた順に足していく', async () => {
    const s = store()
    expect(s.writeRecord(record(T, 1))).toEqual({ saved: true })
    expect(s.writeRecord(record(T + 60_000, 2))).toEqual({ saved: true })
    await s.close()
    const buf = readFileSync(mseedFilePath(dir, 'mseed', T)!)
    expect(buf.length).toBe(128)
    expect(buf[0]).toBe(1)
    expect(buf[64]).toBe(2)
    expect(s.recordsWritten).toBe(2)
  })

  it('時が違えば別の本へ書く（過ぎた時の本も開き直して足す）', async () => {
    const s = store()
    s.writeRecord(record(T, 1))
    s.writeRecord(record(T + HOUR, 2))
    // 取り戻した分は、波形の時刻の時へ戻って書く。
    s.writeRecord(record(T + 10, 3))
    await s.close()
    expect(readFileSync(mseedFilePath(dir, 'mseed', T)!).length).toBe(128)
    expect(readFileSync(mseedFilePath(dir, 'mseed', T + HOUR)!).length).toBe(64)
  })

  it('既にある本へは追記する（上書きしない）', async () => {
    const a = store()
    a.writeRecord(record(T, 1))
    await a.close()
    const b = store()
    b.writeRecord(record(T, 2))
    await b.close()
    expect(readFileSync(mseedFilePath(dir, 'mseed', T)!).length).toBe(128)
  })

  it('パケットの見出しは溜めておき、5 秒ごとに gzip のかたまりとして足す', async () => {
    const s = store()
    expect(s.notePacket({ rx: T, src: '192.168.0.25:1', header: '{"v":2}' }, T)).toEqual({ saved: true })
    s.tick()
    expect(existsSync(mseedFilePath(dir, 'packets', T)!)).toBe(false)
    now += 5_000
    s.tick()
    s.notePacket({ rx: T + 5_000, src: '192.168.0.25:1', header: '{"v":2,"q":1}', via: 'backlog' }, T)
    now += 5_000
    s.tick()
    await s.close()
    // かたまりが 2 つ連なった gzip を、1 本として読める。
    expect(gunzipLines(mseedFilePath(dir, 'packets', T)!)).toEqual([
      { rx: T, src: '192.168.0.25:1', h: '{"v":2}' },
      { rx: T + 5_000, src: '192.168.0.25:1', h: '{"v":2,"q":1}', via: 'backlog' },
    ])
    expect(s.packetsWritten).toBe(2)
  })

  it('締めくくりで、溜めていた見出しも書き出す', async () => {
    const s = store()
    s.notePacket({ rx: T, src: 'a', header: 'h' }, T)
    await s.close()
    expect(gunzipLines(mseedFilePath(dir, 'packets', T)!)).toHaveLength(1)
  })

  it('読めなかったパケットは、受け取った時刻の時へすぐ書く', async () => {
    const s = store()
    expect(s.writeUnreadable({ rx: T, src: 'a', raw: 'probe', why: 'header-unreadable' }, T)).toEqual({ saved: true })
    await s.close()
    const lines = readFileSync(mseedFilePath(dir, 'unreadable', T)!, 'utf8').trim().split('\n')
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ rx: T, src: 'a', raw: 'probe', why: 'header-unreadable' }])
  })

  it('締めたあとは断る', async () => {
    const s = store()
    await s.close()
    expect(s.writeRecord(record(T, 1))).toEqual({ saved: false, reason: 'closed' })
    expect(s.notePacket({ rx: T, src: 'a', header: 'h' }, T)).toEqual({ saved: false, reason: 'closed' })
  })

  it('時刻として表せない値は、ディスクと別の理由で数える', () => {
    const s = store()
    expect(s.writeRecord(record(Number.NaN, 1))).toEqual({ saved: false, reason: 'bad-time' })
    expect(s.badTimes).toBe(1)
    expect(s.lostRecords).toBe(0)
  })

  it('開けなければ失ったと数え、間隔を置いてから開き直す', () => {
    let opens = 0
    const s = store({
      openStream: () => {
        opens += 1
        throw new Error('EACCES')
      },
    })
    expect(s.writeRecord(record(T, 1))).toEqual({ saved: false, reason: 'no-stream' })
    expect(s.writeRecord(record(T, 1))).toEqual({ saved: false, reason: 'no-stream' })
    expect(opens).toBe(1)
    now += 5_000
    s.writeRecord(record(T, 1))
    expect(opens).toBe(2)
    expect(s.lostRecords).toBe(3)
    expect(s.writeErrors).toBe(2)
    expect(s.lastWriteError).toContain('EACCES')
  })

  it('書き出しが詰まって抱えた量が上限を超えたら捨てて数える', () => {
    const stuck = new Writable({ write: () => {} })
    const s = store({ maxPendingBytes: 100, openStream: () => stuck })
    expect(s.writeRecord(record(T, 1))).toEqual({ saved: true })
    expect(s.writeRecord(record(T, 2))).toEqual({ saved: false, reason: 'backpressure' })
    expect(s.lostRecords).toBe(1)
  })

  it('しばらく書かなかった本は閉じる', async () => {
    const s = store({ idleCloseMs: 120_000 })
    s.writeRecord(record(T, 1))
    expect(s.openBooks).toBe(1)
    now += 119_999
    s.tick()
    expect(s.openBooks).toBe(1)
    now += 1
    s.tick()
    expect(s.openBooks).toBe(0)
    await s.close()
  })
})
