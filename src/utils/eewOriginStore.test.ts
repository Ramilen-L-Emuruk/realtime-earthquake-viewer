// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest'
import {
  EEW_ORIGIN_STORE_KEY,
  EEW_ORIGIN_STORE_MAX,
  loadEewOrigins,
  mergeEewOrigins,
  saveEewOrigins,
  sameEewOrigins,
} from './eewOriginStore'

describe('mergeEewOrigins', () => {
  test('足して、同じ地震 ID は新しい値で上書きする（続報で発生時刻が改められる）', () => {
    const base = new Map([['20261003132605', 1]])
    const next = mergeEewOrigins(base, [['20261003132605', 2], ['20261003132452', 3]])
    expect([...next]).toEqual([['20261003132605', 2], ['20261003132452', 3]])
    expect(base.get('20261003132605')).toBe(1)
  })

  test('取り消された地震は除く', () => {
    const next = mergeEewOrigins(new Map([['20261003132605', 1]]), [], ['20261003132605'])
    expect(next.size).toBe(0)
  })

  test('地震 ID の形でない鍵・有限でない値は残さない', () => {
    const next = mergeEewOrigins(new Map(), [['yahoo-eew-x', 1], ['20261003132605', Number.NaN]])
    expect(next.size).toBe(0)
  })

  test('上限を超えたら、足したのが古いものから捨てる', () => {
    const updates: [string, number][] = []
    for (let i = 0; i < EEW_ORIGIN_STORE_MAX + 5; i += 1) updates.push([String(20260000000000 + i), 1e12 + i])
    const next = mergeEewOrigins(new Map(), updates)
    expect(next.size).toBe(EEW_ORIGIN_STORE_MAX)
    expect(next.has('20260000000000')).toBe(false)
    expect(next.has(String(20260000000000 + EEW_ORIGIN_STORE_MAX + 4))).toBe(true)
  })

  // 安全弁: 古い日付をリプレイして取った分は発生時刻が古い。発生時刻の古い順に捨てると、
  // 取った直後に真っ先に消える。
  test('いっぱいの状態で古い地震を足しても、足したものは残る', () => {
    const full: [string, number][] = []
    for (let i = 0; i < EEW_ORIGIN_STORE_MAX; i += 1) full.push([String(20260000000000 + i), 1.79e12 + i])
    const base = mergeEewOrigins(new Map(), full)
    const old2016 = Date.parse('2016-04-16T01:25:05+09:00')
    const next = mergeEewOrigins(base, [['20160416012505', old2016]])
    expect(next.get('20160416012505')).toBe(old2016)
    expect(next.size).toBe(EEW_ORIGIN_STORE_MAX)
  })

  test('値が変わった地震は後ろへ回り、追い出されにくくなる', () => {
    const base = mergeEewOrigins(new Map(), [['20260000000001', 1], ['20260000000002', 2]])
    const next = mergeEewOrigins(base, [['20260000000001', 5]])
    expect([...next.keys()]).toEqual(['20260000000002', '20260000000001'])
  })

  // 対照: 値が同じ書き直しは順番を動かさない（保存も書き直さないので、動かすと画面と端末でずれる）。
  test('値が同じ書き直しでは順番を動かさない', () => {
    const base = mergeEewOrigins(new Map(), [['20260000000001', 1], ['20260000000002', 2]])
    const next = mergeEewOrigins(base, [['20260000000001', 1]])
    expect([...next.keys()]).toEqual(['20260000000001', '20260000000002'])
  })
})

describe('sameEewOrigins', () => {
  test('中身で比べる', () => {
    expect(sameEewOrigins(new Map([['a', 1]]), new Map([['a', 1]]))).toBe(true)
    expect(sameEewOrigins(new Map([['a', 1]]), new Map([['a', 2]]))).toBe(false)
  })
})

describe('保存と読み出し', () => {
  afterEach(() => localStorage.clear())

  test('書いたものを読める', () => {
    saveEewOrigins(new Map([['20261003132605', 1791000000000]]))
    expect([...loadEewOrigins()]).toEqual([['20261003132605', 1791000000000]])
  })

  test('壊れた値は 1 件ずつ捨て、残りは読む', () => {
    localStorage.setItem(EEW_ORIGIN_STORE_KEY, JSON.stringify({ '20261003132605': 5, bad: 'x', '20261003132452': 'y' }))
    expect([...loadEewOrigins()]).toEqual([['20261003132605', 5]])
  })

  test('JSON として読めなければ空', () => {
    localStorage.setItem(EEW_ORIGIN_STORE_KEY, '{')
    expect(loadEewOrigins().size).toBe(0)
  })

  test('配列など形が違えば空', () => {
    localStorage.setItem(EEW_ORIGIN_STORE_KEY, '[1,2]')
    expect(loadEewOrigins().size).toBe(0)
  })
})
