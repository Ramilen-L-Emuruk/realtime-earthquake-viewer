import { describe, it, expect } from 'vitest'
import {
  travelTimeSec,
  reachRadiusKm,
  TT_MAX_DEPTH_KM,
  TT_MAX_DISTANCE_KM,
} from './travelTime'

// **格子点の値は気象庁の配布ファイル（tjma2001）から採った実値を直に書く。**
// 生成物の `TT_DELTAS_BASE64` から読み直すと、符号化と復号が同じ誤りを共有していても
// 一致してしまう。表の外から持ってきた値と突き合わせて初めて「引けている」と言える。
// （生成側の照合は `scripts/build-travel-time-table.ts` の ANCHORS。値はそちらと同じ）
const ANCHORS: [depth: number, dist: number, p: number, s: number][] = [
  [0, 0, 0.0, 0.0],
  [0, 2, 0.416, 0.703],
  [0, 100, 17.683, 30.048],
  [0, 2000, 252.705, 451.912],
  [10, 0, 1.773, 3.007],
  [30, 100, 16.424, 28.225],
  [100, 200, 30.364, 53.324],
  [700, 0, 79.996, 143.377],
  [700, 2000, 213.863, 384.747],
]

describe('travelTimeSec', () => {
  it('格子点では気象庁の表の値と一致する（0.01 秒単位の丸めの範囲で）', () => {
    for (const [depth, dist, p, s] of ANCHORS) {
      expect(travelTimeSec('P', dist, depth)).toBeCloseTo(p, 2)
      expect(travelTimeSec('S', dist, depth)).toBeCloseTo(s, 2)
    }
  })

  it('格子の中間は両端の値の間に入る', () => {
    // 深さ 0km・距離 100km と 105km のあいだ（表の刻みは 50〜200km で 5km）
    const a = travelTimeSec('S', 100, 0)
    const b = travelTimeSec('S', 105, 0)
    const mid = travelTimeSec('S', 102.5, 0)
    expect(mid).toBeGreaterThan(a)
    expect(mid).toBeLessThan(b)
  })

  it('深さの中間も両端の値の間に入る', () => {
    // 深さ 30km と 32km のあいだ（表の刻みは 0〜50km で 2km）
    const a = travelTimeSec('S', 100, 30)
    const b = travelTimeSec('S', 100, 32)
    const mid = travelTimeSec('S', 100, 31)
    expect(mid).toBeGreaterThan(Math.min(a, b))
    expect(mid).toBeLessThan(Math.max(a, b))
  })

  it('P は S より先に着く', () => {
    for (const depth of [0, 10, 33, 60, 150, 400, 700]) {
      for (const dist of [0, 20, 100, 300, 800]) {
        expect(travelTimeSec('P', dist, depth)).toBeLessThan(travelTimeSec('S', dist, depth) + 1e-9)
      }
    }
  })

  it('表の右端より遠い距離でも伸び続ける（打ち切らない）', () => {
    // 予報円は自動解除まで伸び、浅い震源でも M8 で P 円が約 2500km・M9 で約 3900km に達する
    // （深い震源ではさらに伸びる。測り方と深さの条件は `travelTime.ts` の `rowTravelSec`）。
    const atEdge = travelTimeSec('P', TT_MAX_DISTANCE_KM, 10)
    const beyond = travelTimeSec('P', TT_MAX_DISTANCE_KM + 500, 10)
    expect(beyond).toBeGreaterThan(atEdge)
    // 末端の見かけ速度（深さ 0 で P 約 8.9 km/s）から外れた値にならないこと
    expect((500 / (beyond - atEdge))).toBeGreaterThan(7)
    expect((500 / (beyond - atEdge))).toBeLessThan(11)
  })

  it('表より深い震源は表の下端へ張り付く（NaN を返さない）', () => {
    const atEdge = travelTimeSec('S', 100, TT_MAX_DEPTH_KM)
    expect(travelTimeSec('S', 100, TT_MAX_DEPTH_KM + 200)).toBe(atEdge)
  })

  it('有限でない入力でも NaN を返さない', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(Number.isFinite(travelTimeSec('S', bad, 10))).toBe(true)
      expect(Number.isFinite(travelTimeSec('S', 100, bad))).toBe(true)
    }
    // 負の距離・深さは 0 として扱う（震央そのもの）
    expect(travelTimeSec('S', -50, 10)).toBe(travelTimeSec('S', 0, 10))
  })
})

describe('reachRadiusKm', () => {
  it('震源の真上へ届く前は半径 0（対照）', () => {
    const depth = 60
    const surfaceArrival = travelTimeSec('S', 0, depth)
    expect(reachRadiusKm('S', surfaceArrival - 0.5, depth)).toBe(0)
    expect(reachRadiusKm('S', surfaceArrival + 0.5, depth)).toBeGreaterThan(0)
  })

  it('走時の逆関数になっている（往復して同じ距離に戻る）', () => {
    for (const depth of [0, 10, 33, 60, 150, 400, 700]) {
      for (const dist of [50, 150, 400, 900, 1800]) {
        const t = travelTimeSec('S', dist, depth)
        expect(reachRadiusKm('S', t, depth)).toBeCloseTo(dist, 0)
      }
    }
  })

  it('P 側でも往復する', () => {
    for (const depth of [10, 100, 500]) {
      for (const dist of [20, 200, 1000]) {
        const t = travelTimeSec('P', dist, depth)
        expect(reachRadiusKm('P', t, depth)).toBeCloseTo(dist, 0)
      }
    }
  })

  // **震央のすぐ近くだけは往復が完全に戻らない。** 原因は 1 つで、設計上のもの ——
  // 走時を 0.01 秒単位へ丸めている。深い震源の震央近傍は距離が伸びても走時がほとんど
  // 変わらないので、丸めの幅が距離の分解能を下回る（深さ 470km・距離 6km で 6.0km）。
  //
  // **かつては原因が 2 つあった。** 深さの補間を「行ごとに逆引きしてから距離を混ぜる」順序で
  // 行っていたため、震央直上では混ぜた走時が一方の行では到達後・他方では到達前になっていた
  // （深さ 33km・距離 0km で 3.8km）。`reachRadiusKm` を `travelTimeSec` の二分探索へ変えて
  // 消えた（同じ組を測ると**いまは 0.00km**）。
  //
  // **上限を固定しておく**（実測の最悪は 6.0km。深さ 470km・距離 6km で、深さ 700km でも同値）。
  // 置き換える前の 2 層モデルは深さ 40〜200km の帯で
  // 17〜36km ずれていたので桁が違うが、符号化の精度を落とす変更が入ればここで落ちる。
  // **深さは「格子の間」も走査する。** 格子点（深さ 0-50km は 2km・50-200km は 5km・以降 10km
  // 刻み）だけを見ていると、深さ補間の破綻を一度も踏まない —— 実際、以前の実装
  // （行ごとに逆引きしてから距離を混ぜる形）は格子点では誤差 0 なのに、格子の間では
  // **深さ 693.5km・距離 0km で 43.94km** ずれていた。**緊急地震速報の深さは整数 km で届き、
  // 50km 以深の格子は 5km・10km 刻みなので、実運用では普通に格子から外れる。**
  it('格子の間の深さでも往復が壊れない（回帰）', () => {
    // 直す前にいちばん大きくずれた組。ここが戻らなければ深さ補間が逆関数になっていない。
    expect(reachRadiusKm('S', travelTimeSec('S', 0, 693.5), 693.5)).toBeCloseTo(0, 1)
    expect(reachRadiusKm('S', travelTimeSec('S', 15, 683), 683)).toBeCloseTo(15, 1)
  })

  // **上限は実測で固定する**（深さ 0〜700km を 0.5km 刻み・距離 0〜2000km を 1km 刻みで走査した値）。
  //
  //  - S 波: 全域で最大 6.0km（深さ 470km・距離 6km）・**震央距離 15km 以上では 0km**
  //    （厳密には二分探索の残差が 1.8e-9 km ＝ 約 1.8μm 残るので、そこは `toBeLessThan` で見る）
  //  - P 波: 全域で最大 10.0km（深さ 610km・距離 10km）・距離 30km 以上でも最大 2.0km
  //
  // P のほうが大きいのは、速いぶん 0.01 秒の丸めが距離へ 1.7 倍ほど出るため。
  // 走査をテストの中で全域やると重いので、いちばん悪い帯だけを刻んで踏む。
  it('格子の間の深さを走査しても上限を超えない（安全弁）', () => {
    const worstOf = (phase: 'P' | 'S', minDist: number) => {
      let worst = 0
      // 各帯の「格子の中点」を通す（0.5 のずれが最悪値を出す深さ）。
      for (const depth of [48.5, 96.5, 196.5, 293.5, 470, 493.5, 510, 610, 683, 690, 693.5]) {
        for (let dist = minDist; dist <= 60; dist += 1) {
          const t = travelTimeSec(phase, dist, depth)
          worst = Math.max(worst, Math.abs(reachRadiusKm(phase, t, depth) - dist))
        }
      }
      return worst
    }
    expect(worstOf('S', 0)).toBeLessThanOrEqual(6)
    expect(worstOf('P', 0)).toBeLessThanOrEqual(10)
    // 震央から離れれば丸めの影響は消える（S は完全に戻る。残るのは二分探索の残差だけ）。
    expect(worstOf('S', 15)).toBeLessThan(1e-6)
  })

  it('震央近傍の往復誤差が実測の上限を超えない（安全弁）', () => {
    let worst = 0
    for (const depth of [0, 2, 10, 32, 33, 34, 60, 150, 300, 500, 700]) {
      for (let dist = 0; dist <= 20; dist += 1) {
        const t = travelTimeSec('S', dist, depth)
        worst = Math.max(worst, Math.abs(reachRadiusKm('S', t, depth) - dist))
      }
    }
    expect(worst).toBeLessThanOrEqual(6)
  })

  it('表の右端を越えても往復する（外挿の傾きが両方向で同じ）', () => {
    const depth = 10
    const dist = TT_MAX_DISTANCE_KM + 800
    const t = travelTimeSec('P', dist, depth)
    expect(reachRadiusKm('P', t, depth)).toBeCloseTo(dist, 0)
  })

  it('時間が進めば半径は縮まない（安全弁）', () => {
    const depth = 30
    let prev = 0
    for (let t = 0; t <= 300; t += 3) {
      const r = reachRadiusKm('S', t, depth)
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = r
    }
  })

  it('有限でない入力でも NaN を返さない', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(Number.isFinite(reachRadiusKm('S', bad, 10))).toBe(true)
      expect(Number.isFinite(reachRadiusKm('S', 60, bad))).toBe(true)
    }
    expect(reachRadiusKm('S', -10, 10)).toBe(0)
  })
})
