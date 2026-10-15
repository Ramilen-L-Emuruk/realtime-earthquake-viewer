import { describe, expect, test } from 'vitest'
import { pickEewOrigins } from './quakeOriginSources'
import type { EEWAlert } from '../types/earthquake'

const ID = '20261003132605'

function report(serial: string, originTime: string, extra: { condition?: string; cancelled?: boolean; test?: boolean } = {}): EEWAlert {
  return {
    kind: 'eew',
    id: `p2p-${serial}`,
    time: originTime,
    test: extra.test ?? false,
    earthquake: { originTime, arrivalTime: originTime, condition: extra.condition ?? '', hypocenter: {} },
    issue: { eventId: ID, serial, time: originTime },
    cancelled: extra.cancelled ?? false,
  } as unknown as EEWAlert
}

const T1 = '2026-10-03T13:26:01+09:00'
const T2 = '2026-10-03T13:26:02+09:00'

describe('pickEewOrigins', () => {
  // `/history` は新しい順に返す。前から上書きすると最も古い報が残る。
  test('報番号の大きい報を採る（並び順に頼らない）', () => {
    const out = pickEewOrigins([report('3', T2), report('1', T1)])
    expect(out.origins.get(ID)).toEqual({ originMs: Date.parse(T2), assumed: false })
    expect(pickEewOrigins([report('1', T1), report('3', T2)]).origins.get(ID)).toEqual({ originMs: Date.parse(T2), assumed: false })
  })

  test('後の報が仮定震源要素でも、震源の決まった最後の報を採る', () => {
    const out = pickEewOrigins([report('2', T2, { condition: '仮定震源要素' }), report('1', T1)])
    expect(out.origins.get(ID)).toEqual({ originMs: Date.parse(T1), assumed: false })
  })

  test('仮定震源要素の報しか無ければ、印を付けて残す', () => {
    const out = pickEewOrigins([report('1', T1, { condition: '仮定震源要素' })])
    expect(out.origins.get(ID)).toEqual({ originMs: Date.parse(T1), assumed: true })
  })

  test('取り消された地震は他の報も採らない・訓練の報は採らない', () => {
    const out = pickEewOrigins([report('2', T2, { cancelled: true }), report('1', T1)])
    expect(out.origins.has(ID)).toBe(false)
    // 取り消された地震は返す（呼び出し側が端末の記録から除く）。
    expect(out.canceled).toEqual([ID])
    expect(pickEewOrigins([report('1', T1, { test: true })]).origins.has(ID)).toBe(false)
  })
})
