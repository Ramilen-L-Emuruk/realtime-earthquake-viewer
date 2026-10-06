import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseSensorPacket } from '../protocol/parsePacket'
import type { SensorPacket } from '../protocol/types'
import { buildMseed3Record, framesForRecord } from './mseed3Record'
import { orderByReceipt, readMseedHour } from './mseedPacketReader'
import { MseedRecorder } from './mseedRecorder'
import { mseedFilePath } from './mseedStore'
import { encodeSteim2 } from './steim2'

/** 2026-10-01 12:30 JST。 */
const T = Date.UTC(2026, 9, 1, 3, 30, 0)
const SRC = '192.0.2.41:52440'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mseed-reader-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 実機と同じ形の版 2 のパケット（30 サンプル・揺れを含む値）。 */
function payload(q: number, over: Record<string, unknown> = {}): string {
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
    t: T + q * 10,
    q,
    c: 30,
    o: 0,
    ack: 1,
    ...over,
  }
  const rows = Array.from({ length: 30 }, (_, i) => {
    const n = q + i
    return `${Math.round(800 * Math.sin(n / 7))},${-n % 97},${16000 + ((n * 31) % 257)}`
  })
  return `${JSON.stringify(header)}\n${rows.join('\n')}\n`
}

function packetOf(p: string): SensorPacket {
  const read = parseSensorPacket(p)
  if (!read.ok) throw new Error('読めない')
  return read.packet
}

async function writeAll(sends: Array<{ p: string; rx: number | null; lane: 'live' | 'backlog' }>): Promise<Uint8Array> {
  const r = new MseedRecorder({ dir, now: () => T })
  for (const s of sends) {
    if (s.lane === 'backlog') await r.acceptRecovered(SRC, s.p, s.rx)
    else r.accept(SRC, s.p, s.rx)
  }
  await r.close()
  return new Uint8Array(readFileSync(mseedFilePath(dir, T)!))
}

describe('readMseedHour', () => {
  it('書いたパケットが、番号・時刻・サンプル・受け取った時刻まで元どおりに戻る', async () => {
    // 3 秒ぶん（10 パケット）＋名乗る時刻が外挿から 1 ms ずれたもの。
    const sends = Array.from({ length: 10 }, (_, k) => ({
      p: payload(k * 30, k === 4 ? { t: T + k * 300 + 1 } : {}),
      rx: T + k * 300 + 250 + (k % 3) * 7,
      lane: 'live' as const,
    }))
    const out = readMseedHour(await writeAll(sends))
    expect(out.crcFailures).toBe(0)
    expect(out.skippedBytes).toBe(0)
    expect(out.unreadableLogs).toBe(0)
    expect(out.incompletePackets).toBe(0)
    expect(out.unclaimedSamples).toBe(0)
    expect(out.packets.map((x) => x.packet)).toEqual(sends.map((s) => packetOf(s.p)))
    expect(out.packets.map((x) => x.rx)).toEqual(sends.map((s) => s.rx))
    expect(out.packets.map((x) => x.arrival)).toEqual(sends.map((_, k) => k))
    expect(out.packets.every((x) => x.lane === 'live' && x.source === SRC && x.ackRequested)).toBe(true)
  })

  it('取り戻した分・遅れて届いた分も、届き方の印つきで戻る', async () => {
    const sends = [
      { p: payload(0), rx: T + 300, lane: 'live' as const },
      { p: payload(30), rx: T + 600, lane: 'live' as const },
      // 番号が戻る（重ねて届いた）→ 組み立てが late へ回す。
      { p: payload(0), rx: T + 650, lane: 'live' as const },
      { p: payload(9000), rx: T + 700, lane: 'backlog' as const },
    ]
    const out = readMseedHour(await writeAll(sends))
    const got = out.packets.map((x) => [x.lane, x.packet.firstSeq])
    expect(got).toEqual(
      expect.arrayContaining([
        ['live', 0],
        ['live', 30],
        ['late', 0],
        ['backlog', 9000],
      ]),
    )
    expect(out.packets).toHaveLength(4)
    expect(out.incompletePackets).toBe(0)
  })

  it('読めなかったパケットを、中身と理由つきで返す', async () => {
    const out = readMseedHour(await writeAll([{ p: 'probe', rx: T, lane: 'live' }]))
    expect(out.unreadable).toEqual([{ rx: T, arrival: 0, source: SRC, lane: 'live', why: 'header-unreadable', raw: 'probe' }])
  })

  it('受け取った時刻が判らない区間は null のまま戻る', async () => {
    const out = readMseedHour(await writeAll([{ p: payload(0), rx: null, lane: 'live' }]))
    expect(out.packets[0]!.rx).toBeNull()
  })

  it('受信の記録が無いサンプルは、パケットにせず数える（波形は失っていないことが分かる）', async () => {
    const buf = await writeAll([{ p: payload(0), rx: T, lane: 'live' }])
    // 受信の記録（テキストのレコード・encoding 0）だけを抜き取る。
    const kept: number[] = []
    let pos = 0
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    while (pos < buf.length) {
      const total = 40 + buf[pos + 33]! + view.getUint16(pos + 34, true) + view.getUint32(pos + 36, true)
      if (buf[pos + 15] !== 0) kept.push(...buf.subarray(pos, pos + total))
      pos += total
    }
    const out = readMseedHour(new Uint8Array(kept))
    expect(out.packets).toHaveLength(0)
    expect(out.unclaimedSamples).toBe(90)
  })

  it('サンプルが揃わないパケットは組み立て直さずに数える', async () => {
    const buf = await writeAll([{ p: payload(0), rx: T, lane: 'live' }])
    // 波形のレコードを 1 本（1 軸）だけ落とす。
    const out = [] as number[]
    let pos = 0
    let dropped = false
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    while (pos < buf.length) {
      const total = 40 + buf[pos + 33]! + view.getUint16(pos + 34, true) + view.getUint32(pos + 36, true)
      if (!dropped && buf[pos + 15] === 11) dropped = true
      else out.push(...buf.subarray(pos, pos + total))
      pos += total
    }
    const read = readMseedHour(new Uint8Array(out))
    expect(read.packets).toHaveLength(0)
    expect(read.incompletePackets).toBe(1)
  })

  it('正: 起動 ID・番号を読めない波形のレコードは、捨てずに本数を数える', async () => {
    const buf = await writeAll([{ p: payload(0), rx: T, lane: 'live' }])
    // 検査値は合うが、拡張ヘッダにこの観測網の欄が無い波形のレコードを 1 本足す。
    const sourceId = 'FDSN:XX_00000001_I2C0-68_H_N_1'
    const extra = '{}'
    const block = encodeSteim2(Int32Array.from([1, 2, 3]), framesForRecord(sourceId, extra.length))
    const odd = buildMseed3Record({ sourceId, startMs: T, sampleRateHz: 100, block, timeQuestionable: false, extraHeaders: extra })
    const read = readMseedHour(new Uint8Array([...buf, ...odd]))
    expect(read.crcFailures).toBe(0)
    expect(read.unreadableWaveRecords).toBe(1)
    // 残りは普通に組み上がる。
    expect(read.packets).toHaveLength(1)
  })

  it('対照: ふつうに書いた本では、読めない波形のレコードは 0', async () => {
    const read = readMseedHour(await writeAll([{ p: payload(0), rx: T, lane: 'live' }, { p: payload(9000), rx: T, lane: 'backlog' }]))
    expect(read.unreadableWaveRecords).toBe(0)
  })

  it('安全弁: 取り戻した分の一部の軸だけ書けて訊き直しても、組み上がるパケットは 1 つ（既知の限界: 書けた軸の波形は 2 本残る）', async () => {
    // 2 本目の書き込み（1 つ目のパケットの 2 軸目）だけが失敗する流し口。流し口ごと壊すと
    // 開き直しの間隔に入り、訊き直しの分まで書けなくなるので、その 1 本にだけ失敗を返す。
    let writes = 0
    const openStream = (path: string): Writable => {
      const real = createWriteStream(path, { flags: 'a' })
      const flaky = {
        write: (bytes: Uint8Array, cb: (error?: Error | null) => void) => {
          writes += 1
          if (writes === 2) {
            queueMicrotask(() => cb(new Error('EIO')))
            return true
          }
          return real.write(bytes, cb)
        },
        end: (cb: () => void) => real.end(cb),
        on: (event: string, listener: (...args: unknown[]) => void) => {
          real.on(event, listener)
          return flaky
        },
      }
      return flaky as unknown as Writable
    }
    const r = new MseedRecorder({ dir, now: () => T, openStream })
    const p = payload(9000)
    expect(await r.acceptRecovered(SRC, p, T)).toBe(false)
    expect(await r.acceptRecovered(SRC, p, T)).toBe(true)
    await r.close()
    const buf = new Uint8Array(readFileSync(mseedFilePath(dir, T)!))
    const read = readMseedHour(buf)
    expect(read.packets.map((x) => x.packet)).toEqual([packetOf(p)])
    expect(read.incompletePackets).toBe(0)
    // 重なった側にも印が付くので、使われなかったサンプルには数えない。
    expect(read.unclaimedSamples).toBe(0)
    // 1 回目に書けた 2 軸（1・3 軸目）の波形が、2 回目の 3 軸と重なってファイルに残る。
    let waveRecords = 0
    let pos = 0
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    while (pos < buf.length) {
      if (buf[pos + 15] === 11) waveRecords += 1
      pos += 40 + buf[pos + 33]! + view.getUint16(pos + 34, true) + view.getUint32(pos + 36, true)
    }
    expect(waveRecords).toBe(5)
  })
})

describe('orderByReceipt', () => {
  it('受け取った順に並べ、時刻が無いものは名乗った時刻で並べる（同じなら元の順）', async () => {
    const out = readMseedHour(
      await writeAll([
        { p: payload(0), rx: T + 900, lane: 'live' },
        { p: payload(0, { sid: 'i2c0-69' }), rx: T + 300, lane: 'live' },
        { p: payload(0, { sid: 'i2c1-68' }), rx: null, lane: 'live' },
      ]),
    )
    expect(orderByReceipt(out.packets).map((x) => x.packet.sensorId)).toEqual(['i2c1-68', 'i2c0-69', 'i2c0-68'])
  })

  it('受け取った時刻が同じミリ秒なら、ホストが受け付けた順に戻す', async () => {
    // 2 つのセンサーが交互に届き、受け取った時刻はどれも同じミリ秒。
    const sends = [0, 30, 60].flatMap((q) => [
      { p: payload(q), rx: T + 900, lane: 'live' as const },
      { p: payload(q, { sid: 'i2c0-69' }), rx: T + 900, lane: 'live' as const },
    ])
    const out = readMseedHour(await writeAll(sends))
    const key = (x: { packet: SensorPacket }): string => `${x.packet.sensorId}/${x.packet.firstSeq}`
    const sent = sends.map((s) => key({ packet: packetOf(s.p) }))
    // 対照: ファイルの中では受信の記録が流れごとにまとまるので、受け付けた順ではない。
    expect(out.packets.map(key)).not.toEqual(sent)
    expect(orderByReceipt(out.packets).map(key)).toEqual(sent)
  })
})
