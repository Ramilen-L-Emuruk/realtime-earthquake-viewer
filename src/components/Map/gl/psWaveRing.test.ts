// EEW 予報円が「地面の上で正しい円」であることを固定する。
// 実際の描画は WebGL なのでここでは触れない（ブラウザ確認の担当）。
// 背景と実測値は docs/spec/eew-spec.md §6。
import { describe, it, expect } from 'vitest'
import { ringVertex, ringBounds } from './psWaveRing'
import { haversineKm, bearingDeg, EARTH_RADIUS_KM } from '../../../utils/geo'

const TOKYO: [number, number] = [139.7, 35.7]
const bearings = Array.from({ length: 36 }, (_, i) => (i / 36) * 2 * Math.PI)

describe('ringVertex', () => {
  // 正: これが円の定義そのもの。どの方位へ進んでも、震央からの距離が半径に等しい。
  it.each([10, 50, 100, 200, 400, 800])('半径 %ikm: どの方位でも震央からの距離が半径に等しい', (km) => {
    for (const th of bearings) {
      const [lng, lat] = ringVertex(TOKYO[0], TOKYO[1], km, th)
      expect(haversineKm(TOKYO[1], TOKYO[0], lat, lng)).toBeCloseTo(km, 6)
    }
  })

  // 正: 引数の方位がそのまま「震央から見た方位」になっている（真北 0・時計回り）。
  it.each([0, 45, 90, 135, 180, 225, 270, 315])('方位 %i 度へ進む', (deg) => {
    const [lng, lat] = ringVertex(TOKYO[0], TOKYO[1], 200, (deg * Math.PI) / 180)
    // 180 度は 180、0 度は 0（bearingDeg は [0,360) を返す）。
    expect(bearingDeg(TOKYO[1], TOKYO[0], lat, lng)).toBeCloseTo(deg, 4)
  })

  it('方位 0 は経度を変えずに北へ', () => {
    const north = ringVertex(TOKYO[0], TOKYO[1], 100, 0)
    expect(north[0]).toBeCloseTo(TOKYO[0], 10)
    expect(north[1]).toBeGreaterThan(TOKYO[1])
  })

  // **東へ「まっすぐ」進んでも緯度は変わらない、ではない。** 大円は等緯度線ではないので、
  // 北半球で東へ進むと経路はわずかに赤道側へ曲がる（100km で約 0.005 度）。等緯度線を辿るのは
  // 航程線（rhumb line）で、こちらは距離が最短にならない＝波の到達位置としては正しくない。
  it('方位 90 は東へ進み、緯度はわずかに赤道側へ寄る', () => {
    const east = ringVertex(TOKYO[0], TOKYO[1], 100, Math.PI / 2)
    expect(east[0]).toBeGreaterThan(TOKYO[0])
    expect(east[1]).toBeLessThan(TOKYO[1])
    expect(TOKYO[1] - east[1]).toBeLessThan(0.01)
    // 南半球では逆向き（やはり赤道側）。
    const south = ringVertex(TOKYO[0], -35.7, 100, Math.PI / 2)
    expect(south[1]).toBeGreaterThan(-35.7)
  })

  it('半径 0 なら震央そのもの（対照）', () => {
    for (const th of bearings) {
      const [lng, lat] = ringVertex(TOKYO[0], TOKYO[1], 0, th)
      expect(lng).toBeCloseTo(TOKYO[0], 10)
      expect(lat).toBeCloseTo(TOKYO[1], 10)
    }
  })

  // 対照: 直したのはこの近似。緯度 1 度 = 111.32km・経度は震央の cos で割る、という置き方だと
  // 南北の端で距離がずれる。**このテストが落ちるようなら、近似へ戻ってしまっている。**
  it('置き換え前の近似より正確（半径 400km の斜め方位で比べる）', () => {
    const km = 400
    const th = Math.PI / 4
    const K = 111.32
    const approx: [number, number] = [
      TOKYO[0] + (km * Math.sin(th)) / (K * Math.cos((TOKYO[1] * Math.PI) / 180)),
      TOKYO[1] + (km * Math.cos(th)) / K,
    ]
    const approxErr = Math.abs(haversineKm(TOKYO[1], TOKYO[0], approx[1], approx[0]) - km)
    const [lng, lat] = ringVertex(TOKYO[0], TOKYO[1], km, th)
    const exactErr = Math.abs(haversineKm(TOKYO[1], TOKYO[0], lat, lng) - km)
    expect(approxErr).toBeGreaterThan(1) // 近似は 1km 以上ずれる
    expect(exactErr).toBeLessThan(1e-6)
  })

  // 安全弁: 高緯度でも成り立つ（近似は cos(緯度) が小さいほど破綻しやすい）。
  it.each([0, 35, 60, 80])('緯度 %i 度でも半径どおり', (lat0) => {
    for (const th of bearings) {
      const [lng, lat] = ringVertex(139.7, lat0, 300, th)
      expect(haversineKm(lat0, 139.7, lat, lng)).toBeCloseTo(300, 5)
    }
  })

  // 安全弁: 日付変更線をまたいでも距離は保たれる（経度は ±180 を越えた値になりうるが、
  // MapLibre は連続した経度を受け付けるのでそのままでよい）。
  it('日付変更線の近くでも半径どおり', () => {
    for (const th of bearings) {
      const [lng, lat] = ringVertex(179.5, 40, 300, th)
      expect(haversineKm(40, 179.5, lat, lng)).toBeCloseTo(300, 5)
    }
  })

  // 安全弁: 距離を測る側と円を作る側で地球半径が同じであること。**別々の値を使うと、
  // 「200km に到達」と描いた円が haversineKm の 200km とずれる。**
  it('地球半径は距離計算と共有している', () => {
    expect(EARTH_RADIUS_KM).toBe(6371)
  })
})

describe('ringBounds', () => {
  /** 総当たりで求めた真の外接矩形。 */
  const brute = (lng0: number, lat0: number, km: number) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
    for (let i = 0; i < 20000; i++) {
      const [lng, lat] = ringVertex(lng0, lat0, km, (i / 20000) * 2 * Math.PI)
      w = Math.min(w, lng); e = Math.max(e, lng)
      s = Math.min(s, lat); n = Math.max(n, lat)
    }
    return [w, s, e, n]
  }

  // 正: 総当たりと一致すること。**東西端は方位 90 度の点ではない**——大円は東へ進むと赤道側へ
  // 曲がるので、最も東へ届くのは方位 90 度より少し極寄りの点になる。
  it.each([
    [139.7, 35.7, 200],
    [139.7, 35.7, 800],
    [139.7, 60, 637],
    [139.7, 0, 800],
    [139.7, -40, 500],
  ])('中心 (%f, %f)・半径 %ikm で総当たりと一致', (lng0, lat0, km) => {
    const [w, s, e, n] = ringBounds(lng0, lat0, km)
    const [bw, bs, be, bn] = brute(lng0, lat0, km)
    expect(w).toBeCloseTo(bw, 3)
    expect(e).toBeCloseTo(be, 3)
    expect(s).toBeCloseTo(bs, 3)
    expect(n).toBeCloseTo(bn, 3)
  })

  // 対照: 方位 90 度の点で代用すると足りない。**この差がテストの存在理由。**
  it('方位 90 度の点では東端に届かない（緯度が高いほど差が開く）', () => {
    for (const [lat0, km, minGapDeg] of [[40, 800, 0.03], [60, 637, 0.1]] as [number, number, number][]) {
      const [, , east] = ringBounds(139.7, lat0, km)
      const [naive] = ringVertex(139.7, lat0, km, Math.PI / 2)
      expect(east - naive).toBeGreaterThan(minGapDeg)
    }
  })

  it('赤道上では方位 90 度の点と一致する（対照）', () => {
    const [, , east] = ringBounds(139.7, 0, 800)
    const [naive] = ringVertex(139.7, 0, 800, Math.PI / 2)
    expect(east).toBeCloseTo(naive, 9)
  })

  it('中心について対称', () => {
    const [w, s, e, n] = ringBounds(139.7, 35.7, 300)
    expect(e - 139.7).toBeCloseTo(139.7 - w, 9)
    // 南北は対称にならない（球面上で北へ 300km と南へ 300km は緯度差が違う）。
    expect(n).toBeGreaterThan(35.7)
    expect(s).toBeLessThan(35.7)
  })

  // 安全弁: 円が極を含むと経度は一周する。素直に asin を取ると定義域外で NaN になる。
  it('極を含む円は全経度を返す', () => {
    const [w, , e] = ringBounds(139.7, 89, 500)
    expect(e - w).toBe(360)
    expect(Number.isFinite(w) && Number.isFinite(e)).toBe(true)
  })

  it('半径 0 なら中心に潰れる（対照）', () => {
    const [w, s, e, n] = ringBounds(139.7, 35.7, 0)
    expect(w).toBeCloseTo(139.7, 9)
    expect(e).toBeCloseTo(139.7, 9)
    expect(s).toBeCloseTo(35.7, 9)
    expect(n).toBeCloseTo(35.7, 9)
  })
})
