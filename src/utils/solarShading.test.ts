import { describe, it, expect } from 'vitest'
import {
  shadingDepth,
  nightOpacityAt,
  shadingDepthGlsl,
  SUNSET_ALTITUDE,
  NIGHT_ALTITUDE,
} from './solarShading'

/**
 * 薄明の明るさの表（実装と同じ値）。
 *
 * **実装から import せずに書き写している。** 下の「明るさが等間隔」のテストは、この表と
 * 実装の折れ線が一致していることを確かめるためのもの。実装から借りると、表を書き換えたときに
 * テストも一緒に動いて食い違いを検出できなくなる。
 */
const LUMINANCE_TABLE = [
  { altitude: -0.833, logLux: Math.log10(400) },
  { altitude: -6, logLux: Math.log10(3.4) },
  { altitude: -12, logLux: Math.log10(0.008) },
  { altitude: -18, logLux: Math.log10(0.0006) },
]

/** 指定した明るさになる太陽高度（度）。表の間を直線で結んで逆に引く。 */
function altitudeForLogLux(logLux: number): number {
  for (let i = 1; i < LUMINANCE_TABLE.length; i++) {
    const upper = LUMINANCE_TABLE[i - 1]
    const lower = LUMINANCE_TABLE[i]
    if (logLux >= lower.logLux) {
      const ratio = (upper.logLux - logLux) / (upper.logLux - lower.logLux)
      return upper.altitude + (lower.altitude - upper.altitude) * ratio
    }
  }
  return LUMINANCE_TABLE[LUMINANCE_TABLE.length - 1].altitude
}

describe('shadingDepth', () => {
  it('日の入りの高度で 0、天文薄明の下限で 1 になる', () => {
    expect(shadingDepth(SUNSET_ALTITUDE)).toBeCloseTo(0, 10)
    expect(shadingDepth(NIGHT_ALTITUDE)).toBeCloseTo(1, 10)
  })

  it('日の入りより上は 0 のまま（昼側に夜を掛けない）', () => {
    for (const altitude of [0, 0.5, 10, 45, 90]) {
      expect(shadingDepth(altitude)).toBe(0)
    }
  })

  it('天文薄明より下は 1 で頭打ちになる', () => {
    for (const altitude of [-18.1, -30, -60, -90]) {
      expect(shadingDepth(altitude)).toBe(1)
    }
  })

  it('高度が下がるほど深くなる（単調）', () => {
    let previous = -1
    for (let altitude = 5; altitude >= -25; altitude -= 0.05) {
      const depth = shadingDepth(altitude)
      expect(depth).toBeGreaterThanOrEqual(previous)
      previous = depth
    }
  })

  it('深さは明るさに対して等間隔（高度に対してではない）', () => {
    // 表を逆に引いて「明るさが等間隔になる高度」を作り、そこで深さが等間隔に並ぶことを見る。
    // 段に刻んでいた頃の段の位置がまさにこれで、**濃さの付き方が当時と変わっていない**ことの証拠。
    const brightest = LUMINANCE_TABLE[0].logLux
    const darkest = LUMINANCE_TABLE[LUMINANCE_TABLE.length - 1].logLux
    const steps = 32
    for (let i = 0; i < steps; i++) {
      const fraction = i / (steps - 1)
      const altitude = altitudeForLogLux(brightest + (darkest - brightest) * fraction)
      expect(shadingDepth(altitude)).toBeCloseTo(fraction, 9)
    }
  })

  it('高度に対しては等間隔でない（暗くなる大半が最初の数度で起きる）', () => {
    // 対照。高度の中点（-9.4°）で深さが 0.5 になるなら、明るさの曲線に沿っていないことになる。
    const middle = (SUNSET_ALTITUDE + NIGHT_ALTITUDE) / 2
    expect(shadingDepth(middle)).toBeGreaterThan(0.6)
  })

  it('有限でない高度では 0 を返す（濃くなる側へ倒さない）', () => {
    expect(shadingDepth(NaN)).toBe(0)
    expect(shadingDepth(Infinity)).toBe(0)
    expect(shadingDepth(-Infinity)).toBe(0)
  })
})

describe('nightOpacityAt', () => {
  it('最も深いところが設定どおりの濃さになる', () => {
    for (const opacity of [0.2, 0.5, 0.7, 0.95]) {
      expect(nightOpacityAt(NIGHT_ALTITUDE, opacity)).toBeCloseTo(opacity, 10)
    }
  })

  it('日の入りの高度では透明', () => {
    for (const opacity of [0.2, 0.5, 0.95]) {
      expect(nightOpacityAt(SUNSET_ALTITUDE, opacity)).toBeCloseTo(0, 10)
    }
  })

  it('段を重ねていた頃と同じ付き方をする', () => {
    // 旧実装の濃さは `1 - (1 - A)^(depth / steps)` で、depth は帯の内側の端に対応していた。
    // 深さ 0..1 をその指数に読み替えた形になっていることを固定する。
    const opacity = 0.7
    for (const depth of [0.25, 0.5, 0.75, 1]) {
      const altitude = altitudeForLevelOfDepth(depth)
      expect(nightOpacityAt(altitude, opacity)).toBeCloseTo(1 - Math.pow(1 - opacity, depth), 9)
    }
  })

  it('濃さを上げても 1 を超えない・下げても 0 を下回らない', () => {
    for (let altitude = 2; altitude >= -20; altitude -= 0.5) {
      for (const opacity of [0.2, 0.95]) {
        const value = nightOpacityAt(altitude, opacity)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
  })
})

/** 深さ `depth` になる太陽高度（度）。表を逆に引く。 */
function altitudeForLevelOfDepth(depth: number): number {
  const brightest = LUMINANCE_TABLE[0].logLux
  const darkest = LUMINANCE_TABLE[LUMINANCE_TABLE.length - 1].logLux
  return altitudeForLogLux(brightest + (darkest - brightest) * depth)
}

describe('shadingDepthGlsl', () => {
  const source = shadingDepthGlsl()

  it('shadingDepth を定義する', () => {
    expect(source).toContain('float shadingDepth(float altitudeDeg)')
  })

  it('表の全区間ぶんの補間を持つ', () => {
    // 4 点の表なら区間は 3 つ。区間が 1 つ落ちると、その範囲だけ濃さが飛ぶ。
    expect(source.match(/mix\(/g)).toHaveLength(LUMINANCE_TABLE.length - 1)
  })

  it('表の高度をそのまま埋め込む（JS 側と定数がずれない）', () => {
    for (const { altitude } of LUMINANCE_TABLE) {
      // 有効桁を落として書き出すと JS 側とずれるため、9 桁の表現が現れることを見る。
      expect(source).toContain(altitude.toPrecision(9))
    }
  })

  it('正規化を 0..1 へ切り詰める', () => {
    expect(source).toContain('clamp(')
    expect(source).toContain('0.0, 1.0')
  })
})
