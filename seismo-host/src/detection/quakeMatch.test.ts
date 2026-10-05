import { describe, expect, it } from 'vitest'

import { travelTimeSec } from '../../../src/utils/travelTime'
import { MATCH_TOLERANCE_DEFAULT, arrivalWindow, matchesQuake } from './quakeMatch'
import type { ReferenceQuake } from './quakeMatch'

// 観測点（架空の位置）と、照らし合わせる地震（M3.5・ごく浅い）。
const HOME = { lat: 35.0, lon: 135.0 }
const ORIGIN_MIN = Date.UTC(2026, 9, 3, 4, 26, 0) // 13:26:00 JST（地震情報は分単位）
const AMAKUSA: ReferenceQuake = {
  originMs: ORIGIN_MIN,
  originPrecisionMs: 60_000,
  lat: 32.5,
  lon: 130.5,
  depthKm: 0,
  magnitude: 3.5,
  name: '熊本県天草・芦北地方',
}

describe('arrivalWindow', () => {
  it('震央距離と走時から P・S の窓を出す（分単位の発生時刻ぶん後ろへ広げる）', () => {
    const w = arrivalWindow(AMAKUSA, HOME)
    expect(w.distanceKm).toBeGreaterThan(0)
    expect(Number.isFinite(w.distanceKm)).toBe(true)
    const tP = travelTimeSec('P', w.distanceKm, 0)
    const tS = travelTimeSec('S', w.distanceKm, 0)
    expect(w.earliestPMs).toBeCloseTo(ORIGIN_MIN + tP * 1000, 0)
    expect(w.earliestSMs).toBeCloseTo(ORIGIN_MIN + tS * 1000, 0)
    expect(w.latestSMs).toBeCloseTo(ORIGIN_MIN + 60_000 + tS * 1000, 0)
  })

  it('深さが分からないときは浅い側と深い側の両方で走時を引き、窓を広げる', () => {
    const known = arrivalWindow({ ...AMAKUSA, depthKm: 0 }, HOME)
    const unknown = arrivalWindow({ ...AMAKUSA, depthKm: null }, HOME)
    expect(unknown.earliestPMs).toBeLessThanOrEqual(known.earliestPMs)
    expect(unknown.latestSMs).toBeGreaterThan(known.latestSMs)
  })
})

describe('matchesQuake', () => {
  const w = arrivalWindow(AMAKUSA, HOME)

  it('正: 実機で S 波の引き金が引かれた時刻は一致する', () => {
    expect(matchesQuake(w.earliestSMs + 5_000, w)).toBe(true)
  })

  it('対照: 2 分前の M3.0 の揺れはこの地震とは一致しない', () => {
    expect(matchesQuake(w.earliestPMs - 60_000, w)).toBe(false)
  })

  it('対照: 窓より大きく遅れた揺れ（13:28:30）は一致しない', () => {
    expect(matchesQuake(Date.UTC(2026, 9, 3, 4, 28, 30), w)).toBe(false)
  })

  it('境目: 最も早い P の余裕ぶん手前までは一致、その外は一致しない', () => {
    expect(matchesQuake(w.earliestPMs - MATCH_TOLERANCE_DEFAULT.beforeMs, w)).toBe(true)
    expect(matchesQuake(w.earliestPMs - MATCH_TOLERANCE_DEFAULT.beforeMs - 1, w)).toBe(false)
    expect(matchesQuake(w.latestSMs + MATCH_TOLERANCE_DEFAULT.afterMs, w)).toBe(true)
    expect(matchesQuake(w.latestSMs + MATCH_TOLERANCE_DEFAULT.afterMs + 1, w)).toBe(false)
  })
})
