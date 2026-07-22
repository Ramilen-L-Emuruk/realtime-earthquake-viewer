import { describe, it, expect } from 'vitest'
import {
  indexToValue,
  siteKey,
  ewmaAlpha,
  updateSiteState,
  step,
  initState,
  PARAMS,
  type Frame,
  type SiteState,
} from './kyoshinDetector'

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
      lastValue: -3, triggeredAt: null, noiseWeight: 1,
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
      lastValue: 0.55, triggeredAt: null, noiseWeight: 1,
    }
    // value 0.6（震度1超）だが前値 0.55 からの上昇はわずか
    const r = updateSiteState(prev, 0.6, 1000, 2000)
    expect(r.triggered).toBe(true)
    expect(r.path).toBe('slow')
  })

  it('下限未満（TRIG_FLOOR 未満）は常に非トリガー', () => {
    const prev: SiteState = {
      sta: -3, lta: -3, sigma: 0, frozen: false,
      lastValue: -3, triggeredAt: null, noiseWeight: 1,
    }
    // value -2.0（index 2、TRIG_FLOOR=-1.5 未満）
    const r = updateSiteState(prev, -2.0, 1000, 2000)
    expect(r.triggered).toBe(false)
  })

  it('σ→0 の完全静穏点が微小上昇（マージン未満）で誤発火しない', () => {
    const prev: SiteState = {
      sta: -1.0, lta: -1.0, sigma: 0, frozen: false,
      lastValue: -1.0, triggeredAt: null, noiseWeight: 1,
    }
    // lta=-1.0 に対し value=-0.9（+0.1 のみ、SIGMA_FLOOR_MARGIN=0.75 未満）
    // かつ delta も小、絶対レベルも ABS_LEVEL 未満
    const r = updateSiteState(prev, -0.9, 1000, 2000)
    expect(r.triggered).toBe(false)
  })

  it('トリガー発火時は次フレームで LTA を凍結する（frozen=true）', () => {
    const prev: SiteState = {
      sta: -3, lta: -3, sigma: 0, frozen: false,
      lastValue: -3, triggeredAt: null, noiseWeight: 1,
    }
    const r = updateSiteState(prev, indexToValue(8), 1000, 2000)
    expect(r.state.frozen).toBe(true)
    expect(r.state.triggeredAt).toBe(2000)
  })

  it('凍結中は LTA が揺れに追随せず据え置かれる（余震マスキング防止）', () => {
    const prev: SiteState = {
      sta: 1.0, lta: -3, sigma: 0, frozen: true,
      lastValue: 1.0, triggeredAt: 1000, noiseWeight: 1,
    }
    const r = updateSiteState(prev, indexToValue(10), 1000, 2000)
    expect(r.state.lta).toBe(-3) // 凍結で不変
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

  it('detections は Phase 1 では常に空（②③ 未実装）', () => {
    const results = runIndices([1, 1, 12, 13, 14])
    expect(results.every((r) => r.detections.length === 0)).toBe(true)
  })
})
