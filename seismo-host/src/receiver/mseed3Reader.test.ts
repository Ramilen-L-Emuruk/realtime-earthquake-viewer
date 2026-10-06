import { decodeSteim2 as referenceDecode } from 'seisplotjs-seedcodec'
import { describe, expect, it } from 'vitest'

import { crc32c } from './crc32c'
import { buildMseed3Record, buildMseed3TextRecord, framesForRecord } from './mseed3Record'
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

const SID = 'FDSN:XX_00000001_I2C0-68_H_N_1'
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

  it('Node の Buffer（ファイルから読んだもの）でも全部のレコードを読み、渡したバッファを書き換えない', () => {
    // **`Buffer#slice` は写しを作らない。** 写しのつもりで検査値の欄を 0 にすると、元のバッファ
    // （の先頭レコード）を書き換え、2 本目以降はすべて「検査値が合わない」に化ける。
    // 前に余白を置き、バッファがメモリの先頭から始まらない形にする（readFileSync の大きなファイルと同じ）。
    const bytes = new Uint8Array([...record(walk(200, 40, 11), T), ...record(walk(200, 40, 12), T + 2_000), ...record(walk(200, 40, 13), T + 4_000)])
    const backing = Buffer.alloc(bytes.length + 64)
    backing.set(bytes, 64)
    const buf = backing.subarray(64)
    const before = Buffer.from(buf)
    const out = readMseed3Records(buf)
    expect(out.crcFailures).toBe(0)
    expect(out.records).toHaveLength(3)
    expect(Buffer.compare(buf, before)).toBe(0)
    expect(Buffer.compare(backing.subarray(0, 64), Buffer.alloc(64))).toBe(0)
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

  it('波形と受信の記録（テキスト）が混ざって並んでも、それぞれの中身を戻す', () => {
    const wave = walk(200, 40, 7)
    const text = '{"seq":0,"packets":[[0,30,0,0,0]]}'
    const buf = new Uint8Array([
      ...record(wave, T),
      ...buildMseed3TextRecord({ sourceId: 'FDSN:XX_00000001_I2C0-68_L_O_G', startMs: T, text }),
      ...record(walk(100, 40, 8), T + 2_000),
    ])
    const out = readMseed3Records(buf)
    expect(out.skippedBytes).toBe(0)
    expect(out.records.map((r) => r.encoding)).toEqual([11, 0, 11])
    expect(out.records[1]!.text).toBe(text)
    expect(out.records[1]!.samples).toBeNull()
    expect(out.records[0]!.text).toBeNull()
  })

  it('UTF-8 として読めないテキストは置換文字で通さず、復号できなかったと数える', () => {
    const r = buildMseed3TextRecord({ sourceId: 'FDSN:XX_00000001_I2C0-68_L_O_G', startMs: T, text: 'ab' })
    // データ部の 1 バイト目を UTF-8 の続きのバイト（単独では不正）へ差し替え、検査値を付け直す。
    const sidLen = r[33]!
    r[40 + sidLen] = 0x80
    const v = new DataView(r.buffer)
    v.setUint32(28, 0, true)
    v.setUint32(28, crc32c(r), true)
    const out = readMseed3Records(r)
    expect(out.decodeFailures).toBe(1)
    expect(out.records[0]!.text).toBeNull()
  })
})
