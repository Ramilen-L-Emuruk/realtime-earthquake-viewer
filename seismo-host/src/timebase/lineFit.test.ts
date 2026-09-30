import { describe, expect, it } from 'vitest'

import { IncrementalLineFit } from './lineFit'

function fitOf(points: readonly (readonly [number, number])[]) {
  const f = new IncrementalLineFit()
  for (const [x, y] of points) f.add(x, y)
  return f.result()
}

describe('IncrementalLineFit', () => {
  describe('当てはめる', () => {
    it('直線に乗っている点から、傾きと切片を戻す', () => {
      const r = fitOf([[0, 100], [30, 400], [60, 700], [90, 1000]])
      expect(r.slope).toBeCloseTo(10, 12)
      expect(r.intercept).toBeCloseTo(100, 9)
      expect(r.residualRms).toBeCloseTo(0, 9)
      expect(r.usable).toBe(true)
      expect(r.count).toBe(4)
    })

    it('ばらついた点では、ばらつきが残差に出る', () => {
      // y = 100 + 10x（= 100, 400, 700, 1000）に ±2 を乗せる。
      // 傾きはほぼ保たれ、残差は 0 ではなくなる。
      const r = fitOf([[0, 102], [30, 398], [60, 702], [90, 998]])
      expect(r.slope).toBeCloseTo(10, 1)
      expect(r.residualRms).toBeGreaterThan(1)
      expect(r.residualRms).toBeLessThan(3)
    })

    it('残差は n で割る（offline の解析と同じ数え方）', () => {
      // 2 点なら直線は必ず通るので残差 0。n−2 で割る流儀だと 0/0 になる。
      const r = fitOf([[0, 0], [10, 100]])
      expect(r.residualRms).toBe(0)
      expect(r.usable).toBe(true)
    })
  })

  describe('unix ミリ秒をそのまま渡せる', () => {
    // **これがこの実装を選んだ理由。** 時刻は 1.79×10¹² の桁で入ってくるので、
    // `Σx²` や `Σxy` をそのまま貯める書き方だと、大きな値どうしの引き算で
    // 有効桁を失う。偏差だけを貯める形なら基準時刻を引かなくても精度が保てる。
    it('大きな時刻と長い区間でも傾きが崩れない', () => {
      const t0 = 1790181865671
      const points: [number, number][] = []
      // 8 時間ぶん・30 サンプルごとに 1 つ（実際の記録と同じ密度）。
      for (let i = 0; i < 2_880_000; i += 30) points.push([i, t0 + 10 * i])
      const r = fitOf(points)
      expect(r.slope).toBeCloseTo(10, 9)
      // 切片は絶対時刻そのものなので、ミリ秒より細かく一致すること。
      expect(Math.abs(r.intercept - t0)).toBeLessThan(0.001)
    })
  })

  describe('当てはめられないとき', () => {
    it('点が 1 つなら使えない', () => {
      const r = fitOf([[0, 100]])
      expect(r.usable).toBe(false)
      expect(r.count).toBe(1)
      expect(r.slope).toBeNaN()
    })

    it('点が無ければ使えない', () => {
      expect(fitOf([]).usable).toBe(false)
    })

    it('横に広がりが無ければ使えない（0 除算を返さない）', () => {
      // 同じ位置に複数の点。傾きは決まらないので NaN を返す——
      // `Infinity` を返すと下流が有限性の検査を通してしまう。
      const r = fitOf([[5, 100], [5, 200], [5, 300]])
      expect(r.usable).toBe(false)
      expect(r.slope).toBeNaN()
    })
  })
})
