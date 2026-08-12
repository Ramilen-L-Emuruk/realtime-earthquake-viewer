import { describe, it, expect } from 'vitest'
import {
  tsunamiMaxGrade,
  tsunamiOverallGrade,
  isTsunamiNewFire,
  isTsunamiGradeUpgrade,
  hasActiveSpecialEEW,
} from './tsunami'
import type { JMATsunami, TsunamiArea } from '../types/earthquake'

function makeArea(overrides: Partial<TsunamiArea> = {}): TsunamiArea {
  return {
    code: '100',
    name: 'テスト予報区',
    grade: 'Watch',
    immediate: false,
    ...overrides,
  }
}

function makeTsunami(overrides: Partial<JMATsunami> = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: 'test-tsunami',
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: [makeArea()],
    ...overrides,
  }
}

describe('tsunamiMaxGrade', () => {
  it('areas 内の最高グレードを返す', () => {
    const t = makeTsunami({
      areas: [
        makeArea({ grade: 'Watch' }),
        makeArea({ grade: 'MajorWarning' }),
        makeArea({ grade: 'Warning' }),
      ],
    })
    expect(tsunamiMaxGrade(t)).toBe('MajorWarning')
  })

  it('areas が空なら Unknown', () => {
    const t = makeTsunami({ areas: [] })
    expect(tsunamiMaxGrade(t)).toBe('Unknown')
  })
})

describe('tsunamiOverallGrade', () => {
  it('cancelled/cancelledAt は除外する', () => {
    const t1 = makeTsunami({ areas: [makeArea({ grade: 'MajorWarning' })], cancelled: true })
    const t2 = makeTsunami({ areas: [makeArea({ grade: 'Warning' })] })
    expect(tsunamiOverallGrade([t1, t2])).toBe('Warning')
  })

  it('Forecast/Unknown は除外し MajorWarning>Warning>Watch の順で最大を返す', () => {
    const t = makeTsunami({ areas: [makeArea({ grade: 'Forecast' }), makeArea({ grade: 'Watch' })] })
    expect(tsunamiOverallGrade([t])).toBe('Watch')
  })

  it('候補が無ければ null', () => {
    const t = makeTsunami({ areas: [makeArea({ grade: 'Forecast' })] })
    expect(tsunamiOverallGrade([t])).toBeNull()
  })
})

describe('isTsunamiNewFire', () => {
  it('current 無しは true（新規）', () => {
    const next = makeTsunami({ eventId: 'A' })
    expect(isTsunamiNewFire(next, undefined)).toBe(true)
  })

  it('current が cancelled は true（新規）', () => {
    const current = makeTsunami({ eventId: 'A', cancelled: true })
    const next = makeTsunami({ eventId: 'A' })
    expect(isTsunamiNewFire(next, current)).toBe(true)
  })

  it('current が cancelledAt（10秒表示中の解除）は true（新規）', () => {
    const current = makeTsunami({ eventId: 'A', cancelledAt: new Date() })
    const next = makeTsunami({ eventId: 'A' })
    expect(isTsunamiNewFire(next, current)).toBe(true)
  })

  it('eventId が異なれば true（別地震）', () => {
    const current = makeTsunami({ eventId: 'A' })
    const next = makeTsunami({ eventId: 'B' })
    expect(isTsunamiNewFire(next, current)).toBe(true)
  })

  it('eventId が同じは false（続報）', () => {
    const current = makeTsunami({ eventId: 'A' })
    const next = makeTsunami({ eventId: 'A' })
    expect(isTsunamiNewFire(next, current)).toBe(false)
  })

  it('eventId が両方 undefined でも sourceEarthquake.originTime が異なれば true（P2PQuake 経路のフォールバック）', () => {
    const current = makeTsunami({ sourceEarthquake: { hypocenterName: 'A', originTime: '2026-01-01T00:00:00Z' } })
    const next = makeTsunami({ sourceEarthquake: { hypocenterName: 'B', originTime: '2026-01-02T00:00:00Z' } })
    expect(isTsunamiNewFire(next, current)).toBe(true)
  })

  it('eventId が両方 undefined で originTime が同じは false（同一地震の続報）', () => {
    const current = makeTsunami({ sourceEarthquake: { hypocenterName: 'A', originTime: '2026-01-01T00:00:00Z' } })
    const next = makeTsunami({ sourceEarthquake: { hypocenterName: 'A', originTime: '2026-01-01T00:00:00Z' } })
    expect(isTsunamiNewFire(next, current)).toBe(false)
  })

  it('eventId も originTime も無い場合は false（保守的に続報扱い）', () => {
    const current = makeTsunami({})
    const next = makeTsunami({})
    expect(isTsunamiNewFire(next, current)).toBe(false)
  })
})

describe('isTsunamiGradeUpgrade', () => {
  it('current 無しは false（新規は isTsunamiNewFire 側で拾う）', () => {
    const next = makeTsunami({ areas: [makeArea({ grade: 'MajorWarning' })] })
    expect(isTsunamiGradeUpgrade(next, undefined)).toBe(false)
  })

  it('current が cancelled は false', () => {
    const current = makeTsunami({ areas: [makeArea({ grade: 'Watch' })], cancelled: true })
    const next = makeTsunami({ areas: [makeArea({ grade: 'MajorWarning' })] })
    expect(isTsunamiGradeUpgrade(next, current)).toBe(false)
  })

  it('grade 格上げは true（Watch → Warning）', () => {
    const current = makeTsunami({ areas: [makeArea({ grade: 'Watch' })] })
    const next = makeTsunami({ areas: [makeArea({ grade: 'Warning' })] })
    expect(isTsunamiGradeUpgrade(next, current)).toBe(true)
  })

  it('grade 格上げは true（Warning → MajorWarning）', () => {
    const current = makeTsunami({ areas: [makeArea({ grade: 'Warning' })] })
    const next = makeTsunami({ areas: [makeArea({ grade: 'MajorWarning' })] })
    expect(isTsunamiGradeUpgrade(next, current)).toBe(true)
  })

  it('同一 grade は false（続報）', () => {
    const current = makeTsunami({ areas: [makeArea({ grade: 'Warning' })] })
    const next = makeTsunami({ areas: [makeArea({ grade: 'Warning' })] })
    expect(isTsunamiGradeUpgrade(next, current)).toBe(false)
  })

  it('grade 格下げは false（Warning → Watch）', () => {
    const current = makeTsunami({ areas: [makeArea({ grade: 'Warning' })] })
    const next = makeTsunami({ areas: [makeArea({ grade: 'Watch' })] })
    expect(isTsunamiGradeUpgrade(next, current)).toBe(false)
  })
})

describe('hasActiveSpecialEEW', () => {
  it('空 Map は false', () => {
    expect(hasActiveSpecialEEW(new Map())).toBe(false)
  })

  it('level=0 のみは false', () => {
    expect(hasActiveSpecialEEW(new Map([['a', 0]]))).toBe(false)
  })

  it('level=1 のみは false（警報級だが特別警報ではない）', () => {
    expect(hasActiveSpecialEEW(new Map([['a', 1]]))).toBe(false)
  })

  it('level=2 が 1 件でもあれば true', () => {
    expect(hasActiveSpecialEEW(new Map([['a', 1], ['b', 2]]))).toBe(true)
  })

  it('level=2 のみは true', () => {
    expect(hasActiveSpecialEEW(new Map([['a', 2]]))).toBe(true)
  })
})
