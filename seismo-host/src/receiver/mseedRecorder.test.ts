import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseSensorPacket } from '../protocol/parsePacket'
import type { PacketParseResult } from '../protocol/types'
import { readMseed3Records } from './mseed3Reader'
import type { ParsedMseed3Record } from './mseed3Reader'
import { MSEED3_HOST_LOG_SOURCE_ID } from './mseed3Record'
import { MseedRecorder } from './mseedRecorder'
import { mseedFilePath } from './mseedStore'

/** 2026-10-01 12:30 JST。 */
const T = Date.UTC(2026, 9, 1, 3, 30, 0)
const SRC = '192.0.2.41:52440'
const LOG_SID = 'FDSN:XX_00000001_I2C0-68_L_O_G'

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
    mac: '020000000001',
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
    ack: 1,
    ...over,
  }
  const rows = Array.from({ length: 10 }, (_, i) => `${q + i},${-(q + i)},${16000 + i}`)
  return `${JSON.stringify(header)}\n${rows.join('\n')}\n`
}

function recorder(over: Partial<ConstructorParameters<typeof MseedRecorder>[0]> = {}): MseedRecorder {
  return new MseedRecorder({ dir, now: () => now, ...over })
}

function recordsAt(atMs: number): readonly ParsedMseed3Record[] {
  const read = readMseed3Records(new Uint8Array(readFileSync(mseedFilePath(dir, atMs)!)))
  expect(read.crcFailures).toBe(0)
  expect(read.skippedBytes).toBe(0)
  return read.records
}

function textOf(atMs: number, sid: string): Array<Record<string, unknown>> {
  return recordsAt(atMs)
    .filter((r) => r.sourceId === sid)
    .map((r) => JSON.parse(r.text!) as Record<string, unknown>)
}

describe('MseedRecorder', () => {
  it('読めたパケットは、波形のレコードと受信の記録を同じ 1 本へ残す', async () => {
    const r = recorder()
    for (let k = 0; k < 3; k++) r.accept(SRC, payload(k * 10), T + k * 100)
    await r.close()
    const all = recordsAt(T)
    const waves = all.filter((x) => x.encoding === 11)
    expect(new Set(waves.map((x) => x.sourceId))).toEqual(
      new Set(['FDSN:XX_00000001_I2C0-68_H_N_1', 'FDSN:XX_00000001_I2C0-68_H_N_2', 'FDSN:XX_00000001_I2C0-68_H_N_3']),
    )
    const [log] = textOf(T, LOG_SID)
    expect(log).toMatchObject({
      board: 'mac:020000000001',
      boot: '63c9812e',
      sensor: 'i2c0-68',
      lane: 'live',
      version: 2,
      type: 'MPU6050',
      channels: ['HN1', 'HN2', 'HN3'],
      ugPerLsb: 61.0352,
      fullScaleG: 2,
      sampleRateHz: 100,
      source: SRC,
      ack: true,
      seq: 0,
      time: T,
      received: T,
      arrival: 0,
      overflow: 0,
    })
    // 2 つ目以降は前のパケットからの差分（番号の飛び 0・名乗った時刻は外挿どおり・受け取りは 100 ms 後・
    // 受付番号は 1 つずつ進む）。
    expect(log!.packets).toEqual([
      [0, 10, 0, 0, 0, 0],
      [0, 10, 0, 100, 1, 0],
      [0, 10, 0, 100, 1, 0],
    ])
    expect(r.health().recordsWritten).toBe(3)
    expect(r.health().packetsLogged).toBe(3)
  })

  it('読み取った結果を返す（呼び出し側は読み直さない）', () => {
    const r = recorder()
    const p = payload(0)
    expect(r.accept(SRC, p, T)).toEqual(parseSensorPacket(p))
    expect(r.accept(SRC, 'probe', T).ok).toBe(false)
  })

  it('読めなかったパケットは、理由を付けて中身ごとホストの受信の記録へ残す', async () => {
    const r = recorder()
    r.accept(SRC, 'probe-from-workpc', T)
    await r.close()
    expect(textOf(T, MSEED3_HOST_LOG_SOURCE_ID)).toEqual([
      { received: T, arrival: 0, source: SRC, lane: 'live', why: 'header-unreadable', raw: 'probe-from-workpc' },
    ])
    expect(r.health().unreadableWritten).toBe(1)
  })

  it('組み立てで退けたパケットも、理由を付けて中身ごと残す（センサーの受信の記録には載せない）', async () => {
    const r = recorder()
    const bad = payload(0, T, { sid: 'i2c0_68' })
    r.accept(SRC, bad, T)
    await r.close()
    expect(textOf(T, MSEED3_HOST_LOG_SOURCE_ID)).toEqual([
      { received: T, arrival: 0, source: SRC, lane: 'live', why: 'no-source-id', raw: bad },
    ])
    expect(recordsAt(T).filter((x) => x.sourceId !== MSEED3_HOST_LOG_SOURCE_ID)).toHaveLength(0)
  })

  it('組み立てで退けた取り戻し分も、波形の時刻の時へ入れる（受け取った時刻の時へ紛れ込ませない）', async () => {
    const r = recorder()
    const past = T - 3_600_000
    const bad = payload(0, past, { sid: 'i2c0_68' })
    // 中身ごと残せたので「書けた」—— 訊き直しても同じ理由で退けるだけ。
    expect(await r.acceptRecovered(SRC, bad, T)).toBe(true)
    await r.close()
    expect(textOf(past, MSEED3_HOST_LOG_SOURCE_ID)).toEqual([
      { received: T, arrival: 0, source: SRC, lane: 'backlog', why: 'no-source-id', raw: bad },
    ])
    expect(existsSync(mseedFilePath(dir, T)!)).toBe(false)
  })

  it('読めなかったパケットは波形の時刻を持たないので、受け取った時刻の時へ入れる（対照）', async () => {
    const r = recorder()
    await r.acceptRecovered(SRC, 'probe-from-workpc', T)
    await r.close()
    expect(existsSync(mseedFilePath(dir, T)!)).toBe(true)
  })

  it('取り戻した分は届き方を記録し、波形の時刻の時へ入れる', async () => {
    const r = recorder()
    const past = T - 3_600_000
    await r.acceptRecovered(SRC, payload(0, past), T)
    await r.close()
    const [log] = textOf(past, LOG_SID)
    expect(log).toMatchObject({ lane: 'backlog', time: past, received: T })
    expect(recordsAt(past).some((x) => x.encoding === 11)).toBe(true)
  })

  it('正: 取り戻した分は溜めずに書き、ディスクへ書き終えたら true を返す', async () => {
    const r = recorder()
    expect(await r.acceptRecovered(SRC, payload(0, T - 60_000), T)).toBe(true)
    // 刻み（tick）を待たずに、波形 3 軸と受信の記録が書き終わっている。
    expect(r.health().recordsWritten).toBe(3)
    expect(r.health().packetsLogged).toBe(1)
    expect(r.health().pendingSamples).toBe(0)
    expect(r.health().bufferedPackets).toBe(0)
  })

  it('正: その場で書けなければ false を返す（呼び出し側は欠けを残して訊き直す）', async () => {
    const r = recorder({
      openStream: () => {
        throw new Error('EACCES')
      },
    })
    expect(await r.acceptRecovered(SRC, payload(0, T - 60_000), T)).toBe(false)
  })

  it('正: 流し口へ渡したあとで書き込みが失敗しても false を返す（ディスクが一杯・I/O エラーはこの形で届く）', async () => {
    const failing = new Writable({ write: (_chunk, _enc, cb) => cb(new Error('ENOSPC')) })
    failing.on('error', () => {})
    const r = recorder({ openStream: () => failing })
    expect(await r.acceptRecovered(SRC, payload(0, T - 60_000), T)).toBe(false)
    expect(r.health().recordsWritten).toBe(0)
    expect(r.health().packetsLogged).toBe(0)
  })

  it('対照: いま届いた分（accept）は従来どおり溜め、刻みで書き出す', () => {
    const r = recorder()
    r.accept(SRC, payload(0), T)
    expect(r.health().recordsWritten).toBe(0)
    expect(r.health().pendingSamples).toBe(30)
  })

  it('安全弁: 波形を書けなかったパケットは、受信の記録を書こうとしない（読み返しで同じパケットが二重に組み上がらない）', async () => {
    // 受信の記録だけが残ると、訊き直して書けた波形とあわせて、同じパケットが 2 回組み上がる
    // （読み手は受信の記録に載った回数だけパケットを組む。`mseedPacketReader.ts`）。
    const r = recorder({
      openStream: () => {
        throw new Error('EACCES')
      },
    })
    await r.acceptRecovered(SRC, payload(0, T - 60_000), T)
    // 書こうとして失ったのは波形の 3 本だけ（受信の記録の 1 本は試していない）。
    expect(r.health().lostRecords).toBe(3)
    expect(r.health().packetsLogged).toBe(0)
  })

  it('時計が合う前のパケットは、受け取った時刻の時へ入れ、時刻が疑わしい印を立てる', async () => {
    const r = recorder()
    r.accept(SRC, payload(0, 8_430), T)
    await r.close()
    const log = recordsAt(T).find((x) => x.sourceId === LOG_SID)!
    expect(log.timeQuestionable).toBe(true)
    expect(JSON.parse(log.text!)).toMatchObject({ time: 8_430 })
  })

  it('受け取った時刻が判らなければ、いまの時刻で振り分ける（記録には null のまま残す）', async () => {
    const r = recorder()
    r.accept(SRC, payload(0), null)
    await r.close()
    const [log] = textOf(T, LOG_SID)
    expect(log!.received).toBeNull()
    expect(log!.packets).toEqual([[0, 10, 0, null, 0, 0]])
  })

  it('刻みで、溜まった波形は 5 秒・受信の記録は 30 秒で書き出す', async () => {
    const r = recorder()
    r.accept(SRC, payload(0), T)
    now = T + 4_999
    r.tick(now)
    expect(r.health().recordsWritten).toBe(0)
    now = T + 5_000
    r.tick(now)
    // 流し口へ渡したかは数で見る（ファイルへ出るのは非同期なので、中身は閉じてから読む）。
    expect(r.health().recordsWritten).toBe(3)
    expect(r.health().packetsLogged).toBe(0)
    now = T + 30_000
    r.tick(now)
    expect(r.health().packetsLogged).toBe(1)
    await r.close()
    expect(textOf(T, LOG_SID)).toHaveLength(1)
  })

  it('正: 読み直す前に吐き出すと、溜めていたパケットが閉じずにそのまま読める（#596）', async () => {
    const r = recorder()
    r.accept(SRC, payload(0), T)
    r.accept(SRC, payload(10), T + 100)
    // 刻みの前（波形 5 秒・受信の記録 30 秒の手前）でも、待ち終えればファイルにある。
    expect(await r.flushForRead()).toBe(true)
    const { readMseedRange } = await import('./mseedPacketReader')
    const read = readMseedRange(new Uint8Array(readFileSync(mseedFilePath(dir, T)!)), T - 1_000, T + 1_000)
    expect(read.packets.map((p) => p.packet.firstSeq)).toEqual([0, 10])
    // 対照: 閉じていないので、続けて届いた分も従来どおり受ける。
    r.accept(SRC, payload(20), T + 200)
    await r.close()
    expect(textOf(T, LOG_SID)).toHaveLength(2)
  })

  it('正: 区間だけ読むと、区間の中のパケットは全部読んだときと同じで、遠く離れたレコードは解かない（#596）', async () => {
    const r = recorder()
    // 0 秒・60 秒・180 秒に 1 つずつ。受信の記録は 30 秒で切れるので、それぞれ別のレコードになる。
    for (const [q, at] of [[0, T], [6_000, T + 60_000], [18_000, T + 180_000]] as const) {
      now = at
      r.accept(SRC, payload(q, at), at)
      now = at + 31_000
      r.tick(now)
    }
    await r.close()
    const { readMseedHour, readMseedRange } = await import('./mseedPacketReader')
    const buf = new Uint8Array(readFileSync(mseedFilePath(dir, T)!))
    const all = readMseedHour(buf)
    const part = readMseedRange(buf, T + 55_000, T + 65_000)
    const inWindow = (p: { packet: { firstSampleMs: number } }) => p.packet.firstSampleMs >= T + 55_000 && p.packet.firstSampleMs < T + 65_000
    expect(part.packets.filter(inWindow)).toEqual(all.packets.filter(inWindow))
    expect(part.packets.filter(inWindow)).toHaveLength(1)
    // 対照: 区間から 35 秒より前・区間の後のパケットは組み上がらない（そのレコードを読んでいない）。
    expect(part.packets.map((p) => p.packet.firstSeq)).toEqual([6_000])
  })

  it('組み立ての途中で想定外の例外が出ても投げず、数えて、そのパケットを中身ごと残す', async () => {
    const p = payload(0)
    // 軸の並びを持たない壊れた読み取り結果を 1 回だけ返す（組み立てが中で投げる）。
    let first = true
    const parse = (raw: string): PacketParseResult => {
      const read = parseSensorPacket(raw)
      if (!first || !read.ok) return read
      first = false
      return { ...read, packet: { ...read.packet, channels: null as never } }
    }
    const r = recorder({ parse })
    expect(() => r.accept(SRC, p, T)).not.toThrow()
    expect(r.health().internalErrors).toBe(1)
    expect(r.health().lastInternalError).not.toBeNull()
    // その後のパケットは普通に通る。
    r.accept(SRC, payload(10), T)
    await r.close()
    expect(textOf(T, MSEED3_HOST_LOG_SOURCE_ID)).toEqual([
      { received: T, arrival: 0, source: SRC, lane: 'live', why: 'internal-error', raw: p },
    ])
    // 受付番号は、例外で残したデータグラムの分も進む（次のパケットは 1）。
    const [log] = textOf(T, LOG_SID)
    expect(log).toMatchObject({ arrival: 1 })
  })

  it('安全弁: 取り戻した分の組み立てで想定外の例外が出たら、中身は残しても「書けた」とは答えない（訊き直させる）', async () => {
    // 波形は 1 本も書けていない。一時的な原因なら、訊き直せば書ける。
    let first = true
    const parse = (raw: string): PacketParseResult => {
      const read = parseSensorPacket(raw)
      if (!first || !read.ok) return read
      first = false
      return { ...read, packet: { ...read.packet, channels: null as never } }
    }
    const r = recorder({ parse })
    const p = payload(0, T - 60_000)
    expect(await r.acceptRecovered(SRC, p, T)).toBe(false)
    expect(r.health().internalErrors).toBe(1)
    // 対照: 次（訊き直した回）は普通に書けて true。
    expect(await r.acceptRecovered(SRC, p, T)).toBe(true)
    await r.close()
    // 中身は読めなかったパケットとして残っている（黙って捨てない）。
    expect(textOf(T, MSEED3_HOST_LOG_SOURCE_ID)).toMatchObject([{ lane: 'backlog', why: 'internal-error', raw: p }])
  })

  it('健全性に、組み立ての状態と書き出しの数をまとめて出す', () => {
    const r = recorder()
    r.accept(SRC, payload(0), T)
    const h = r.health()
    expect(h.pendingSamples).toBe(30)
    expect(h.bufferedPackets).toBe(1)
    expect(h.lostRecords).toBe(0)
    expect(h.cuts.full).toBe(0)
  })
})
