import { describe, expect, it } from 'vitest'
import { movingAverage, signedMovingAverages } from './waveMeanLines'

/** 時刻（ms）の並びを `TimedPoints` にする。 */
const series = (t: number[]): { t: number[]; length: number } => ({ t, length: t.length })

describe('前後を均した線（movingAverage）', () => {
  it('窓は各時刻の前後 windowMs/2 で、両端ちょうどの点も含む', () => {
    const got = movingAverage(series([0, 500, 1000]), [1, 2, 3], 1000)
    // 0 ms の窓は −500〜500（500 ms の点を含む）、500 ms の窓は 0〜1000（3 点とも）
    expect([...got]).toEqual([1.5, 2, 2.5])
  })

  it('対照: 窓の端を 1 ms でも越えた点は入れない', () => {
    const got = movingAverage(series([0, 501]), [1, 3], 1000)
    expect([...got]).toEqual([1, 3])
  })

  it('値の無い点は NaN のまま返し、前後の平均にも数えない', () => {
    const got = movingAverage(series([0, 100, 200]), [1, Number.NaN, 3], 1000)
    expect(got[0]).toBe(2)
    expect(Number.isNaN(got[1]!)).toBe(true)
    expect(got[2]).toBe(2)
  })

  it('安全弁: 点が無ければ空を返す', () => {
    expect(movingAverage(series([]), [], 1000)).toHaveLength(0)
  })
})

describe('正側・負側の平均の線（signedMovingAverages）', () => {
  it('窓の中の正の値と負の値を別々に平均する', () => {
    const got = signedMovingAverages(series([0, 100, 200, 300]), [2, -1, 4, -3], 1000)
    expect([...got.pos]).toEqual([3, 3, 3, 3])
    expect([...got.neg]).toEqual([-2, -2, -2, -2])
  })

  it('0 ちょうどの値はどちらにも数えない。その側の値が無ければ 0', () => {
    const got = signedMovingAverages(series([0, 100]), [0, 5], 1000)
    expect([...got.pos]).toEqual([5, 5])
    expect([...got.neg]).toEqual([0, 0])
  })

  it('対照: 窓の外の値はその時刻の平均に混ざらない', () => {
    const got = signedMovingAverages(series([0, 2000]), [10, 2], 1000)
    expect([...got.pos]).toEqual([10, 2])
  })

  it('値の無い点は両方とも NaN のまま返し、前後の平均にも数えない', () => {
    const got = signedMovingAverages(series([0, 100, 200]), [4, Number.NaN, 2], 1000)
    expect(Number.isNaN(got.pos[1]!)).toBe(true)
    expect(Number.isNaN(got.neg[1]!)).toBe(true)
    expect(got.pos[0]).toBe(3)
  })

  it('安全弁: 点が無ければ空を返す', () => {
    const got = signedMovingAverages(series([]), [], 1000)
    expect(got.pos).toHaveLength(0)
    expect(got.neg).toHaveLength(0)
  })
})
