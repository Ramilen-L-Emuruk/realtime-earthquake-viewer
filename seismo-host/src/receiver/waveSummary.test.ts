import { describe, expect, it } from 'vitest'

import {
  SUMMARY_COARSE_MS,
  SUMMARY_FINE_MS,
  SUMMARY_PARTS,
  SUMMARY_PEEK_BYTES,
  SummaryBuilder,
  decodeSummaryPart,
  decodeSummaryPartWhere,
  encodeSummaryPart,
  peekSummarySourceBytes,
  type SummaryChannel,
} from './waveSummary'

const HOUR_START = Date.parse('2026-10-07T03:00:00.000Z') // 日本時間 12 時
const HOUR_END = HOUR_START + 3_600_000

function builder(): SummaryBuilder {
  return new SummaryBuilder({ fromMs: HOUR_START, toMs: HOUR_END })
}

function channel(file: { channels: readonly SummaryChannel[] }, id: string): SummaryChannel {
  const c = file.channels.find((ch) => ch.id === id)
  if (c === undefined) throw new Error(`channel ${id} が無い`)
  return c
}

describe('SummaryBuilder', () => {
  it('1 秒ごとに min・max・平均・ばらつき・本数を持つ', () => {
    const b = builder()
    b.declare('A', { unit: 'count', ugPerLsb: 61.0352 })
    // 10ms 刻みで 200 点 = 2 秒ぶん。1 秒目は 0..99、2 秒目は 100 を中心に ±1。
    const values = new Array(200).fill(0).map((_, i) => (i < 100 ? i : 100 + (i % 2 === 0 ? 1 : -1)))
    b.add('A', HOUR_START, 10, values)
    const file = b.build(12345)
    const fine = channel(file, 'A').fine

    expect(fine.bucketMs).toBe(SUMMARY_FINE_MS)
    expect(fine.firstBucket).toBe(HOUR_START / SUMMARY_FINE_MS)
    expect(Array.from(fine.n)).toEqual([100, 100])
    expect(Array.from(fine.min)).toEqual([0, 99])
    expect(Array.from(fine.max)).toEqual([99, 101])
    expect(fine.mean[0]).toBeCloseTo(49.5, 4)
    expect(fine.mean[1]).toBeCloseTo(100, 4)
    // 0..99 の母分散は (100^2 - 1) / 12
    expect(fine.variance[0]).toBeCloseTo((100 * 100 - 1) / 12, 2)
    expect(fine.variance[1]).toBeCloseTo(1, 4)
    expect(file.sourceBytes).toBe(12345)
  })

  it('重力が乗った値でも小さなばらつきを潰さない（二乗和で持つと桁落ちする）', () => {
    const b = builder()
    b.declare('Z', { unit: 'count', ugPerLsb: 61.0352 })
    // 重力 1g ≒ 16384 カウントの上に ±2 カウントのノイズ。
    const values = new Array(100).fill(0).map((_, i) => 16384 + (i % 2 === 0 ? 2 : -2))
    b.add('Z', HOUR_START, 10, values)
    const fine = channel(b.build(0), 'Z').fine
    expect(fine.variance[0]).toBeCloseTo(4, 3)
  })

  it('1 分ごとの段は 1 秒の段を束ね、ノイズの分散（1 秒ごとのばらつきの平均）も持つ', () => {
    const b = builder()
    b.declare('A', { unit: 'gal', ugPerLsb: null })
    // 1 秒目は 0 の周りで ±1、2 秒目は 10 の周りで ±1。1 分のばらつきには平均の差（10）が効くが、
    // ノイズの分散は 1 秒ごとのばらつき（1）だけを見る。
    const values = new Array(200).fill(0).map((_, i) => (i < 100 ? 0 : 10) + (i % 2 === 0 ? 1 : -1))
    b.add('A', HOUR_START, 10, values)
    const coarse = channel(b.build(0), 'A').coarse

    expect(coarse.bucketMs).toBe(SUMMARY_COARSE_MS)
    expect(coarse.firstBucket).toBe(HOUR_START / SUMMARY_COARSE_MS)
    expect(Array.from(coarse.n)).toEqual([200])
    expect(coarse.min[0]).toBe(-1)
    expect(coarse.max[0]).toBe(11)
    expect(coarse.mean[0]).toBeCloseTo(5, 4)
    // 全体の母分散 = ノイズ 1 ＋ 平均の差 (±5)^2 = 26
    expect(coarse.variance[0]).toBeCloseTo(26, 3)
    expect(coarse.noiseVariance).not.toBeNull()
    expect(coarse.noiseVariance![0]).toBeCloseTo(1, 4)
    expect(channel(b.build(0), 'A').fine.noiseVariance).toBeNull()
  })

  it('届かなかった秒は本数 0 で持ち、0 の値と区別できる', () => {
    const b = builder()
    b.declare('A', { unit: 'gal', ugPerLsb: null })
    b.add('A', HOUR_START, 10, new Array(100).fill(0))
    b.add('A', HOUR_START + 3000, 10, new Array(100).fill(0))
    const fine = channel(b.build(0), 'A').fine
    expect(Array.from(fine.n)).toEqual([100, 0, 0, 100])
    expect(fine.min[1]).toBeNaN()
    expect(fine.max[1]).toBeNaN()
    expect(fine.mean[1]).toBeNaN()
  })

  it('順番が前後して届いたまとまりも、時刻の秒へ入れる', () => {
    const b = builder()
    b.declare('A', { unit: 'gal', ugPerLsb: null })
    b.add('A', HOUR_START + 2000, 10, new Array(100).fill(5))
    b.add('A', HOUR_START, 10, new Array(100).fill(1))
    const fine = channel(b.build(0), 'A').fine
    expect(fine.firstBucket).toBe(HOUR_START / SUMMARY_FINE_MS)
    expect(Array.from(fine.n)).toEqual([100, 0, 100])
    expect(fine.max[0]).toBe(1)
    expect(fine.max[2]).toBe(5)
  })

  it('有限でない値は数えずに外す', () => {
    const b = builder()
    b.declare('A', { unit: 'gal', ugPerLsb: null })
    b.add('A', HOUR_START, 10, [1, Number.NaN, 3, Number.POSITIVE_INFINITY])
    const file = b.build(0)
    expect(Array.from(channel(file, 'A').fine.n)).toEqual([2])
    expect(file.droppedNonFinite).toBe(2)
  })

  it('ファイルの時間から外れたサンプル（時計が合う前の 1970 年など）は要約へ入れずに数える', () => {
    const b = builder()
    b.declare('A', { unit: 'count', ugPerLsb: 61.0352 })
    b.add('A', 1000, 10, new Array(100).fill(1))
    b.add('A', HOUR_START, 10, new Array(100).fill(2))
    const file = b.build(0)
    const fine = channel(file, 'A').fine
    expect(fine.firstBucket).toBe(HOUR_START / SUMMARY_FINE_MS)
    expect(Array.from(fine.n)).toEqual([100])
    expect(file.outOfWindowSamples).toBe(100)
  })

  it('時間の終わりを少しはみ出すまとまり（レコードは時の頭で始まる）は、はみ出した分も入れる', () => {
    const b = builder()
    b.declare('A', { unit: 'gal', ugPerLsb: null })
    // 時の終わりの 1 秒前から 3 秒ぶん。レコードは最長 5 秒なので、ここまでは正当にはみ出す。
    b.add('A', HOUR_END - 1000, 10, new Array(300).fill(1))
    const file = b.build(0)
    expect(Array.from(channel(file, 'A').fine.n)).toEqual([100, 100, 100])
    expect(file.outOfWindowSamples).toBe(0)
  })

  it('名乗っていないチャンネルへ足しても投げず、単位の分からないチャンネルとして持つ', () => {
    const b = builder()
    b.add('X', HOUR_START, 10, [1, 2])
    const c = channel(b.build(0), 'X')
    expect(c.unit).toBe('count')
    expect(c.ugPerLsb).toBeNull()
  })

  it('同じチャンネルが違う分解能を名乗ったら、換算できないものとして null にする', () => {
    const b = builder()
    b.declare('A', { unit: 'count', ugPerLsb: 61.0352 })
    b.declare('A', { unit: 'count', ugPerLsb: 122.07 })
    b.add('A', HOUR_START, 10, [1])
    const file = b.build(0)
    expect(channel(file, 'A').ugPerLsb).toBeNull()
    expect(file.conflictingScales).toBe(1)
  })

  it('1 分ごとの PSD を持つ（1 区間に満たないチャンネルは null）', () => {
    const b = builder()
    b.declare('long', { unit: 'gal', ugPerLsb: null })
    b.declare('short', { unit: 'gal', ugPerLsb: null })
    // 5 秒ずつのまとまり（レコードの長さ）で 1 分ぶん。
    for (let s = 0; s < 60; s += 5) {
      b.add('long', HOUR_START + s * 1000, 10, new Array(500).fill(0).map((_, i) => Math.sin((2 * Math.PI * 5 * (s * 100 + i)) / 100)))
    }
    b.add('short', HOUR_START, 10, new Array(500).fill(1))
    const file = b.build(0)
    const psd = channel(file, 'long').psd
    expect(psd).not.toBeNull()
    expect(psd!.firstMinute).toBe(HOUR_START / SUMMARY_COARSE_MS)
    expect(psd!.segments[0]).toBe(Math.floor((6000 - 1024) / 512) + 1)
    expect(channel(file, 'short').psd).toBeNull()
  })

  it('時の外に先頭があるまとまりは PSD にも使わない', () => {
    const b = builder()
    b.declare('A', { unit: 'gal', ugPerLsb: null })
    b.add('A', 1000, 10, new Array(2000).fill(0).map((_, i) => Math.sin(i)))
    b.add('A', HOUR_START, 10, [1])
    expect(channel(b.build(0), 'A').psd).toBeNull()
  })

  it('サンプルの無いチャンネルは出さない', () => {
    const b = builder()
    b.declare('A', { unit: 'count', ugPerLsb: 61.0352 })
    expect(b.build(0).channels).toHaveLength(0)
  })
})

describe('encodeSummaryPart / decodeSummaryPart', () => {
  it('書いたものをそのまま読み戻せる', () => {
    const b = builder()
    b.declare('FDSN:XX_A1B2C3D4_S1_H_N_Z', { unit: 'count', ugPerLsb: 61.0352 })
    b.declare('station/home/NS', { unit: 'gal', ugPerLsb: null })
    b.add('FDSN:XX_A1B2C3D4_S1_H_N_Z', HOUR_START, 10, new Array(250).fill(0).map((_, i) => 16000 + (i % 7)))
    b.add('station/home/NS', HOUR_START + 500, 10, new Array(80).fill(0).map((_, i) => Math.sin(i / 5)))
    b.add('station/home/NS', HOUR_START + 70_000, 10, new Array(50).fill(0.25))
    b.add('station/home/NS', 5, 10, [1])
    b.add('station/home/NS', HOUR_START, 10, [Number.NaN])
    b.declare('station/home/UD', { unit: 'gal', ugPerLsb: null })
    b.add('station/home/UD', HOUR_START, 10, new Array(3000).fill(0).map((_, i) => Math.sin(i / 3)))
    const file = b.build(987654, { skippedBytes: 17, badRecords: 2 })

    for (const part of SUMMARY_PARTS) {
      const decoded = decodeSummaryPart(encodeSummaryPart(file, part))
      expect(decoded).not.toBeNull()
      expect(decoded!.part).toBe(part)
      expect(decoded!.sourceBytes).toBe(987654)
      expect(decoded!.sourceProblems).toEqual({ skippedBytes: 17, badRecords: 2 })
      expect(decoded!.outOfWindowSamples).toBe(1)
      expect(decoded!.droppedNonFinite).toBe(1)
      expect(decoded!.conflictingScales).toBe(0)
      expect(decoded!.channels.map((c) => c.id)).toEqual(file.channels.map((c) => c.id))
      for (const c of file.channels) {
        const d = decoded!.channels.find((x) => x.id === c.id)!
        expect(d.unit).toBe(c.unit)
        expect(d.ugPerLsb).toBe(c.ugPerLsb)
        if (part === 'psd') {
          expect(d.level).toBeNull()
          if (c.psd === null) {
            expect(d.psd).toBeNull()
          } else {
            expect(d.psd!.firstMinute).toBe(c.psd.firstMinute)
            expect(Array.from(d.psd!.segments)).toEqual(Array.from(c.psd.segments))
            expect(Array.from(d.psd!.power)).toEqual(Array.from(c.psd.power))
          }
          continue
        }
        const want = c[part]
        const got = d.level!
        expect(d.psd).toBeNull()
        expect(got.bucketMs).toBe(want.bucketMs)
        expect(got.firstBucket).toBe(want.firstBucket)
        expect(Array.from(got.n)).toEqual(Array.from(want.n))
        expect(Array.from(got.min)).toEqual(Array.from(want.min))
        expect(Array.from(got.max)).toEqual(Array.from(want.max))
        expect(Array.from(got.mean)).toEqual(Array.from(want.mean))
        expect(Array.from(got.variance)).toEqual(Array.from(want.variance))
        if (want.noiseVariance === null) expect(got.noiseVariance).toBeNull()
        else expect(Array.from(got.noiseVariance!)).toEqual(Array.from(want.noiseVariance))
      }
    }
    // PSD のあるもの・無いものが両方入っていることを確かめておく（片方だけだと読み戻しの検査が空振る）
    expect(channel(file, 'station/home/UD').psd).not.toBeNull()
    expect(channel(file, 'station/home/NS').psd).toBeNull()
  })

  it('チャンネルを絞って読んでも、残したチャンネルは全部読んだときと同じ（PSD を持つチャンネルも飛ばせる）', () => {
    const b = builder()
    b.declare('FDSN:XX_A1B2C3D4_S1_H_N_Z', { unit: 'count', ugPerLsb: 61.0352 })
    b.declare('station/home/UD', { unit: 'gal', ugPerLsb: null })
    b.add('FDSN:XX_A1B2C3D4_S1_H_N_Z', HOUR_START, 10, new Array(3000).fill(0).map((_, i) => 16000 + (i % 7)))
    b.add('station/home/UD', HOUR_START, 10, new Array(3000).fill(0).map((_, i) => Math.sin(i / 3)))
    const file = b.build(1)
    // 両方とも PSD を持つ（飛ばす側に中身のある PSD が来ないと、飛ばし方の検査が空振る）
    expect(file.channels.every((c) => c.psd !== null)).toBe(true)
    for (const part of SUMMARY_PARTS) {
      const buf = encodeSummaryPart(file, part)
      const full = decodeSummaryPart(buf)!
      for (const keepId of ['FDSN:XX_A1B2C3D4_S1_H_N_Z', 'station/home/UD']) {
        const only = decodeSummaryPartWhere(buf, (id) => id === keepId)
        expect(only).not.toBeNull()
        expect(only!.channels).toEqual(full.channels.filter((c) => c.id === keepId))
      }
      // 飛ばしたチャンネルの途中で切れていても読まない
      expect(decodeSummaryPartWhere(buf.subarray(0, buf.length - 1), (id) => id === 'nothing')).toBeNull()
    }
  })

  it('目印が合わない・版が違う・途中で切れたファイルは読まない（null）', () => {
    const b = builder()
    b.declare('A', { unit: 'gal', ugPerLsb: null })
    b.add('A', HOUR_START, 10, [1, 2, 3])
    const buf = encodeSummaryPart(b.build(1), 'fine')

    const badMagic = Buffer.from(buf)
    badMagic[0] ^= 0xff
    expect(decodeSummaryPart(badMagic)).toBeNull()

    const badVersion = Buffer.from(buf)
    badVersion[4] = 99
    expect(decodeSummaryPart(badVersion)).toBeNull()

    const badPart = Buffer.from(buf)
    badPart[5] = 9
    expect(decodeSummaryPart(badPart)).toBeNull()

    expect(decodeSummaryPart(buf.subarray(0, buf.length - 1))).toBeNull()
    expect(decodeSummaryPart(Buffer.alloc(0))).toBeNull()
  })

  it('頭だけ覗けば、要約が控えている元のファイルの大きさが分かる（どの部分でも）', () => {
    const b = builder()
    b.declare('A', { unit: 'gal', ugPerLsb: null })
    b.add('A', HOUR_START, 10, [1])
    const file = b.build(4242)
    for (const part of SUMMARY_PARTS) {
      expect(peekSummarySourceBytes(encodeSummaryPart(file, part).subarray(0, SUMMARY_PEEK_BYTES))).toBe(4242)
    }
    expect(peekSummarySourceBytes(Buffer.alloc(SUMMARY_PEEK_BYTES))).toBeNull()
  })

  it('末尾に余計なバイトがあるファイルも読まない（書きかけの上書きを取り違えない）', () => {
    const b = builder()
    b.declare('A', { unit: 'gal', ugPerLsb: null })
    b.add('A', HOUR_START, 10, [1])
    const buf = encodeSummaryPart(b.build(1), 'coarse')
    expect(decodeSummaryPart(Buffer.concat([buf, Buffer.from([0])]))).toBeNull()
  })
})
