import { describe, expect, it } from 'vitest'

import { IncrementalLineFit } from './lineFit'

function fitOf(points: readonly (readonly [number, number])[], forgetAfterX = Number.POSITIVE_INFINITY) {
  const f = new IncrementalLineFit(forgetAfterX)
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

  describe('古いアンカーを忘れる', () => {
    // 実機の形を写す: 100 Hz 前後・30 サンプルごとに 1 アンカー・8 時間。
    const t0 = 1791588090000
    const STEP = 30
    const TAU = 300 * 100 // 5 分ぶんのサンプル数（`TIMEBASE_FORGET_SEC` と同じ）

    /** 間隔が途中から 200 ppm 縮む（2026-10-11 の IIS2ICLX の一晩の変わり方を 4 時間で起こす）。 */
    function driftingPoints(): [number, number][] {
      const points: [number, number][] = []
      let t = t0
      const total = 8 * 3600 * 100
      for (let i = 0; i < total; i += STEP) {
        points.push([i, t])
        const ms = i < total / 2 ? 10 : 10 * (1 - 200e-6 * Math.min(1, (i - total / 2) / (total / 4)))
        t += ms * STEP
      }
      return points
    }

    it('正: 間隔が途中で変わっても、いまの位置の時刻は名乗る時刻に沿う', () => {
      const points = driftingPoints()
      const [lastX, lastY] = points[points.length - 1]!
      const forgetting = fitOf(points, TAU)
      expect(Math.abs(forgetting.intercept + forgetting.slope * lastX - lastY)).toBeLessThan(5)
    })

    it('対照: 忘れない当てはめでは、同じ点でいまの時刻が大きくずれる', () => {
      // 直したいのはこれ。区間全体を同じ重みで通すと、直線が変化に追いつかない。
      const points = driftingPoints()
      const [lastX, lastY] = points[points.length - 1]!
      const plain = fitOf(points)
      expect(Math.abs(plain.intercept + plain.slope * lastX - lastY)).toBeGreaterThan(300)
    })

    it('対照: 間隔が一定なら、忘れても忘れなくても同じ直線になる', () => {
      const points: [number, number][] = []
      for (let i = 0; i < 2_880_000; i += STEP) points.push([i, t0 + 9.53 * i])
      const a = fitOf(points, TAU)
      const b = fitOf(points)
      expect(a.slope).toBeCloseTo(9.53, 9)
      expect(Math.abs(a.intercept - t0)).toBeLessThan(0.01)
      expect(a.slope).toBeCloseTo(b.slope, 9)
    })

    it('安全弁: 名乗る時刻の揺れは忘れても平均される（±20 ms の揺れで 2 ms 以内）', () => {
      // 揺れは決まった並び（再現できるように擬似乱数を自前で回す）。
      let seed = 12345
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31
        return seed / 2 ** 31
      }
      const points: [number, number][] = []
      for (let i = 0; i < 2 * 3600 * 100; i += STEP) points.push([i, t0 + 10 * i + (rand() - 0.5) * 40])
      const r = fitOf(points, TAU)
      const [lastX] = points[points.length - 1]!
      expect(Math.abs(r.intercept + r.slope * lastX - (t0 + 10 * lastX))).toBeLessThan(2)
      // 残差は揺れの大きさ（一様分布 ±20 → 約 11.5）を示し、忘れたせいで小さく見えたりしない。
      expect(r.residualRms).toBeGreaterThan(9)
      expect(r.residualRms).toBeLessThan(14)
      // 通算の数は忘れた分も含む。
      expect(r.count).toBe(points.length)
    })

    it('安全弁: x が戻ったら重みを減らさない（同じ位置を二度足しても壊れない）', () => {
      const f = new IncrementalLineFit(TAU)
      f.add(0, t0)
      f.add(3000, t0 + 30_000)
      f.add(3000, t0 + 30_000)
      f.add(1000, t0 + 10_000)
      const r = f.result()
      expect(r.slope).toBeCloseTo(10, 9)
      expect(r.usable).toBe(true)
    })

    it('安全弁: 時定数が正の数でなければ作らない', () => {
      expect(() => new IncrementalLineFit(0)).toThrow(RangeError)
      expect(() => new IncrementalLineFit(-1)).toThrow(RangeError)
      expect(() => new IncrementalLineFit(Number.NaN)).toThrow(RangeError)
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
