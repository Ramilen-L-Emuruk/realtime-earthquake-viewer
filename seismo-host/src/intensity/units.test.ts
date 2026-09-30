import { describe, expect, it } from 'vitest'
import { GAL_PER_G, galFromCounts } from './units'

// MPU6050 を ±2g へ設定したときの、実データ（`cap-quiet1`）が名乗る値。
const MPU2G = { ugPerLsb: 61.0352, fullScaleG: 2 }

describe('galFromCounts', () => {
  it('1 g 相当のカウントは 980.665 gal になる', () => {
    const counts = 1_000_000 / MPU2G.ugPerLsb
    expect(galFromCounts(counts, MPU2G)).toBeCloseTo(GAL_PER_G, 6)
  })

  it('実データのカウントが 1 g 付近になる', () => {
    // 重力が乗っている第 3 軸の実値。
    expect(galFromCounts(16880, MPU2G)).toBeCloseTo(1010.35, 2)
  })

  it('符号と 0 をそのまま通す', () => {
    expect(galFromCounts(0, MPU2G)).toBe(0)
    const plus = galFromCounts(100, MPU2G)
    expect(plus).not.toBeNull()
    expect(galFromCounts(-100, MPU2G)).toBeCloseTo(-(plus as number), 12)
  })

  it('目盛りの端はフルスケールをわずかに超えても通す', () => {
    // 名乗る分解能は丸めた値なので、16 bit の端は 2g をほんの少し超える。
    expect(galFromCounts(-32768, MPU2G)).not.toBeNull()
    expect(galFromCounts(32767, MPU2G)).not.toBeNull()
  })

  it('分解能の桁が違えば落とす', () => {
    // 1000 倍で名乗ったヘッダ。通せば、静止している基板が強い揺れとして出る。
    expect(galFromCounts(16880, { ugPerLsb: 61035.2, fullScaleG: 2 })).toBeNull()
  })

  it('フルスケールを大きく超えたカウントは落とす', () => {
    expect(galFromCounts(16880 * 1000, MPU2G)).toBeNull()
  })

  it('分解能が小さすぎる向きは捕まえられない（この検査の限界）', () => {
    // **上限しか見ていないので、揺れを小さく見せる向きは素通りする。** 捕まえるには
    // 静止しているときの重力（1 g）と突き合わせる自己診断が要る（受信層の担当）。
    // この対照が無いと、あとから下限を足して境界を壊しても誰も気づかない。
    expect(galFromCounts(16880, { ugPerLsb: 0.0610352, fullScaleG: 2 })).not.toBeNull()
  })

  it('有限でない値は落とす', () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(galFromCounts(v, MPU2G)).toBeNull()
    }
    expect(galFromCounts(100, { ugPerLsb: NaN, fullScaleG: 2 })).toBeNull()
    expect(galFromCounts(100, { ugPerLsb: 61.0352, fullScaleG: Infinity })).toBeNull()
    expect(galFromCounts(100, { ugPerLsb: 0, fullScaleG: 2 })).toBeNull()
    expect(galFromCounts(100, { ugPerLsb: 61.0352, fullScaleG: 0 })).toBeNull()
  })
})
