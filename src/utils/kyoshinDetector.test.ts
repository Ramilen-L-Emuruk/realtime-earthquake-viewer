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
  chronicNoiseFloor,
  PARAMS,
  type DetectorState,
  type Frame,
  type StationMeta,
  type SiteState,
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

describe('step: EEW 発表中の確定緩和（§19）', () => {
  it('EEW 発表中は密な網でも CONFIRM_POINTS(5) 未満・EEW_CONFIRM_POINTS(3) で confirmed になる', () => {
    const defs = grid3x3(35.0, 139.0, 0.1) // 9点・全点相互近傍（avail=8・密度正規化の影響を受けない）
    const meta = buildStationMeta(sitesOf(defs))
    // 9点中3点だけ揺らす（EEW_CONFIRM_POINTS ちょうど）。残り6点は静穏のまま。
    const shakeIdx = new Set([0, 1, 2])
    const quiet = (t: number, eewActive: boolean): Frame => ({ ...uniformFrame(defs, t, 0), eewActive })
    const shake = (t: number, eewActive: boolean): Frame => ({
      ...frameWith(defs, t, (i) => (shakeIdx.has(i) ? 2.0 : 0)),
      eewActive,
    })

    let t = 0
    const framesEEW: Frame[] = []
    for (let i = 0; i < 5; i++, t += 1000) framesEEW.push(quiet(t, true))
    for (let i = 0; i < 4; i++, t += 1000) framesEEW.push(shake(t, true))
    const { detections: detEEW } = drive(framesEEW, meta)
    expect(detEEW.some((d) => d.confidence === 'confirmed')).toBe(true)

    t = 0
    const framesNormal: Frame[] = []
    for (let i = 0; i < 5; i++, t += 1000) framesNormal.push(quiet(t, false))
    for (let i = 0; i < 4; i++, t += 1000) framesNormal.push(shake(t, false))
    const { detections: detNormal } = drive(framesNormal, meta)
    expect(detNormal.some((d) => d.confidence === 'confirmed')).toBe(false)
  })

  it('EEW 発表中は CONFIRM_FRAMES(2) を待たず EEW_CONFIRM_FRAMES(1) で確定する', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) {
      state = step(state, { ...uniformFrame(defs, t, 0), eewActive: true }, meta).state
    }
    // 揺れ開始 1 フレーム目（EEW_CONFIRM_FRAMES=1）で confirmed になるはず
    const r = step(state, { ...uniformFrame(defs, t, 2.0), eewActive: true }, meta)
    expect(r.detections.some((d) => d.confidence === 'confirmed')).toBe(true)
  })

  it('EEW 発表中でも近傍が揃わない孤立単点は confirmed にならない（MIN_CLUSTER は緩めない）', () => {
    const defs: StationDef[] = [
      { lat: 33.0, lng: 131.0 },
      { lat: 35.0, lng: 139.0 },
      { lat: 38.0, lng: 141.0 },
      { lat: 43.0, lng: 143.0 },
      { lat: 34.0, lng: 135.0 },
    ]
    const meta = buildStationMeta(sitesOf(defs))
    const frames = quietThenShake(defs, { quietCount: 5, shakeCount: 5, shakeValue: 3.0 }).map(
      (f): Frame => ({ ...f, eewActive: true }),
    )
    const { detections } = drive(frames, meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
  })

  it('EEW 発表中でも「単点だけ確定震度・周囲は震度0」は confirmed にならない（CONFIRM_INTENSE_POINTS は緩めない）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1) // 9点・全点相互近傍
    const meta = buildStationMeta(sitesOf(defs))
    const frames: Frame[] = []
    let t = 0
    // 静穏期は value=-0.5（floor 学習後も 0.0→0.5 の立ち上がりで全点 onset させるための下準備）
    for (let i = 0; i < 5; i++, t += 1000) {
      frames.push({ ...uniformFrame(defs, t, -0.5), eewActive: true })
    }
    // 1点だけ震度1(0.5)・残り8点は震度0(0.0) で onset（茨城県北部の誤 confirmed と同型の分布）
    for (let i = 0; i < 5; i++, t += 1000) {
      frames.push({ ...frameWith(defs, t, (idx) => (idx === 0 ? 0.5 : 0.0)), eewActive: true })
    }
    const { detections } = drive(frames, meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
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

  it('疎地域（離島・過疎網）は少数点でも confirmed になる（密度正規化・改良5）', () => {
    // 本土から遠く離れた小さな観測点クラスタ（互いに近傍・avail=3）。密度正規化で 5 点未満でも確定。
    const defs: StationDef[] = [
      { lat: 28.3, lng: 129.4 },
      { lat: 28.35, lng: 129.45 },
      { lat: 28.4, lng: 129.4 },
      { lat: 28.35, lng: 129.35 },
    ]
    const meta = buildStationMeta(sitesOf(defs))
    // avail が少ない（各点 3）ことを確認
    expect(meta.avail[siteKey(28.35, 129.45)]).toBeLessThan(PARAMS.CONFIRM_POINTS)
    const frames = quietThenShake(defs, { quietCount: 5, shakeCount: 5, shakeValue: 2.0 })
    const { detections } = drive(frames, meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(true)
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

describe('step: 欠測点(missing)の扱い', () => {
  /**
   * 実データ調査（2026-07-29）で判明: Yahoo 強震モニタは観測点の約3%が index=-1（charCode 99）を
   * 恒常的に返す。Yahoo公式サイト自身も CSS で `.kyoshin_si--1{display:none}` として非表示にしており、
   * これは計測震度ではなく欠測（観測点データなし）を示す特殊値である。missing で除外しないと、
   * この値が value=-3.5 のまま扱われ、欠測から復旧した瞬間の急上昇（-3.5 → 実測値）が onset と
   * 誤認識され、近傍が同時に復旧すると誤検知（likely/confirmed）につながる（過去に記録した
   * 「全国的なデータ欠測グリッチ」と同種のリスク）。
   *
   * 下の2テストは同一シナリオを missing フラグの有無だけ変えて対照する:
   *   近傍3点が欠測相当の異常低値(index -1 = value -3.5)を静穏期間ずっと返し、その後まとめて
   *   震度2相当へ復帰する。missing なし＝バグ再現（誤検知する）／missing あり＝修正（誤検知しない）。
   */
  const ANOMALY_IDXS = [0, 1, 2] // 3×3 グリッド先頭行（相互に近傍・連結成分を作る）

  /**
   * @param useMissing 欠測点を missing:true で除外するか（false は修正前＝実測値-3.5として扱う）
   * @returns 復帰後の最終検知結果
   */
  function missingThenRecover(useMissing: boolean): ReturnType<typeof step>['detections'] {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    // 静穏期間: ANOMALY_IDXS は欠測相当(index -1)、それ以外は震度0。
    for (let i = 0; i < 8; i++, t += 1000) {
      const frame: Frame = {
        dataTimeMs: t,
        sites: sitesOf(defs),
        values: defs.map((_, j) => (ANOMALY_IDXS.includes(j) ? -1 : valueToIndex(0.0))),
        missing: useMissing ? defs.map((_, j) => ANOMALY_IDXS.includes(j)) : undefined,
      }
      state = step(state, frame, meta).state
    }
    // 復帰: ANOMALY_IDXS が一斉に震度2相当へ（missing は付けない＝復旧した実測値）。
    let detections: ReturnType<typeof step>['detections'] = []
    for (let i = 0; i < 4; i++, t += 1000) {
      const frame: Frame = {
        dataTimeMs: t,
        sites: sitesOf(defs),
        values: defs.map((_, j) => valueToIndex(ANOMALY_IDXS.includes(j) ? 2.0 : 0.0)),
      }
      const r = step(state, frame, meta)
      state = r.state
      detections = r.detections
    }
    return detections
  }

  it('欠測点(-1)を実測値として扱うと復帰時の急上昇で誤検知する（修正前バグの再現）', () => {
    const detections = missingThenRecover(false)
    expect(detections.some((d) => d.confidence === 'confirmed' || d.confidence === 'likely')).toBe(true)
  })

  it('欠測点を missing で除外すれば復帰しても誤検知しない（修正の検証）', () => {
    const detections = missingThenRecover(true)
    expect(detections.some((d) => d.confidence === 'confirmed' || d.confidence === 'likely')).toBe(false)
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

  it('近傍グラフが分断された同一地震の2パッチは1イベントに統合される（重心≤MERGE_EVENT_KM）', () => {
    // 2つの 3×3 グリッドを ~78km 離す（各パッチ内は近傍・パッチ間は R_KM 外＝別成分）→ 統合パスで1本化
    const a = grid3x3(35.0, 139.0, 0.1)
    const b = grid3x3(35.7, 139.0, 0.1)
    const defs = [...a, ...b]
    const meta = buildStationMeta(sitesOf(defs))
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

  it('likely に達したイベントは面が縮んでも LIKELY_HOLD_MS はティアを維持し経過後 weak へ落ちる', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    // 静穏 → 上段 3 点だけ震度1(value 0.5) で揺れる。密網で size3<confirm 点数=likely 止まり（confirmed 未達）。
    for (let i = 0; i < 6; i++, t += 1000) state = step(state, uniformFrame(defs, t, 0), meta).state
    const shake = (tt: number): Frame => frameWith(defs, tt, (i) => (i <= 2 ? 0.5 : 0))
    for (let i = 0; i < 4; i++, t += 1000) state = step(state, shake(t), meta).state
    expect(state.events.some((e) => e.confidence === 'likely')).toBe(true)
    expect(state.events.some((e) => e.confidence === 'confirmed')).toBe(false)

    // 面を縮小: 1 点のみ震度1継続・他 2 点は床下(value -1.0)。size<MIN_LIKELY_POINTS で spread 喪失だが
    // 最大震度は 0.5 を維持。recentOnset(TRIG_ACTIVE_MS)が抜けたあとも LIKELY_HOLD_MS の間は likely を保つ。
    const shrink = (tt: number): Frame => frameWith(defs, tt, (i) => (i === 0 ? 0.5 : i <= 2 ? -1.0 : 0))
    for (let i = 0; i < 12; i++, t += 1000) state = step(state, shrink(t), meta).state
    expect(state.events.some((e) => e.confidence === 'likely')).toBe(true)

    // LIKELY_HOLD_MS を十分超えると likely/faint でなくなる（イベントは 1 局居残りで存置＝weak）
    for (let i = 0; i < 12; i++, t += 1000) state = step(state, shrink(t), meta).state
    expect(state.events.some((e) => e.confidence === 'likely' || e.confidence === 'faint')).toBe(false)
  })

  it('揺れが続く限り onset が止まっても size は減衰せずイベントが維持される（早期消滅の回帰）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    // 震度1(value 0.5)で立ち上がった後、値を頭打ちのまま長く保持（新規 onset は数秒で止まる）。
    // TRIG_ACTIVE_MS(8s)を大きく超える 15 フレーム継続させる。
    const frames = quietThenShake(defs, { quietCount: 6, shakeCount: 15, shakeValue: 0.5 })
    const { detections } = drive(frames, meta)
    const active = detections.filter((d) => d.confidence !== 'weak')
    expect(active.length).toBe(1)
    // 揺れ継続中はメンバー数が維持される（onset 基準だと 0 に減衰していた）
    expect(active[0].lastSize).toBeGreaterThanOrEqual(PARAMS.MIN_LIKELY_POINTS)
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

describe('step: 大きな揺れ直後のノイズ床フリーズ（群発地震での感度劣化対策）', () => {
  /**
   * 2026-07-28 熊本群発地震のリプレイ検証で発見した実挙動: 本震級の揺れが収まった後もしばらく
   * 残留変動（value が levelActive の閾値を割ったり超えたりしながら緩やかに収まる）が続くと、
   * その「levelActive でない」瞬間の値が静穏点の床学習に取り込まれ続け、ノイズ床
   * （floorMean + FLOOR_SIGMA_K・floorDev）が FLOOR_CAP まで上昇してしまう。一度 FLOOR_CAP まで
   * 上がると、震度1程度の後続の弱い余震は levelActive にすらならず検知できなくなる（実データでは
   * 本震後 8 分間、震度1相当の余震 5 件が完全に無反応だった。詳細はハーネスでの熊本群発リプレイ参照）。
   * FLOOR_FREEZE_MS は、onset した点についてその後一定時間は床学習をスキップし、揺れの残響を
   * ノイズとして誤学習しないようにする。
   */
  it('onset した点は COINCIDENCE_MS を過ぎても FLOOR_FREEZE_MS の間はノイズ床を更新しない', () => {
    const defs = grid3x3(32.6, 130.7, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) state = step(state, uniformFrame(defs, t, -2.0), meta).state
    for (let i = 0; i < 4; i++, t += 1000) state = step(state, uniformFrame(defs, t, 4.0), meta).state
    expect(state.events.some((e) => e.confidence === 'confirmed')).toBe(true)

    const key = siteKey(defs[4].lat, defs[4].lng)
    const floorMeanAtOnset = state.sites[key].floorMean
    const floorDevAtOnset = state.sites[key].floorDev

    // COINCIDENCE_MS(4s) を過ぎても FLOOR_FREEZE_MS 未満の間、levelActive でない値(揺れの残響)を
    // 1 秒間隔(実運用と同じ頻度)で与え続ける。
    const untilMs = PARAMS.FLOOR_FREEZE_MS - 60_000
    while (t < untilMs) {
      t += 1000
      state = step(state, uniformFrame(defs, t, -1.0), meta).state
    }
    expect(state.sites[key].floorMean).toBeCloseTo(floorMeanAtOnset)
    expect(state.sites[key].floorDev).toBeCloseTo(floorDevAtOnset)
  })

  it('FLOOR_FREEZE_MS を過ぎれば通常どおりノイズ床の学習を再開する', () => {
    const defs = grid3x3(32.6, 130.7, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) state = step(state, uniformFrame(defs, t, -2.0), meta).state
    for (let i = 0; i < 4; i++, t += 1000) state = step(state, uniformFrame(defs, t, 4.0), meta).state

    const key = siteKey(defs[4].lat, defs[4].lng)
    const floorMeanAtOnset = state.sites[key].floorMean

    // FLOOR_FREEZE_MS を十分に超えるまで 1 秒間隔で経過させる(MAX_DT_GAP_MS 超のジャンプは
    // 不連続リセット扱いになり学習が起きないため、実運用と同じ 1 秒刻みで積み上げる)。
    const untilMs = PARAMS.FLOOR_FREEZE_MS + 60_000
    while (t < untilMs) {
      t += 1000
      state = step(state, uniformFrame(defs, t, -1.0), meta).state
    }
    expect(state.sites[key].floorMean).not.toBeCloseTo(floorMeanAtOnset)
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

describe('step: faint ティア（震度0級のコヒーレント揺れ）', () => {
  it('震度0(value 0.0)まで立ち上がる同期クラスタは faint（likely/confirmed ではない）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    // 静穏 value -0.5 → 揺れ value 0.0（震度0）。rise 0.5 で onset、最大震度は震度1未満。
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 6; i++, t += 1000) frames.push(uniformFrame(defs, t, -0.5))
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(defs, t, 0.0))
    const { detections } = drive(frames, meta)

    const faint = detections.filter((d) => d.confidence === 'faint')
    expect(faint.length).toBe(1)
    expect(faint[0].maxIntensity).toBeLessThan(PARAMS.MIN_LIKELY_INTENSITY)
    expect(detections.some((d) => d.confidence === 'confirmed' || d.confidence === 'likely')).toBe(false)
  })

  it('同じ配置でも震度1(value 0.5)まで上がれば likely 以上に昇格する', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const frames = quietThenShake(defs, { quietCount: 6, shakeCount: 5, shakeValue: 0.5 })
    const { detections } = drive(frames, meta)
    expect(detections.some((d) => d.confidence === 'confirmed' || d.confidence === 'likely')).toBe(true)
    expect(detections.some((d) => d.confidence === 'faint')).toBe(false)
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

describe('chronicNoiseFloor（震度0ドット表示専用の慢性ノイズ床）', () => {
  const site = (floorMean: number, floorDev: number): SiteState => ({
    hist: [],
    floorMean,
    floorDev,
    triggeredAtMs: null,
  })

  it('effectiveFloor と異なり下限(FLOOR_MIN=0.0)でクランプしない（静かな点はマイナスのまま）', () => {
    // 東京のような静かな観測点: floorMean が負（value -2.0 相当）でばらつきも小さい
    expect(chronicNoiseFloor(site(-2.0, 0.1))).toBeLessThan(0)
  })

  it('上限(FLOOR_CAP)はトリガー用の床と共有し頭打ちにする（実地震まで潰さない）', () => {
    // 大阪のような慢性ノイズ観測点: floorMean+3*floorDev が FLOOR_CAP を超える
    expect(chronicNoiseFloor(site(1.0, 1.0))).toBeCloseTo(PARAMS.FLOOR_CAP)
  })

  it('学習前（floorMean=floorDev=0）は 0 を返す', () => {
    expect(chronicNoiseFloor(site(0, 0))).toBeCloseTo(0)
  })
})
