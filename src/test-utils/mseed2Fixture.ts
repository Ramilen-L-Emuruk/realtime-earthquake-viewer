/**
 * テスト用の miniSEED 2 レコード（512 バイト）を組む。データ部はホストの Steim2 符号化器で詰める
 * （出どころの違う復号器 seisplotjs-seedcodec で確かめてある。`seismo-host/src/receiver/mseed3.test.ts`）。
 */
import { encodeSteim2 } from '../../seismo-host/src/receiver/steim2'

export interface Mseed2FixtureHeader {
  station?: string
  channel?: string
  network?: string
  location?: string
  year?: number
  dayOfYear?: number
  hms?: [number, number, number]
  ticks?: number
  factor?: number
  multiplier?: number
  activity?: number
  correction?: number
  encoding?: number
  microseconds?: number | null
  little?: boolean
  dataLittle?: boolean
}

/** 512 バイトのレコードを組む。データ部は `payload`（Steim のフレーム列）をそのまま置く。 */
export function mseed2Record(samples: number, payload: Uint8Array, h: Mseed2FixtureHeader = {}): Uint8Array {
  const buf = new Uint8Array(512)
  const v = new DataView(buf.buffer)
  const le = h.little ?? false
  const put = (at: number, s: string, len: number) => {
    for (let i = 0; i < len; i++) buf[at + i] = i < s.length ? s.charCodeAt(i) : 0x20
  }
  put(0, '000001', 6)
  buf[6] = 'D'.charCodeAt(0)
  buf[7] = 0x20
  put(8, h.station ?? 'JMN', 5)
  put(13, h.location ?? '', 2)
  put(15, h.channel ?? 'BHZ', 3)
  put(18, h.network ?? 'JP', 2)
  v.setUint16(20, h.year ?? 2026, le)
  v.setUint16(22, h.dayOfYear ?? 286, le)
  const [hh, mm, ss] = h.hms ?? [11, 44, 29]
  buf[24] = hh
  buf[25] = mm
  buf[26] = ss
  v.setUint16(28, h.ticks ?? 1234, le)
  v.setUint16(30, samples, le)
  v.setInt16(32, h.factor ?? 20, le)
  v.setInt16(34, h.multiplier ?? 1, le)
  buf[36] = h.activity ?? 0
  v.setInt32(40, h.correction ?? 0, le)
  v.setUint16(44, 64, le)
  v.setUint16(46, 48, le)
  // Blockette 1000
  v.setUint16(48, 1000, le)
  const withB1001 = h.microseconds !== null && h.microseconds !== undefined
  v.setUint16(50, withB1001 ? 56 : 0, le)
  buf[52] = h.encoding ?? 11
  buf[53] = (h.dataLittle ?? false) ? 0 : 1
  buf[54] = 9
  if (withB1001) {
    v.setUint16(56, 1001, le)
    v.setUint16(58, 0, le)
    v.setInt8(61, h.microseconds as number)
  }
  buf.set(payload.subarray(0, 448), 64)
  return buf
}

/** 再現できる擬似乱数（実データに近い、ゆっくり動く整数列） */
export function walk(n: number, seed: number, step: number): Int32Array {
  let s = seed >>> 0
  const out = new Int32Array(n)
  let x = 1_000_000
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    x += Math.round(((s / 2 ** 32) - 0.5) * step)
    out[i] = x
  }
  return out
}

export function steim2Record(values: Int32Array, h: Mseed2FixtureHeader = {}) {
  const block = encodeSteim2(values, 7)
  return { bytes: mseed2Record(block.sampleCount, block.payload, h), count: block.sampleCount }
}
