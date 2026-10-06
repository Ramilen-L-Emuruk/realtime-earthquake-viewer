import { describe, expect, test } from 'vitest'
import { buildOriginSecondsMap, eewOriginsFromActive } from './useQuakeOriginSeconds'
import { quakeEventKey } from '../utils/quakeMerge'
import type { EEWAlert, JMAQuake } from '../types/earthquake'
import type { JmaQuakeListEntry } from '../utils/quakeOriginSeconds'

function quake(id: string, time: string, name: string, magnitude: number): JMAQuake {
  return {
    id,
    time,
    issue: { source: '', time, type: '震源・震度情報' },
    earthquake: {
      time,
      hypocenter: { name, latitude: 32.5, longitude: 130.5, depth: 10, magnitude },
      maxScale: 10,
      domesticTsunami: 'None',
    },
    points: [],
  } as unknown as JMAQuake
}

function eew(eventId: string, originTime: string, extra: Partial<EEWAlert> = {}): EEWAlert {
  return {
    kind: 'eew',
    id: `x-${eventId}`,
    time: originTime,
    earthquake: { originTime, arrivalTime: originTime, condition: '', hypocenter: {} },
    issue: { eventId, serial: '1', time: originTime },
    cancelled: false,
    ...extra,
  } as unknown as EEWAlert
}

const EEW_MS = Date.parse('2026-10-03T13:26:01+09:00')
const ID_MS = Date.parse('2026-10-03T13:26:05+09:00')

describe('buildOriginSecondsMap（DMDSS 版）', () => {
  // DMDSS 版のカードは電文 ID に地震 ID を持つ（`dmdata-quake-<eventId>-<serial>`）。
  const card = quake('dmdata-quake-20261003132605-3', '2026-10-03T13:26:00+09:00', '熊本県天草・芦北地方', 3.5)

  test('同じ地震 ID の緊急地震速報があればその発生時刻', () => {
    const map = buildOriginSecondsMap({
      quakes: [card], isDmdss: true, eewOrigins: new Map([['20261003132605', EEW_MS]]), jmaList: [],
    })
    expect(map.get(quakeEventKey(card))).toEqual({ originMs: EEW_MS, source: 'eew' })
  })

  test('無ければ地震 ID の時刻', () => {
    const map = buildOriginSecondsMap({ quakes: [card], isDmdss: true, eewOrigins: new Map(), jmaList: [] })
    expect(map.get(quakeEventKey(card))).toEqual({ originMs: ID_MS, source: 'event-id' })
  })

  test('気象庁の一覧は見ない（地震 ID はカードが持っている）', () => {
    const p2pLike = quake('p2p-1', '2026-10-03T13:26:00+09:00', '熊本県天草・芦北地方', 3.5)
    const list: JmaQuakeListEntry[] = [
      { eid: '20261003132605', at: '2026-10-03T13:26:00+09:00', anm: '熊本県天草・芦北地方', mag: '3.5' },
    ]
    const map = buildOriginSecondsMap({ quakes: [p2pLike], isDmdss: true, eewOrigins: new Map(), jmaList: list })
    expect(map.size).toBe(0)
  })
})

describe('buildOriginSecondsMap（標準版）', () => {
  const card = quake('p2p-abc', '2026/10/03 13:26:00', '熊本県天草・芦北地方', 3.5)
  const list: JmaQuakeListEntry[] = [
    { eid: '20261003132605', at: '2026-10-03T13:26:00+09:00', anm: '熊本県天草・芦北地方', mag: '3.5' },
  ]

  test('気象庁の一覧で地震 ID を引き、緊急地震速報の発生時刻へ結び付ける', () => {
    const map = buildOriginSecondsMap({
      quakes: [card], isDmdss: false, eewOrigins: new Map([['20261003132605', EEW_MS]]), jmaList: list,
    })
    expect(map.get(quakeEventKey(card))).toEqual({ originMs: EEW_MS, source: 'eew' })
  })

  test('一覧で引けなければ秒は無い（緊急地震速報があっても結び付けられない）', () => {
    const map = buildOriginSecondsMap({
      quakes: [card], isDmdss: false, eewOrigins: new Map([['20261003132605', EEW_MS]]), jmaList: [],
    })
    expect(map.size).toBe(0)
  })
})

describe('eewOriginsFromActive', () => {
  test('地震 ID と発生時刻を取り出す', () => {
    const { updates, removals } = eewOriginsFromActive([eew('20261003132605', '2026-10-03T13:26:01+09:00')])
    expect(updates).toEqual([['20261003132605', EEW_MS]])
    expect(removals).toEqual([])
  })

  test('取り消された地震は除く側へ回す（誤報の発生時刻で線を引かない）', () => {
    // **画面の EEW の実際の形。** 取消電文を受けると既存の報へ `cancelledAt` だけが足され、
    // `cancelled` は false のまま表示猶予の間残る（`useEarthquakes` の 'eew' 分岐）。
    const { updates, removals } = eewOriginsFromActive([
      eew('20261003132605', '2026-10-03T13:26:01+09:00', { cancelledAt: new Date() }),
    ])
    expect(updates).toEqual([])
    expect(removals).toEqual(['20261003132605'])
  })

  test('取消電文そのもの（cancelled が真）も除く側へ回す', () => {
    const { removals } = eewOriginsFromActive([
      eew('20261003132605', '2026-10-03T13:26:01+09:00', { cancelled: true }),
    ])
    expect(removals).toEqual(['20261003132605'])
  })

  test('訓練・試験の報は採らない', () => {
    const { updates } = eewOriginsFromActive([eew('20261003132605', '2026-10-03T13:26:01+09:00', { test: true })])
    expect(updates).toEqual([])
  })

  test('地震 ID を持たない報は採らない', () => {
    const noId = eew('20261003132605', '2026-10-03T13:26:01+09:00', { issue: undefined })
    expect(eewOriginsFromActive([noId]).updates).toEqual([])
  })

  test('発生時刻が読めない報は採らない', () => {
    expect(eewOriginsFromActive([eew('20261003132605', 'こわれた時刻')]).updates).toEqual([])
  })
})
