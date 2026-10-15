// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest'
import {
  EEW_ORIGIN_STORE_KEY,
  EEW_ORIGIN_STORE_MAX,
  loadEewOrigins,
  mergeEewOrigins,
  saveEewOrigins,
  sameEewOrigins,
  type EewOriginEntry,
} from './eewOriginStore'

/** 震源の決まった報の記録。 */
const decided = (originMs: number): EewOriginEntry => ({ originMs, assumed: false })
/** 仮定震源要素の報の記録。 */
const assumed = (originMs: number): EewOriginEntry => ({ originMs, assumed: true })
/** 見分けられない記録（強震モニタ）。 */
const unknown = (originMs: number): EewOriginEntry => ({ originMs, assumed: null })

const ID = '20261003132605'

describe('mergeEewOrigins', () => {
  test('足して、同じ地震 ID は新しい値で上書きする（続報で発生時刻が改められる）', () => {
    const base = new Map([[ID, decided(1)]])
    const next = mergeEewOrigins(base, [[ID, decided(2)], ['20261003132452', decided(3)]])
    expect([...next]).toEqual([[ID, decided(2)], ['20261003132452', decided(3)]])
    expect(base.get(ID)).toEqual(decided(1))
  })

  test('取り消された地震は除く', () => {
    const next = mergeEewOrigins(new Map([[ID, decided(1)]]), [], [ID])
    expect(next.size).toBe(0)
  })

  test('地震 ID の形でない鍵・有限でない値は残さない', () => {
    const next = mergeEewOrigins(new Map(), [['yahoo-eew-x', decided(1)], [ID, decided(Number.NaN)]])
    expect(next.size).toBe(0)
  })

  // 正: 画面の緊急地震速報は最新の 1 報しか持たない。最後に届いたのが仮定震源要素の報でも、
  // その前の震源の決まった報の値を残す。
  test('仮定震源要素の値は、震源の決まった値を置き換えない', () => {
    const next = mergeEewOrigins(new Map([[ID, decided(1)]]), [[ID, assumed(7)]])
    expect(next.get(ID)).toEqual(decided(1))
  })

  // 対照: 仮定の後に震源が決まれば、決まった値で置き換える。
  test('震源の決まった値は、仮定震源要素の値を置き換える', () => {
    const next = mergeEewOrigins(new Map([[ID, assumed(7)]]), [[ID, decided(1)]])
    expect(next.get(ID)).toEqual(decided(1))
  })

  // 安全弁: 見分けられない経路（強震モニタ）が同じ値を返しても、仮定の印を消さない。
  // 消すと、仮定震源要素の値が使える値に化ける。
  test('見分けられない値は、同じ発生時刻なら印を上書きしない', () => {
    expect(mergeEewOrigins(new Map([[ID, assumed(7)]]), [[ID, unknown(7)]]).get(ID)).toEqual(assumed(7))
    expect(mergeEewOrigins(new Map([[ID, decided(1)]]), [[ID, unknown(1)]]).get(ID)).toEqual(decided(1))
  })

  // 安全弁: 見分けられない経路の報が仮定のまま発生時刻だけ改まった地震を、使える値に化けさせない。
  test('仮定震源要素の値は、発生時刻が違っても見分けられない値では置き換えない', () => {
    expect(mergeEewOrigins(new Map([[ID, assumed(7)]]), [[ID, unknown(2)]]).get(ID)).toEqual(assumed(7))
  })

  test('見分けられない値でも、震源の決まった値の発生時刻が改まれば置き換える', () => {
    expect(mergeEewOrigins(new Map([[ID, decided(1)]]), [[ID, unknown(2)]]).get(ID)).toEqual(unknown(2))
  })

  test('上限を超えたら、足したのが古いものから捨てる', () => {
    const updates: [string, EewOriginEntry][] = []
    for (let i = 0; i < EEW_ORIGIN_STORE_MAX + 5; i += 1) updates.push([String(20260000000000 + i), decided(1e12 + i)])
    const next = mergeEewOrigins(new Map(), updates)
    expect(next.size).toBe(EEW_ORIGIN_STORE_MAX)
    expect(next.has('20260000000000')).toBe(false)
    expect(next.has(String(20260000000000 + EEW_ORIGIN_STORE_MAX + 4))).toBe(true)
  })

  // 安全弁: 古い日付をリプレイして取った分は発生時刻が古い。発生時刻の古い順に捨てると、
  // 取った直後に真っ先に消える。
  test('いっぱいの状態で古い地震を足しても、足したものは残る', () => {
    const full: [string, EewOriginEntry][] = []
    for (let i = 0; i < EEW_ORIGIN_STORE_MAX; i += 1) full.push([String(20260000000000 + i), decided(1.79e12 + i)])
    const base = mergeEewOrigins(new Map(), full)
    const old2016 = Date.parse('2016-04-16T01:25:05+09:00')
    const next = mergeEewOrigins(base, [['20160416012505', decided(old2016)]])
    expect(next.get('20160416012505')).toEqual(decided(old2016))
    expect(next.size).toBe(EEW_ORIGIN_STORE_MAX)
  })

  test('値が変わった地震は後ろへ回り、追い出されにくくなる', () => {
    const base = mergeEewOrigins(new Map(), [['20260000000001', decided(1)], ['20260000000002', decided(2)]])
    const next = mergeEewOrigins(base, [['20260000000001', decided(5)]])
    expect([...next.keys()]).toEqual(['20260000000002', '20260000000001'])
  })

  // 対照: 値が同じ書き直しは順番を動かさない（保存も書き直さないので、動かすと画面と端末でずれる）。
  test('値が同じ書き直しでは順番を動かさない', () => {
    const base = mergeEewOrigins(new Map(), [['20260000000001', decided(1)], ['20260000000002', decided(2)]])
    const next = mergeEewOrigins(base, [['20260000000001', decided(1)]])
    expect([...next.keys()]).toEqual(['20260000000001', '20260000000002'])
  })
})

describe('sameEewOrigins', () => {
  test('中身で比べる（印も見る）', () => {
    expect(sameEewOrigins(new Map([['a', decided(1)]]), new Map([['a', decided(1)]]))).toBe(true)
    expect(sameEewOrigins(new Map([['a', decided(1)]]), new Map([['a', decided(2)]]))).toBe(false)
    expect(sameEewOrigins(new Map([['a', decided(1)]]), new Map([['a', assumed(1)]]))).toBe(false)
  })
})

describe('保存と読み出し', () => {
  afterEach(() => localStorage.clear())

  test('書いたものを読める（印も戻る）', () => {
    saveEewOrigins(new Map([[ID, decided(1791000000000)], ['20261003132452', assumed(5)], ['20261003132453', unknown(6)]]))
    expect([...loadEewOrigins()]).toEqual([
      [ID, decided(1791000000000)],
      ['20261003132452', assumed(5)],
      ['20261003132453', unknown(6)],
    ])
  })

  // 仮定震源要素の印を持つ前に残した値（数値だけ）は、DMDATA の一覧（見分けられない）から取った値が混ざるので使わない。
  test('数値だけの値（以前の形）は使わない（印のある値は読む）', () => {
    localStorage.setItem(EEW_ORIGIN_STORE_KEY, JSON.stringify({ [ID]: 5, '20261003132452': { originMs: 6, assumed: false } }))
    expect([...loadEewOrigins()]).toEqual([['20261003132452', decided(6)]])
    // 捨てた分は書き戻すので、次に読むときは以前の形が残っていない。
    expect(JSON.parse(localStorage.getItem(EEW_ORIGIN_STORE_KEY) ?? '{}')).toEqual({ '20261003132452': { originMs: 6, assumed: false } })
  })

  test('壊れた値は 1 件ずつ捨て、残りは読む', () => {
    localStorage.setItem(EEW_ORIGIN_STORE_KEY, JSON.stringify({
      [ID]: { originMs: 5, assumed: false },
      bad: 'x',
      '20261003132452': 'y',
      '20261003132453': { originMs: 5, assumed: 'yes' },
      '20261003132454': { assumed: false },
    }))
    expect([...loadEewOrigins()]).toEqual([[ID, decided(5)]])
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
