import { describe, expect, test } from 'vitest'
import {
  findJmaEventId,
  parseEventIdMs,
  parseJstTimeMs,
  resolveOriginSeconds,
  type JmaQuakeListEntry,
} from './quakeOriginSeconds'

describe('parseEventIdMs', () => {
  test('日本時間として読む', () => {
    expect(parseEventIdMs('20261003132605')).toBe(Date.parse('2026-10-03T13:26:05+09:00'))
  })

  test('日付をまたぐ時刻も日本時間で読む（UTC では前日）', () => {
    expect(parseEventIdMs('20261004080000')).toBe(Date.parse('2026-10-04T08:00:00+09:00'))
  })

  test.each(['2026100313260', '202610031326050', 'abcdefghijklmn', ''])('書式が違えば null（%s）', (id) => {
    expect(parseEventIdMs(id)).toBeNull()
  })

  // 安全弁: Date.UTC は 13 月や 2 月 30 日を黙って繰り上げる。繰り上げた時刻で線を引かない。
  test.each(['20261303132605', '20260230120000', '20261003246000'])('存在しない日時は null（%s）', (id) => {
    expect(parseEventIdMs(id)).toBeNull()
  })
})

describe('resolveOriginSeconds', () => {
  const eewMs = Date.parse('2026-10-03T13:26:01+09:00')

  test('緊急地震速報の発生時刻があればそれを採る', () => {
    expect(resolveOriginSeconds('20261003132605', eewMs)).toEqual({ originMs: eewMs, source: 'eew' })
  })

  test('無ければ地震 ID の時刻を採る', () => {
    expect(resolveOriginSeconds('20261003132605', undefined)).toEqual({
      originMs: Date.parse('2026-10-03T13:26:05+09:00'),
      source: 'event-id',
    })
  })

  test('地震 ID が分からなければ秒は無い（緊急地震速報があっても結び付けられない）', () => {
    expect(resolveOriginSeconds(null, eewMs)).toBeNull()
  })

  test('有限でない発生時刻は採らず、地震 ID へ落ちる', () => {
    expect(resolveOriginSeconds('20261003132605', Number.NaN)?.source).toBe('event-id')
  })

  test('地震 ID が読めなければ null', () => {
    expect(resolveOriginSeconds('bad', undefined)).toBeNull()
  })
})

describe('findJmaEventId', () => {
  // 実際の一覧（2026-10-04 取得）から取った 2 件。同じ震央地名で 73 秒違い。
  const entries: JmaQuakeListEntry[] = [
    { eid: '20261003132605', at: '2026-10-03T13:26:00+09:00', anm: '熊本県天草・芦北地方', mag: '3.5' },
    { eid: '20261003132605', at: '2026-10-03T13:26:00+09:00', anm: '熊本県天草・芦北地方', mag: '3.5' },
    { eid: '20261003132452', at: '2026-10-03T13:24:00+09:00', anm: '熊本県天草・芦北地方', mag: '3.0' },
  ]
  const quake = (time: string, epicenter: string, magnitude: number | null) => ({
    timeMs: Date.parse(time), epicenter, magnitude,
  })

  test('分と震央地名が一致する地震 ID を返す（同じ地震の行が複数あっても 1 つに数える）', () => {
    expect(findJmaEventId(quake('2026-10-03T13:26:00+09:00', '熊本県天草・芦北地方', 3.5), entries))
      .toBe('20261003132605')
  })

  test('分が違えば別の地震として扱う', () => {
    expect(findJmaEventId(quake('2026-10-03T13:24:00+09:00', '熊本県天草・芦北地方', 3.0), entries))
      .toBe('20261003132452')
  })

  test('震央地名が違えば引かない', () => {
    expect(findJmaEventId(quake('2026-10-03T13:26:00+09:00', '熊本県熊本地方', 3.5), entries)).toBeNull()
  })

  test('同じ分・同じ震央地名の別の地震は規模で絞る', () => {
    const twin: JmaQuakeListEntry[] = [
      { eid: 'A0000000000001', at: '2026-10-03T13:26:00+09:00', anm: '茨城県南部', mag: '3.1' },
      { eid: 'A0000000000002', at: '2026-10-03T13:26:00+09:00', anm: '茨城県南部', mag: '4.2' },
    ]
    expect(findJmaEventId(quake('2026-10-03T13:26:00+09:00', '茨城県南部', 4.2), twin)).toBe('A0000000000002')
  })

  // 安全弁: 取り違えると別の地震の秒で線を引く。決められなければ引かない。
  test('規模でも決まらなければ null', () => {
    const twin: JmaQuakeListEntry[] = [
      { eid: 'A0000000000001', at: '2026-10-03T13:26:00+09:00', anm: '茨城県南部', mag: '3.1' },
      { eid: 'A0000000000002', at: '2026-10-03T13:26:00+09:00', anm: '茨城県南部', mag: '3.1' },
    ]
    expect(findJmaEventId(quake('2026-10-03T13:26:00+09:00', '茨城県南部', 3.1), twin)).toBeNull()
    expect(findJmaEventId(quake('2026-10-03T13:26:00+09:00', '茨城県南部', null), twin)).toBeNull()
  })

  test('時刻が読めない地震カードは引かない', () => {
    expect(findJmaEventId({ timeMs: Number.NaN, epicenter: '熊本県天草・芦北地方', magnitude: 3.5 }, entries))
      .toBeNull()
  })
})

describe('parseJstTimeMs', () => {
  // **端末の時間帯に依らないことを固定する。** テストは日本時間で走るので `new Date()` と比べても
  // 違いは出ない。時間帯つきの絶対時刻と突き合わせる。
  test('P2PQuake の時計表記を日本時間として読む', () => {
    expect(parseJstTimeMs('2026/10/03 13:26:00')).toBe(Date.parse('2026-10-03T13:26:00+09:00'))
  })

  test('小数秒つき・秒なしも読む', () => {
    expect(parseJstTimeMs('2026/10/03 13:26:05.500')).toBe(Date.parse('2026-10-03T13:26:05+09:00'))
    expect(parseJstTimeMs('2026/10/03 13:26')).toBe(Date.parse('2026-10-03T13:26:00+09:00'))
  })

  test('時間帯を持つ表記（DMDATA の ISO 形式）はそのまま読む', () => {
    expect(parseJstTimeMs('2026-10-03T04:26:00Z')).toBe(Date.parse('2026-10-03T13:26:00+09:00'))
    expect(parseJstTimeMs('2026-10-03T13:26:00+09:00')).toBe(Date.parse('2026-10-03T13:26:00+09:00'))
  })

  test('存在しない日時・読めない文字列は NaN', () => {
    expect(parseJstTimeMs('2026/02/30 12:00:00')).toBeNaN()
    expect(parseJstTimeMs('こわれた時刻')).toBeNaN()
  })
})
