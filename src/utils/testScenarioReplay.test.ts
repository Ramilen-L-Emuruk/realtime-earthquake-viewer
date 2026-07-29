import { describe, it, expect } from 'vitest'
import { instantiateScenario } from './testScenarioReplay'
import type { TestScenarioFile } from '../types/testScenario'
import type { EEWAlert, JMAQuake, JMATsunami, JMALpgm, JMANankai, JMAKohatsu } from '../types/earthquake'

function makeQuake(overrides: Partial<JMAQuake> = {}): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20240101070900-1',
    eventId: '20240101070900',
    time: '2024-01-01T07:10:00Z',
    issue: { source: '気象庁', time: '2024-01-01T07:10:00Z', type: '震度速報', correct: 'なし' },
    earthquake: {
      time: '2024-01-01T07:09:00Z',
      hypocenter: { name: 'テスト震源', latitude: 37.0, longitude: 137.0, depth: 10, magnitude: 7.0 },
      maxScale: 60,
      domesticTsunami: '警報等',
    },
    points: [],
    ...overrides,
  }
}

function makeEEW(overrides: Partial<EEWAlert> = {}): EEWAlert {
  return {
    kind: 'eew',
    id: 'dmdata-eew-20240101070900-1',
    time: '2024-01-01T07:09:05Z',
    test: false,
    earthquake: {
      originTime: '2024-01-01T07:09:00Z',
      arrivalTime: '2024-01-01T07:09:20Z',
      condition: '以上',
      hypocenter: { name: 'テスト震源', latitude: 37.0, longitude: 137.0, depth: 10, magnitude: 7.0 },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { eventId: '20240101070900', serial: '1', time: '2024-01-01T07:09:05Z' },
    areas: [
      { pref: 'テスト県', name: 'テスト地域', scaleFrom: 50, scaleTo: 60, kindCode: '1', arrivalTime: '2024-01-01T07:09:30Z' },
      { pref: 'テスト県2', name: 'テスト地域2', scaleFrom: 10, scaleTo: 20, kindCode: '1', arrivalTime: null },
    ],
    ...overrides,
  }
}

function makeTsunami(overrides: Partial<JMATsunami> = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: 'dmdata-tsunami-20240101070900-1',
    eventId: '20240101070900',
    time: '2024-01-01T07:15:00Z',
    cancelled: false,
    validDateTime: '2024-01-01T09:15:00Z',
    sourceEarthquake: { hypocenterName: 'テスト震源', magnitude: 7.0, originTime: '2024-01-01T07:09:00Z' },
    issue: { source: '気象庁', time: '2024-01-01T07:15:00Z', type: 'Focus' },
    areas: [
      {
        grade: 'Warning', immediate: false, name: 'テスト沿岸',
        firstHeight: { arrivalTime: '2024-01-01T07:40:00Z', condition: 'ただちに津波来襲と予測' },
        stations: [
          { name: 'テスト観測点', code: '001', highTideDateTime: '2024-01-01T08:00:00Z', arrivalTime: '2024-01-01T07:41:00Z' },
        ],
      },
    ],
    observations: [
      { name: 'テスト観測点2', arrivalTime: '2024-01-01T07:42:00Z' },
    ],
    ...overrides,
  }
}

function makeLpgm(overrides: Partial<JMALpgm> = {}): JMALpgm {
  return {
    id: 'dmdata-lpgm-20240101070900-1',
    eventId: '20240101070900',
    time: '2024-01-01T07:11:00Z',
    originTime: '2024-01-01T07:09:00Z',
    maxClass: 4,
    cancelled: false,
    ...overrides,
  }
}

function makeNankai(overrides: Partial<JMANankai> = {}): JMANankai {
  return {
    id: 'dmdata-xml-nankai-20240101070900-1',
    eventId: '20240101070900',
    time: '2024-01-01T07:30:00Z',
    kindCode: '0202',
    kindName: '巨大地震注意',
    headline: 'テスト見出し',
    body: 'テスト本文',
    cancelled: false,
    reportDateTime: '2024-01-01T07:30:00Z',
    ...overrides,
  }
}

function makeKohatsu(overrides: Partial<JMAKohatsu> = {}): JMAKohatsu {
  return {
    id: 'dmdata-xml-kohatsu-20240101070900-1',
    eventId: '20240101070900',
    time: '2024-01-01T07:30:00Z',
    headline: 'テスト見出し',
    body: 'テスト本文',
    cancelled: false,
    reportDateTime: '2024-01-01T07:30:00Z',
    expireAt: '2024-01-08T07:30:00Z',
    ...overrides,
  }
}

const NOW = new Date('2026-07-30T10:00:00Z')

describe('instantiateScenario', () => {
  it('offsetMs:0のエントリのreplayTimeがnowと一致する', () => {
    const scenario: TestScenarioFile = {
      id: 'test', label: 'テスト', description: '', category: 'quake', durationMs: 0,
      baseTime: '2024-01-01T07:10:00Z',
      entries: [{ offsetMs: 0, payload: { kind: 'event', event: makeQuake() } }],
    }
    const result = instantiateScenario(scenario, NOW)
    expect(result[0].replayTime.getTime()).toBe(NOW.getTime())
  })

  it('offsetMsに応じてreplayTimeがnowからシフトする', () => {
    const scenario: TestScenarioFile = {
      id: 'test', label: 'テスト', description: '', category: 'quake', durationMs: 60000,
      baseTime: '2024-01-01T07:10:00Z',
      entries: [
        { offsetMs: 0, payload: { kind: 'event', event: makeQuake() } },
        { offsetMs: 60000, payload: { kind: 'event', event: makeQuake({ id: 'dmdata-quake-20240101070900-2' }) } },
      ],
    }
    const result = instantiateScenario(scenario, NOW)
    expect(result[1].replayTime.getTime()).toBe(NOW.getTime() + 60000)
  })

  it('silentフラグがそのまま引き継がれる', () => {
    const scenario: TestScenarioFile = {
      id: 'test', label: 'テスト', description: '', category: 'quake', durationMs: 0,
      baseTime: '2024-01-01T07:10:00Z',
      entries: [{ offsetMs: 0, payload: { kind: 'event', event: makeQuake() }, silent: true }],
    }
    const result = instantiateScenario(scenario, NOW)
    expect(result[0].silent).toBe(true)
  })

  describe('JMAQuake', () => {
    it('time・issue.time・earthquake.timeが同じdeltaでシフトされる', () => {
      const quake = makeQuake()
      const baseTime = '2024-01-01T07:10:00Z'
      const originalDelta = NOW.getTime() - new Date(baseTime).getTime()
      const scenario: TestScenarioFile = {
        id: 'test', label: 'テスト', description: '', category: 'quake', durationMs: 0,
        baseTime,
        entries: [{ offsetMs: 0, payload: { kind: 'event', event: quake } }],
      }
      const result = instantiateScenario(scenario, NOW)
      const shifted = (result[0].payload as { kind: 'event'; event: JMAQuake }).event
      expect(new Date(shifted.time).getTime()).toBe(new Date(quake.time).getTime() + originalDelta)
      expect(new Date(shifted.issue.time).getTime()).toBe(new Date(quake.issue.time).getTime() + originalDelta)
      expect(new Date(shifted.earthquake.time).getTime()).toBe(new Date(quake.earthquake.time).getTime() + originalDelta)
    })

    it('idに埋め込まれたeventIdが再採番され、既存の正規表現にマッチし続ける', () => {
      const quake = makeQuake()
      const scenario: TestScenarioFile = {
        id: 'test', label: 'テスト', description: '', category: 'quake', durationMs: 0,
        baseTime: '2024-01-01T07:10:00Z',
        entries: [{ offsetMs: 0, payload: { kind: 'event', event: quake } }],
      }
      const result = instantiateScenario(scenario, NOW)
      const shifted = (result[0].payload as { kind: 'event'; event: JMAQuake }).event
      expect(shifted.id).toMatch(/^dmdata-quake-(\d{14})-1$/)
      expect(shifted.id).not.toBe(quake.id)
    })

    it('同一シナリオ内で同じidのeventId部分を持つ複数報が同じ新IDにマッピングされる', () => {
      const quake1 = makeQuake({ id: 'dmdata-quake-20240101070900-1', issue: { source: '気象庁', time: '2024-01-01T07:10:00Z', type: '震度速報', correct: 'なし' } })
      const quake2 = makeQuake({ id: 'dmdata-quake-20240101070900-2', issue: { source: '気象庁', time: '2024-01-01T07:12:00Z', type: '震源・震度情報', correct: 'なし' } })
      const scenario: TestScenarioFile = {
        id: 'test', label: 'テスト', description: '', category: 'quake', durationMs: 120000,
        baseTime: '2024-01-01T07:10:00Z',
        entries: [
          { offsetMs: 0, payload: { kind: 'event', event: quake1 } },
          { offsetMs: 120000, payload: { kind: 'event', event: quake2 } },
        ],
      }
      const result = instantiateScenario(scenario, NOW)
      const e1 = (result[0].payload as { kind: 'event'; event: JMAQuake }).event
      const e2 = (result[1].payload as { kind: 'event'; event: JMAQuake }).event
      const eid1 = e1.id.match(/^dmdata-quake-(\d{14})-1$/)?.[1]
      const eid2 = e2.id.match(/^dmdata-quake-(\d{14})-2$/)?.[1]
      expect(eid1).toBeDefined()
      expect(eid1).toBe(eid2)
    })
  })

  describe('EEWAlert', () => {
    it('earthquake.originTime・arrivalTime・issue.timeがシフトされる', () => {
      const eew = makeEEW()
      const baseTime = '2024-01-01T07:09:05Z'
      const originalDelta = NOW.getTime() - new Date(baseTime).getTime()
      const scenario: TestScenarioFile = {
        id: 'test', label: 'テスト', description: '', category: 'eew-warning', durationMs: 0,
        baseTime,
        entries: [{ offsetMs: 0, payload: { kind: 'event', event: eew } }],
      }
      const result = instantiateScenario(scenario, NOW)
      const shifted = (result[0].payload as { kind: 'event'; event: EEWAlert }).event
      expect(new Date(shifted.earthquake.originTime).getTime()).toBe(new Date(eew.earthquake.originTime).getTime() + originalDelta)
      expect(new Date(shifted.earthquake.arrivalTime).getTime()).toBe(new Date(eew.earthquake.arrivalTime).getTime() + originalDelta)
      expect(new Date(shifted.issue!.time!).getTime()).toBe(new Date(eew.issue!.time!).getTime() + originalDelta)
    })

    it('areas[].arrivalTimeがシフトされ、nullはnullのまま保持される', () => {
      const eew = makeEEW()
      const baseTime = '2024-01-01T07:09:05Z'
      const originalDelta = NOW.getTime() - new Date(baseTime).getTime()
      const scenario: TestScenarioFile = {
        id: 'test', label: 'テスト', description: '', category: 'eew-warning', durationMs: 0,
        baseTime,
        entries: [{ offsetMs: 0, payload: { kind: 'event', event: eew } }],
      }
      const result = instantiateScenario(scenario, NOW)
      const shifted = (result[0].payload as { kind: 'event'; event: EEWAlert }).event
      expect(new Date(shifted.areas![0].arrivalTime!).getTime()).toBe(new Date(eew.areas![0].arrivalTime!).getTime() + originalDelta)
      expect(shifted.areas![1].arrivalTime).toBeNull()
    })

    it('issue.eventIdが再採番される', () => {
      const eew = makeEEW()
      const scenario: TestScenarioFile = {
        id: 'test', label: 'テスト', description: '', category: 'eew-warning', durationMs: 0,
        baseTime: '2024-01-01T07:09:05Z',
        entries: [{ offsetMs: 0, payload: { kind: 'event', event: eew } }],
      }
      const result = instantiateScenario(scenario, NOW)
      const shifted = (result[0].payload as { kind: 'event'; event: EEWAlert }).event
      expect(shifted.issue!.eventId).toBeDefined()
      expect(shifted.issue!.eventId).not.toBe(eew.issue!.eventId)
      expect(shifted.id).toContain(shifted.issue!.eventId!)
    })
  })

  describe('JMATsunami', () => {
    it('validDateTime・sourceEarthquake.originTime・areas/observationsのネストした時刻がすべてシフトされる', () => {
      const tsunami = makeTsunami()
      const baseTime = '2024-01-01T07:15:00Z'
      const originalDelta = NOW.getTime() - new Date(baseTime).getTime()
      const scenario: TestScenarioFile = {
        id: 'test', label: 'テスト', description: '', category: 'tsunami', durationMs: 0,
        baseTime,
        entries: [{ offsetMs: 0, payload: { kind: 'event', event: tsunami } }],
      }
      const result = instantiateScenario(scenario, NOW)
      const shifted = (result[0].payload as { kind: 'event'; event: JMATsunami }).event

      expect(new Date(shifted.validDateTime!).getTime()).toBe(new Date(tsunami.validDateTime!).getTime() + originalDelta)
      expect(new Date(shifted.sourceEarthquake!.originTime!).getTime()).toBe(new Date(tsunami.sourceEarthquake!.originTime!).getTime() + originalDelta)
      expect(new Date(shifted.areas[0].firstHeight!.arrivalTime!).getTime()).toBe(new Date(tsunami.areas[0].firstHeight!.arrivalTime!).getTime() + originalDelta)
      expect(new Date(shifted.areas[0].stations![0].highTideDateTime!).getTime()).toBe(new Date(tsunami.areas[0].stations![0].highTideDateTime!).getTime() + originalDelta)
      expect(new Date(shifted.areas[0].stations![0].arrivalTime!).getTime()).toBe(new Date(tsunami.areas[0].stations![0].arrivalTime!).getTime() + originalDelta)
      expect(new Date(shifted.observations![0].arrivalTime!).getTime()).toBe(new Date(tsunami.observations![0].arrivalTime!).getTime() + originalDelta)
    })

    it('eventIdが再採番される', () => {
      const tsunami = makeTsunami()
      const scenario: TestScenarioFile = {
        id: 'test', label: 'テスト', description: '', category: 'tsunami', durationMs: 0,
        baseTime: '2024-01-01T07:15:00Z',
        entries: [{ offsetMs: 0, payload: { kind: 'event', event: tsunami } }],
      }
      const result = instantiateScenario(scenario, NOW)
      const shifted = (result[0].payload as { kind: 'event'; event: JMATsunami }).event
      expect(shifted.eventId).toBeDefined()
      expect(shifted.eventId).not.toBe(tsunami.eventId)
    })
  })

  describe('JMALpgm', () => {
    it('time・originTimeがシフトされ、eventId・idが再採番される', () => {
      const lpgm = makeLpgm()
      const baseTime = '2024-01-01T07:11:00Z'
      const originalDelta = NOW.getTime() - new Date(baseTime).getTime()
      const scenario: TestScenarioFile = {
        id: 'test', label: 'テスト', description: '', category: 'lpgm', durationMs: 0,
        baseTime,
        entries: [{ offsetMs: 0, payload: { kind: 'lpgm', data: lpgm } }],
      }
      const result = instantiateScenario(scenario, NOW)
      const shifted = (result[0].payload as { kind: 'lpgm'; data: JMALpgm }).data
      expect(new Date(shifted.time).getTime()).toBe(new Date(lpgm.time).getTime() + originalDelta)
      expect(new Date(shifted.originTime).getTime()).toBe(new Date(lpgm.originTime).getTime() + originalDelta)
      expect(shifted.eventId).not.toBe(lpgm.eventId)
      expect(shifted.id).toContain(shifted.eventId)
    })
  })

  describe('JMANankai', () => {
    it('time・reportDateTimeがシフトされ、eventId・idが再採番される', () => {
      const nankai = makeNankai()
      const baseTime = '2024-01-01T07:30:00Z'
      const originalDelta = NOW.getTime() - new Date(baseTime).getTime()
      const scenario: TestScenarioFile = {
        id: 'test', label: 'テスト', description: '', category: 'foreign', durationMs: 0,
        baseTime,
        entries: [{ offsetMs: 0, payload: { kind: 'nankai', data: nankai } }],
      }
      const result = instantiateScenario(scenario, NOW)
      const shifted = (result[0].payload as { kind: 'nankai'; data: JMANankai }).data
      expect(new Date(shifted.time).getTime()).toBe(new Date(nankai.time).getTime() + originalDelta)
      expect(new Date(shifted.reportDateTime).getTime()).toBe(new Date(nankai.reportDateTime).getTime() + originalDelta)
      expect(shifted.eventId).not.toBe(nankai.eventId)
      expect(shifted.id).toContain(shifted.eventId)
    })
  })

  describe('JMAKohatsu', () => {
    it('time・reportDateTime・expireAtがすべて同じdeltaでシフトされる', () => {
      const kohatsu = makeKohatsu()
      const baseTime = '2024-01-01T07:30:00Z'
      const originalDelta = NOW.getTime() - new Date(baseTime).getTime()
      const scenario: TestScenarioFile = {
        id: 'test', label: 'テスト', description: '', category: 'foreign', durationMs: 0,
        baseTime,
        entries: [{ offsetMs: 0, payload: { kind: 'kohatsu', data: kohatsu } }],
      }
      const result = instantiateScenario(scenario, NOW)
      const shifted = (result[0].payload as { kind: 'kohatsu'; data: JMAKohatsu }).data
      expect(new Date(shifted.time).getTime()).toBe(new Date(kohatsu.time).getTime() + originalDelta)
      expect(new Date(shifted.reportDateTime).getTime()).toBe(new Date(kohatsu.reportDateTime).getTime() + originalDelta)
      expect(new Date(shifted.expireAt).getTime()).toBe(new Date(kohatsu.expireAt).getTime() + originalDelta)
      // expireAtは「今から7日後」であり続ける（過去日時に固定されない）
      expect(new Date(shifted.expireAt).getTime()).toBeGreaterThan(NOW.getTime())
    })
  })

  it('1シナリオ内に10種類を超えるdistinctなeventIdがあっても新IDが衝突しない', () => {
    const DISTINCT_COUNT = 20
    const entries = Array.from({ length: DISTINCT_COUNT }, (_, i) => ({
      offsetMs: i * 1000,
      payload: {
        kind: 'event' as const,
        event: makeQuake({
          id: `dmdata-quake-2024010107${String(i).padStart(4, '0')}-1`,
          eventId: `2024010107${String(i).padStart(4, '0')}`,
        }),
      },
    }))
    const scenario: TestScenarioFile = {
      id: 'test', label: 'テスト', description: '', category: 'quake', durationMs: DISTINCT_COUNT * 1000,
      baseTime: '2024-01-01T07:10:00Z',
      entries,
    }
    const result = instantiateScenario(scenario, NOW)
    const newIds = result.map(r => (r.payload as { kind: 'event'; event: JMAQuake }).event.id)
    expect(new Set(newIds).size).toBe(DISTINCT_COUNT)
    for (const id of newIds) expect(id).toMatch(/^dmdata-quake-\d{14}-1$/)
  })

  it('異なるnowでinstantiateScenarioを呼ぶと異なる新IDが採番される', () => {
    const scenario: TestScenarioFile = {
      id: 'test', label: 'テスト', description: '', category: 'quake', durationMs: 0,
      baseTime: '2024-01-01T07:10:00Z',
      entries: [{ offsetMs: 0, payload: { kind: 'event', event: makeQuake() } }],
    }
    const result1 = instantiateScenario(scenario, NOW)
    const result2 = instantiateScenario(scenario, new Date(NOW.getTime() + 1))
    const id1 = (result1[0].payload as { kind: 'event'; event: JMAQuake }).event.id
    const id2 = (result2[0].payload as { kind: 'event'; event: JMAQuake }).event.id
    expect(id1).not.toBe(id2)
  })
})
