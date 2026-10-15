import { describe, expect, it } from 'vitest'
import { steim2Record, walk } from '../test-utils/mseed2Fixture'
import { groupMseed2ByStation, splitMseed2Stream } from './miniseed2Stream'

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

describe('splitMseed2Stream', () => {
  // 正: 保存庫は観測点・成分のレコードを続けて返す。並びのまま全部読む。
  it('続けて並んだレコードを、並びのまま全部読む', () => {
    const a = steim2Record(walk(100, 1, 50), { station: 'JMM', channel: 'BHZ' })
    const b = steim2Record(walk(100, 2, 50), { station: 'JMM', channel: 'BHN' })
    const c = steim2Record(walk(100, 3, 50), { station: 'YOJ', channel: 'BHE' })
    const r = splitMseed2Stream(concat([a.bytes, b.bytes, c.bytes]))
    expect(r.records.map((x) => `${x.station}.${x.channel}`)).toEqual(['JMM.BHZ', 'JMM.BHN', 'YOJ.BHE'])
    expect(r.unreadable).toEqual([])
    expect(r.trailingBytes).toBe(0)
  })

  // 安全弁: 壊れたレコードが 1 本あっても、その 512 バイトだけ飛ばして続きを読む（黙って全部を捨てない）。
  it('壊れたレコードは理由つきで数え、続きは読む', () => {
    const good1 = steim2Record(walk(50, 4, 50), { station: 'JMM' })
    const bad = new Uint8Array(512) // 年が 0 で読めない
    const good2 = steim2Record(walk(50, 5, 50), { station: 'YOJ' })
    const r = splitMseed2Stream(concat([good1.bytes, bad, good2.bytes]))
    expect(r.records.map((x) => x.station)).toEqual(['JMM', 'YOJ'])
    expect(r.unreadable).toHaveLength(1)
    expect(r.unreadable[0]!.problem).toBe('bad-header')
  })

  // 対照: 512 に満たない端数は読まずに数えるだけ（途中で切れた応答）。
  it('末尾の端数は読まずにバイト数を返す', () => {
    const good = steim2Record(walk(50, 6, 50))
    const r = splitMseed2Stream(concat([good.bytes, new Uint8Array(100)]))
    expect(r.records).toHaveLength(1)
    expect(r.trailingBytes).toBe(100)
  })

  it('空の応答は空で返す', () => {
    const r = splitMseed2Stream(new Uint8Array(0))
    expect(r).toEqual({ records: [], unreadable: [], trailingBytes: 0 })
  })
})

describe('groupMseed2ByStation', () => {
  // 正: 複数の観測点を並べた応答を、観測点ごとの束へ並びのまま分ける。束はそれだけで読み直せる。
  it('観測点ごとに分け、束はそれぞれ読み直せる', () => {
    const a = steim2Record(walk(100, 1, 50), { station: 'JMM', channel: 'BHZ' })
    const b = steim2Record(walk(100, 2, 50), { station: 'YOJ', channel: 'BHN' })
    const c = steim2Record(walk(100, 3, 50), { station: 'JMM', channel: 'BHE' })
    const r = groupMseed2ByStation(concat([a.bytes, b.bytes, c.bytes]))
    expect([...r.byStation.keys()].sort()).toEqual(['JMM', 'YOJ'])
    expect(splitMseed2Stream(r.byStation.get('JMM')!).records.map((x) => x.channel)).toEqual(['BHZ', 'BHE'])
    expect(splitMseed2Stream(r.byStation.get('YOJ')!).records.map((x) => x.channel)).toEqual(['BHN'])
    expect(r.unreadable).toEqual([])
  })

  // 安全弁: 壊れたレコードはどの束にも入れず、理由つきで数える。
  it('壊れたレコードは束に入れずに数える', () => {
    const good = steim2Record(walk(50, 4, 50), { station: 'JMM' })
    const r = groupMseed2ByStation(concat([good.bytes, new Uint8Array(512)]))
    expect(r.byStation.get('JMM')!.length).toBe(good.bytes.length)
    expect(r.unreadable).toHaveLength(1)
  })
})
