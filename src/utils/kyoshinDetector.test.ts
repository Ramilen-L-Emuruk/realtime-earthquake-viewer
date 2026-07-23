import { describe, it, expect } from 'vitest'
import {
  indexToValue,
  siteKey,
  ewmaAlpha,
  updateSiteState,
  clusterActive,
  estimateWaveFit,
  frameScore,
  classify,
  step,
  initState,
  PARAMS,
  type Frame,
  type SiteState,
  type ActiveTrigger,
  type DetectorState,
} from './kyoshinDetector'
import { haversineKm } from './geo'

// ============================================================
// ヘルパー: 単一観測点の逐次フレームを流す（キャプチャ列の最小形）
// ============================================================

/** 1 点だけのフレームを生成する。 */
function frameOf(dataTimeMs: number, index: number): Frame {
  return { dataTimeMs, sites: [[35, 139]], values: [index] }
}

/** index 値の列を 1 秒刻みで step に流し、各フレームのトリガー結果を返す。 */
function runIndices(indices: number[], startMs = 1_000_000): ReturnType<typeof step>[] {
  let state = initState(startMs - 1000)
  const results: ReturnType<typeof step>[] = []
  indices.forEach((idx, i) => {
    const r = step(state, frameOf(startMs + i * 1000, idx))
    state = r.state
    results.push(r)
  })
  return results
}

// ============================================================
// indexToValue
// ============================================================

describe('indexToValue', () => {
  it('index 6 は震度0の計測震度 0.0 に変換される', () => {
    expect(indexToValue(6)).toBeCloseTo(0.0)
  })

  it('index 7 は震度1下端の 0.5 に変換される', () => {
    expect(indexToValue(7)).toBeCloseTo(0.5)
  })

  it('index 0 は最小 -3.0、index 20 は最大 7.0', () => {
    expect(indexToValue(0)).toBeCloseTo(-3.0)
    expect(indexToValue(20)).toBeCloseTo(7.0)
  })
})

// ============================================================
// siteKey
// ============================================================

describe('siteKey', () => {
  it('小数第3位で丸めて安定化する（約100m以内の揺れは同一キー）', () => {
    expect(siteKey(35.68123, 139.76711)).toBe(siteKey(35.68119, 139.76713))
  })

  it('異なる観測点は別キーになる', () => {
    expect(siteKey(35.0, 139.0)).not.toBe(siteKey(36.0, 139.0))
  })
})

// ============================================================
// ewmaAlpha
// ============================================================

describe('ewmaAlpha', () => {
  it('Δt=時定数 のとき α ≈ 1 − 1/e ≈ 0.632', () => {
    expect(ewmaAlpha(2000, 2000)).toBeCloseTo(1 - Math.exp(-1), 3)
  })

  it('Δt=0 は 0（更新なし）', () => {
    expect(ewmaAlpha(0, 2000)).toBe(0)
  })

  it('Δt が大きいほど α は 1 に近づく（欠損後に強く追随）', () => {
    expect(ewmaAlpha(10000, 2000)).toBeGreaterThan(ewmaAlpha(1000, 2000))
  })
})

// ============================================================
// updateSiteState: トリガー判定
// ============================================================

describe('updateSiteState', () => {
  it('新規観測点（prev=null）はトリガーしない', () => {
    const r = updateSiteState(null, indexToValue(0), 1000, 1000)
    expect(r.triggered).toBe(false)
    expect(r.path).toBeNull()
  })

  it('速い経路: 静穏点の急上昇で fast トリガー', () => {
    // 前状態: 静穏（value=-3 で収束）
    const prev: SiteState = {
      sta: -3, lta: -3, sigma: 0, frozen: false,
      lastValue: -3, triggeredAt: null, triggerRate: 0, noiseWeight: 1,
    }
    // index 8 (value 1.0) へ急上昇
    const r = updateSiteState(prev, indexToValue(8), 1000, 2000)
    expect(r.triggered).toBe(true)
    expect(r.path).toBe('fast')
    expect(r.rising).toBe(true)
  })

  it('遅い経路: 急上昇でないが絶対レベルが震度1以上なら slow トリガー', () => {
    // 前状態: value=0.4 付近で安定（sta≈lta で delta 小、σ 小）
    const prev: SiteState = {
      sta: 0.4, lta: 0.4, sigma: 0, frozen: false,
      lastValue: 0.55, triggeredAt: null, triggerRate: 0, noiseWeight: 1,
    }
    // value 0.6（震度1超）だが前値 0.55 からの上昇はわずか
    const r = updateSiteState(prev, 0.6, 1000, 2000)
    expect(r.triggered).toBe(true)
    expect(r.path).toBe('slow')
  })

  it('下限未満（TRIG_FLOOR 未満）は常に非トリガー', () => {
    const prev: SiteState = {
      sta: -3, lta: -3, sigma: 0, frozen: false,
      lastValue: -3, triggeredAt: null, triggerRate: 0, noiseWeight: 1,
    }
    // value -2.0（index 2、TRIG_FLOOR=-1.5 未満）
    const r = updateSiteState(prev, -2.0, 1000, 2000)
    expect(r.triggered).toBe(false)
  })

  it('σ→0 の完全静穏点が微小上昇（マージン未満）で誤発火しない', () => {
    const prev: SiteState = {
      sta: -1.0, lta: -1.0, sigma: 0, frozen: false,
      lastValue: -1.0, triggeredAt: null, triggerRate: 0, noiseWeight: 1,
    }
    // lta=-1.0 に対し value=-0.9（+0.1 のみ、SIGMA_FLOOR_MARGIN=0.75 未満）
    // かつ delta も小、絶対レベルも ABS_LEVEL 未満
    const r = updateSiteState(prev, -0.9, 1000, 2000)
    expect(r.triggered).toBe(false)
  })

  it('トリガー発火時は次フレームで LTA を凍結する（frozen=true）', () => {
    const prev: SiteState = {
      sta: -3, lta: -3, sigma: 0, frozen: false,
      lastValue: -3, triggeredAt: null, triggerRate: 0, noiseWeight: 1,
    }
    const r = updateSiteState(prev, indexToValue(8), 1000, 2000)
    expect(r.state.frozen).toBe(true)
    expect(r.state.triggeredAt).toBe(2000)
  })

  it('凍結中は LTA が揺れに追随せず据え置かれる（余震マスキング防止）', () => {
    const prev: SiteState = {
      sta: 1.0, lta: -3, sigma: 0, frozen: true,
      lastValue: 1.0, triggeredAt: 1000, triggerRate: 0, noiseWeight: 1,
    }
    const r = updateSiteState(prev, indexToValue(10), 1000, 2000)
    expect(r.state.lta).toBe(-3) // 凍結で不変
  })
})

// ============================================================
// updateSiteState: 慢性ノイズ源の noiseWeight（設計書 §5-D）
// ============================================================

describe('updateSiteState: noiseWeight（慢性ノイズ抑制）', () => {
  const quiet = (): SiteState => ({
    sta: -3, lta: -3, sigma: 0, frozen: false,
    lastValue: -3, triggeredAt: null, triggerRate: 0, noiseWeight: 1,
  })

  it('鳴り続ける観測点は noiseWeight が除外閾値未満まで下がる（慢性ノイズ源）', () => {
    let st = quiet()
    // 20分間、毎秒トリガーし続ける（慢性ノイズを模擬）
    for (let t = 0; t < 20 * 60; t++) {
      st = updateSiteState(st, indexToValue(14), 1000, (t + 1) * 1000).state
    }
    expect(st.triggerRate).toBeGreaterThan(0.6)
    expect(st.noiseWeight).toBeLessThan(PARAMS.NOISE_WEIGHT_MIN)
  })

  it('一過性の地震（60秒トリガー）では noiseWeight はほぼ1のまま（除外されない）', () => {
    let st = quiet()
    for (let t = 0; t < 60; t++) {
      st = updateSiteState(st, indexToValue(14), 1000, (t + 1) * 1000).state
    }
    expect(st.noiseWeight).toBeGreaterThan(0.9)
  })
})

// ============================================================
// step: フレーム列の統合挙動
// ============================================================

describe('step', () => {
  it('静穏なベースラインが続く限りトリガーは出ない', () => {
    const results = runIndices([1, 1, 1, 1, 1, 1, 1, 1])
    const total = results.reduce((n, r) => n + r.triggers.length, 0)
    expect(total).toBe(0)
  })

  it('静穏から急上昇したフレームでトリガーが出る', () => {
    // 十分に静穏（index 1）を続けた後、index 12 へ急上昇
    const results = runIndices([1, 1, 1, 1, 1, 12])
    const last = results[results.length - 1]
    expect(last.triggers.length).toBe(1)
    expect(last.triggers[0].path).toBe('fast')
  })

  it('時刻の大ジャンプ（不連続）ではリセットしトリガーを出さない', () => {
    let state = initState(0)
    // 通常フレームで基準を作る
    for (let i = 0; i < 5; i++) {
      state = step(state, frameOf(1000 + i * 1000, 1)).state
    }
    // MAX_DT_GAP_MS を超える時刻ジャンプ ＋ 大きな値
    const r = step(state, frameOf(1000 + 5 * 1000 + PARAMS.MAX_DT_GAP_MS + 5000, 15))
    expect(r.triggers.length).toBe(0)
    expect(r.state.lastDataTimeMs).toBe(1000 + 5 * 1000 + PARAMS.MAX_DT_GAP_MS + 5000)
  })

  it('missing の観測点は状態更新・トリガー対象から除外される', () => {
    const state = initState(0)
    const frame: Frame = {
      dataTimeMs: 1000,
      sites: [[35, 139], [36, 140]],
      values: [0, 15],
      missing: [false, true],
    }
    const r = step(state, frame)
    // 2点目は missing なので状態に存在しない
    expect(Object.keys(r.state.sites)).toHaveLength(1)
    expect(r.state.sites[siteKey(35, 139)]).toBeDefined()
    expect(r.state.sites[siteKey(36, 140)]).toBeUndefined()
  })

  it('単一観測点はクラスタ不成立でイベント化しない（単発ノイズ棄却）', () => {
    const results = runIndices([1, 1, 12, 13, 14])
    expect(results.every((r) => r.detections.length === 0)).toBe(true)
  })
})

// ============================================================
// Phase 2: ② 時空間アソシエーション
// ============================================================

/** ActiveTrigger を組み立てるヘルパー。 */
function mkAT(
  key: string,
  lat: number,
  lng: number,
  onsetMs: number,
  peakValue = 3,
  noiseWeight = 1,
): ActiveTrigger {
  return { key, lat, lng, onsetMs, lastTrigMs: onsetMs, peakValue, noiseWeight }
}

// 震源 A から北へ約10km刻みで並ぶ3観測点（波面フィット検証用）
const SITE_A: [number, number] = [35.0, 139.0]
const SITE_B: [number, number] = [35.09, 139.0] // A から約10km
const SITE_C: [number, number] = [35.18, 139.0] // A から約20km
const SITE_D: [number, number] = [35.27, 139.0] // A から約30km

describe('clusterActive', () => {
  it('近接点は同一クラスタ、遠方点は別クラスタになる', () => {
    const triggers = [
      mkAT('a', SITE_A[0], SITE_A[1], 0),
      mkAT('b', SITE_B[0], SITE_B[1], 0), // a から約10km（同一）
      mkAT('c', 36.5, 139.0, 0), // a から約167km（別）
    ]
    const clusters = clusterActive(triggers)
    expect(clusters).toHaveLength(2)
    const sizes = clusters.map((c) => c.length).sort()
    expect(sizes).toEqual([1, 2])
  })

  it('空入力は空配列', () => {
    expect(clusterActive([])).toEqual([])
  })

  it('同時多発（非伝播）の広域トリガーは巨大ブロブに融合せず分割される', () => {
    // 南北に約20km刻みで10点、全て同一オンセット（データ不整合・広域ノイズを模擬）
    const pts = Array.from({ length: 10 }, (_, i) =>
      mkAT(`p${i}`, 35.0 + i * 0.18, 139.0, 0),
    )
    const clusters = clusterActive(pts)
    // 単一連結なら 1 個の size 10 になるが、時空間ゲートで小クラスタに割れる
    expect(clusters.length).toBeGreaterThan(1)
    expect(Math.max(...clusters.map((c) => c.length))).toBeLessThan(pts.length)
  })

  it('本物の伝播波面（遠いほど遅い）は1クラスタに保たれる', () => {
    // 同じ配置だが、震源(先頭)から約4km/sで伝播するオンセット時刻を与える
    const V = 4 // km/s
    const pts = Array.from({ length: 10 }, (_, i) => {
      const lat = 35.0 + i * 0.18
      const rKm = (lat - 35.0) * 111 // 緯度差→おおよそのkm
      return mkAT(`w${i}`, lat, 139.0, Math.round((rKm / V) * 1000))
    })
    const clusters = clusterActive(pts)
    expect(clusters.length).toBe(1)
    expect(clusters[0].length).toBe(10)
  })
})

describe('estimateWaveFit', () => {
  it('遠い点ほど遅いオンセットなら波面フィットが成立し速度が物理域に入る', () => {
    // A(0km,0s) B(10km,3s) C(20km,6s) → 見かけ速度 ≈ 3.3 km/s
    const cluster = [
      mkAT('a', SITE_A[0], SITE_A[1], 0),
      mkAT('b', SITE_B[0], SITE_B[1], 3000),
      mkAT('c', SITE_C[0], SITE_C[1], 6000),
    ]
    const fit = estimateWaveFit(cluster)
    expect(fit.fitOk).toBe(true)
    expect(fit.velocityKmS).toBeGreaterThanOrEqual(PARAMS.V_MIN_KMS)
    expect(fit.velocityKmS).toBeLessThanOrEqual(PARAMS.V_MAX_KMS)
    expect(fit.residualRms).toBeLessThan(1)
    expect(fit.epicenter).toEqual(SITE_A) // 最早オンセット点
  })

  it('3点未満はフィット不能', () => {
    const cluster = [mkAT('a', SITE_A[0], SITE_A[1], 0), mkAT('b', SITE_B[0], SITE_B[1], 3000)]
    expect(estimateWaveFit(cluster).fitOk).toBe(false)
  })

  it('距離レンジが狭すぎる（密集）とフィット不能', () => {
    // 3点とも同一地点付近 → 距離レンジ < FIT_RANGE_MIN_KM
    const cluster = [
      mkAT('a', 35.0, 139.0, 0),
      mkAT('b', 35.001, 139.001, 2000),
      mkAT('c', 35.002, 139.0, 4000),
    ]
    expect(estimateWaveFit(cluster).fitOk).toBe(false)
  })
})

// ============================================================
// estimateWaveFit: 片側配置（海溝型 type-B）の方位推定
// ============================================================

/** 震源から見かけ速度 V(km/s) で伝播したオンセットを持つクラスタを組み立てる。 */
function clusterFromSource(
  src: [number, number],
  points: [number, number][],
  vKmS = 6,
): ActiveTrigger[] {
  return points.map((p, i) => {
    const onsetMs = Math.round((haversineKm(src[0], src[1], p[0], p[1]) / vKmS) * 1000)
    return mkAT(`s${i}`, p[0], p[1], onsetMs)
  })
}

describe('estimateWaveFit: 片側配置(type-B)', () => {
  it('海側震源・陸側のみの配置では oneSided=true で震源方位が沖側(東)を向く', () => {
    // 震源は東の沖合。観測点はすべて西側（陸側）に 2D で散らばる。
    const src: [number, number] = [35.2, 140.5]
    const land: [number, number][] = [
      [35.2, 139.0],
      [35.0, 139.5],
      [35.4, 139.5],
      [35.2, 139.5],
      [35.0, 139.2],
      [35.4, 139.2],
    ]
    const fit = estimateWaveFit(clusterFromSource(src, land))
    expect(fit.oneSided).toBe(true)
    expect(fit.azimuthalGapDeg).toBeGreaterThanOrEqual(PARAMS.ONE_SIDED_GAP_DEG)
    expect(fit.bearingDeg).not.toBeNull()
    // 震源は東（≈90°）方向
    expect(fit.bearingDeg as number).toBeGreaterThan(45)
    expect(fit.bearingDeg as number).toBeLessThan(135)
    // 片側配置でも検知は担保される（平面波フィットで fitOk）
    expect(fit.fitOk).toBe(true)
    // 震央アンカーは最短距離（最も沖＝東寄り）の点
    expect(fit.epicenter).toEqual([35.2, 139.5])
  })

  it('観測点が震源を囲む配置では oneSided=false（内陸浅発）', () => {
    const src: [number, number] = [35.2, 139.2]
    const around: [number, number][] = [
      [35.2, 139.2], // 震央近傍（最早）
      [35.5, 139.2], // 北
      [34.9, 139.2], // 南
      [35.2, 139.5], // 東
      [35.2, 138.9], // 西
    ]
    const fit = estimateWaveFit(clusterFromSource(src, around))
    expect(fit.oneSided).toBe(false)
    expect(fit.azimuthalGapDeg).toBeLessThan(PARAMS.ONE_SIDED_GAP_DEG)
    // 震央は最早オンセット点＝震央近傍
    expect(fit.epicenter).toEqual([35.2, 139.2])
    expect(fit.fitOk).toBe(true)
  })
})

describe('frameScore', () => {
  it('点数が多くフィット良好なほど高スコア', () => {
    const goodFit = {
      epicenter: SITE_A,
      velocityKmS: 3.3,
      residualRms: 0,
      fitOk: true,
      radialFitOk: true,
      bearingDeg: null,
      oneSided: false,
      azimuthalGapDeg: 0,
    }
    const noFit = {
      epicenter: SITE_A,
      velocityKmS: NaN,
      residualRms: Infinity,
      fitOk: false,
      radialFitOk: false,
      bearingDeg: null,
      oneSided: false,
      azimuthalGapDeg: 0,
    }
    expect(frameScore(5, goodFit)).toBeGreaterThan(frameScore(2, noFit))
  })
})

// ============================================================
// classify: 確信度の非対称ゲート（radial 裏取り vs 片側配置）
// ============================================================

describe('classify', () => {
  const HIGH = PARAMS.S_ON + 0.5 // confirmed しきい値を十分超えるスコア
  const PEAK = PARAMS.MIN_LIKELY_PEAK + 1.0 // 振幅ゲートを十分超える
  const BIG = PARAMS.MIN_CONFIRM_SIZE_ONESIDED + 2 // サイズゲートを十分超える

  it('fitOk でなければスコア・点数が高くても weak 止まり', () => {
    expect(classify(HIGH, BIG, PEAK, false, false, false)).toBe('weak')
  })

  it('radial 裏取りあり: MIN_CONFIRM_SIZE(4) で confirmed に上げられる', () => {
    expect(classify(HIGH, PARAMS.MIN_CONFIRM_SIZE, PEAK, true, true, false)).toBe('confirmed')
  })

  it('片側配置(radialFitOk=false): 4点では confirmed に上げず likely 止まり', () => {
    // 高スコアでも片側配置の少数点はノイズ塊の偶然フィットと区別できない
    expect(classify(HIGH, PARAMS.MIN_CONFIRM_SIZE, PEAK, true, false, false)).toBe('likely')
  })

  it('片側配置(radialFitOk=false): MIN_CONFIRM_SIZE_ONESIDED 点あれば confirmed 可', () => {
    expect(classify(HIGH, PARAMS.MIN_CONFIRM_SIZE_ONESIDED, PEAK, true, false, false)).toBe('confirmed')
  })

  it('スコアが S_LIKELY 未満なら fitOk でも weak', () => {
    expect(classify(PARAMS.S_LIKELY - 0.1, BIG, PEAK, true, true, false)).toBe('weak')
  })

  it('ウォームアップ中は confirmed に上げず likely に留める', () => {
    expect(classify(HIGH, PARAMS.MIN_CONFIRM_SIZE, PEAK, true, true, true)).toBe('likely')
  })

  it('少数点(MIN_LIKELY_SIZE 未満)は高スコア・高振幅でも weak（平常時ノイズ抑制）', () => {
    expect(classify(HIGH, PARAMS.MIN_LIKELY_SIZE - 1, PEAK, true, true, false)).toBe('weak')
  })

  it('低振幅(震度0未満)は点数・スコアが十分でも weak（低振幅の都市ノイズ抑制）', () => {
    expect(classify(HIGH, BIG, PARAMS.MIN_LIKELY_PEAK - 0.5, true, true, false)).toBe('weak')
  })
})

// ============================================================
// Phase 2: ③ 確信度積分・イベントライフサイクル（step 統合）
// ============================================================

/** ウォームアップ無効の初期状態（confirmed まで検証するため）。 */
function stateNoWarmup(startMs: number): DetectorState {
  return { ...initState(startMs - 1000), warmupUntilMs: 0 }
}

/** 4観測点フレームを組み立てる。 */
function frame4(dataTimeMs: number, a: number, b: number, c: number, d: number): Frame {
  return { dataTimeMs, sites: [SITE_A, SITE_B, SITE_C, SITE_D], values: [a, b, c, d] }
}

/**
 * 波面状に立ち上がる地震シナリオを流す。
 * baseline 確立後、A→B→C→D の順に約3秒間隔でトリガーさせ、以後は高値維持。
 * confirmed は MIN_CONFIRM_SIZE=4 のため、4点揃う（D onset）以降に成立しうる。
 */
function runWaveScenario(extraQuietFrames = 0): {
  state: DetectorState
  last: ReturnType<typeof step>
  peak: ReturnType<typeof step>
} {
  const start = 1_000_000
  let state = stateNoWarmup(start)
  const schedule: [number, number, number, number][] = [
    [1, 1, 1, 1], // f0 baseline
    [1, 1, 1, 1], // f1
    [1, 1, 1, 1], // f2
    [1, 1, 1, 1], // f3
    [14, 1, 1, 1], // f4 A onset
    [14, 1, 1, 1], // f5
    [14, 1, 1, 1], // f6
    [14, 14, 1, 1], // f7 B onset
    [14, 14, 1, 1], // f8
    [14, 14, 1, 1], // f9
    [14, 14, 14, 1], // f10 C onset
    [14, 14, 14, 1], // f11
    [14, 14, 14, 1], // f12
    [14, 14, 14, 14], // f13 D onset
    [14, 14, 14, 14], // f14
    [14, 14, 14, 14], // f15
    [14, 14, 14, 14], // f16
    [14, 14, 14, 14], // f17
    [14, 14, 14, 14], // f18
    [14, 14, 14, 14], // f19
    [14, 14, 14, 14], // f20
    [14, 14, 14, 14], // f21
    [14, 14, 14, 14], // f22
  ]
  let last!: ReturnType<typeof step>
  schedule.forEach(([a, b, c, d], i) => {
    last = step(state, frame4(start + i * 1000, a, b, c, d))
    state = last.state
  })
  const peak = last
  // 追加の静穏フレーム（終了判定検証用）
  for (let i = 0; i < extraQuietFrames; i++) {
    last = step(state, frame4(start + (schedule.length + i) * 1000, 1, 1, 1, 1))
    state = last.state
  }
  return { state, last, peak }
}

describe('step: イベントライフサイクル', () => {
  it('波面状に立ち上がる4点クラスタは confirmed に到達する', () => {
    const { peak } = runWaveScenario()
    expect(peak.detections.length).toBeGreaterThanOrEqual(1)
    const ev = peak.detections[0]
    expect(ev.confidence).toBe('confirmed')
    expect(ev.epicenter).toEqual(SITE_A)
    expect(ev.memberKeys.length).toBe(4)
  })

  it('揺れが収まると END_TIMEOUT 経過後にイベントが終了する', () => {
    // 高値維持後、十分な静穏フレームで active 失効＋スコア減衰＋idle 超過
    const { last } = runWaveScenario(20)
    expect(last.detections.length).toBe(0)
  })

  it('空間的に離れた2つの地震は別イベントに分離される', () => {
    const start = 2_000_000
    let state = stateNoWarmup(start)
    // クラスタ1: A,B,C（関東）。クラスタ2: 遠方3点（約500km南西）
    const D: [number, number] = [31.0, 131.0]
    const E: [number, number] = [31.09, 131.0]
    const F: [number, number] = [31.18, 131.0]
    const sites = [SITE_A, SITE_B, SITE_C, D, E, F]
    const seq: number[][] = [
      [1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1],
      [14, 14, 14, 14, 14, 14], // 両クラスタ同時立ち上がり
      [14, 14, 14, 14, 14, 14],
      [14, 14, 14, 14, 14, 14],
    ]
    let last!: ReturnType<typeof step>
    seq.forEach((values, i) => {
      last = step(state, { dataTimeMs: start + i * 1000, sites, values })
      state = last.state
    })
    // 震源が 100km 超離れているため 2 イベントに分かれる
    expect(last.detections.length).toBe(2)
  })

  it('離れた単発トリガー2点はクラスタも形成せずイベント化しない', () => {
    const start = 3_000_000
    let state = stateNoWarmup(start)
    const far1: [number, number] = [35.0, 139.0]
    const far2: [number, number] = [40.0, 141.0] // 約600km
    const sites = [far1, far2]
    const seq: number[][] = [
      [1, 1],
      [1, 1],
      [14, 14], // 両点トリガーするが遠すぎてクラスタ不成立
      [14, 14],
    ]
    let last!: ReturnType<typeof step>
    seq.forEach((values, i) => {
      last = step(state, { dataTimeMs: start + i * 1000, sites, values })
      state = last.state
    })
    expect(last.detections.length).toBe(0)
  })
})
