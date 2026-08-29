// 深さを持つ点の座標変換・深度の帯・柄の長さを固定する。
// 描画そのものは WebGL なのでここでは触れない（ブラウザ確認の担当）。
// 実装の詳細と背景は docs/spec/map-rendering-spec.md §16「深さを持つ点」。
import { describe, it, expect } from 'vitest'
import {
  toMercator,
  cosLatFromMercatorY,
  clampElevationForGlobe,
  GLOBE_RADIUS_M,
  metersPerPixelAt,
  depthSlabRange,
  depthSlabNdc,
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

  it('z の単位はメートル（globe の projectTileFor3D が受け取る単位）', () => {
    // **緯度に依存しない。** ここを Mercator 座標系の z にすると、globe で深さが 6000 倍ずれる。
    expect(toMercator(139, 35, 30)[2]).toBeCloseTo(-30_000, 6)
    expect(toMercator(139, 60, 30)[2]).toBeCloseTo(-30_000, 6)
  })

  it('x は経度に線形（MercatorCoordinate と同じ定義）', () => {
    expect(toMercator(0, 35, 0)[0]).toBeCloseTo(0.5, 10)
    expect(toMercator(180, 35, 0)[0]).toBeCloseTo(1, 10)
  })
})

describe('cosLatFromMercatorY', () => {
  // シェーダーの elevationForProjection が Mercator 側で使う換算。**ここがずれると、平面のとき
  // だけ深さが緯度に応じて狂う**（緯度 60 度で 2 倍）。素直に緯度から求めた値と突き合わせる。
  const mercY = (lat: number) =>
    (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360

  it.each([0, 10, 35, 45, 60, 75])('緯度 %i 度で cos(lat) に一致する', (lat) => {
    expect(cosLatFromMercatorY(mercY(lat))).toBeCloseTo(Math.cos((lat * Math.PI) / 180), 10)
  })

  it('赤道（y = 0.5）で 1', () => {
    expect(cosLatFromMercatorY(0.5)).toBeCloseTo(1, 12)
  })
})

describe('clampElevationForGlobe', () => {
  // MapLibre は球面上の点を spherePos * (1 + elevation / GLOBE_RADIUS) で置く。
  // 係数が負になると点は地球の反対側へ写るので、そこへ到達させない。
  const factor = (elevMeters: number) => 1 + clampElevationForGlobe(elevMeters) / GLOBE_RADIUS_M

  it('通常の深さはそのまま通す（対照）', () => {
    expect(clampElevationForGlobe(-30_000)).toBe(-30_000)
    expect(clampElevationForGlobe(-700_000)).toBe(-700_000)
  })

  it('深さ 700km × 強調 10 倍でも反対側へ写らない（正）', () => {
    // 700 × 10 = 7000km は地球半径 6371km を越える。素通しすると係数が負になる。
    expect(factor(-700_000 * 10)).toBeGreaterThan(0)
  })

  it('強調の上限 20 倍でも反対側へ写らない（正）', () => {
    expect(factor(-700_000 * 20)).toBeGreaterThan(0)
  })

  it('どれだけ深くしても地球の中心を越えない（安全弁）', () => {
    for (const m of [-1e6, -1e7, -1e9, -Number.MAX_SAFE_INTEGER]) {
      expect(factor(m)).toBeGreaterThan(0)
      expect(clampElevationForGlobe(m)).toBeGreaterThan(-GLOBE_RADIUS_M)
    }
  })

  it('地表と上空は触らない（安全弁）', () => {
    expect(clampElevationForGlobe(0)).toBe(0)
    expect(clampElevationForGlobe(5000)).toBe(5000)
  })
})

describe('depthSlabRange', () => {
  // 深度の帯。カメラからの距離 w を「手前の薄い帯」へ写す係数を返す。
  // シェーダー側の slabZ は (-1 + slab * t) * w で、t = clamp((w - nearZ) * invRange, 0, 1)。
  const t = (s: { nearZ: number; invRange: number }, distance: number) =>
    Math.min(Math.max((distance - s.nearZ) * s.invRange, 0), 1)
  const ndc = depthSlabNdc

  it('near で帯の手前端、far で帯の奥端になる（対照）', () => {
    const s = depthSlabRange(10, 700, 0)
    expect(t(s, 10)).toBeCloseTo(0, 6)
    expect(t(s, 700)).toBeCloseTo(1, 6)
  })

  it('深さのぶんだけ距離の範囲が伸びる（余裕 1.2 倍込み）', () => {
    const s = depthSlabRange(10, 700, 100)
    expect(t(s, 820)).toBeCloseTo(1, 6) // 700 + 100×1.2
    expect(t(s, 700)).toBeLessThan(1)
  })

  it('MapLibre が切っていた距離も帯に収まる（正）', () => {
    // 傾き 0 では far が地表の 1.01 倍しかない。その外側にある地下の点が対象。
    const s = depthSlabRange(10, 700, 100)
    expect(t(s, 790)).toBeLessThan(1)
    expect(t(s, 790)).toBeGreaterThan(0)
  })

  it('帯は必ずクリップ空間の手前側に収まる（安全弁）', () => {
    // **これが崩れると地図の描画物に隠される**（球では地表のタイルが深度を書く）。
    const s = depthSlabRange(10, 700, 100)
    for (const d of [10, 100, 700, 820, 5000]) {
      expect(ndc(s, d)).toBeGreaterThanOrEqual(-1)
      expect(ndc(s, d)).toBeLessThan(-0.9)
    }
  })

  it('near より手前は依然として切られる（安全弁）', () => {
    // **下限を 0 で丸めないこと。** 丸めると、破棄される代わりに近クリップ面へ貼り付く。
    const s = depthSlabRange(10, 700, 100)
    expect(ndc(s, 5)).toBeLessThan(-1)
  })

  it('遠いほど帯の奥（点どうしの前後関係が保たれる）', () => {
    const s = depthSlabRange(10, 700, 100)
    expect(ndc(s, 400)).toBeGreaterThan(ndc(s, 100))
  })

  it('near と far が同値でも 0 除算にならない（安全弁）', () => {
    const s = depthSlabRange(10, 10, 0)
    expect(Number.isFinite(s.invRange)).toBe(true)
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
