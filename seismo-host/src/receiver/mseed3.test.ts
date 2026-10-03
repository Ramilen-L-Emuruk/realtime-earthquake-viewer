import { describe, expect, it } from 'vitest'
// **復号は別の実装で確かめる。** 自分で書いた符号化器を自分で書いた復号器で戻しても、
// 同じ読み違いを両側に持っていれば一致してしまう。seisplotjs-seedcodec は SEED の Java 実装
// （seedCodec）から移したもので、こちらとは出どころが違う。
import { decodeSteim2 } from 'seisplotjs-seedcodec'

import { crc32c } from './crc32c'
import {
  MSEED3_MAX_RECORD_BYTES,
  buildMseed3Record,
  framesForRecord,
  mseed3SourceId,
} from './mseed3Record'
import { encodeSteim2 } from './steim2'

function decode(payload: Uint8Array, count: number): Int32Array {
  // 第 3 引数は「小さいバイト順で読むか」。Steim2 は大きいバイト順なので false。
  return decodeSteim2(new DataView(payload.buffer, payload.byteOffset, payload.byteLength), count, false, 0)
}

/** 再現できる擬似乱数（テストが走るたびに値が変わらないように）。 */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function noise(n: number, amp: number, seed = 1): Int32Array {
  const r = seeded(seed)
  return Int32Array.from({ length: n }, () => Math.round((r() * 2 - 1) * amp))
}

function walk(n: number, amp: number, seed = 2): Int32Array {
  const r = seeded(seed)
  let x = 0
  return Int32Array.from({ length: n }, () => (x += Math.round((r() * 2 - 1) * amp)))
}

/** 先頭から順に詰め、全件を戻せることを確かめる。何本に分かれたかを返す。 */
function roundTrip(xs: Int32Array, maxFrames: number): number {
  let pos = 0
  let blocks = 0
  while (pos < xs.length) {
    const part = xs.subarray(pos)
    const block = encodeSteim2(part, maxFrames)
    expect(block.sampleCount).toBeGreaterThan(0)
    expect(block.payload.byteLength % 64).toBe(0)
    expect(block.payload.byteLength / 64).toBeLessThanOrEqual(maxFrames)
    const back = decode(block.payload, block.sampleCount)
    expect(Array.from(back)).toEqual(Array.from(part.subarray(0, block.sampleCount)))
    pos += block.sampleCount
    blocks += 1
  }
  return blocks
}

describe('crc32c', () => {
  it('規格の検査値と一致する（RFC 3720 B.4 の "123456789"）', () => {
    expect(crc32c(new TextEncoder().encode('123456789'))).toBe(0xe3069283)
  })

  it('空の列は 0', () => {
    expect(crc32c(new Uint8Array(0))).toBe(0)
  })

  it('32 バイトの 0 は RFC 3720 B.4 の値', () => {
    expect(crc32c(new Uint8Array(32))).toBe(0x8a9136aa)
  })
})

describe('encodeSteim2', () => {
  it.each([0, 1, 7, 8, 15, 16, 31, 32, 127, 128, 511, 512, 16383, 16384, 30000])(
    '振幅 ±%i の雑音も酔歩も元へ戻る',
    (amp) => {
      roundTrip(noise(3000, amp), 6)
      roundTrip(walk(3000, amp), 6)
    },
  )

  it('差分の幅の境目そのものを戻せる', () => {
    // 4・5・6・8・10・15・30 ビットの、それぞれ入る端と入らない端。
    const diffs = [7, -8, 8, -9, 15, -16, 16, -17, 31, -32, 32, -33, 127, -128, 128, -129, 511, -512, 512, -513, 16383, -16384, 16384, -16385, 2 ** 29 - 1, -(2 ** 29)]
    let x = 0
    const xs = Int32Array.from([0, ...diffs.map((d) => (x += d))])
    roundTrip(xs, 6)
  })

  it('1 件だけでも戻る', () => {
    roundTrip(Int32Array.from([12345]), 6)
  })

  it('MPU6050 が出しうる 16 ビットの両端を行き来しても戻る', () => {
    roundTrip(Int32Array.from({ length: 2000 }, (_, i) => (i % 2 === 0 ? 32767 : -32768)), 6)
  })

  it('フレーム数の上限を守り、入りきらない分は次へ回す', () => {
    const xs = walk(5000, 300)
    const block = encodeSteim2(xs, 6)
    expect(block.payload.byteLength).toBe(6 * 64)
    expect(block.sampleCount).toBeLessThan(xs.length)
    expect(roundTrip(xs, 6)).toBeGreaterThan(1)
  })

  it('30 ビットに収まらない差分の手前で止める（次の本で新しい先頭値から始められる）', () => {
    const xs = Int32Array.from([0, 1, 2, 2 ** 30, 2 ** 30 + 1])
    const first = encodeSteim2(xs, 6)
    expect(first.sampleCount).toBe(3)
    // 止まった位置から始めれば、先頭値として収まる。
    const second = encodeSteim2(xs.subarray(3), 6)
    expect(second.sampleCount).toBe(2)
    expect(Array.from(decode(second.payload, 2))).toEqual([2 ** 30, 2 ** 30 + 1])
  })

  it('空の列は受け付けない', () => {
    expect(() => encodeSteim2(new Int32Array(0), 6)).toThrow(RangeError)
  })

  it('フレーム数が 1 未満なら受け付けない', () => {
    expect(() => encodeSteim2(Int32Array.from([1]), 0)).toThrow(RangeError)
  })

  it('先頭のフレームに先頭値と末尾値を書く（SEED 付録 B の X0・Xn）', () => {
    const xs = Int32Array.from([100, 101, 99, 105, -7])
    const { payload } = encodeSteim2(xs, 6)
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    expect(view.getInt32(4, false)).toBe(100)
    expect(view.getInt32(8, false)).toBe(-7)
  })
})

describe('mseed3SourceId', () => {
  it('MAC の下位 8 桁とセンサー ID から組み立てる', () => {
    expect(mseed3SourceId('mac:a0b76525ead0', 'i2c0-68', 'HN1')).toBe('FDSN:XX_6525EAD0_I2C0-68_H_N_1')
  })

  it('MAC を名乗らない基板（版 1）には識別子を作らない', () => {
    expect(mseed3SourceId('name:seismo-3', 'i2c0-68', 'HN1')).toBeNull()
  })

  it('MAC が 12 桁の 16 進でなければ作らない', () => {
    expect(mseed3SourceId('mac:a0b7', 'i2c0-68', 'HN1')).toBeNull()
    expect(mseed3SourceId('mac:zzb76525ead0', 'i2c0-68', 'HN1')).toBeNull()
  })

  it('センサー ID がロケーションの規則（英数字と - で 8 文字まで・"--" 禁止）に収まらなければ作らない', () => {
    expect(mseed3SourceId('mac:a0b76525ead0', 'i2c0-68-long', 'HN1')).toBeNull()
    expect(mseed3SourceId('mac:a0b76525ead0', 'i2c0_68', 'HN1')).toBeNull()
    expect(mseed3SourceId('mac:a0b76525ead0', '--', 'HN1')).toBeNull()
  })

  it('チャンネルが英数字 3 文字でなければ作らない', () => {
    expect(mseed3SourceId('mac:a0b76525ead0', 'i2c0-68', 'HN')).toBeNull()
    expect(mseed3SourceId('mac:a0b76525ead0', 'i2c0-68', 'HN-')).toBeNull()
  })
})

describe('buildMseed3Record', () => {
  const sid = 'FDSN:XX_6525EAD0_I2C0-68_H_N_1'
  const samples = walk(400, 40)
  const block = encodeSteim2(samples, framesForRecord(sid))
  // 2024-02-29（閏日）を通しの日で 60 日目として書けるかも見る。
  const startMs = Date.UTC(2024, 1, 29, 13, 4, 5, 678) + 0.25

  const record = buildMseed3Record({ sourceId: sid, startMs, sampleRateHz: 100, block })
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength)

  it('512 バイトに収まる', () => {
    expect(record.byteLength).toBeLessThanOrEqual(MSEED3_MAX_RECORD_BYTES)
  })

  it('固定ヘッダの各欄が規格の位置にある', () => {
    expect(String.fromCharCode(record[0]!, record[1]!)).toBe('MS')
    expect(record[2]).toBe(3)
    expect(record[3]).toBe(0)
    expect(view.getUint32(4, true)).toBe(678_250_000)
    expect(view.getUint16(8, true)).toBe(2024)
    expect(view.getUint16(10, true)).toBe(60)
    expect(record[12]).toBe(13)
    expect(record[13]).toBe(4)
    expect(record[14]).toBe(5)
    expect(record[15]).toBe(11)
    expect(view.getFloat64(16, true)).toBe(100)
    expect(view.getUint32(24, true)).toBe(block.sampleCount)
    expect(record[32]).toBe(1)
    expect(record[33]).toBe(sid.length)
    expect(view.getUint16(34, true)).toBe(0)
    expect(view.getUint32(36, true)).toBe(block.payload.byteLength)
    expect(record.byteLength).toBe(40 + sid.length + block.payload.byteLength)
  })

  it('識別子をヘッダの直後に置く', () => {
    expect(new TextDecoder().decode(record.subarray(40, 40 + sid.length))).toBe(sid)
  })

  it('CRC は CRC 欄を 0 にした記録全体の CRC-32C', () => {
    const copy = record.slice()
    new DataView(copy.buffer).setUint32(28, 0, true)
    expect(view.getUint32(28, true)).toBe(crc32c(copy))
  })

  it('データ部を別の実装で戻すと元のサンプルになる', () => {
    const payload = record.subarray(40 + sid.length)
    expect(Array.from(decode(payload, block.sampleCount))).toEqual(Array.from(samples.subarray(0, block.sampleCount)))
  })

  it('時刻の端数が 1 秒へ繰り上がる場合も正しく書く', () => {
    const r = buildMseed3Record({ sourceId: sid, startMs: Date.UTC(2026, 11, 31, 23, 59, 59, 999) + 0.9999999, sampleRateHz: 100, block })
    const v = new DataView(r.buffer, r.byteOffset, r.byteLength)
    expect(v.getUint16(8, true)).toBe(2027)
    expect(v.getUint16(10, true)).toBe(1)
    expect([r[12], r[13], r[14]]).toEqual([0, 0, 0])
    expect(v.getUint32(4, true)).toBe(0)
  })

  it('時刻の質を旗で伝えられる（ビット 1 = 時刻が疑わしい）', () => {
    const r = buildMseed3Record({ sourceId: sid, startMs, sampleRateHz: 100, block, timeQuestionable: true })
    expect(r[3]).toBe(0b10)
  })

  it('非有限の時刻・負の時刻・刻みは受け付けない', () => {
    expect(() => buildMseed3Record({ sourceId: sid, startMs: Number.NaN, sampleRateHz: 100, block })).toThrow(RangeError)
    expect(() => buildMseed3Record({ sourceId: sid, startMs: -1, sampleRateHz: 100, block })).toThrow(RangeError)
    expect(() => buildMseed3Record({ sourceId: sid, startMs, sampleRateHz: 0, block })).toThrow(RangeError)
  })

  it('512 バイトに収まらない組み合わせは受け付けない', () => {
    const big = encodeSteim2(walk(3000, 3000), 7)
    expect(() => buildMseed3Record({ sourceId: sid, startMs, sampleRateHz: 100, block: big })).toThrow(RangeError)
  })
})

describe('framesForRecord', () => {
  it('識別子の長さに応じて、512 バイトへ収まる最大のフレーム数を返す', () => {
    const sid = 'FDSN:XX_6525EAD0_I2C0-68_H_N_1'
    const frames = framesForRecord(sid)
    expect(40 + sid.length + frames * 64).toBeLessThanOrEqual(MSEED3_MAX_RECORD_BYTES)
    expect(40 + sid.length + (frames + 1) * 64).toBeGreaterThan(MSEED3_MAX_RECORD_BYTES)
  })
})
