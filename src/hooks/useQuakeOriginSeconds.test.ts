import { describe, expect, test } from 'vitest'
import { buildOriginSecondsMap, catalogYearsNeeded, eewOriginsFromActive, type LoadedCatalog } from './useQuakeOriginSeconds'
import { quakeEventKey } from '../utils/quakeMerge'
import type { EEWAlert, JMAQuake } from '../types/earthquake'
import type { EewOriginEntry } from '../utils/eewOriginStore'
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
const CATALOG_MS = Date.parse('2026-10-03T13:26:00.85+09:00')
const decided = (originMs: number): EewOriginEntry => ({ originMs, assumed: false })

/** 2026 年の長期震源カタログ（その地震 1 件だけ）。 */
const CATALOG: LoadedCatalog = {
  years: new Map([[2026, { timeMs: [CATALOG_MS], lat: [32.5], lng: [130.5], magnitude: [3.5] }]]),
  coveredThroughMs: CATALOG_MS + 10 * 24 * 3600_000,
}

describe('buildOriginSecondsMap（DMDSS 版）', () => {
  // DMDSS 版のカードは電文 ID に地震 ID を持つ（`dmdata-quake-<eventId>-<serial>`）。
  const card = quake('dmdata-quake-20261003132605-3', '2026-10-03T13:26:00+09:00', '熊本県天草・芦北地方', 3.5)

  test('同じ地震 ID の緊急地震速報があればその発生時刻', () => {
    const map = buildOriginSecondsMap({
      quakes: [card], isDmdss: true, eewOrigins: new Map([['20261003132605', decided(EEW_MS)]]), jmaList: [], catalog: CATALOG,
    })
    expect(map.get(quakeEventKey(card))).toEqual({ originMs: EEW_MS, source: 'eew' })
  })

  test('無ければ長期震源カタログ', () => {
    const map = buildOriginSecondsMap({ quakes: [card], isDmdss: true, eewOrigins: new Map(), jmaList: [], catalog: CATALOG })
    expect(map.get(quakeEventKey(card))).toEqual({ originMs: CATALOG_MS, source: 'catalog' })
  })

  // 2026-10-15 ユーザー承認「カタログが届くまで線を引かない」。地震 ID の時刻へは落とさない。
  test('カタログにも無ければ秒は無い（地震 ID の時刻は使わない）', () => {
    const map = buildOriginSecondsMap({ quakes: [card], isDmdss: true, eewOrigins: new Map(), jmaList: [], catalog: null })
    expect(map.size).toBe(0)
  })

  test('仮定震源要素の報しか無ければカタログへ回る', () => {
    const map = buildOriginSecondsMap({
      quakes: [card], isDmdss: true,
      eewOrigins: new Map([['20261003132605', { originMs: EEW_MS + 5_000, assumed: true }]]),
      jmaList: [], catalog: CATALOG,
    })
    expect(map.get(quakeEventKey(card))).toEqual({ originMs: CATALOG_MS, source: 'catalog' })
  })

  test('気象庁の一覧は見ない（地震 ID はカードが持っている）', () => {
    const p2pLike = quake('p2p-1', '2026-10-03T13:26:00+09:00', '熊本県天草・芦北地方', 3.5)
    const list: JmaQuakeListEntry[] = [
      { eid: '20261003132605', at: '2026-10-03T13:26:00+09:00', anm: '熊本県天草・芦北地方', mag: '3.5' },
    ]
    const map = buildOriginSecondsMap({
      quakes: [p2pLike], isDmdss: true, eewOrigins: new Map([['20261003132605', decided(EEW_MS)]]), jmaList: list, catalog: null,
    })
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
      quakes: [card], isDmdss: false, eewOrigins: new Map([['20261003132605', decided(EEW_MS)]]), jmaList: list, catalog: null,
    })
    expect(map.get(quakeEventKey(card))).toEqual({ originMs: EEW_MS, source: 'eew' })
  })

  test('一覧で引けなければ緊急地震速報は結べない（カタログは地震 ID なしで引ける）', () => {
    const eewOrigins = new Map([['20261003132605', decided(EEW_MS)]])
    expect(buildOriginSecondsMap({ quakes: [card], isDmdss: false, eewOrigins, jmaList: [], catalog: null }).size).toBe(0)
    expect(buildOriginSecondsMap({ quakes: [card], isDmdss: false, eewOrigins, jmaList: [], catalog: CATALOG })
      .get(quakeEventKey(card))).toEqual({ originMs: CATALOG_MS, source: 'catalog' })
  })
})

describe('buildOriginSecondsMap（カタログの年）', () => {
  // 安全弁: 年をまたぐ分で片方の年しか読めていないと、もう片方の候補が見えず取り違える。
  test('要る年が揃っていなければカタログから引かない', () => {
    const newYear = Date.parse('2026-01-01T00:00:00+09:00')
    const card = quake('dmdata-quake-20251231235900-1', '2025-12-31T23:59:00+09:00', '熊本県天草・芦北地方', 3.5)
    const only2026: LoadedCatalog = {
      years: new Map([[2026, { timeMs: [newYear + 3_000], lat: [32.5], lng: [130.5], magnitude: [3.5] }]]),
      coveredThroughMs: newYear + 86400_000,
    }
    expect(buildOriginSecondsMap({ quakes: [card], isDmdss: true, eewOrigins: new Map(), jmaList: [], catalog: only2026 }).size).toBe(0)
    const both: LoadedCatalog = { ...only2026, years: new Map([...only2026.years, [2025, { timeMs: [], lat: [], lng: [], magnitude: [] }]]) }
    expect(buildOriginSecondsMap({ quakes: [card], isDmdss: true, eewOrigins: new Map(), jmaList: [], catalog: both })
      .get(quakeEventKey(card))).toEqual({ originMs: newYear + 3_000, source: 'catalog' })
  })
})

describe('catalogYearsNeeded', () => {
  const card = quake('dmdata-quake-20261003132605-3', '2026-10-03T13:26:00+09:00', '熊本県天草・芦北地方', 3.5)

  test('緊急地震速報から秒が取れない地震の年だけ', () => {
    expect(catalogYearsNeeded({ quakes: [card], isDmdss: true, eewOrigins: new Map(), jmaList: [] })).toEqual([2026])
    expect(catalogYearsNeeded({
      quakes: [card], isDmdss: true, eewOrigins: new Map([['20261003132605', decided(EEW_MS)]]), jmaList: [],
    })).toEqual([])
  })

  test('震央か規模が判らない地震は数えない', () => {
    const noMag = quake('dmdata-quake-20261003132605-1', '2026-10-03T13:26:00+09:00', '熊本県天草・芦北地方', Number.NaN)
    expect(catalogYearsNeeded({ quakes: [noMag], isDmdss: true, eewOrigins: new Map(), jmaList: [] })).toEqual([])
  })
})

describe('eewOriginsFromActive', () => {
  test('地震 ID と発生時刻を取り出す（震源の決まった報）', () => {
    const { updates, removals } = eewOriginsFromActive([eew('20261003132605', '2026-10-03T13:26:01+09:00')])
    expect(updates).toEqual([['20261003132605', decided(EEW_MS)]])
    expect(removals).toEqual([])
  })

  test('仮定震源要素の報は印を付けて残す', () => {
    const e = eew('20261003132605', '2026-10-03T13:26:01+09:00')
    const assumed = { ...e, earthquake: { ...e.earthquake, condition: '仮定震源要素' } } as EEWAlert
    expect(eewOriginsFromActive([assumed]).updates).toEqual([['20261003132605', { originMs: EEW_MS, assumed: true }]])
  })

  // 強震モニタ（Yahoo）の報は `condition` を運ばないので、決まった報とも仮定とも言えない。
  test('condition の欄を持たない報は見分けられないとして残す', () => {
    const e = eew('20261003132605', '2026-10-03T13:26:01+09:00')
    const noCondition = { ...e, earthquake: { ...e.earthquake, condition: undefined } } as unknown as EEWAlert
    expect(eewOriginsFromActive([noCondition]).updates).toEqual([['20261003132605', { originMs: EEW_MS, assumed: null }]])
  })

  test('強震モニタの報は見分けられないとして残す', () => {
    const yahoo = eew('20261003132605', '2026-10-03T13:26:01+09:00', { id: 'yahoo-eew-20261003132605' })
    expect(eewOriginsFromActive([yahoo]).updates).toEqual([['20261003132605', { originMs: EEW_MS, assumed: null }]])
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
