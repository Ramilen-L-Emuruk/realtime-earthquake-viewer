import { describe, it, expect } from 'vitest'
import { computeEewCircle } from './usePsWaveCalc'
import type { EEWAlert } from '../types/earthquake'

function makeEEW(overrides: Partial<EEWAlert> = {}): EEWAlert {
  return {
    kind: 'eew',
    id: 'test-eew',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '以上',
      hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
    },
    severity: 'Warning',
    cancelled: false,
    ...overrides,
  }
}

// originTime から60秒後（P波・S波とも十分地表に到達している時刻）
const NOW = new Date('2026-01-01T12:01:00Z').getTime()

describe('computeEewCircle', () => {
  it('通常の EEW から円を計算する', () => {
    const circle = computeEewCircle(makeEEW(), NOW)
    expect(circle).not.toBeNull()
    expect(circle).toMatchObject({ eventId: 'test-eew', lat: 35.0, lng: 135.0, depth: 10, magnitude: 6.0 })
    expect(circle!.pRadius).toBeGreaterThan(0)
    expect(circle!.sRadius).toBeGreaterThan(0)
  })

  it('issue.eventId があればそちらを eventId に使う', () => {
    const circle = computeEewCircle(makeEEW({ issue: { eventId: 'ev-1' } }), NOW)
    expect(circle!.eventId).toBe('ev-1')
  })

  it('issue.eventId が無ければ id を eventId に使う', () => {
    const circle = computeEewCircle(makeEEW({ id: 'fallback-id', issue: undefined }), NOW)
    expect(circle!.eventId).toBe('fallback-id')
  })

  it('cancelled な EEW は null', () => {
    expect(computeEewCircle(makeEEW({ cancelled: true }), NOW)).toBeNull()
  })

  it('cancelledAt がある EEW は null', () => {
    expect(computeEewCircle(makeEEW({ cancelledAt: new Date() }), NOW)).toBeNull()
  })

  it('座標が無効（NaN）な EEW は null', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '以上',
        hypocenter: { name: 'テスト震源', latitude: NaN, longitude: 135.0, depth: 10, magnitude: 6.0 },
      },
    })
    expect(computeEewCircle(eew, NOW)).toBeNull()
  })

  it('震源名が無い（単独観測点処理）EEW は null', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '以上',
        hypocenter: { name: '', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
      },
    })
    expect(computeEewCircle(eew, NOW)).toBeNull()
  })

  it('仮定震源要素の EEW は null', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '仮定震源要素',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
      },
    })
    expect(computeEewCircle(eew, NOW)).toBeNull()
  })

  it('originTime が未来（発生前）の EEW は null', () => {
    const future = new Date('2026-01-01T12:02:00Z').getTime()
    expect(computeEewCircle(makeEEW({ earthquake: { ...makeEEW().earthquake, originTime: '2026-01-01T12:05:00Z' } }), future)).toBeNull()
  })

  it('発生直後（数秒以内）は深さぶんの走時に届かず円がまだ無い', () => {
    // Arrange: depth=24km・VP1=6.0km/s なら P波が地表に届くまで depth/VP1=4秒かかる
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '以上',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 24, magnitude: 7.0 },
      },
    })
    const now = new Date('2026-01-01T12:00:01Z').getTime() // 発生から1秒後

    // Act
    const circle = computeEewCircle(eew, now)

    // Assert: 円自体は返るが半径はまだ0（bounds 計算側で無視される）
    expect(circle!.pRadius).toBe(0)
    expect(circle!.sRadius).toBe(0)
  })
})
