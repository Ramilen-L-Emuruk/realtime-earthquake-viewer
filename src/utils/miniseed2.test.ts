import { describe, expect, it } from 'vitest'
// **データ部は別の実装で詰める。** 自分で書いた復号器を自分で書いた符号化器で確かめると、同じ読み違いを
// 両側に持っていても一致してしまう。ホストの Steim2 符号化器は、出どころの違う復号器
// （seisplotjs-seedcodec）で確かめてある（`seismo-host/src/receiver/mseed3.test.ts`）。
// 実レコード（2026-10-14 に受けた JP 網の 15,980 本）でも、別に書いた読み手と全件一致を確かめた
import { mseed2Record as record, steim2Record, walk } from '../test-utils/mseed2Fixture'
import { Mseed2Error, parseMseed2Record, sampleRateFrom } from './miniseed2'

describe('parseMseed2Record', () => {
  it('Steim2 のデータ部を、詰めたとおりのサンプルへ戻す（差分の幅が小さい・大きい両方）', () => {
    // 歩幅で詰め方が変わる（4・5・6・8・10・15・30 ビット）。どの副種別も踏むように並べる
    for (const [seed, step] of [[1, 10], [12, 40], [13, 100], [14, 400], [2, 2_000], [15, 50_000], [3, 400_000]] as const) {
      const values = walk(600, seed, step)
      const { bytes, count } = steim2Record(values)
      const r = parseMseed2Record(bytes)
      expect(r.samples.length).toBe(count)
      expect(Array.from(r.samples)).toEqual(Array.from(values.subarray(0, count)))
    }
  })

  it('最初の差分（前のレコードとの差）は使わず、先頭値から組み立てる', () => {
    const values = walk(80, 16, 50)
    const { bytes, count } = steim2Record(values)
    // 最初のフレームの語 3 の上位 8 ビット＝最初の差分。大きな値へ書き換えても結果は変わらない
    const v = new DataView(bytes.buffer)
    const word = v.getUint32(64 + 12)
    const nib = (v.getUint32(64) >>> (2 * (15 - 3))) & 3
    expect(nib).toBe(3) // 4 ビット詰め（歩幅 50 は 4〜6 ビット）
    v.setUint32(64 + 12, ((word & 0xc0ffffff) | (0x2a << 24)) >>> 0)
    expect(Array.from(parseMseed2Record(bytes).samples)).toEqual(Array.from(values.subarray(0, count)))
  })

  it('データ部が小さいバイト順（Blockette 1000 の印）でも読む', () => {
    const values = walk(90, 17, 300)
    const block = steim2Record(values)
    const bytes = block.bytes
    const v = new DataView(bytes.buffer)
    for (let o = 64; o < 512; o += 4) v.setUint32(o, v.getUint32(o, false), true)
    bytes[53] = 0 // 小さいバイト順
    expect(Array.from(parseMseed2Record(bytes).samples)).toEqual(Array.from(values.subarray(0, block.count)))
  })

  it('サンプルが無いレコードは空で返す（データ部の位置が 0 でもよい）', () => {
    const bytes = record(0, new Uint8Array(0))
    new DataView(bytes.buffer).setUint16(44, 0)
    expect(parseMseed2Record(bytes).samples.length).toBe(0)
  })

  it('閏年でない年の通日 366 は断る（翌年へ黙って流さない）', () => {
    const { bytes } = steim2Record(walk(10, 18, 50), { year: 2026, dayOfYear: 366 })
    expect(() => parseMseed2Record(bytes)).toThrow(Mseed2Error)
    const leap = steim2Record(walk(10, 18, 50), { year: 2024, dayOfYear: 366 }).bytes
    expect(parseMseed2Record(leap).startMs).toBe(Date.UTC(2024, 11, 31, 11, 44, 29) + 123.4)
  })

  it('ブロケットが末尾をはみ出す位置を指しても、Mseed2Error で断る（RangeError を出さない）', () => {
    for (const at of [505, 508, 511, 20]) {
      const { bytes } = steim2Record(walk(10, 19, 50))
      new DataView(bytes.buffer).setUint16(46, at)
      expect(() => parseMseed2Record(bytes), `位置 ${at}`).toThrow(Mseed2Error)
    }
  })

  it('壊れた入力（ランダムに書き換えた見出しとデータ部）で、Mseed2Error 以外は投げない', () => {
    let s = 12345
    const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const base = steim2Record(walk(300, 20, 500)).bytes
    for (let trial = 0; trial < 2000; trial++) {
      const bytes = base.slice()
      const n = 1 + Math.floor(rand() * 8)
      for (let k = 0; k < n; k++) bytes[Math.floor(rand() * 512)] = Math.floor(rand() * 256)
      try {
        parseMseed2Record(trial % 7 === 0 ? bytes.subarray(0, Math.floor(rand() * 512)) : bytes)
      } catch (e) {
        expect(e, `試行 ${trial}`).toBeInstanceOf(Mseed2Error)
      }
    }
  })

  it('見出しの名前・品質・採取率・レコード長を読む', () => {
    const { bytes } = steim2Record(walk(100, 4, 50), { station: 'YOJ', channel: 'BHN', location: '00' })
    const r = parseMseed2Record(bytes)
    expect([r.network, r.station, r.location, r.channel, r.quality]).toEqual(['JP', 'YOJ', '00', 'BHN', 'D'])
    expect(r.sampleRate).toBe(20)
    expect(r.recordLength).toBe(512)
  })

  it('時刻は年・通日・時分秒・0.1 ms 刻みから組み立てる（通日 286 = 10 月 13 日）', () => {
    const { bytes } = steim2Record(walk(50, 5, 50))
    expect(parseMseed2Record(bytes).startMs).toBe(Date.UTC(2026, 9, 13, 11, 44, 29) + 123.4)
  })

  it('時刻の補正は、まだ足されていない（活動の印の 2 ビット目が立っていない）ときだけ足す', () => {
    const base = Date.UTC(2026, 9, 13, 11, 44, 29) + 123.4
    const notApplied = steim2Record(walk(50, 6, 50), { correction: 5_000 }).bytes
    expect(parseMseed2Record(notApplied).startMs).toBeCloseTo(base + 500, 6)
    const applied = steim2Record(walk(50, 6, 50), { correction: 5_000, activity: 0x02 }).bytes
    expect(parseMseed2Record(applied).startMs).toBeCloseTo(base, 6)
  })

  it('Blockette 1001 のマイクロ秒を足す', () => {
    const { bytes } = steim2Record(walk(50, 7, 50), { microseconds: -37 })
    expect(parseMseed2Record(bytes).startMs).toBeCloseTo(Date.UTC(2026, 9, 13, 11, 44, 29) + 123.4 - 0.037, 6)
  })

  it('見出しが小さいバイト順でも読む（年の欄で見分ける）', () => {
    const values = walk(80, 8, 50)
    const { bytes, count } = steim2Record(values, { little: true })
    const r = parseMseed2Record(bytes)
    expect(r.startMs).toBe(Date.UTC(2026, 9, 13, 11, 44, 29) + 123.4)
    expect(Array.from(r.samples)).toEqual(Array.from(values.subarray(0, count)))
  })

  it('Steim1 も読む（8・16・32 ビットの語を手で組んだ見本）', () => {
    // 差分: 8 ビット ×4（語 3）・16 ビット ×2（語 4）・32 ビット ×1（語 5）
    const diffs = [0, -3, 100, -128, 30_000, -32_768, 2_000_000_000]
    const values: number[] = []
    let x = 7
    for (let i = 0; i < diffs.length; i++) {
      x = i === 0 ? 7 : (x + diffs[i]!) | 0
      values.push(x)
    }
    const payload = new Uint8Array(64)
    const v = new DataView(payload.buffer)
    v.setUint32(0, ((1 << (2 * 12)) | (2 << (2 * 11)) | (3 << (2 * 10))) >>> 0)
    v.setInt32(4, values[0]!)
    v.setInt32(8, values[values.length - 1]!)
    v.setUint32(12, (((diffs[0]! & 0xff) << 24) | ((diffs[1]! & 0xff) << 16) | ((diffs[2]! & 0xff) << 8) | (diffs[3]! & 0xff)) >>> 0)
    v.setUint32(16, (((diffs[4]! & 0xffff) << 16) | (diffs[5]! & 0xffff)) >>> 0)
    v.setInt32(20, diffs[6]!)
    const r = parseMseed2Record(record(values.length, payload, { encoding: 10 }))
    expect(Array.from(r.samples)).toEqual(values)
  })

  it('末尾値が合わないレコードは壊れたものとして断る', () => {
    const { bytes } = steim2Record(walk(100, 9, 50))
    new DataView(bytes.buffer).setInt32(64 + 8, 42) // 末尾値を書き換える
    expect(() => parseMseed2Record(bytes)).toThrow(Mseed2Error)
    try {
      parseMseed2Record(bytes)
    } catch (e) {
      expect((e as Mseed2Error).problem).toBe('steim-check-failed')
    }
  })

  it('読まない符号化・Blockette 1000 の無いレコード・短すぎる入力は、理由つきで断る', () => {
    const problemOf = (bytes: Uint8Array) => {
      try {
        parseMseed2Record(bytes)
        return null
      } catch (e) {
        return (e as Mseed2Error).problem
      }
    }
    const { bytes } = steim2Record(walk(10, 10, 50), { encoding: 3 })
    expect(problemOf(bytes)).toBe('unsupported-encoding')
    const noBlockette = steim2Record(walk(10, 11, 50)).bytes
    new DataView(noBlockette.buffer).setUint16(46, 0)
    expect(problemOf(noBlockette)).toBe('no-blockette-1000')
    expect(problemOf(new Uint8Array(20))).toBe('too-short')
    expect(problemOf(new Uint8Array(512))).toBe('bad-header')
  })
})

describe('sampleRateFrom（SEED 2.4 の係数と倍数）', () => {
  it('正の係数は Hz、負の係数は周期（秒）として読む', () => {
    expect(sampleRateFrom(20, 1)).toBe(20)
    expect(sampleRateFrom(40, -2)).toBe(20)
    expect(sampleRateFrom(-10, 1)).toBe(0.1)
    expect(sampleRateFrom(-1, -10)).toBe(0.1)
    expect(sampleRateFrom(0, 1)).toBe(0)
  })
})
