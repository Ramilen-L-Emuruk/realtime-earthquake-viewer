import { describe, it, expect } from 'vitest'
import {
  step,
  initState,
  buildStationMeta,
  extractLearned,
  hydrateLearned,
  indexToValue,
  siteKey,
  cellKey,
  ewmaAlpha,
  memberOverlapFrac,
  PARAMS,
  type DetectorState,
  type Frame,
  type StationMeta,
} from './kyoshinDetector'

// ============================================================
// テスト用ヘルパー
// ============================================================

/** value(計測震度) → インデックス。indexToValue の逆変換。 */
function valueToIndex(value: number): number {
  return Math.round(value * 2 + 6)
}

interface StationDef {
  lat: number
  lng: number
}

/**
 * 中心の周りに 3×3 グリッドの観測点を作る（間隔 spacingDeg）。
 * spacing=0.1° なら対角 ≈ 28km で全点が相互に R_KM(40km) 近傍になる。
 */
function grid3x3(centerLat: number, centerLng: number, spacingDeg = 0.1): StationDef[] {
  const out: StationDef[] = []
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      out.push({ lat: centerLat + i * spacingDeg, lng: centerLng + j * spacingDeg })
    }
  }
  return out
}

function sitesOf(defs: StationDef[]): [number, number][] {
  return defs.map((d) => [d.lat, d.lng])
}

/** 全観測点を一律 value にしたフレームを作る。 */
function uniformFrame(defs: StationDef[], t: number, value: number): Frame {
  return {
    dataTimeMs: t,
    sites: sitesOf(defs),
    values: defs.map(() => valueToIndex(value)),
  }
}

/** 個別に value を与えるフレームを作る（valueFn: index → value）。 */
function frameWith(defs: StationDef[], t: number, valueFn: (i: number) => number): Frame {
  return {
    dataTimeMs: t,
    sites: sitesOf(defs),
    values: defs.map((_, i) => valueToIndex(valueFn(i))),
  }
}

/** 一連のフレームを step に流し、最終 state と最終検知を返す。 */
function drive(
  frames: Frame[],
  meta?: StationMeta,
  initial?: DetectorState,
): { state: DetectorState; detections: ReturnType<typeof step>['detections'] } {
  let state = initial ?? initState(frames[0].dataTimeMs - 1000)
  let detections: ReturnType<typeof step>['detections'] = []
  for (const f of frames) {
    const r = step(state, f, meta)
    state = r.state
    detections = r.detections
  }
  return { state, detections }
}

/**
 * 静穏フレーム（value 0）を quietCount 個 → 揺れフレーム（value shakeValue）を shakeCount 個。
 * 1Hz・startT 起点。オンセット窓に静穏の baseline が入るよう静穏を先に十分積む。
 */
function quietThenShake(
  defs: StationDef[],
  opts: { quietCount?: number; shakeCount?: number; shakeValue?: number; startT?: number } = {},
): Frame[] {
  const { quietCount = 5, shakeCount = 4, shakeValue = 2.0, startT = 0 } = opts
  const frames: Frame[] = []
  let t = startT
  for (let i = 0; i < quietCount; i++, t += 1000) frames.push(uniformFrame(defs, t, 0))
  for (let i = 0; i < shakeCount; i++, t += 1000) frames.push(uniformFrame(defs, t, shakeValue))
  return frames
}

// ============================================================
// 純粋ヘルパー
// ============================================================

describe('indexToValue', () => {
  it('index 6 は震度0(value 0.0)', () => {
    expect(indexToValue(6)).toBeCloseTo(0.0)
  })
  it('index 0 は value -3.0・index 20 は value 7.0', () => {
    expect(indexToValue(0)).toBeCloseTo(-3.0)
    expect(indexToValue(20)).toBeCloseTo(7.0)
  })
})

describe('siteKey / cellKey', () => {
  it('siteKey は小数第3位で丸める', () => {
    expect(siteKey(35.12345, 139.98765)).toBe('35.123,139.988')
  })
  it('cellKey は CELL_DEG ビンで量子化する', () => {
    expect(cellKey(35.05, 139.03)).toBe(
      `${Math.floor(35.05 / PARAMS.CELL_DEG)},${Math.floor(139.03 / PARAMS.CELL_DEG)}`,
    )
  })
  it('同一セル内の2点は同じ cellKey', () => {
    expect(cellKey(35.01, 139.01)).toBe(cellKey(35.09, 139.09))
  })
})

describe('ewmaAlpha', () => {
  it('dt<=0 は 0', () => {
    expect(ewmaAlpha(0, 1000)).toBe(0)
    expect(ewmaAlpha(-5, 1000)).toBe(0)
  })
  it('dt=tau で 1-1/e ≈ 0.632', () => {
    expect(ewmaAlpha(1000, 1000)).toBeCloseTo(1 - Math.exp(-1), 3)
  })
})

describe('memberOverlapFrac', () => {
  it('空集合は 0', () => {
    expect(memberOverlapFrac(new Set<string>(), ['a'])).toBe(0)
    expect(memberOverlapFrac(new Set(['a']), [])).toBe(0)
  })
  it('|a∩b| / min(|a|,|b|)', () => {
    expect(memberOverlapFrac(new Set(['a', 'b', 'c']), ['a', 'b'])).toBeCloseTo(1.0)
    expect(memberOverlapFrac(new Set(['a', 'x']), ['a', 'y'])).toBeCloseTo(0.5)
  })
})

describe('buildStationMeta', () => {
  it('近接3×3グリッドは相互に近傍になる（avail>=3・neighbors<=K）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const centerKey = siteKey(35.0, 139.0)
    expect(meta.avail[centerKey]).toBeGreaterThanOrEqual(3)
    expect(meta.neighbors[centerKey].length).toBeLessThanOrEqual(PARAMS.K)
    expect(meta.cellOf[centerKey]).toBe(cellKey(35.0, 139.0))
  })
  it('R_KM より遠い孤立点は近傍を持たない', () => {
    const defs = [
      { lat: 35.0, lng: 139.0 },
      { lat: 40.0, lng: 143.0 },
    ]
    const meta = buildStationMeta(sitesOf(defs))
    expect(meta.avail[siteKey(40.0, 143.0)]).toBe(0)
    expect(meta.neighbors[siteKey(40.0, 143.0)]).toEqual([])
  })
})

// ============================================================
// step: トリガー・近傍一致・確定
// ============================================================

describe('step: 近傍同時の揺れを confirmed 検知', () => {
  it('密な観測点群が同時に立ち上がると数フレームで confirmed になる', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const frames = quietThenShake(defs, { quietCount: 5, shakeCount: 4, shakeValue: 2.0 })
    const { detections } = drive(frames, meta)

    const confirmed = detections.filter((d) => d.confidence === 'confirmed')
    expect(confirmed.length).toBe(1)
    expect(confirmed[0].lastSize).toBeGreaterThanOrEqual(PARAMS.CONFIRM_POINTS)
    expect(confirmed[0].maxIntensity).toBeCloseTo(2.0)
  })

  it('確定は V1 相当の速さ: 揺れ開始から CONFIRM_FRAMES+1 フレーム以内', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) state = step(state, uniformFrame(defs, t, 0), meta).state

    let framesToConfirm = 0
    let confirmed = false
    for (let i = 0; i < 5 && !confirmed; i++, t += 1000) {
      const r = step(state, uniformFrame(defs, t, 2.0), meta)
      state = r.state
      framesToConfirm++
      confirmed = r.detections.some((d) => d.confidence === 'confirmed')
    }
    expect(confirmed).toBe(true)
    expect(framesToConfirm).toBeLessThanOrEqual(PARAMS.CONFIRM_FRAMES + 1)
  })
})

describe('step: 特異度（散在ノイズを排除）', () => {
  it('孤立した単点ノイズは近傍が揃わず confirmed にならない', () => {
    const defs: StationDef[] = [
      { lat: 33.0, lng: 131.0 },
      { lat: 35.0, lng: 139.0 },
      { lat: 38.0, lng: 141.0 },
      { lat: 43.0, lng: 143.0 },
      { lat: 34.0, lng: 135.0 },
    ]
    const meta = buildStationMeta(sitesOf(defs))
    const frames = quietThenShake(defs, { quietCount: 5, shakeCount: 5, shakeValue: 3.0 })
    const { detections } = drive(frames, meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
    expect(detections.some((d) => d.confidence === 'likely')).toBe(false)
  })

  it('平常（微小変動のみ）では検知ゼロ', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 30; i++, t += 1000) {
      frames.push(frameWith(defs, t, () => (i % 2 === 0 ? 0.0 : 0.2)))
    }
    const { detections } = drive(frames, meta)
    expect(detections.length).toBe(0)
  })
})

describe('step: グループ化とID安定性', () => {
  it('セル境界をまたぐ揺れも1イベントに保たれる（近傍グラフ連結）', () => {
    const defs: StationDef[] = [
      { lat: 34.95, lng: 139.0 },
      { lat: 34.98, lng: 139.05 },
      { lat: 35.02, lng: 139.0 },
      { lat: 35.05, lng: 139.05 },
      { lat: 35.0, lng: 139.1 },
      { lat: 34.9, lng: 139.1 },
    ]
    const meta = buildStationMeta(sitesOf(defs))
    const cells = new Set(defs.map((d) => meta.cellOf[siteKey(d.lat, d.lng)]))
    expect(cells.size).toBeGreaterThanOrEqual(2)

    const frames = quietThenShake(defs, { quietCount: 5, shakeCount: 4, shakeValue: 2.0 })
    const { detections } = drive(frames, meta)
    const active = detections.filter((d) => d.confidence !== 'weak')
    expect(active.length).toBe(1)
  })

  it('離れた2地震は別IDに分離する', () => {
    const west = grid3x3(33.0, 131.0, 0.1)
    const east = grid3x3(38.0, 141.0, 0.1)
    const defs = [...west, ...east]
    const meta = buildStationMeta(sitesOf(defs))
    const frames = quietThenShake(defs, { quietCount: 5, shakeCount: 4, shakeValue: 2.0 })
    const { detections } = drive(frames, meta)
    const confirmed = detections.filter((d) => d.confidence === 'confirmed')
    expect(confirmed.length).toBe(2)
    const a = new Set(confirmed[0].memberKeys)
    expect(confirmed[1].memberKeys.some((k) => a.has(k))).toBe(false)
  })
})

describe('step: 保持と明滅防止', () => {
  it('揺れ停止後もオンセット途絶から HOLD_MS までは confirmed を維持する', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) state = step(state, uniformFrame(defs, t, 0), meta).state
    for (let i = 0; i < 3; i++, t += 1000) state = step(state, uniformFrame(defs, t, 2.0), meta).state
    expect(state.events.some((e) => e.confidence === 'confirmed')).toBe(true)

    let stillConfirmed = true
    for (let i = 0; i < 6; i++, t += 1000) {
      const r = step(state, uniformFrame(defs, t, 0), meta)
      state = r.state
      const idleMs = i * 1000 + 1000
      if (idleMs < PARAMS.HOLD_MS) {
        stillConfirmed = stillConfirmed && r.detections.some((d) => d.confidence === 'confirmed')
      }
    }
    expect(stillConfirmed).toBe(true)
  })

  it('HOLD_MS を十分超えるとイベントは解除される', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) state = step(state, uniformFrame(defs, t, 0), meta).state
    for (let i = 0; i < 3; i++, t += 1000) state = step(state, uniformFrame(defs, t, 2.0), meta).state
    for (let i = 0; i < 25; i++, t += 1000) state = step(state, uniformFrame(defs, t, 0), meta).state
    expect(state.events.length).toBe(0)
  })
})

describe('step: 特異度の第2軸（セル慢性活性ガード）', () => {
  it('慢性活性セルでは震度1のコヒーレント同時多発を confirmed にしない', () => {
    const defs = grid3x3(36.1, 140.3, 0.1) // 北関東型
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) state = step(state, uniformFrame(defs, t, 0), meta).state
    for (const d of defs) state.cellActivity[meta.cellOf[siteKey(d.lat, d.lng)]] = 0.9

    for (let i = 0; i < 5; i++, t += 1000) state = step(state, uniformFrame(defs, t, 0.5), meta).state
    expect(state.events.some((e) => e.confidence === 'confirmed')).toBe(false)
  })

  it('同じ震度1でも通常セルなら confirmed になり得る', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const frames = quietThenShake(defs, { quietCount: 5, shakeCount: 5, shakeValue: 0.5 })
    const { detections } = drive(frames, meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(true)
  })
})

describe('step: 不連続リセット', () => {
  it('大きな時刻ジャンプで状態をリセットしその1フレームは検知しない', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) state = step(state, uniformFrame(defs, t, 0), meta).state
    const r = step(state, uniformFrame(defs, t + PARAMS.MAX_DT_GAP_MS + 5000, 3.0), meta)
    expect(r.detections.length).toBe(0)
    expect(r.state.events.length).toBe(0)
  })

  it('不連続リセットでも学習資産（点別床・セル慢性活性）は引き継ぐ', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const k = siteKey(35.0, 139.0)
    const cell = meta.cellOf[k]
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) state = step(state, uniformFrame(defs, t, 0), meta).state
    // 学習資産を手で仕込む
    state.sites[k] = { hist: [], floorMean: 0.8, floorDev: 0.3, triggeredAtMs: null }
    state.cellActivity[cell] = 0.7
    // 不連続ジャンプ
    const r = step(state, uniformFrame(defs, t + PARAMS.MAX_DT_GAP_MS + 5000, 0.0), meta)
    expect(r.state.sites[k].floorMean).toBeCloseTo(0.8)
    expect(r.state.sites[k].floorDev).toBeCloseTo(0.3)
    expect(r.state.cellActivity[cell]).toBeCloseTo(0.7)
  })
})

describe('永続化: extractLearned / hydrateLearned', () => {
  it('学習した床とセル活性を抽出→復元できる（既定床の静穏点は省略）', () => {
    const state = initState(0)
    state.sites['a'] = { hist: [], floorMean: 0.9, floorDev: 0.4, triggeredAtMs: null } // 学習済み
    state.sites['b'] = { hist: [], floorMean: 0.0, floorDev: 0.0, triggeredAtMs: null } // 静穏（省略対象）
    state.cellActivity['c1'] = 0.6

    const learned = extractLearned(state)
    expect(learned.floors['a']).toEqual([0.9, 0.4])
    expect(learned.floors['b']).toBeUndefined() // 微小床は保存しない
    expect(learned.cellActivity['c1']).toBeCloseTo(0.6)

    const restored = hydrateLearned(initState(0), learned)
    expect(restored.sites['a'].floorMean).toBeCloseTo(0.9)
    expect(restored.sites['a'].floorDev).toBeCloseTo(0.4)
    expect(restored.sites['a'].triggeredAtMs).toBeNull()
    expect(restored.cellActivity['c1']).toBeCloseTo(0.6)
  })

  it('復元した床は初フレームから有効（学習で鈍った点は誤検知しにくい）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    // 全点の床を高く（震度1.5相当）復元した状態から開始
    const learned = {
      floors: Object.fromEntries(defs.map((d) => [siteKey(d.lat, d.lng), [1.5, 0.2] as [number, number]])),
      cellActivity: {},
    }
    const state = hydrateLearned(initState(0), learned)
    // 震度1(value 0.5)のコヒーレント揺れ: 床(1.5)+マージン(0.5)=2.0 を超えないので確定しない
    const frames = quietThenShake(defs, { quietCount: 5, shakeCount: 5, shakeValue: 0.5 })
    const { detections } = drive(frames, meta, state)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
  })
})
