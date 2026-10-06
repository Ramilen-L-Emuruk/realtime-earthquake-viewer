import { decodeSteim2 } from 'seisplotjs-seedcodec'
import { describe, expect, it } from 'vitest'

import type { SensorPacket } from '../protocol/types'
import { MSEED3_MAX_RECORD_BYTES } from './mseed3Record'
import { RecordAssembler } from './recordAssembler'
import type { AssembledRecord } from './recordAssembler'

/** 実際の記録と同じ桁の時刻。**正時の 10 分前**から始め、正時の境目を跨ぐ形も作れるようにする。 */
const BASE_MS = Date.UTC(2026, 9, 1, 3, 50, 0, 0)
const HZ = 100
const PERIOD_MS = 1000 / HZ
const PER_PACKET = 10

/** 決まった形の揺れ（乱数を使わない）。軸ごとに位相をずらし、取り違えたら分かるようにする。 */
function value(seq: number, axis: number, amp: number): number {
  return Math.round(amp * Math.sin((2 * Math.PI * (seq + axis * 7)) / 37)) + axis * 1000
}

function pkt(over: Partial<SensorPacket> & { amp?: number } = {}): SensorPacket {
  const firstSeq = over.firstSeq ?? 0
  const n = over.samples?.length ?? PER_PACKET
  const amp = over.amp ?? 30
  return {
    version: 2,
    boardKey: 'mac:020000000001',
    bootId: '63c9812e',
    sensorId: 'i2c0-68',
    sensorType: 'MPU6050',
    channels: ['HN1', 'HN2', 'HN3'],
    ugPerLsb: 61.0352,
    fullScaleG: 2,
    sampleRateHz: HZ,
    firstSampleMs: BASE_MS + firstSeq * PERIOD_MS,
    firstSeq,
    overflowCount: 0,
    samples: Array.from({ length: n }, (_, i) => [0, 1, 2].map((axis) => value(firstSeq + i, axis, amp))),
    ...over,
  }
}

/** 番号の続いたパケットを count 個。受け取った時刻はデータの時刻と同じにする。 */
function run(a: RecordAssembler, count: number, startSeq = 0, over: Partial<SensorPacket> & { amp?: number } = {}): AssembledRecord[] {
  const out: AssembledRecord[] = []
  for (let k = 0; k < count; k++) {
    const p = pkt({ ...over, firstSeq: startSeq + k * PER_PACKET })
    const r = a.push(p, 'live', p.firstSampleMs)
    expect(r.rejected).toBeNull()
    out.push(...r.records)
  }
  return out
}

function header(r: AssembledRecord): DataView {
  return new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength)
}

function decoded(r: AssembledRecord): number[] {
  const v = header(r)
  const sidLen = r.bytes[33]!
  const extraLen = v.getUint16(34, true)
  const payload = r.bytes.subarray(40 + sidLen + extraLen)
  return Array.from(decodeSteim2(new DataView(payload.buffer, payload.byteOffset, payload.byteLength), v.getUint32(24, true), false, 0))
}

function ofAxis(records: readonly AssembledRecord[], axis: 1 | 2 | 3): AssembledRecord[] {
  return records.filter((r) => r.sourceId.endsWith(`_${axis}`))
}

describe('RecordAssembler', () => {
  it('続いたパケットを、軸ごとに 512 バイトまでのレコードへ切り、値を欠かさない', () => {
    const a = new RecordAssembler()
    // 振幅を大きめにして、5 秒の上限より先に 512 バイトへ達するようにする。
    const records = [...run(a, 200, 0, { amp: 3000 }), ...a.flushAll()]
    for (const axis of [1, 2, 3] as const) {
      const mine = ofAxis(records, axis)
      expect(mine.length).toBeGreaterThan(1)
      const all = mine.flatMap(decoded)
      expect(all).toEqual(Array.from({ length: 200 * PER_PACKET }, (_, i) => value(i, axis - 1, 3000)))
      for (const r of mine) expect(r.bytes.byteLength).toBeLessThanOrEqual(MSEED3_MAX_RECORD_BYTES)
    }
    expect(a.pendingSamples).toBe(0)
  })

  it('識別子は軸ごとに分かれる', () => {
    const a = new RecordAssembler()
    run(a, 1)
    const ids = a.flushAll().map((r) => r.sourceId).sort()
    expect(ids).toEqual(['FDSN:XX_00000001_I2C0-68_H_N_1', 'FDSN:XX_00000001_I2C0-68_H_N_2', 'FDSN:XX_00000001_I2C0-68_H_N_3'])
  })

  it('レコードの先頭時刻は、その頭にあたるパケットが名乗る時刻から取る（途中で切れても）', () => {
    const a = new RecordAssembler()
    const records = ofAxis([...run(a, 200, 0, { amp: 3000 }), ...a.flushAll()], 1)
    let seq = 0
    for (const r of records) {
      expect(r.startMs).toBe(BASE_MS + seq * PERIOD_MS)
      seq += r.sampleCount
    }
  })

  it('外挿とのずれが 2 サンプル以内なら同じレコードに繋ぎ、超えたら切る', () => {
    const a = new RecordAssembler()
    run(a, 1)
    // 次のパケットが 15 ms 遅れて名乗る（1.5 サンプル）→ 繋ぐ。
    a.push(pkt({ firstSeq: PER_PACKET, firstSampleMs: BASE_MS + PER_PACKET * PERIOD_MS + 15 }), 'live', BASE_MS + 100)
    expect(ofAxis(a.flushAll(), 1)).toHaveLength(1)

    const b = new RecordAssembler()
    run(b, 1)
    // 25 ms 遅れる（2.5 サンプル）→ 切る。新しいレコードはそのパケットの時刻から始まる。
    const late = BASE_MS + PER_PACKET * PERIOD_MS + 25
    const cut = b.push(pkt({ firstSeq: PER_PACKET, firstSampleMs: late }), 'live', BASE_MS + 100).records
    expect(ofAxis(cut, 1)).toHaveLength(1)
    expect(ofAxis(cut, 1)[0]!.sampleCount).toBe(PER_PACKET)
    expect(ofAxis(b.flushAll(), 1)[0]!.startMs).toBe(late)
  })

  it('番号が途切れたら、そこで切る', () => {
    const a = new RecordAssembler()
    run(a, 3)
    const r = a.push(pkt({ firstSeq: 3 * PER_PACKET + 5 }), 'live', BASE_MS).records
    expect(ofAxis(r, 1)).toHaveLength(1)
    expect(ofAxis(r, 1)[0]!.sampleCount).toBe(3 * PER_PACKET)
  })

  it('刻みが変わったら、そこで切る', () => {
    const a = new RecordAssembler()
    run(a, 2)
    const r = a.push(pkt({ firstSeq: 2 * PER_PACKET, sampleRateHz: 50 }), 'live', BASE_MS).records
    expect(ofAxis(r, 1)).toHaveLength(1)
  })

  it('起動が変わったら別の流れになる（前の流れは残ったまま）', () => {
    const a = new RecordAssembler()
    run(a, 2)
    a.push(pkt({ firstSeq: 0, bootId: 'ffffffff' }), 'live', BASE_MS)
    expect(a.pendingSamples).toBe(3 * 3 * PER_PACKET)
  })

  it('データの時刻が次の正時を越えたら切る（1 時間のファイルを跨ぐレコードを作らない）', () => {
    const a = new RecordAssembler()
    // BASE_MS は正時の 10 分前。正時の 0.5 秒前から 1 秒ぶん流す。
    const first = 10 * 60 * HZ - HZ / 2
    const records = [...run(a, 10, first), ...a.flushAll()]
    const mine = ofAxis(records, 1)
    expect(mine).toHaveLength(2)
    const hour = Date.UTC(2026, 9, 1, 4, 0, 0, 0)
    expect(mine[0]!.startMs).toBeLessThan(hour)
    expect(mine[1]!.startMs).toBe(hour)
    expect(mine[0]!.fileAtMs).toBe(mine[0]!.startMs)
  })

  it('1 つのパケットのサンプルは 1 つの時のファイルに収まる（正時を跨ぐパケットの途中で満杯になっても）', () => {
    // 実データの 1 日で、正時を跨ぐパケットの途中で 512 バイトに達し、残り 1 サンプルのレコードだけが
    // 次の時のファイルへ入った。開始位置をずらして、満杯の切れ目がその途中へ来る形を必ず作る。
    //
    // 差分がすべて 30 ビット幅を要する値（±2^27 の交互）にすると、1 本にちょうど 88 サンプル入る
    // （最初のフレームに 13 語・残り 5 フレームに 15 語ずつ・1 語に 1 差分）。そこから逆算して、
    // 正時（番号 60000）を跨ぐパケット（59997〜60006）の途中、番号 60001 で満杯になるよう並べる。
    const boundarySeq = 10 * 60 * HZ
    const cutAt = boundarySeq + 1
    const first = cutAt - 88 * 3
    const a = new RecordAssembler()
    const records: AssembledRecord[] = []
    for (let k = 0; k < 40; k++) {
      const q = first + k * PER_PACKET
      const samples = Array.from({ length: PER_PACKET }, (_, i) => {
        const v = (q + i) % 2 === 0 ? 2 ** 27 : -(2 ** 27)
        return [v, v, v]
      })
      const p = pkt({ firstSeq: q, samples })
      records.push(...a.push(p, 'live', p.firstSampleMs).records)
    }
    records.push(...a.flushAll())
    const mine = ofAxis(records, 1)
    // 前提が崩れていない（88 サンプルで満杯・その切れ目が正時の直後）ことを先に確かめる。
    expect(mine.some((r) => r.cut === 'full' && r.firstSeq + r.sampleCount === cutAt)).toBe(true)
    for (const r of mine) {
      const fileHour = Math.floor(r.fileAtMs / 3_600_000)
      // そのレコードのサンプルを運んだパケットの頭を全部見る。
      for (let seq = r.firstSeq; seq < r.firstSeq + r.sampleCount; seq++) {
        const packetStartSeq = first + Math.floor((seq - first) / PER_PACKET) * PER_PACKET
        const packetT = BASE_MS + packetStartSeq * PERIOD_MS
        expect(Math.floor(packetT / 3_600_000)).toBe(fileHour)
      }
    }
  })

  it('データで 5 秒ぶん溜まったら、満杯でなくても書き出す', () => {
    const a = new RecordAssembler()
    // 静かな値（差分 0）は 1 本に何千件も入るので、5 秒の上限が先に効く。
    const quiet = { amp: 0 }
    const records = run(a, 5 * HZ / PER_PACKET, 0, quiet)
    expect(ofAxis(records, 1)).toHaveLength(1)
    expect(ofAxis(records, 1)[0]!.sampleCount).toBe(5 * HZ)
  })

  it('受け取ってから 5 秒経っても溜まったままなら、刻み（tick）で書き出す', () => {
    const a = new RecordAssembler()
    const p = pkt({ amp: 0 })
    a.push(p, 'live', 1_000)
    expect(a.tick(5_999)).toHaveLength(0)
    expect(ofAxis(a.tick(6_000), 1)).toHaveLength(1)
    expect(a.pendingSamples).toBe(0)
  })

  it('正: 取り戻した分は溜めずに、届いたその場で軸ごとに 1 本ずつ切る（溜めていた従来の形を覆した）', () => {
    // 書けたかをその場で確かめて欠けを外すため（`backlogFetcher.ts`）。溜めると、書けないと
    // 分かる前に欠けを閉じてしまい、書けなかった分を訊き直せない。
    const a = new RecordAssembler()
    const back = a.push(pkt({ firstSeq: 1000 }), 'backlog', BASE_MS)
    expect(back.rejected).toBeNull()
    expect(back.records.map((r) => [r.lane, r.cut, r.firstSeq, r.sampleCount])).toEqual([
      ['backlog', 'recovered', 1000, PER_PACKET],
      ['backlog', 'recovered', 1000, PER_PACKET],
      ['backlog', 'recovered', 1000, PER_PACKET],
    ])
    expect(ofAxis(back.records, 2)[0]!.startMs).toBe(BASE_MS + 1000 * PERIOD_MS)
    expect(decoded(ofAxis(back.records, 2)[0]!)).toEqual(Array.from({ length: PER_PACKET }, (_, i) => value(1000 + i, 1, 30)))
    expect(a.pendingSamples).toBe(0)
    expect(a.cutCounts.recovered).toBe(3)
  })

  it('対照: いま届いた分は従来どおり溜める（取り戻した分だけをその場で切る）', () => {
    const a = new RecordAssembler()
    expect(run(a, 1)).toHaveLength(0)
    expect(a.pendingSamples).toBe(3 * PER_PACKET)
    expect(a.cutCounts.recovered).toBe(0)
  })

  it('安全弁: 取り戻した分をその場で切っても、いま届いている分の繋がりは崩さない', () => {
    const a = new RecordAssembler()
    run(a, 2)
    a.push(pkt({ firstSeq: 1000 }), 'backlog', BASE_MS)
    run(a, 1, 2 * PER_PACKET)
    const live = ofAxis(a.flushAll(), 1)
    expect(live.map((r) => r.lane)).toEqual(['live'])
    expect(live[0]!.sampleCount).toBe(3 * PER_PACKET)
  })

  it('時計が合う前の値は旗を立て、受け取った時刻で振り分ける', () => {
    const a = new RecordAssembler()
    a.push(pkt({ firstSampleMs: 8_430 }), 'live', BASE_MS + 123)
    const r = ofAxis(a.flushAll(), 1)[0]!
    expect(r.timeQuestionable).toBe(true)
    expect(r.bytes[3]).toBe(0b10)
    expect(r.startMs).toBe(8_430)
    expect(r.fileAtMs).toBe(BASE_MS + 123)
  })

  it('時計が合う前と後は同じレコードへ繋がない', () => {
    const a = new RecordAssembler()
    a.push(pkt({ firstSeq: 0, firstSampleMs: 8_430 }), 'live', BASE_MS)
    const r = a.push(pkt({ firstSeq: PER_PACKET }), 'live', BASE_MS).records
    expect(ofAxis(r, 1)).toHaveLength(1)
    expect(ofAxis(r, 1)[0]!.timeQuestionable).toBe(true)
  })

  it('識別子を作れないパケット（MAC を名乗らない版 1）は丸ごと退け、状態を変えない', () => {
    const a = new RecordAssembler()
    const r = a.push(pkt({ version: 1, boardKey: 'name:seismo-3' }), 'live', BASE_MS)
    expect(r.rejected).toBe('no-source-id')
    expect(r.records).toHaveLength(0)
    expect(a.pendingSamples).toBe(0)
  })

  it('1 軸でも識別子を作れなければ丸ごと退ける（軸の一部だけを残さない）', () => {
    const a = new RecordAssembler()
    const r = a.push(pkt({ channels: ['HN1', 'HN2', 'bad!'] }), 'live', BASE_MS)
    expect(r.rejected).toBe('no-source-id')
    expect(a.pendingSamples).toBe(0)
  })

  it('32 ビットに収まらない値を含むパケットは丸ごと退ける', () => {
    const a = new RecordAssembler()
    const r = a.push(pkt({ samples: [[0, 0, 2 ** 31]] }), 'live', BASE_MS)
    expect(r.rejected).toBe('sample-out-of-range')
    expect(a.pendingSamples).toBe(0)
  })

  it('締めくくり（flushAll）で溜めた分を全部出す', () => {
    const a = new RecordAssembler()
    run(a, 3)
    const out = a.flushAll()
    expect(out.reduce((s, r) => s + r.sampleCount, 0)).toBe(3 * 3 * PER_PACKET)
    expect(a.pendingSamples).toBe(0)
  })

  it('切った理由をレコードに持たせ、理由ごとの本数を数える', () => {
    const a = new RecordAssembler()
    run(a, 3)
    const gap = a.push(pkt({ firstSeq: 1000 }), 'live', BASE_MS).records
    expect(gap.map((r) => r.cut)).toEqual(['seq-gap', 'seq-gap', 'seq-gap'])
    const flushed = a.flushAll()
    expect(flushed.map((r) => r.cut)).toEqual(['flush', 'flush', 'flush'])
    expect(a.cutCounts).toMatchObject({ 'seq-gap': 3, flush: 3, full: 0, hold: 0 })
  })

  it('締めくくりで入りきらずに分かれた分は「満杯」として数える（最後の 1 本だけが締めくくり）', () => {
    // maxHoldMs を延ばして、5 秒の上限より先に 512 バイトを越える量を溜める。
    const a = new RecordAssembler({ maxHoldMs: 600_000 })
    for (let k = 0; k < 30; k++) {
      const p = pkt({ firstSeq: k * PER_PACKET, amp: 20000 })
      // 満杯になった分はその場で出るので、溜まりきる前に出たものは捨てて数だけ見る。
      a.push(p, 'live', p.firstSampleMs)
    }
    const before = a.cutCounts.full
    const out = ofAxis(a.flushAll(), 1)
    expect(out.at(-1)!.cut).toBe('flush')
    expect(out.slice(0, -1).every((r) => r.cut === 'full')).toBe(true)
    expect(a.cutCounts.full).toBeGreaterThanOrEqual(before)
  })

  it('満杯で 1 本出した残りは、その残りが届いた時刻から 5 秒を測る（半端に書き出さない）', () => {
    // 実データの 1 日で、本数の半分が「残りを最初の溜め始めから測って半端に出す」形だった。
    const a = new RecordAssembler()
    let rx = 0
    for (let k = 0; k < 60; k++) {
      const p = pkt({ firstSeq: k * PER_PACKET, amp: 3000 })
      a.push(p, 'live', rx)
      rx += 100
    }
    const pending = a.pendingSamples
    expect(pending).toBeGreaterThan(0)
    // 最後のパケットを受け取ってから 1 秒後。残りの先頭はそれより後に届いた分なので、まだ出さない。
    expect(a.tick(rx + 1_000)).toHaveLength(0)
    expect(a.pendingSamples).toBe(pending)
  })

  it('拡張ヘッダに起動 ID と先頭サンプルの通し番号を入れる（取り戻した分には印）', () => {
    const a = new RecordAssembler()
    run(a, 200, 0, { amp: 3000 })
    // 取り戻した分は届いたその場で切れて出る。
    const recovered = a.push(pkt({ firstSeq: 5000 }), 'backlog', BASE_MS).records
    const all = ofAxis([...recovered, ...a.flushAll()], 1)
    const extraOf = (r: AssembledRecord): unknown => {
      const sidLen = r.bytes[33]!
      const len = header(r).getUint16(34, true)
      return JSON.parse(new TextDecoder().decode(r.bytes.subarray(40 + sidLen, 40 + sidLen + len)))
    }
    const live = all.find((r) => r.lane === 'live')!
    expect(extraOf(live)).toEqual({ Seismo: { b: '63c9812e', q: live.firstSeq } })
    const back = all.find((r) => r.lane === 'backlog')!
    expect(extraOf(back)).toEqual({ Seismo: { b: '63c9812e', q: 5000, r: 1 } })
  })

  it('レコードの先頭の通し番号は、前のレコードの続き（途中で切れても）', () => {
    const a = new RecordAssembler()
    const records = ofAxis([...run(a, 200, 0, { amp: 3000 }), ...a.flushAll()], 2)
    let seq = 0
    for (const r of records) {
      expect(r.firstSeq).toBe(seq)
      expect(r.bootId).toBe('63c9812e')
      seq += r.sampleCount
    }
  })

  it('番号が前へ戻るパケット（重複・遅着）は別の流れへ入れ、いまの流れを切らない', () => {
    const a = new RecordAssembler()
    run(a, 3)
    // 2 つ目のパケットが重ねて届く。
    const dup = a.push(pkt({ firstSeq: PER_PACKET }), 'live', BASE_MS)
    expect(dup.rejected).toBeNull()
    expect(dup.records).toHaveLength(0)
    // 続きはそのまま繋がる（番号の巻き戻しで続きが切れない）。
    expect(run(a, 1, 3 * PER_PACKET)).toHaveLength(0)
    const out = ofAxis(a.flushAll(), 1)
    const live = out.filter((r) => r.lane === 'live')
    const late = out.filter((r) => r.lane === 'late')
    expect(live).toHaveLength(1)
    expect(live[0]!.sampleCount).toBe(4 * PER_PACKET)
    expect(decoded(live[0]!)).toEqual(Array.from({ length: 4 * PER_PACKET }, (_, i) => value(i, 0, 30)))
    expect(late).toHaveLength(1)
    expect(late[0]!.firstSeq).toBe(PER_PACKET)
    expect(decoded(late[0]!)).toEqual(Array.from({ length: PER_PACKET }, (_, i) => value(PER_PACKET + i, 0, 30)))
    const v = header(late[0]!)
    const sidLen = late[0]!.bytes[33]!
    const extra = new TextDecoder().decode(late[0]!.bytes.subarray(40 + sidLen, 40 + sidLen + v.getUint16(34, true)))
    expect(JSON.parse(extra)).toEqual({ Seismo: { b: '63c9812e', q: PER_PACKET, l: 1 } })
    expect(a.cutCounts['seq-gap']).toBe(0)
  })

  it('番号が先へ飛んだパケットは、別の流れへ回さずいまの流れで切る（対照）', () => {
    const a = new RecordAssembler()
    run(a, 2)
    const r = a.push(pkt({ firstSeq: 5 * PER_PACKET }), 'live', BASE_MS).records
    expect(ofAxis(r, 1).map((x) => [x.lane, x.cut])).toEqual([['live', 'seq-gap']])
    expect(ofAxis(a.flushAll(), 1).map((x) => x.lane)).toEqual(['live'])
  })

  it('取り戻した分は、番号がいまの流れより前でも取り戻した分の流れへ入れる（安全弁）', () => {
    const a = new RecordAssembler()
    run(a, 3)
    const recovered = a.push(pkt({ firstSeq: 0 }), 'backlog', BASE_MS).records
    expect(ofAxis(recovered, 1).map((x) => x.lane)).toEqual(['backlog'])
    expect(ofAxis(a.flushAll(), 1).map((x) => x.lane)).toEqual(['live'])
  })

  it('隣り合う差が 30 ビットに収まらないところで切り、理由を value-jump として数える', () => {
    const a = new RecordAssembler()
    const big = 2 ** 30
    const samples = Array.from({ length: PER_PACKET }, (_, i) => (i < 5 ? [0, 0, 0] : [big, big, big]))
    // 段差の手前までは、届いたその場で切れて出る（満杯と同じ扱い）。
    const pushed = a.push(pkt({ samples }), 'live', BASE_MS).records
    const out = ofAxis([...pushed, ...a.flushAll()], 1)
    expect(out.map((r) => [r.cut, r.sampleCount])).toEqual([
      ['value-jump', 5],
      ['flush', 5],
    ])
    expect(out.flatMap(decoded)).toEqual(samples.map((row) => row[0]))
    expect(a.cutCounts['value-jump']).toBe(3)
    expect(a.cutCounts.full).toBe(0)
  })

  it('起動 ID が上限の長さで番号の桁が大きくても、レコードは 512 バイトに収まる', () => {
    const a = new RecordAssembler()
    const bootId = 'f'.repeat(32)
    const base = 900_000_000_000_000
    const records: AssembledRecord[] = []
    for (let k = 0; k < 100; k++) {
      const q = base + k * PER_PACKET
      const samples = Array.from({ length: PER_PACKET }, (_, i) => [0, 1, 2].map((axis) => value(q + i, axis, 3000)))
      const p = pkt({ bootId, firstSeq: q, firstSampleMs: BASE_MS + k * PER_PACKET * PERIOD_MS, samples })
      const r = a.push(p, 'live', p.firstSampleMs)
      expect(r.rejected).toBeNull()
      records.push(...r.records)
    }
    records.push(...a.flushAll())
    expect(records.some((r) => r.cut === 'full')).toBe(true)
    for (const r of records) expect(r.bytes.byteLength).toBeLessThanOrEqual(MSEED3_MAX_RECORD_BYTES)
    expect(ofAxis(records, 1).reduce((s, r) => s + r.sampleCount, 0)).toBe(100 * PER_PACKET)
  })

  it('起動 ID が上限を超えるパケットは丸ごと退ける', () => {
    const a = new RecordAssembler()
    const r = a.push(pkt({ bootId: 'f'.repeat(33) }), 'live', BASE_MS)
    expect(r.rejected).toBe('boot-id-too-long')
    expect(a.pendingSamples).toBe(0)
  })

  it('しばらく何も来ない流れは帳面から外す（起動のたびに増え続けない）', () => {
    const a = new RecordAssembler()
    a.push(pkt({ amp: 0 }), 'live', 0)
    a.tick(6_000)
    expect(a.streamCount).toBe(3)
    a.tick(6_000 + 60_000)
    expect(a.streamCount).toBe(0)
  })
})
