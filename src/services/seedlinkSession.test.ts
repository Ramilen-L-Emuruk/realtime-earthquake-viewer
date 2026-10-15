import { describe, expect, it } from 'vitest'
import { SEEDLINK_PACKET_BYTES, SeedlinkSession, seedlinkCommands, seedlinkTime, type SeedlinkEvent } from './seedlinkSession'

const enc = new TextEncoder()
const START = Date.UTC(2026, 0, 1)

function packet(seq: string, fill: number): Uint8Array {
  const b = new Uint8Array(SEEDLINK_PACKET_BYTES).fill(fill)
  b.set(enc.encode(`SL${seq}`), 0)
  return b
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** END まで進めた手順（1 観測点） */
function streaming(): SeedlinkSession {
  const s = new SeedlinkSession({ network: 'JP', stations: ['JMN'], startMs: START })
  s.start()
  s.feed(enc.encode('OK\r\n'))
  s.feed(enc.encode('OK\r\n'))
  expect(s.isStreaming).toBe(true)
  return s
}

const kinds = (evs: SeedlinkEvent[]) => evs.map((e) => (e.type === 'packet' ? e.sequence : e.type))

describe('seedlinkCommands', () => {
  it('観測点ごとに STATION と TIME、最後に END（SELECT は送らない）', () => {
    const ms = Date.UTC(2026, 9, 13, 11, 42, 7, 900)
    expect(seedlinkCommands({ network: 'JP', stations: ['JMN', 'YOJ'], startMs: ms })).toEqual([
      'STATION JMN JP',
      'TIME 2026,10,13,11,42,7',
      'STATION YOJ JP',
      'TIME 2026,10,13,11,42,7',
      'END',
    ])
  })

  it('命令へ混ぜ込める文字（空白・改行）を含むコードと、時刻にならない始めは断る', () => {
    expect(() => seedlinkCommands({ network: 'JP', stations: ['JMN\r\nEND'], startMs: START })).toThrow(RangeError)
    expect(() => seedlinkCommands({ network: 'J P', stations: ['JMN'], startMs: START })).toThrow(RangeError)
    expect(() => seedlinkCommands({ network: 'JP', stations: [], startMs: START })).toThrow(RangeError)
    expect(() => seedlinkCommands({ network: 'JP', stations: ['JMN'], startMs: Number.NaN })).toThrow(RangeError)
  })

  it('TIME の秒未満は切り捨てる（少し手前から受ける側へ倒す）', () => {
    expect(seedlinkTime(Date.UTC(2026, 0, 2, 3, 4, 5, 999))).toBe('2026,1,2,3,4,5')
  })
})

describe('SeedlinkSession の応答', () => {
  it('命令ごとに OK を待ってから次を送り、END の後はレコードを切り出す', () => {
    const s = new SeedlinkSession({ network: 'JP', stations: ['JMN'], startMs: START })
    expect(s.start()).toEqual([{ type: 'send', command: 'STATION JMN JP' }])
    expect(s.feed(enc.encode('OK\r\n'))).toEqual([{ type: 'send', command: 'TIME 2026,1,1,0,0,0' }])
    expect(s.isStreaming).toBe(false)
    expect(s.feed(enc.encode('OK\r\n'))).toEqual([{ type: 'send', command: 'END' }])
    const evs = s.feed(packet('00001A', 7))
    expect(kinds(evs)).toEqual(['00001A'])
    expect((evs[0] as { record: Uint8Array }).record[0]).toBe(7)
    expect(s.sequence).toBe('00001A')
  })

  it('応答が行の途中で分かれて届いても、1 回にまとめて届いても同じに進む', () => {
    const a = new SeedlinkSession({ network: 'JP', stations: ['JMN'], startMs: START })
    a.start()
    expect(a.feed(enc.encode('O'))).toEqual([])
    expect(a.feed(enc.encode('K\r\n'))).toEqual([{ type: 'send', command: 'TIME 2026,1,1,0,0,0' }])
    const b = new SeedlinkSession({ network: 'JP', stations: ['JMN'], startMs: START })
    b.start()
    // 2 つの応答と最初のレコードが 1 回に届く
    const evs = b.feed(concat(enc.encode('OK\r\nOK\r\n'), packet('000001', 1)))
    expect(kinds(evs)).toEqual(['send', 'send', '000001'])
  })

  it('ERROR は refused、それ以外の応答は unexpected（断られたのか手順がずれたのかを分ける）', () => {
    const a = new SeedlinkSession({ network: 'JP', stations: ['JZZ'], startMs: START })
    a.start()
    expect(a.feed(enc.encode('ERROR\r\n'))).toEqual([{ type: 'refused', command: 'STATION JZZ JP', reply: 'ERROR' }])
    const b = new SeedlinkSession({ network: 'JP', stations: ['JMN'], startMs: START })
    b.start()
    expect(b.feed(enc.encode('SeedLink v3.1\r\n'))).toEqual([{ type: 'unexpected', command: 'STATION JMN JP', reply: 'SeedLink v3.1' }])
  })
})

describe('SeedlinkSession の切り分け', () => {
  it('区切りをまたいで届いたレコードを繋ぎ、2 本まとめて届いても 2 本に分ける', () => {
    const s = streaming()
    const two = concat(packet('000001', 1), packet('000002', 2))
    expect(s.feed(two.subarray(0, 300))).toEqual([])
    expect(kinds(s.feed(two.subarray(300)))).toEqual(['000001', '000002'])
  })

  it('区切りの前に余計なバイトが挟まっても、次の区切りから読み直す（後ろの正しいレコードを捨てない）', () => {
    const s = streaming()
    const evs = s.feed(concat(enc.encode('xyz'), packet('000003', 3), packet('000004', 4)))
    expect(kinds(evs)).toEqual(['garbled', '000003', '000004'])
    expect(evs[0]).toMatchObject({ droppedBytes: 3 })
  })

  it('余計なバイトが受信の境目をまたいでも、境目の後ろの区切りを読める', () => {
    const s = streaming()
    const all = concat(enc.encode('<html>404</html>'), packet('000005', 5))
    // 区切りの頭の途中で切れる
    expect(kinds(s.feed(all.subarray(0, 19)))).toEqual(['garbled'])
    expect(kinds(s.feed(all.subarray(19)))).toEqual(['000005'])
  })

  it('END の後に届いた ERROR は refused として返す（区切りへ混ぜない）', () => {
    const s = streaming()
    const evs = s.feed(concat(enc.encode('ERROR\r\n'), packet('000006', 6)))
    expect(evs[0]).toMatchObject({ type: 'refused', command: 'END', reply: 'ERROR' })
    expect(kinds(evs)).toEqual(['refused', '000006'])
  })
})
