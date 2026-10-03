import { decodeSteim2 as referenceDecode } from 'seisplotjs-seedcodec'
import { describe, expect, it } from 'vitest'

import { buildMseed3Record, framesForRecord } from './mseed3Record'
import { readMseed3Records } from './mseed3Reader'
import { decodeSteim2, encodeSteim2 } from './steim2'

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function walk(n: number, amp: number, seed = 3): Int32Array {
  const r = seeded(seed)
  let x = 0
  return Int32Array.from({ length: n }, () => (x += Math.round((r() * 2 - 1) * amp)))
}

const SID = 'FDSN:XX_6525EAD0_I2C0-68_H_N_1'
const T = Date.UTC(2026, 9, 1, 3, 30, 0, 123) + 0.5

describe('decodeSteim2', () => {
  it.each([0, 3, 7, 8, 31, 32, 127, 128, 511, 512, 16383, 16384, 30000, 2 ** 28])('振幅 ±%i で、別の実装と同じ値に戻す', (amp) => {
    const xs = walk(2000, amp)
    let pos = 0
    while (pos < xs.length) {
      const part = xs.subarray(pos)
      const block = encodeSteim2(part, 6)
      const mine = decodeSteim2(block.payload, block.sampleCount)
      const ref = referenceDecode(new DataView(block.payload.buffer, block.payload.byteOffset, block.payload.byteLength), block.sampleCount, false, 0)
      expect(Array.from(mine)).toEqual(Array.from(ref))
      expect(Array.from(mine)).toEqual(Array.from(part.subarray(0, block.sampleCount)))
      pos += block.sampleCount
    }
  })

  it('末尾値（Xn）と合わなければ投げる（中身が壊れている）', () => {
    const block = encodeSteim2(walk(100, 50), 6)
    const broken = block.payload.slice()
    // 語 3（最初の差分の語）を壊す。
    broken[15] = broken[15]! ^ 0x01
    expect(() => decodeSteim2(broken, block.sampleCount)).toThrow()
  })

  it('長さが 64 の倍数でなければ投げる', () => {
    expect(() => decodeSteim2(new Uint8Array(10), 1)).toThrow()
  })

  it('名乗る件数がフレームに収まらなければ投げる', () => {
    const block = encodeSteim2(walk(50, 5), 6)
    expect(() => decodeSteim2(block.payload, block.sampleCount + 1)).toThrow()
  })
})

describe('readMseed3Records', () => {
  function record(samples: Int32Array, startMs: number, extra?: string, questionable = false): Uint8Array {
    const block = encodeSteim2(samples, framesForRecord(SID, 48))
    return buildMseed3Record({ sourceId: SID, startMs, sampleRateHz: 100, block, extraHeaders: extra, timeQuestionable: questionable })
  }

  it('並んだレコードを順に読み、時刻・刻み・識別子・拡張ヘッダ・サンプルを戻す', () => {
    const a = walk(200, 40, 1)
    const b = walk(150, 40, 2)
    const buf = new Uint8Array([...record(a, T, '{"b":"63c9812e","q":0}'), ...record(b, T + 2_000, '{"b":"63c9812e","q":200,"r":1}', true)])
    const out = readMseed3Records(buf)
    expect(out.skippedBytes).toBe(0)
    expect(out.crcFailures).toBe(0)
    expect(out.records).toHaveLength(2)
    const [r0, r1] = out.records
    expect(r0!.sourceId).toBe(SID)
    expect(r0!.startMs).toBeCloseTo(T, 6)
    expect(r0!.sampleRateHz).toBe(100)
    expect(r0!.extra).toEqual({ b: '63c9812e', q: 0 })
    expect(r0!.timeQuestionable).toBe(false)
    expect(Array.from(r0!.samples!)).toEqual(Array.from(a.subarray(0, r0!.samples!.length)))
    expect(r1!.extra).toEqual({ b: '63c9812e', q: 200, r: 1 })
    expect(r1!.timeQuestionable).toBe(true)
  })

  it('検査値が合わないレコードは採らずに数え、次のレコードへ進む', () => {
    const good = record(walk(100, 10, 4), T)
    const bad = record(walk(100, 10, 5), T + 1_000)
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff
    const out = readMseed3Records(new Uint8Array([...bad, ...good]))
    expect(out.crcFailures).toBe(1)
    expect(out.records).toHaveLength(1)
  })

  it('書きかけの末尾（長さが足りない）は読まずに、読まなかったバイト数を返す', () => {
    const r = record(walk(100, 10, 6), T)
    const buf = new Uint8Array([...r, ...r.subarray(0, 100)])
    const out = readMseed3Records(buf)
    expect(out.records).toHaveLength(1)
    expect(out.skippedBytes).toBe(100)
  })

  it('目印（MS・版 3）が合わない位置でやめる', () => {
    const out = readMseed3Records(new Uint8Array([0x4d, 0x53, 2, ...new Uint8Array(60)]))
    expect(out.records).toHaveLength(0)
    expect(out.skippedBytes).toBe(63)
  })
})
