import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseSensorPacket } from '../protocol/parsePacket'
import { MseedRecorder } from './mseedRecorder'
import { mseedFilePath } from './mseedStore'

/** 2026-10-01 12:30 JST。 */
const T = Date.UTC(2026, 9, 1, 3, 30, 0)
const SRC = '192.168.0.25:52440'

let dir: string
let now = T

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mseed-recorder-'))
  now = T
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 実機と同じ形の版 2 のパケット。 */
function payload(q: number, t = T + q * 10, over: Record<string, unknown> = {}): string {
  const header = {
    v: 2,
    mac: 'a0b76525ead0',
    bid: '63c9812e',
    sid: 'i2c0-68',
    st: 'MPU6050',
    ch: ['HN1', 'HN2', 'HN3'],
    ug: 61.0352,
    fs: 2,
    hz: 100,
    t,
    q,
    c: 10,
    o: 0,
    ...over,
  }
  const rows = Array.from({ length: 10 }, (_, i) => `${q + i},${-(q + i)},${16000 + i}`)
  return `${JSON.stringify(header)}\n${rows.join('\n')}\n`
}

function recorder(): MseedRecorder {
  return new MseedRecorder({ dir, now: () => now })
}

function packetLines(atMs: number): Array<{ rx: number; src: string; h: string; via?: string }> {
  return gunzipSync(readFileSync(mseedFilePath(dir, 'packets', atMs)!))
    .toString('utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
}

describe('MseedRecorder', () => {
  it('読めたパケットは、見出しの先頭行をそのまま残し、サンプルをレコードにする', async () => {
    const r = recorder()
    for (let k = 0; k < 3; k++) r.handle(SRC, payload(k * 10), T + k * 100, 'live')
    await r.close()
    const lines = packetLines(T)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toEqual({ rx: T, src: SRC, h: payload(0).split('\n')[0] })
    // 3 軸ぶんのレコードがある（中身の正しさは突き合わせの道具と recordAssembler のテストが見る）。
    const mseed = readFileSync(mseedFilePath(dir, 'mseed', T)!)
    expect(mseed.subarray(0, 2).toString('latin1')).toBe('MS')
    expect(r.health().recordsWritten).toBe(3)
  })

  it('読み取りの結果を渡されたら読み直さない（同じ結果を使う）', async () => {
    const r = recorder()
    const p = payload(0)
    r.handle(SRC, p, T, 'live', parseSensorPacket(p))
    await r.close()
    expect(packetLines(T)).toHaveLength(1)
  })

  it('読めなかったパケットは、理由を付けて丸ごと別に残す', async () => {
    const r = recorder()
    r.handle(SRC, 'probe-from-workpc', T, 'live')
    await r.close()
    const lines = readFileSync(mseedFilePath(dir, 'unreadable', T)!, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([{ rx: T, src: SRC, raw: 'probe-from-workpc', why: 'header-unreadable' }])
  })

  it('組み立てで退けたパケットも、理由を付けて丸ごと別に残す（見出しには載せない）', async () => {
    const r = recorder()
    const bad = payload(0, T, { sid: 'i2c0_68' })
    r.handle(SRC, bad, T, 'live')
    await r.close()
    const lines = readFileSync(mseedFilePath(dir, 'unreadable', T)!, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([{ rx: T, src: SRC, raw: bad, why: 'no-source-id' }])
    expect(r.health().unreadableWritten).toBe(1)
  })

  it('組み立てで退けた取り戻し分も、波形の時刻の時へ入れる（受け取った時刻の時へ紛れ込ませない）', async () => {
    const r = recorder()
    const past = T - 3_600_000
    const bad = payload(0, past, { sid: 'i2c0_68' })
    r.handle(SRC, bad, T, 'backlog')
    await r.close()
    const lines = readFileSync(mseedFilePath(dir, 'unreadable', past)!, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([{ rx: T, src: SRC, raw: bad, via: 'backlog', why: 'no-source-id' }])
    expect(existsSync(mseedFilePath(dir, 'unreadable', T)!)).toBe(false)
  })

  it('読めなかったパケットは波形の時刻を持たないので、受け取った時刻の時へ入れる（対照）', async () => {
    const r = recorder()
    r.handle(SRC, 'probe-from-workpc', T, 'backlog')
    await r.close()
    expect(existsSync(mseedFilePath(dir, 'unreadable', T)!)).toBe(true)
  })

  it('取り戻した分は印を付け、波形の時刻の時へ入れる', async () => {
    const r = recorder()
    const past = T - 3_600_000
    r.handle(SRC, payload(0, past), T, 'backlog')
    await r.close()
    expect(packetLines(past)).toEqual([{ rx: T, src: SRC, h: payload(0, past).split('\n')[0], via: 'backlog' }])
    expect(readFileSync(mseedFilePath(dir, 'mseed', past)!).length).toBeGreaterThan(0)
  })

  it('時計が合う前のパケットは、受け取った時刻の時へ入れる（1970 年の本を作らない）', async () => {
    const r = recorder()
    r.handle(SRC, payload(0, 8_430), T, 'live')
    await r.close()
    expect(packetLines(T)).toHaveLength(1)
    expect(readFileSync(mseedFilePath(dir, 'mseed', T)!).length).toBeGreaterThan(0)
  })

  it('受け取った時刻が判らなければ、いまの時刻で振り分ける（記録には null のまま残す）', async () => {
    const r = recorder()
    r.handle(SRC, payload(0, 8_430), null, 'live')
    await r.close()
    expect(packetLines(T)[0]!.rx).toBeNull()
  })

  it('刻みで、5 秒溜まった見出しとレコードを書き出す', async () => {
    const r = recorder()
    r.handle(SRC, payload(0), T, 'live')
    now = T + 4_999
    r.tick(now)
    expect(r.health().packetsWritten).toBe(0)
    expect(r.health().recordsWritten).toBe(0)
    now = T + 5_000
    r.tick(now)
    // 流し口へ渡したかは数で見る（ファイルへ出るのは非同期なので、中身は閉じてから読む）。
    expect(r.health().packetsWritten).toBe(1)
    expect(r.health().recordsWritten).toBe(3)
    await r.close()
    expect(packetLines(T)).toHaveLength(1)
  })

  it('組み立ての途中で想定外の例外が出ても投げず、数えて、そのパケットを丸ごと別に残す', async () => {
    const r = recorder()
    const p = payload(0)
    // 読み取りの結果として、軸の並びを持たない壊れた形を渡す（組み立てが中で投げる）。
    const broken = { ok: true, packet: { ...(parseSensorPacket(p) as { packet: object }).packet, channels: null } } as never
    expect(() => r.handle(SRC, p, T, 'live', broken)).not.toThrow()
    expect(r.health().internalErrors).toBe(1)
    expect(r.health().lastInternalError).not.toBeNull()
    // その後のパケットは普通に通る。
    r.handle(SRC, payload(10), T, 'live')
    await r.close()
    const lines = readFileSync(mseedFilePath(dir, 'unreadable', T)!, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([{ rx: T, src: SRC, raw: p, why: 'internal-error' }])
    expect(packetLines(T)).toHaveLength(1)
  })

  it('健全性に、組み立ての状態と書き出しの数をまとめて出す', () => {
    const r = recorder()
    r.handle(SRC, payload(0), T, 'live')
    const h = r.health()
    expect(h.pendingSamples).toBe(30)
    expect(h.bufferedPackets).toBe(1)
    expect(h.lostRecords).toBe(0)
    expect(h.cuts.full).toBe(0)
  })
})
