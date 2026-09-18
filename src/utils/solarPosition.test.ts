import { describe, it, expect } from 'vitest'
import { subsolarPoint, solarAltitude } from './solarPosition'

// 至点・分点の時刻（UTC）。天文年鑑の値で、太陽赤緯の折り返し・ゼロ交差を確かめるために使う。
const SOLSTICE_JUNE_2024 = Date.UTC(2024, 5, 20, 20, 51)
const SOLSTICE_DEC_2024 = Date.UTC(2024, 11, 21, 9, 21)
const EQUINOX_MAR_2024 = Date.UTC(2024, 2, 20, 3, 6)

/** 1 年を等間隔で刻んだ時刻列。季節（太陽赤緯）に依存する分岐を全部通すために使う。 */
function yearSamples(count = 73): number[] {
  const start = Date.UTC(2024, 0, 1)
  const span = 366 * 86400000
  return Array.from({ length: count }, (_, i) => start + (span * i) / count)
}

describe('subsolarPoint', () => {
  it('夏至の太陽直下点は北回帰線上にある', () => {
    expect(subsolarPoint(SOLSTICE_JUNE_2024).lat).toBeCloseTo(23.44, 0)
  })

  it('冬至の太陽直下点は南回帰線上にある', () => {
    expect(subsolarPoint(SOLSTICE_DEC_2024).lat).toBeCloseTo(-23.44, 0)
  })

  it('春分の太陽直下点は赤道上にある', () => {
    expect(Math.abs(subsolarPoint(EQUINOX_MAR_2024).lat)).toBeLessThan(0.3)
  })

  it('UTC 正午の太陽直下点はグリニッジ子午線の近くにある', () => {
    // 均時差の分だけずれる（最大 ±4°弱）。ここで見たいのは経度の基準がずれていないこと。
    const lon = subsolarPoint(Date.UTC(2024, 5, 21, 12, 0)).lon
    expect(Math.abs(lon)).toBeLessThan(5)
  })

  it('太陽直下点は 1 年を通じて経度 ±180・緯度 ±23.5 の範囲に収まる', () => {
    for (const t of yearSamples()) {
      const { lat, lon } = subsolarPoint(t)
      expect(lon).toBeGreaterThanOrEqual(-180)
      expect(lon).toBeLessThanOrEqual(180)
      expect(Math.abs(lat)).toBeLessThanOrEqual(23.5)
    }
  })
})

describe('solarAltitude', () => {
  it('太陽直下点では太陽高度が 90 度になる', () => {
    const t = SOLSTICE_JUNE_2024
    const { lat, lon } = subsolarPoint(t)
    expect(solarAltitude(t, lat, lon)).toBeCloseTo(90, 1)
  })

  it('対蹠点では太陽高度が -90 度になる', () => {
    const t = EQUINOX_MAR_2024
    const { lat, lon } = subsolarPoint(t)
    expect(solarAltitude(t, -lat, lon + 180)).toBeCloseTo(-90, 1)
  })

  it('夏至の北極は白夜（太陽高度が正）', () => {
    expect(solarAltitude(SOLSTICE_JUNE_2024, 90, 0)).toBeGreaterThan(0)
  })

  it('夏至の南極は極夜（太陽高度が負）', () => {
    expect(solarAltitude(SOLSTICE_JUNE_2024, -90, 0)).toBeLessThan(0)
  })
})
