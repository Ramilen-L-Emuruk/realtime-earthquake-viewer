import { describe, it, expect } from 'vitest'
import {
  dynamicRegionThresholdKm, isSameEarthquake, isRegionWithinAnyEew,
  REGION_MATCH_KM, DEFAULT_VIRTUAL_DEPTH_KM, DYNAMIC_THRESHOLD_SAFETY_FACTOR, type AlertRegion,
} from './useKyoshinAlerts'
import { computeSWaveRadiusAtTime } from './usePsWaveCalc'
import type { EEWAlert, Hypocenter } from '../types/earthquake'

function fakeRegion(overrides: Partial<AlertRegion> = {}): AlertRegion {
  return {
    lat: 37.5,
    lng: 137.0, // 能登半島付近
    seen: 1,
    fired: false,
    lastTick: 0,
    firstSeenAtMs: 0,
    ...overrides,
  }
}

function fakeEEW(id: string, originTime: string, hypocenter: Hypocenter, condition = '以上'): EEWAlert {
  return {
    kind: 'eew',
    id,
    time: originTime,
    test: false,
    severity: 'Warning',
    cancelled: false,
    earthquake: { originTime, arrivalTime: originTime, condition, hypocenter },
  }
}

describe('dynamicRegionThresholdKm', () => {
  it('EEW無し・経過時間0なら REGION_MATCH_KM を返す', () => {
    const region = fakeRegion({ firstSeenAtMs: 1000 })
    expect(dynamicRegionThresholdKm(region, 1000, null)).toBe(REGION_MATCH_KM)
  })

  it('EEW無し・経過時間が負（時計逆行）なら REGION_MATCH_KM を返す', () => {
    const region = fakeRegion({ firstSeenAtMs: 5000 })
    expect(dynamicRegionThresholdKm(region, 1000, null)).toBe(REGION_MATCH_KM)
  })

  it('EEW無し・経過時間が十分長ければ DEFAULT_VIRTUAL_DEPTH_KM での S波半径×安全マージンまで拡大する', () => {
    const region = fakeRegion({ firstSeenAtMs: 0 })
    const nowMs = 90_000 // 90秒経過
    const expectedRadius = computeSWaveRadiusAtTime(90, DEFAULT_VIRTUAL_DEPTH_KM) * DYNAMIC_THRESHOLD_SAFETY_FACTOR
    expect(expectedRadius).toBeGreaterThan(REGION_MATCH_KM)
    expect(dynamicRegionThresholdKm(region, nowMs, null)).toBeCloseTo(expectedRadius, 5)
  })

  it('動的半径が下限を下回る場合は REGION_MATCH_KM を返す（発生直後）', () => {
    const region = fakeRegion({ firstSeenAtMs: 0 })
    const nowMs = 1_000 // 発生1秒後はまだS波が広がっていない
    expect(dynamicRegionThresholdKm(region, nowMs, null)).toBe(REGION_MATCH_KM)
  })
})

describe('isSameEarthquake', () => {
  it('EEW無し・下限距離(REGION_MATCH_KM)以内なら同一地震とみなす', () => {
    const region = fakeRegion({ lat: 37.5, lng: 137.0, firstSeenAtMs: 0 })
    // 300km未満の近傍点
    expect(isSameEarthquake(region, 38.0, 137.5, 1000, new Map())).toBe(true)
  })

  it('EEW無し・下限距離を超えていれば別地震とみなす', () => {
    const region = fakeRegion({ lat: 37.5, lng: 137.0, firstSeenAtMs: 0 })
    // 沖縄あたり、能登から1000km超
    expect(isSameEarthquake(region, 26.0, 127.7, 1000, new Map())).toBe(false)
  })

  it('EEW があり、region・新規点の両方がその動的閾値内なら同一地震とみなす', () => {
    const region = fakeRegion({ lat: 37.5, lng: 137.0, firstSeenAtMs: 0 })
    const originTime = '2024-01-01T00:00:00.000Z'
    const hypocenter: Hypocenter = { name: '石川県能登地方', latitude: 37.5, longitude: 137.0, depth: 10, magnitude: 7.6 }
    const eew = fakeEEW('eew-1', originTime, hypocenter)
    const nowMs = new Date(originTime).getTime() + 90_000 // 発生90秒後
    // 90秒後の動的閾値(下限超)以内に収まる、能登から少し離れた点
    const radius = computeSWaveRadiusAtTime(90, 10) * DYNAMIC_THRESHOLD_SAFETY_FACTOR
    expect(radius).toBeGreaterThan(REGION_MATCH_KM)
    // 経度方向に radius の半分程度ずらした点（同一緯度なので近似的に km ≒ 度 * 111 * cos(lat)）
    const dLng = (radius * 0.8) / (111 * Math.cos((37.5 * Math.PI) / 180))
    const result = isSameEarthquake(region, 37.5, 137.0 + dLng, nowMs, new Map([[eew.id, eew]]))
    expect(result).toBe(true)
  })

  it('地理的に近いだけの、経過時間が短い別の EEW に判定を乗っ取られない', () => {
    // 2026-08-10 能登半島地震リプレイ検証で発覚した回帰: 94秒経過した遠い震源(能登)より、
    // 地理的にわずかに近いだけの19秒経過の震源(新島・神津島近海)を誤って基準にされ、
    // 動的閾値がまだ拡大しきっていないタイミングで「別地点」と誤判定された。
    const region = fakeRegion({ lat: 37.6, lng: 137.2, firstSeenAtMs: 0 }) // 能登の震源そのもの
    const notoOrigin = '2024-01-01T00:00:00.000Z'
    const notoHypo: Hypocenter = { name: '能登半島沖', latitude: 37.6, longitude: 137.2, depth: 10, magnitude: 7.6 }
    const notoEEW = fakeEEW('noto', notoOrigin, notoHypo)

    const nowMs = new Date(notoOrigin).getTime() + 94_000 // 能登発生から94秒後
    const nearbyOrigin = new Date(nowMs - 19_000).toISOString() // 新島・神津島近海は19秒前に発生
    const nearbyHypo: Hypocenter = { name: '新島・神津島近海', latitude: 34.1, longitude: 138.7, depth: 10, magnitude: 4.0 }
    const nearbyEEW = fakeEEW('nearby', nearbyOrigin, nearbyHypo)

    const activeEEWs = new Map([['noto', notoEEW], ['nearby', nearbyEEW]])
    // 近畿地方の揺れ（能登からは341km、新島・神津島近海からも341km程度の地点を模す）
    const targetLat = 34.88
    const targetLng = 135.09

    // 能登(94秒経過)の動的閾値なら十分カバーできる距離であることを前提として確認
    const notoRadius = computeSWaveRadiusAtTime(94, 10) * DYNAMIC_THRESHOLD_SAFETY_FACTOR
    const distFromNoto = Math.sqrt(
      ((targetLat - 37.6) * 111) ** 2 + ((targetLng - 137.2) * 111 * Math.cos((37.6 * Math.PI) / 180)) ** 2,
    )
    expect(distFromNoto).toBeLessThan(notoRadius)

    const result = isSameEarthquake(region, targetLat, targetLng, nowMs, activeEEWs)
    expect(result).toBe(true)
  })

  it('仮定震源要素の EEW は無視され、EEW無しの近似計算にフォールバックする', () => {
    const region = fakeRegion({ lat: 37.5, lng: 137.0, firstSeenAtMs: 0 })
    const hypocenter: Hypocenter = { name: '', latitude: 37.5, longitude: 137.0, depth: 10, magnitude: 0 }
    const eew = fakeEEW('eew-assumed', '2024-01-01T00:00:00.000Z', hypocenter, '仮定震源要素')
    // 沖縄あたり、能登から1000km超 → EEWが無視されればフォールバックで false になる
    const result = isSameEarthquake(region, 26.0, 127.7, 90_000, new Map([[eew.id, eew]]))
    expect(result).toBe(false)
  })
})

describe('isRegionWithinAnyEew', () => {
  it('EEW が無ければ false を返す', () => {
    const region = fakeRegion({ lat: 37.5, lng: 137.0 })
    expect(isRegionWithinAnyEew(region, 90_000, new Map())).toBe(false)
  })

  it('region が EEW の動的閾値内に収まっていれば true を返す（未発報地域の吸収判定に使う）', () => {
    const region = fakeRegion({ lat: 37.5, lng: 137.0 })
    const originTime = '2024-01-01T00:00:00.000Z'
    const hypocenter: Hypocenter = { name: '石川県能登地方', latitude: 37.5, longitude: 137.0, depth: 10, magnitude: 7.6 }
    const eew = fakeEEW('eew-1', originTime, hypocenter)
    const nowMs = new Date(originTime).getTime() + 90_000
    expect(isRegionWithinAnyEew(region, nowMs, new Map([[eew.id, eew]]))).toBe(true)
  })
})
