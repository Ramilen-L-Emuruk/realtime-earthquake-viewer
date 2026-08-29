// 深さを持つ点の座標変換・far の差し替え・柄の長さを固定する。
// 描画そのものは WebGL なのでここでは触れない（ブラウザ確認の担当）。
// 実装の詳細と背景は docs/spec/map-rendering-spec.md §16「深さを持つ点」。
import { describe, it, expect } from 'vitest'
import {
  toMercator,
  metersPerPixelAt,
  depthClipCoefficients,
  stemScreenLengthPx,
} from './depthPointLayer'

describe('toMercator', () => {
  it('地表（深さ 0）は z が 0', () => {
    // 実装は `-depthKm * ...` なので深さ 0 では -0 になる。符号付きゼロを区別しない形で見る。
    expect(toMercator(139, 35, 0)[2]).toBeCloseTo(0, 12)
  })

  it('地下は z が負（符号を取り違えると上空へ置かれる）', () => {
    // 例外は出ず、傾けたとき逆方向へ伸びるだけなので、ここで固定する。
    expect(toMercator(139, 35, 30)[2]).toBeLessThan(0)
  })

  it('深さに比例する', () => {
    const z10 = toMercator(139, 35, 10)[2]
    const z30 = toMercator(139, 35, 30)[2]
    expect(z30 / z10).toBeCloseTo(3, 6)
  })

  it('x は経度に線形（MercatorCoordinate と同じ定義）', () => {
    expect(toMercator(0, 35, 0)[0]).toBeCloseTo(0.5, 10)
    expect(toMercator(180, 35, 0)[0]).toBeCloseTo(1, 10)
  })

  it('同じ深さでも高緯度ほど z が大きい（Mercator の縮尺が緯度で変わる）', () => {
    expect(Math.abs(toMercator(139, 60, 30)[2])).toBeGreaterThan(Math.abs(toMercator(139, 10, 30)[2]))
  })
})

describe('depthClipCoefficients', () => {
  // クリップ空間の z は zA*(-w) + zB。透視投影では w がカメラからの距離なので、
  // near で -1、far で +1 になるのが定義。
  const ndc = (zA: number, zB: number, distance: number) => (zA * -distance + zB) / distance

  it('深さ 0 なら MapLibre の near/far をそのまま使う（対照）', () => {
    const { zA, zB } = depthClipCoefficients(10, 700, 0)
    expect(ndc(zA, zB, 10)).toBeCloseTo(-1, 6)
    expect(ndc(zA, zB, 700)).toBeCloseTo(1, 6)
  })

  it('深さのぶんだけ far が伸びる（余裕 1.2 倍込み）', () => {
    const { zA, zB } = depthClipCoefficients(10, 700, 100)
    expect(ndc(zA, zB, 820)).toBeCloseTo(1, 6) // 700 + 100×1.2
    expect(ndc(zA, zB, 700)).toBeLessThan(1)
  })

  it('MapLibre が切っていた距離が、差し替え後は収まる（正）', () => {
    // 傾き 0 では far が地表の 1.01 倍しかない。その外側にある地下の点が対象。
    const before = depthClipCoefficients(10, 700, 0)
    expect(ndc(before.zA, before.zB, 790)).toBeGreaterThan(1) // 元はクリップされる
    const after = depthClipCoefficients(10, 700, 100)
    expect(ndc(after.zA, after.zB, 790)).toBeLessThan(1) // 差し替え後は収まる
  })

  it('near より手前は依然として切られる（安全弁）', () => {
    const { zA, zB } = depthClipCoefficients(10, 700, 100)
    expect(ndc(zA, zB, 5)).toBeLessThan(-1)
  })
})

describe('stemScreenLengthPx', () => {
  const mpp = metersPerPixelAt(37.5, 9)

  it('真上（傾き 0）では長さ 0', () => {
    expect(stemScreenLengthPx(16, 1, mpp, 0)).toBe(0)
  })

  it('傾けるほど長くなる', () => {
    expect(stemScreenLengthPx(16, 1, mpp, 55)).toBeGreaterThan(stemScreenLengthPx(16, 1, mpp, 30))
  })

  it('誇張率に比例する', () => {
    const x1 = stemScreenLengthPx(16, 1, mpp, 55)
    expect(stemScreenLengthPx(16, 5, mpp, 55) / x1).toBeCloseTo(5, 6)
  })

  it('浅い震源は傾けても閾値に届かない（傾きだけで判定してはいけない理由）', () => {
    // 深さ 1km は傾き 60 度でも 7.1px で、震央の印と重なって潰れる。
    expect(stemScreenLengthPx(1, 1, mpp, 60)).toBeLessThan(10)
    // 対照: 同じ傾きでも 16km なら 114px で十分。
    expect(stemScreenLengthPx(16, 1, mpp, 60)).toBeGreaterThan(10)
  })

  it('同じ深さでも引いた画では潰れる（ズームも効く）', () => {
    // **深さだけで決まらない。** 深さ 2km・傾き 60 度で、zoom 9 なら 14.3px で見えるが、
    // zoom 6 では 1.8px しかない。閾値をまたぐ条件は深さ・傾き・誇張率・ズームの積で決まる。
    expect(stemScreenLengthPx(2, 1, metersPerPixelAt(37.5, 9), 60)).toBeGreaterThan(10)
    expect(stemScreenLengthPx(2, 1, metersPerPixelAt(37.5, 6), 60)).toBeLessThan(10)
  })

  it('戻り値は CSS px（devicePixelRatio を掛けない）', () => {
    // metersPerPixel はタイル 512px 基準＝CSS px なので、戻り値も CSS px。
    // 傾き 90 度なら深さをそのまま px 換算した値と一致する。ここが dpr で割られていると、
    // Hi-DPI 端末でだけ閾値が変わり、震央と柄が消えやすくなる（実際に一度そうなった）。
    expect(stemScreenLengthPx(16, 1, mpp, 90)).toBeCloseTo((16 * 1000) / mpp, 6)
  })
})

describe('metersPerPixelAt', () => {
  it('ズームが 1 段深いと半分になる', () => {
    expect(metersPerPixelAt(35, 8) / metersPerPixelAt(35, 9)).toBeCloseTo(2, 6)
  })

  it('高緯度ほど小さい（Mercator の縮尺）', () => {
    expect(metersPerPixelAt(60, 8)).toBeLessThan(metersPerPixelAt(10, 8))
  })
})
