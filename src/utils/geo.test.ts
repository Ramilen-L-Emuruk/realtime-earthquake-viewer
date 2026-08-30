import { describe, it, expect } from 'vitest'
import { hasKnownEpicenter, hypocentralDistanceKm, surfaceDistanceKm, haversineKm, EARTH_RADIUS_KM } from './geo'

// 「震源の位置が判っているか」の判定。**否定形で書くと NaN が素通りする**ため、この述語に
// 寄せている（`geo.ts` の注記）。素通りした NaN は地図の寄り先に渡り、MapLibre が例外を投げる。
describe('hasKnownEpicenter', () => {
  it('通常の座標は「位置あり」', () => {
    expect(hasKnownEpicenter(37.5, 137.2)).toBe(true)
    // 南半球・西半球（遠地地震）も通す。-200 は「あり得ない値」としてのセンチネル。
    expect(hasKnownEpicenter(-33.4, -70.6)).toBe(true)
  })

  it('DMDATA・P2PQuake の位置不明センチネル（-200）を弾く', () => {
    expect(hasKnownEpicenter(-200, -200)).toBe(false)
    // 片方だけでも位置は決まらない。
    expect(hasKnownEpicenter(37.5, -200)).toBe(false)
    expect(hasKnownEpicenter(-200, 137.2)).toBe(false)
  })

  it('Yahoo 強震モニタの座標欠落（NaN）を弾く', () => {
    // `services/kyoshin.ts` の parseCoord は空文字を NaN にする。NaN はどの比較でも false に
    // なるため、`lat <= -200` のような否定形の判定では弾けない（このテストの主眼）。
    expect(hasKnownEpicenter(NaN, NaN)).toBe(false)
    expect(hasKnownEpicenter(37.5, NaN)).toBe(false)
    expect(hasKnownEpicenter(NaN, 137.2)).toBe(false)
  })
})

// 地表距離と深さ ⇄ 震源距離。**平らな直角三角形（√(地表距離² + 深さ²)）では解かない。**
// 地表は曲がっているので、震央から離れるほど地表の点は震源から見て「下がって」いく。
// 深発地震で遠方を見ると効く（地表 800km・深さ 700km で 3.3%）。
describe('hypocentralDistanceKm / surfaceDistanceKm', () => {
  const cases: [number, number][] = [
    [0, 0], [0, 10], [1, 10], [50, 10], [100, 10], [400, 10], [800, 10],
    [200, 100], [400, 300], [800, 700], [2000, 100],
  ]

  // 正: 対になっているという主張そのもの。片方だけ直したら落ちる。
  it.each(cases)('地表 %ikm・深さ %ikm で往復が一致する', (surf, depth) => {
    expect(surfaceDistanceKm(hypocentralDistanceKm(surf, depth), depth)).toBeCloseTo(surf, 6)
  })

  // **深さ 0 でも「地表距離と同じ」にはならない。** 震源距離は地中をまっすぐ抜ける弦の長さで、
  // 地表距離は曲がった表面に沿った弧の長さ。地震波が通るのは弦のほう。
  // 差は東京〜大阪（397km）で 64m、10km では 1mm。**「一致するはず」と書くと落ちる。**
  it('深さ 0 なら地表を這う弧ではなく地中を抜ける弦', () => {
    const chord = (surf: number) => 2 * EARTH_RADIUS_KM * Math.sin(surf / (2 * EARTH_RADIUS_KM))
    for (const surf of [0, 10, 100, 400]) {
      expect(hypocentralDistanceKm(surf, 0)).toBeCloseTo(chord(surf), 9)
      expect(hypocentralDistanceKm(surf, 0)).toBeLessThanOrEqual(surf)
    }
  })

  it('震央の真上（地表距離 0）なら震源距離は深さ', () => {
    for (const depth of [0, 10, 100, 700]) {
      expect(hypocentralDistanceKm(0, depth)).toBeCloseTo(depth, 9)
    }
  })

  // 安全弁: 波がまだ地表のどこにも達していない状態。真上へ抜けるのが最短で、その長さが深さ。
  it('震源距離が深さ以下なら地表距離は 0', () => {
    expect(surfaceDistanceKm(100, 100)).toBe(0)
    expect(surfaceDistanceKm(50, 100)).toBe(0)
    expect(surfaceDistanceKm(0, 100)).toBe(0)
  })

  // 正: 平面近似より短くなる（地表が曲がって遠ざかるぶん）。**この向きを取り違えると、
  // 予報円が実際より小さくなって「まだ来ていない」と誤って見せる。**
  it('平らな直角三角形より短い（深いほど・遠いほど差が開く）', () => {
    const flat = (s: number, d: number) => Math.sqrt(s ** 2 + d ** 2)
    for (const [surf, depth] of [[400, 10], [200, 100], [800, 700]] as [number, number][]) {
      expect(hypocentralDistanceKm(surf, depth)).toBeLessThan(flat(surf, depth))
    }
    // 差の大きさも固定する（深発・遠距離で 3% 規模）。
    expect(flat(800, 700) / hypocentralDistanceKm(800, 700)).toBeCloseTo(1.033, 3)
  })

  // 安全弁: 壊れた深さで NaN を出さない。NaN はカメラ追従の矩形へ流れ込むと範囲全体を壊す。
  it('深さが地球半径を超えても NaN にならない', () => {
    for (const depth of [EARTH_RADIUS_KM, EARTH_RADIUS_KM * 2, 1e9]) {
      expect(Number.isFinite(hypocentralDistanceKm(100, depth))).toBe(true)
      expect(Number.isFinite(surfaceDistanceKm(100, depth))).toBe(true)
    }
  })

  // 安全弁: 距離計算（haversineKm）と同じ球で解いていること。同じ半径を使っていなければ、
  // 弧と弦の差では説明が付かないほど大きくずれる。
  it('haversineKm と同じ球（弧と弦の差の範囲で収まる）', () => {
    const surf = haversineKm(35.7, 139.7, 34.7, 135.5) // 東京〜大阪 約 397km
    const chord = 2 * EARTH_RADIUS_KM * Math.sin(surf / (2 * EARTH_RADIUS_KM))
    expect(hypocentralDistanceKm(surf, 0)).toBeCloseTo(chord, 9)
    // 弧より短く、その差は 100m 未満（別の地球半径を使っていれば数 km ずれる）。
    expect(surf - hypocentralDistanceKm(surf, 0)).toBeLessThan(0.1)
    expect(surf - hypocentralDistanceKm(surf, 0)).toBeGreaterThan(0)
  })
})
