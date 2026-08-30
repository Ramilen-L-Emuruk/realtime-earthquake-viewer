import { describe, it, expect } from 'vitest'
import {
  step,
  initState,
  buildStationMeta,
  computeSiteKeys,
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
import { haversineKm } from './geo'

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
  // 分母は成分側に固定した（旧実装は min(|a|,|b|) で、1件目は 1.0 になっていた）。
  it('|a∩b| / |a|（分母は成分側）', () => {
    expect(memberOverlapFrac(new Set(['a', 'b', 'c']), ['a', 'b'])).toBeCloseTo(2 / 3)
    expect(memberOverlapFrac(new Set(['a', 'x']), ['a', 'y'])).toBeCloseTo(0.5)
  })
  it('小さな成分は大きなイベントへ帰属できる（分子=分母で 1.0）', () => {
    const big = Array.from({ length: 30 }, (_, i) => `p${i}`)
    expect(memberOverlapFrac(new Set(['p0']), big)).toBeCloseTo(1.0)
  })
  it('痩せたイベントは大きな成分を飲み込まない（min 分母だった頃の穴）', () => {
    const comp = new Set(Array.from({ length: 30 }, (_, i) => `q${i}`))
    // メンバー2点のうち1点だけ共通。旧実装は 1/min(30,2)=0.5 で MERGE_MEMBER_FRAC を超えていた
    expect(memberOverlapFrac(comp, ['q0', 'z'])).toBeLessThan(PARAMS.MERGE_MEMBER_FRAC)
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
// computeSiteKeys / 座標衝突（2026-08-08 天草・芦北地方 M3.1 の誤報調査で発覚）
//
// Yahoo 強震モニタの公開座標は観測点によっては小数第1位までしか精度が無く、複数の実観測点が
// 同一座標として配信されることがある（全1725点中207グループ・431点が生座標レベルで完全一致）。
// siteKey(lat,lng) だけをキーにすると後発の点が先勝ちの点を黙って上書きし、その点の実測値が
// 検知エンジンから消える。computeSiteKeys は同一座標の2件目以降に #2, #3... を付与して
// 別実体化し、buildStationMeta / step / kyoshinDetectionView.buildSiteIndex がこれを共有する。
// ============================================================

describe('computeSiteKeys', () => {
  it('座標が一意なら siteKey と同じ', () => {
    const sites: [number, number][] = [
      [35.0, 139.0],
      [36.0, 140.0],
    ]
    expect(computeSiteKeys(sites)).toEqual([siteKey(35.0, 139.0), siteKey(36.0, 140.0)])
  })
  it('同一座標が複数回現れたら出現順に #2, #3... を付与する', () => {
    const sites: [number, number][] = [
      [32.2, 130.4],
      [35.0, 139.0],
      [32.2, 130.4],
      [32.2, 130.4],
    ]
    const keys = computeSiteKeys(sites)
    const base = siteKey(32.2, 130.4)
    expect(keys).toEqual([base, siteKey(35.0, 139.0), `${base}#2`, `${base}#3`])
    // 4件とも別実体（重複無し）
    expect(new Set(keys).size).toBe(4)
  })

  // キャッシュ（観測点リストの配列そのものを鍵にする WeakMap）。
  // **効いていることと、効きすぎないことの両方を固定する。** 効かなければ全1725点ぶんの
  // 文字列を毎秒組み直す元の負荷に戻り、効きすぎれば（＝内容が変わったのに同じ配列を返せば）
  // 座標とキーの対応が静かにずれる。どちらも例外を出さないので、テストでしか気づけない。
  it('同じ配列を渡したら組み直さず同じ結果を返す', () => {
    const sites: [number, number][] = [
      [35.0, 139.0],
      [36.0, 140.0],
    ]
    expect(computeSiteKeys(sites)).toBe(computeSiteKeys(sites))
  })

  it('別の配列なら中身が同じでも作り直す（差し替えを取りこぼさない）', () => {
    const a: [number, number][] = [[35.0, 139.0]]
    const b: [number, number][] = [[35.0, 139.0]]
    const ka = computeSiteKeys(a)
    const kb = computeSiteKeys(b)
    expect(kb).not.toBe(ka)
    expect(kb).toEqual(ka)
  })

  it('観測点リストが差し替わったら新しい内容のキーを返す', () => {
    const before: [number, number][] = [[35.0, 139.0]]
    const after: [number, number][] = [[40.0, 141.0]]
    expect(computeSiteKeys(before)).toEqual([siteKey(35.0, 139.0)])
    expect(computeSiteKeys(after)).toEqual([siteKey(40.0, 141.0)])
  })
})

describe('buildStationMeta: 座標衝突時も両方の点を近傍グラフに残す', () => {
  it('同一座標2点はどちらも avail/neighbors/cellOf を持つ（以前は後発が丸ごと消えていた）', () => {
    const defs = [
      ...grid3x3(35.0, 139.0, 0.1), // 周囲に9点（衝突点を近傍として拾わせる下地）
      { lat: 32.2, lng: 130.4 },
      { lat: 32.2, lng: 130.4 }, // 完全に同じ座標の別観測点
    ]
    const meta = buildStationMeta(sitesOf(defs))
    const base = siteKey(32.2, 130.4)
    expect(meta.avail[base]).toBeDefined()
    expect(meta.avail[`${base}#2`]).toBeDefined()
    expect(meta.cellOf[base]).toBe(meta.cellOf[`${base}#2`]) // 同座標なので同一セル
    // 互いを近傍として認識する（距離0）
    expect(meta.neighbors[base]).toContain(`${base}#2`)
    expect(meta.neighbors[`${base}#2`]).toContain(base)
  })
})

describe('step: 座標衝突点があってもクラスタの最大値を取りこぼさない', () => {
  it('先着点が本震を記録し後着の別観測点が静穏なままでも、confirmed の maxIntensity は本震側の値を保つ', () => {
    // 2026-08-08 18:47 天草・芦北地方 M3.1 の誤報の再現: 配列順で先の点(#1)が震度3相当を記録し、
    // 同一座標の後発点(#2)は静穏(0.0)のまま。旧実装は siteKey だけで管理していたため後発点が
    // 同一フレーム内で先着点を上書きし、本震側の実測値がエンジンから丸ごと消えていた。
    const grid = grid3x3(35.0, 139.0, 0.1)
    const dupCoord = grid[8] // (35.1, 139.1)
    const defs = [...grid, { lat: dupCoord.lat, lng: dupCoord.lng }] // index 9 = 座標衝突の別観測点
    const spikeIdx = 8 // 先着（座標衝突の #1）＝本震を記録
    const quietIdx = 9 // 後発（座標衝突の #2）＝ずっと静穏

    const frames: Frame[] = []
    let t = 0
    for (let n = 0; n < 6; n++, t += 1000) {
      frames.push(frameWith(defs, t, () => 0.0))
    }
    for (let n = 0; n < 5; n++, t += 1000) {
      frames.push(
        frameWith(defs, t, (i) => {
          if (i === quietIdx) return 0.0 // 座標衝突の相手はずっと静穏
          if (i === spikeIdx) return 2.5 // 震度3相当の実測（本震）
          return 1.0 // 周辺は震度2相当で同期して揺れる
        }),
      )
    }

    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(frames, meta)
    const confirmed = detections.find((d) => d.confidence === 'confirmed')
    expect(confirmed).toBeDefined()
    // 座標衝突で上書きされていれば周辺と同じ 1.0 止まりになる。別実体なら 2.5 まで反映される。
    expect(confirmed!.maxIntensity).toBeCloseTo(2.5)
    const dupBaseKey = siteKey(dupCoord.lat, dupCoord.lng)
    expect(confirmed!.memberKeys).toContain(dupBaseKey) // 先着（本震側）
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

describe('step: 単点強震ノイズの排除（§18・CONFIRM_INTENSE_POINTS）', () => {
  /**
   * 「連結成分は育つが、確定震度に達したのは1点だけ」というノイズ分布を作る。
   *
   * 静穏期を value=-0.5 に置くのは、揺れ期に全点を onset させるための下準備。
   * 静穏 -0.5 が続くと点別床は FLOOR_MIN(0.0) でクランプされ、震度0(0.0) でも levelActive になる。
   * そこから baseValue への立ち上がりで周囲の点も onset し、連結成分（面）が育つ
   * （既定の baseValue=0.0 なら rise 0.5 = RATE_MIN ちょうど。baseValue を上げた場合は rise が
   * RATE_MIN を上回るだけで、onset が成立することは変わらない）。intenseValue まで上げる点を
   * intenseCount 点に絞ることで、「面はあるが確定震度に達した点の数」だけを変えた対照実験ができる。
   *
   * @param defs 観測点定義
   * @param intenseCount 確定震度（intenseValue）まで上げる点数。残りは baseValue に留める
   * @param intenseValue 確定震度とみなす値（通常セルは MIN_CONFIRM_INTENSITY、慢性活性セルは CHRONIC_CONFIRM_INTENSITY）
   * @param baseValue 確定震度に達しない点の揺れ期の値
   */
  function shakeWithIntensePoints(
    defs: StationDef[],
    intenseCount: number,
    intenseValue = 0.5,
    baseValue = 0.0,
  ): Frame[] {
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(defs, t, -0.5))
    for (let i = 0; i < 5; i++, t += 1000) {
      frames.push(frameWith(defs, t, (idx) => (idx < intenseCount ? intenseValue : baseValue)))
    }
    return frames
  }

  it('「1点だけ震度1・周囲は震度0」は面が育っても confirmed にならない（茨城県北部 2026-07-27 の誤検知）', () => {
    const defs = grid3x3(36.7, 140.5, 0.1) // 9点・全点相互近傍（誤検知が起きた茨城県北部を模す）
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(shakeWithIntensePoints(defs, 1), meta)

    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
    // 点数・最大震度だけなら確定条件を満たしていたことを示す（落ちた理由が第3軸であることの確認）
    const ev = detections[0]
    expect(ev.lastSize).toBeGreaterThanOrEqual(PARAMS.CONFIRM_POINTS)
    expect(ev.maxIntensity).toBeGreaterThanOrEqual(PARAMS.MIN_CONFIRM_INTENSITY)
  })

  it('confirmed を阻まれても likely には留まる（弱い実地震を取りこぼさないため likely には課さない）', () => {
    const defs = grid3x3(36.7, 140.5, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(shakeWithIntensePoints(defs, 1), meta)

    expect(detections.some((d) => d.confidence === 'likely')).toBe(true)
  })

  it('確定震度に達した点が CONFIRM_INTENSE_POINTS(2) あれば confirmed になる（対照）', () => {
    const defs = grid3x3(36.7, 140.5, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(shakeWithIntensePoints(defs, PARAMS.CONFIRM_INTENSE_POINTS), meta)

    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(true)
  })

  /** 疎地域（離島・過疎網）。密度正規化で確定点数が下がっても第3軸は緩まないことを確かめる。 */
  const sparseDefs: StationDef[] = [
    { lat: 28.3, lng: 129.4 },
    { lat: 28.35, lng: 129.45 },
    { lat: 28.4, lng: 129.4 },
    { lat: 28.35, lng: 129.35 },
  ]

  it('疎地域でも「1点だけ震度1」は confirmed にならない（密度正規化は第3軸を緩めない）', () => {
    const meta = buildStationMeta(sitesOf(sparseDefs))
    const { detections } = drive(shakeWithIntensePoints(sparseDefs, 1), meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
  })

  it('疎地域で震度1が2点あれば confirmed になる（奄美型の実地震を取りこぼさない）', () => {
    const meta = buildStationMeta(sitesOf(sparseDefs))
    const { detections } = drive(
      shakeWithIntensePoints(sparseDefs, PARAMS.CONFIRM_INTENSE_POINTS),
      meta,
    )
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(true)
  })

  /** 慢性活性セルを作る（第2軸）。揺れ前に cellActivity を閾値超えへ書き換える。 */
  function driveChronic(defs: StationDef[], frames: Frame[]): DetectorState {
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(frames[0].dataTimeMs - 1000)
    frames.forEach((f, i) => {
      // 静穏期（前半5フレーム）を終えた時点で慢性活性セルに仕立てる
      if (i === 5) {
        for (const d of defs) state.cellActivity[meta.cellOf[siteKey(d.lat, d.lng)]] = 0.9
      }
      state = step(state, f, meta).state
    })
    return state
  }

  it('慢性活性セルでは震度2に達した点で数える（最大震度は足りても震度2が1点なら confirmed にしない）', () => {
    const defs = grid3x3(36.1, 140.3, 0.1) // 北関東型
    // 1点だけ震度2・残り8点は震度1。maxIntensity は CHRONIC_CONFIRM_INTENSITY を満たすが
    // 「震度2に達した点」は1点しかない構成。
    const state = driveChronic(
      defs,
      shakeWithIntensePoints(defs, 1, PARAMS.CHRONIC_CONFIRM_INTENSITY, PARAMS.MIN_CONFIRM_INTENSITY),
    )

    expect(state.events.some((e) => e.confidence === 'confirmed')).toBe(false)
    // 落ちた理由が第3軸であり、点数ゲートへのすり替わりでないことを確認する。
    // 実効要求点数は「慢性活性で引き上げた値」と「密度正規化した値」の小さい方なので、
    // 引き上げ後の値を満たしていれば点数ゲートは必ず通っている。
    const ev = state.events[0]
    expect(ev.lastSize).toBeGreaterThanOrEqual(PARAMS.CONFIRM_POINTS + PARAMS.CHRONIC_POINT_BUMP)
    expect(ev.maxIntensity).toBeGreaterThanOrEqual(PARAMS.CHRONIC_CONFIRM_INTENSITY)
  })

  it('慢性活性セルでも震度2が2点あれば confirmed になる（地域ガードは実地震まで潰さない）', () => {
    const defs = grid3x3(36.1, 140.3, 0.1)
    const state = driveChronic(
      defs,
      shakeWithIntensePoints(
        defs,
        PARAMS.CONFIRM_INTENSE_POINTS,
        PARAMS.CHRONIC_CONFIRM_INTENSITY,
        PARAMS.MIN_CONFIRM_INTENSITY,
      ),
    )
    expect(state.events.some((e) => e.confidence === 'confirmed')).toBe(true)
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

describe('step: 高震度 fast path（§20・§29）', () => {
  /**
   * 9点グリッドのうち3点だけを onset させて連結成分（MIN_CLUSTER=3）を作る。
   * size=3 は effectiveConfirmReq（密な網では CONFIRM_POINTS=5）に届かないため、通常経路では
   * 確定しない構成。高震度に達した点の「値」と「数」だけで結果が変わることを対照実験で確かめる。
   */
  function shakeThree(defs: StationDef[], peakValue: number, peakCount: number): Frame[] {
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(defs, t, 0))
    for (let i = 0; i < 4; i++, t += 1000) {
      // 先頭 peakCount 点を peakValue、残りの onset 要員（計3点）は震度1(0.5)、他は静穏のまま
      frames.push(frameWith(defs, t, (idx) => (idx < peakCount ? peakValue : idx < 3 ? 0.5 : 0)))
    }
    return frames
  }

  it('震度3(2.5)が2点あれば CONFIRM_POINTS(5) 未満の点数でも confirmed になる', () => {
    const defs = grid3x3(35.0, 139.0, 0.1) // 9点・全点相互近傍
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(shakeThree(defs, 2.5, 2), meta)
    const confirmed = detections.filter((d) => d.confidence === 'confirmed')
    expect(confirmed.length).toBe(1)
    // 点数ゲートを免除して確定したことの確認（通常経路なら CONFIRM_POINTS 点が要る）
    expect(confirmed[0].lastSize).toBeLessThan(PARAMS.CONFIRM_POINTS)
    expect(confirmed[0].maxIntensity).toBeCloseTo(2.5)
  })

  it('同じ点数構成でも震度2.0止まりなら confirmed にならない（HIGH_CONFIRM_INTENSITY の対照）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(shakeThree(defs, 2.0, 2), meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
  })

  it('成分が揃っていれば震度3が1点だけでも confirmed になる（HIGH_CONFIRM_POINTS=1・§29）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(shakeThree(defs, 2.5, 1), meta)
    const confirmed = detections.filter((d) => d.confidence === 'confirmed')
    expect(confirmed.length).toBe(1)
    // 点数ゲート（CONFIRM_POINTS=5）を免除して確定したことの確認
    expect(confirmed[0].lastSize).toBeLessThan(PARAMS.CONFIRM_POINTS)
    expect(confirmed[0].maxIntensity).toBeCloseTo(2.5)
  })

  it('fast path でも CONFIRM_FRAMES は免除しない（単フレームの跳ね値では確定しない）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(defs, t, 0))
    // 高震度2点は1フレームだけ出て直後に静穏へ戻る（落雷起因の瞬間ノイズを模す）
    frames.push(frameWith(defs, t, (idx) => (idx < 2 ? 2.5 : idx < 3 ? 0.5 : 0)))
    t += 1000
    for (let i = 0; i < 3; i++, t += 1000) frames.push(uniformFrame(defs, t, 0))
    const { detections } = drive(frames, meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
  })
})

describe('PARAMS: 成分点数の段階付けの不変条件（§29）', () => {
  // requiredClusterSize は if の順序に依存するため、値を動かすと分岐の意味が静かに反転しうる。
  // 型チェックでは捕まらないので、段階の前提をここで固定する。
  it('SOLO_CLUSTER_INTENSITY は HIGH_CONFIRM_INTENSITY 以上（震度の段階が逆転しない）', () => {
    expect(PARAMS.SOLO_CLUSTER_INTENSITY).toBeGreaterThanOrEqual(PARAMS.HIGH_CONFIRM_INTENSITY)
  })

  it('HIGH_CLUSTER_POINTS は MIN_CLUSTER 以下（震度が高いほど点数要求が緩む）', () => {
    expect(PARAMS.HIGH_CLUSTER_POINTS).toBeLessThanOrEqual(PARAMS.MIN_CLUSTER)
  })

  it('HIGH_CLUSTER_POINTS は 2 以上（震度3の単点は信じない・§18 の思想を維持）', () => {
    expect(PARAMS.HIGH_CLUSTER_POINTS).toBeGreaterThanOrEqual(2)
  })
})

describe('step: 成分点数の震度連動（§29）', () => {
  /**
   * 先頭 count 点だけを value にし、残りは静穏（value 0）に保つ。揺れる点が count 点しか無いので
   * L2 連結成分のサイズがそのまま count になり、`requiredClusterSize` が成分内の最大震度で点数要求を
   * 変えることの対照実験ができる。
   */
  function shakeFew(defs: StationDef[], count: number, value: number, shakeCount = 4): Frame[] {
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(defs, t, 0))
    for (let i = 0; i < shakeCount; i++, t += 1000) {
      frames.push(frameWith(defs, t, (idx) => (idx < count ? value : 0)))
    }
    return frames
  }

  it('震度4(3.5)の単点は成分1点でも confirmed になる（SOLO_CLUSTER_INTENSITY）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(shakeFew(defs, 1, 3.5), meta)
    const confirmed = detections.filter((d) => d.confidence === 'confirmed')
    expect(confirmed.length).toBe(1)
    expect(confirmed[0].lastSize).toBe(1)
    expect(confirmed[0].maxIntensity).toBeCloseTo(3.5)
  })

  it('震度3(2.5)の単点では confirmed にならない（震度4未満に単点を許さない）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(shakeFew(defs, 1, 2.5), meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
  })

  it('震度3(2.5)が2点あれば confirmed になる（HIGH_CLUSTER_POINTS）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(shakeFew(defs, 2, 2.5), meta)
    const confirmed = detections.filter((d) => d.confidence === 'confirmed')
    expect(confirmed.length).toBe(1)
    expect(confirmed[0].lastSize).toBe(2)
  })

  it('震度2(1.5)が2点ではイベントすら生まれない（MIN_CLUSTER は緩めない）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(shakeFew(defs, 2, 1.5), meta)
    expect(detections.length).toBe(0)
  })

  it('単点でも CONFIRM_FRAMES は免除しない（単フレームの跳ね値では確定しない）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(defs, t, 0))
    // 1 フレームだけ震度4に跳ねて静穏へ戻る（落雷起因の電磁誘導ノイズを模す）
    frames.push(frameWith(defs, t, (idx) => (idx === 0 ? 3.5 : 0)))
    t += 1000
    for (let i = 0; i < 3; i++, t += 1000) frames.push(uniformFrame(defs, t, 0))
    const { detections } = drive(frames, meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
  })

  it('高震度の単点は確定前 weak にとどまる（面が足りず likely/faint にはならない）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    // 揺れフレームを 1 つだけ流し、CONFIRM_FRAMES を満たす前の状態を見る
    const { detections } = drive(shakeFew(defs, 1, 3.5, 1), meta)
    expect(detections.length).toBe(1)
    expect(detections[0].confidence).toBe('weak')
  })

  /**
   * 面（`MIN_CLUSTER` 点）は成立しているが、確定震度（震度1）に達しているのは高震度の 1 点だけ、という
   * 分布を作る。静穏を value -1.0 に置くことで、companion が震度0（value 0.0）へ上がる動きを onset として
   * 拾わせている（静穏を 0 にすると companion に変化が無く onset しない）。
   */
  function shakeOneStrong(defs: StationDef[], peak: number, companion: number): Frame[] {
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(defs, t, -1.0))
    for (let i = 0; i < 4; i++, t += 1000) {
      frames.push(frameWith(defs, t, (idx) => (idx === 0 ? peak : idx < 3 ? companion : -1.0)))
    }
    return frames
  }

  it('面が成立していても「1点だけ震度3・周囲は震度0」なら confirmed にならない（§18 の防御を維持）', () => {
    // 2026-07-27 13:35 茨城県北部の誤 confirmed と構造的に同一の分布（§18）。震度のバーを 2.5 に
    // 上げただけでこれを通すと、fast path が第3ゲート `CONFIRM_INTENSE_POINTS` を迂回してしまう。
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(shakeOneStrong(defs, 2.6, 0.0), meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
  })

  it('同じ面で周囲が震度1に達していれば震度3が1点でも confirmed になる', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(shakeOneStrong(defs, 2.6, 0.5), meta)
    const confirmed = detections.filter((d) => d.confidence === 'confirmed')
    expect(confirmed.length).toBe(1)
    expect(confirmed[0].lastSize).toBeLessThan(PARAMS.CONFIRM_POINTS)
  })

  it('イベントが減衰して揺れているメンバーが居なくなった後、メンバー1点が跳ねても confirmed にならない', () => {
    // 第3ゲートを免除する条件に `lastSize`（揺れているメンバー数）を使うと、TRIG_ACTIVE_MS(8s) の
    // onset 途絶で size が 0 に落ちてから HOLD_MS でイベントが消えるまでの間、あらゆる減衰中の
    // イベントが免除対象になる。その窓でメンバーの 1 点が震度3へ跳ねると、周囲が完全に静穏でも
    // confirmed に達してしまう（§18 が塞いだ分布と同型）。判定は「今フレームに帰属した成分の点数」で
    // 行う必要がある——単点の震度3はそもそも成分にならないので、この経路は塞がる。
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) {
      state = step(state, uniformFrame(defs, t, -1.0), meta).state
    }
    // 3 点が震度0級で立ち上がり、MIN_CLUSTER を満たす弱いイベント（faint）ができる
    for (let i = 0; i < 3; i++, t += 1000) {
      state = step(state, frameWith(defs, t, (idx) => (idx < 3 ? 0.0 : -1.0)), meta).state
    }
    // onset が途絶え、揺れているメンバーが居なくなる（イベント自体は HOLD 中で生存）
    for (let i = 0; i < 10; i++, t += 1000) {
      state = step(state, frameWith(defs, t, () => -0.5), meta).state
    }
    const decayed = step(state, frameWith(defs, t, () => -0.5), meta)
    expect(decayed.detections.length).toBeGreaterThan(0) // まだ生存している
    expect(decayed.detections[0].lastSize).toBe(0) // 揺れているメンバーは居ない
    state = decayed.state
    t += 1000
    // メンバーの 1 点だけが震度3へ跳ねる（周囲は静穏のまま）
    for (let i = 0; i < 3; i++, t += 1000) {
      const r = step(state, frameWith(defs, t, (idx) => (idx === 0 ? 2.6 : -0.5)), meta)
      state = r.state
      expect(r.detections.some((d) => d.confidence === 'confirmed')).toBe(false)
    }
  })

  it('単点の震度が閾値付近で1フレーム沈むと確定が遅れる（受容した挙動）', () => {
    // 単点・2点の成分は毎フレーム requiredClusterSize を満たし直さないと成分にならないため、値が
    // 沈んだフレームでは免除が切れて confirmStreak がリセットされる。実データは 0.5 刻み・1Hz なので
    // 震度3〜4 の帯ではこの沈み込みが起こりうる。
    //
    // イベント全体に時間保持を持たせて救う実装を試したが、「免除の根拠になった小さな成分の構成点」と
    // 「免除が適用される高震度メンバー」が別人でも通る穴を作ったため撤回した（設計書§29）。実データ
    // 34 窓では保持の有無で結果が一切変わらず、効く場面が観測されなかったことも判断の材料。
    // 変更前は単点では永久に確定しなかったので、遅れても劣化ではない。
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) {
      state = step(state, uniformFrame(defs, t, -1.0), meta).state
    }
    const solo = [3.5, 3.0, 3.5, 4.0] // 震度4 → 震度3 へ沈んで戻る
    const confirmedAt: number[] = []
    for (let i = 0; i < solo.length; i++, t += 1000) {
      const r = step(state, frameWith(defs, t, (idx) => (idx === 0 ? solo[i] : -1.0)), meta)
      state = r.state
      if (r.detections.some((d) => d.confidence === 'confirmed')) confirmedAt.push(i)
    }
    // i=0 で streak=1 → i=1 の沈み込みでリセット → i=2 で streak=1 → i=3 で確定。
    // 沈み込みが無ければ i=1 で確定していた（2 フレームの遅れ）。
    expect(confirmedAt[0]).toBe(3)
  })

  it('小さな成分の直後に別メンバーが単独で跳ねても confirmed にならない（免除は今フレームの成分に閉じる）', () => {
    // イベント全体に免除の時間保持を持たせると、idx0 が付けた免除で idx1 の単独スパイクが確定して
    // しまう（§18 の「単点だけ強く・周囲は震度0」が「4 秒以内の 2 回の別々のスパイク」という形で
    // 再現する）。免除を今フレームの成分に閉じることでこの経路を塞いでいる。
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) {
      state = step(state, uniformFrame(defs, t, -1.0), meta).state
    }
    // 3 点が同時に立ち上がり、MIN_CLUSTER 経由の正規のイベントを作る（メンバーが蓄積される）
    for (let i = 0; i < 3; i++, t += 1000) {
      state = step(state, frameWith(defs, t, (idx) => (idx < 3 ? 1.0 : -1.0)), meta).state
    }
    // idx0 が震度4 へ 1 フレームだけ跳ねる。単点成分としては認められるが CONFIRM_FRAMES(2) には
    // 届かないので、この時点では確定しない
    const spike0 = step(state, frameWith(defs, t, (idx) => (idx === 0 ? 3.6 : -0.5)), meta)
    state = spike0.state
    t += 1000
    expect(spike0.detections.some((d) => d.confidence === 'confirmed')).toBe(false)
    // idx0 は静まり、代わりに別メンバー idx1 が単独で震度3 へ跳ねる。免除がイベント全体に保持されて
    // いると、idx0 が付けた免除で idx1 のスパイクが確定してしまう
    for (let i = 0; i < 3; i++, t += 1000) {
      const r = step(state, frameWith(defs, t, (idx) => (idx === 1 ? 2.6 : -0.5)), meta)
      state = r.state
      expect(r.detections.some((d) => d.confidence === 'confirmed')).toBe(false)
    }
  })

  it('震源最近傍の単点が先行する立ち上がりで、震度4到達の翌フレームに確定する', () => {
    // 能登半島地震 本震（2024-01-01 16:10）の Yahoo 実データの形。震源最近傍の 1 点が
    // 震度3→4→5→6弱 と上がる一方、隣の点（20〜30km 先）には S 波がまだ届かず静穏のままという
    // 4 秒間が実在する（実測: 16:10:13 に震度3 の時点で近傍の value は 0 / -0.5 / -1）。
    // MIN_CLUSTER(3) 据え置きでは、この 4 秒間はイベントすら生まれず検知が動かない。
    const defs = grid3x3(37.5, 137.3, 0.2)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) state = step(state, uniformFrame(defs, t, 0), meta).state
    const solo = [3.0, 4.5, 5.0, 6.0] // 実データの単点 value（16:10:13〜16:10:16）
    const confirmedAt: number[] = []
    for (let i = 0; i < solo.length; i++, t += 1000) {
      const r = step(state, frameWith(defs, t, (idx) => (idx === 0 ? solo[i] : 0)), meta)
      state = r.state
      if (r.detections.some((d) => d.confidence === 'confirmed')) confirmedAt.push(i)
    }
    // i=0 は震度3 なので単点では成分にならない。i=1 で震度4 に達して成分成立＋fast path 成立、
    // CONFIRM_FRAMES(2) の連続要求により確定は i=2。
    expect(confirmedAt[0]).toBe(2)
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

  /**
   * KYO-1: 学習資産（floorMean/floorDev）を持つ点が長時間欠測を挟んで復帰した際、
   * 前回の hist を据え置くと windowRate が「N秒前の値」を「RATE_DT_MS 窓の最新」と誤認する。
   * hist を空リセットすることで、緩やかなドリフト（気温・風・センサー再較正等）が
   * 復帰直後の急上昇として検出されない。
   */
  it('KYO-1: 学習済み点が長時間欠測を挟んで緩やかに値変化しても、hist リセットで誤検知しない', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    // 学習期間: 全点が震度0で 15 秒間観測（floorMean/floorDev が育つ）
    for (let i = 0; i < 15; i++, t += 1000) {
      const frame: Frame = {
        dataTimeMs: t,
        sites: sitesOf(defs),
        values: defs.map(() => valueToIndex(0.0)),
      }
      state = step(state, frame, meta).state
    }
    // ANOMALY_IDXS が 60 秒間欠測
    for (let i = 0; i < 60; i++, t += 1000) {
      const frame: Frame = {
        dataTimeMs: t,
        sites: sitesOf(defs),
        values: defs.map((_, j) => (ANOMALY_IDXS.includes(j) ? -1 : valueToIndex(0.0))),
        missing: defs.map((_, j) => ANOMALY_IDXS.includes(j)),
      }
      state = step(state, frame, meta).state
    }
    // 復帰: 緩やかなドリフトで震度0.5 相当（RATE_DT_MS 窓では検出されない上昇量）に戻る
    let detections: ReturnType<typeof step>['detections'] = []
    for (let i = 0; i < 4; i++, t += 1000) {
      const frame: Frame = {
        dataTimeMs: t,
        sites: sitesOf(defs),
        values: defs.map((_, j) => valueToIndex(ANOMALY_IDXS.includes(j) ? 0.5 : 0.0)),
      }
      const r = step(state, frame, meta)
      state = r.state
      detections = r.detections
    }
    // 復帰値 0.5 は静穏時の床から急上昇ではなく、緩やかドリフト扱い → 誤検知は出ない
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

describe('step: ノイズ床フリーズの副作用と境界（群発地震対策の周辺）', () => {
  /**
   * 1Hz で frames 個ぶん床学習が進んだときの、EWMA の理論上の到達割合（0〜1）。
   * 床が動いた／動いていないの判定を FLOOR_TAU_MS から導出するために使う。
   */
  function learnedPull(frames: number): number {
    return 1 - Math.exp(-(frames * 1000) / PARAMS.FLOOR_TAU_MS)
  }

  /** 3x3 グリッドの一部だけを揺らし、残りは静穏値に据えたフレームを作る。 */
  function partialShake(
    defs: StationDef[],
    t: number,
    shakenIdx: number[],
    shakeValue: number,
    calmValue: number,
  ): Frame {
    return frameWith(defs, t, (i) => (shakenIdx.includes(i) ? shakeValue : calmValue))
  }

  it('onset していない観測点はフリーズの対象外で、慢性ノイズ床の学習を続ける', () => {
    const defs = grid3x3(32.6, 130.7, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    // 全点を -2.0 に揃えて床を -2.0 に確定させる
    for (let i = 0; i < 5; i++, t += 1000) state = step(state, uniformFrame(defs, t, -2.0), meta).state

    // index 0〜5 の 6 点だけ震度4級で揺れて onset する（＝フリーズ対象）。残る index 6〜8 は -1.0 に
    // 据える（実効床 0 を下回るので levelActive にならず onset しない＝フリーズ対象外）。
    // grid3x3 は緯度の小さい行から詰めるので index 0〜5 は南側 2 行・6〜8 は北側 1 行。方位に
    // 依存した読み方をしなくて済むよう、揺らす点は index で書く。
    for (let i = 0; i < 5; i++, t += 1000) {
      state = step(state, partialShake(defs, t, [0, 1, 2, 3, 4, 5], 4.0, -1.0), meta).state
    }
    // このテストに必要な前提は「揺れた点が onset したこと」だけ（フリーズは triggeredAtMs を見る）。
    // confirmed 到達を前提にすると CONFIRM_POINTS 系の調整で意図と無関係に落ちるので onset で判定する。
    expect(state.sites[siteKey(defs[0].lat, defs[0].lng)].triggeredAtMs).not.toBeNull()
    expect(state.sites[siteKey(defs[8].lat, defs[8].lng)].triggeredAtMs).toBeNull()

    // 揺れが収まり、揺れた点も -1.0 まで下がる（levelActive ではない＝本来なら床学習の対象）
    const calmFrames = 120
    for (let i = 0; i < calmFrames; i++, t += 1000) {
      state = step(state, uniformFrame(defs, t, -1.0), meta).state
    }

    // onset した点はフリーズ中なので床が動かない
    expect(state.sites[siteKey(defs[0].lat, defs[0].lng)].floorMean).toBeCloseTo(-2.0)
    // onset していない点は -1.0 を学習し続けて床が上がる。慢性的にノイジーな観測点を
    // FLOOR_CAP まで鈍くする本来の役目が、フリーズ導入後も損なわれていないことの確認。
    // 期待値は時定数から導く（FLOOR_TAU_MS を将来調整しても偽陽性で落ちないように、
    // 理論上の到達量の半分を下限にする）。床は -2.0 から -1.0 へ向かうので可動域は 1.0。
    expect(state.sites[siteKey(defs[8].lat, defs[8].lng)].floorMean).toBeGreaterThan(
      -2.0 + learnedPull(calmFrames) * 0.5,
    )
  })

  it('群発地震で onset を繰り返すと、そのたびにフリーズ起点が更新され床が守られ続ける', () => {
    const defs = grid3x3(32.6, 130.7, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    // データ時刻は必ず 1 秒ずつ厳密に進める。同じ時刻のフレームを 2 度渡すと dtMs <= 0 が
    // 不連続とみなされ、検証したい onset 時刻の更新そのものが消えてしまう。
    const feed = (v: number): void => {
      t += 1000
      state = step(state, uniformFrame(defs, t, v), meta).state
    }
    for (let i = 0; i < 5; i++) feed(-2.0)

    const key = siteKey(defs[4].lat, defs[4].lng)
    // フリーズ期間の 6 割ずつ挟むので、1 回目の onset からの経過は FLOOR_FREEZE_MS を超えるが、
    // 2 回目の onset からは超えない。起点が更新されなければ途中で学習が再開してしまう。
    const segmentMs = PARAMS.FLOOR_FREEZE_MS * 0.6

    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 5; i++) feed(4.0)
      const until = t + segmentMs
      while (t < until) feed(-1.0)
    }

    expect(state.sites[key].floorMean).toBeCloseTo(-2.0)
  })

  it('データ時刻が巻き戻ると onset 時刻を破棄し、フリーズに閉じ込められない', () => {
    const defs = grid3x3(32.6, 130.7, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) state = step(state, uniformFrame(defs, t, -2.0), meta).state
    for (let i = 0; i < 5; i++, t += 1000) state = step(state, uniformFrame(defs, t, 4.0), meta).state

    const key = siteKey(defs[4].lat, defs[4].lng)
    expect(state.sites[key].triggeredAtMs).not.toBeNull()

    // アーカイブ再生などでデータ時刻が過去へ跳ぶと dtMs <= 0 が不連続とみなされ、一過性の状態
    // （triggeredAtMs）が作り直される。これが無いと now − triggeredAtMs が負になり、
    // フリーズ条件が永久に真のままになって床学習が二度と再開しない。
    let t2 = t - 3_600_000
    state = step(state, uniformFrame(defs, t2, -1.0), meta).state
    expect(state.sites[key].triggeredAtMs).toBeNull()
    // 学習資産（床）は不連続をまたいでも引き継がれる
    expect(state.sites[key].floorMean).toBeCloseTo(-2.0)

    // 巻き戻し後も床学習が進む（フリーズが解けないままになっていない）
    const resumedFrames = 120
    for (let i = 0; i < resumedFrames; i++) {
      t2 += 1000
      state = step(state, uniformFrame(defs, t2, -1.0), meta).state
    }
    expect(state.sites[key].floorMean).toBeGreaterThan(-2.0 + learnedPull(resumedFrames) * 0.5)
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
    state.sites[k] = { hist: [], floorMean: 0.8, floorDev: 0.3, triggeredAtMs: null, lastLevelActiveAtMs: null }
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
    state.sites['a'] = { hist: [], floorMean: 0.9, floorDev: 0.4, triggeredAtMs: null, lastLevelActiveAtMs: null } // 学習済み
    state.sites['b'] = { hist: [], floorMean: 0.0, floorDev: 0.0, triggeredAtMs: null, lastLevelActiveAtMs: null } // 静穏（省略対象）
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
    lastLevelActiveAtMs: null,
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

// 表示側（kyoshinDetectionView.dropIsolatedZeroPoints）が「今まさに揺れ始めた点」と
// 「揺れが去った後の残り」を区別するために使う。窓はイベントのメンバー判定と同じ TRIG_ACTIVE_MS。
describe('step: recentOnsetKeys（直近に立ち上がった観測点）', () => {
  const defs = grid3x3(35.0, 139.0)
  const meta = buildStationMeta(sitesOf(defs))

  /** 静穏を積んでから揺らし、揺れ最終フレームの step 結果を返す。 */
  function shakeThenQuiet(quietAfter: number): ReturnType<typeof step> {
    const frames = quietThenShake(defs, { quietCount: 5, shakeCount: 2, shakeValue: 2.0 })
    let t = frames[frames.length - 1].dataTimeMs
    for (let i = 0; i < quietAfter; i++) {
      t += 1000
      frames.push(uniformFrame(defs, t, 0))
    }
    let state = initState(frames[0].dataTimeMs - 1000)
    let last: ReturnType<typeof step> | null = null
    for (const f of frames) {
      last = step(state, f, meta)
      state = last.state
    }
    return last!
  }

  it('揺れた直後は立ち上がった点を返す', () => {
    expect(shakeThenQuiet(0).recentOnsetKeys.length).toBe(defs.length)
  })

  it('TRIG_ACTIVE_MS を過ぎたら外れる', () => {
    const withinWindow = shakeThenQuiet(PARAMS.TRIG_ACTIVE_MS / 1000 - 1)
    expect(withinWindow.recentOnsetKeys.length).toBe(defs.length)
    const afterWindow = shakeThenQuiet(PARAMS.TRIG_ACTIVE_MS / 1000 + 1)
    expect(afterWindow.recentOnsetKeys).toEqual([])
  })

  it('不連続（時刻ジャンプ）で状態を作り直したフレームでは空', () => {
    const state = initState(0)
    const jumped = step(state, uniformFrame(defs, PARAMS.MAX_DT_GAP_MS + 5000, 2.0), meta)
    expect(jumped.recentOnsetKeys).toEqual([])
  })
})

// ============================================================
// 密網の連結（K 近傍が足りないと本物の揺れの面が途切れる）
//
// 2026-07-22 05:49 の福岡県筑後地方 M2.4 震度1 が K=7 で非検知だった件（設計書§17）の回帰。
// 実データそのものは持ち込めないため、取りこぼしの「仕組み」を最小構成で再現する。
// ============================================================

/** 揺れる点を経度方向に並べる間隔（度）。lat35 で約 22.8km ＝ R_KM(40km) 内で隣と繋がる。 */
const CHAIN_LNG_PITCH = 0.25
/** 各揺れる点の周りに置く静穏点の緯度オフセット（度）。1.1〜4.5km の至近距離に 8 点。 */
const CROWD_LAT_OFFSETS = [0.01, -0.01, 0.02, -0.02, 0.03, -0.03, 0.04, -0.04]

/**
 * 密な観測網に「橋渡しが必要な揺れ」を作る配置。
 *
 * 揺れる点を経度方向へ等間隔に 3 つ並べ、各点の周りに静穏点を**緯度方向だけ**に置く。
 * 緯度へ直交にずらすと、その静穏点は隣の揺れる点から見て必ず「隣の揺れる点自身より遠い」
 * （直角の分だけ距離が伸びる）ため、近傍リストの順位が
 *   1〜8 番: 自分の周りの静穏点（至近） → 9 番以降: 隣の揺れる点
 * に固定される。つまり K が 8 以下だと隣の揺れる点が近傍から溢れ、揺れの面が繋がらない。
 * 実際の福岡は、床を超えて立ち上がった点が 20〜30km 間隔で並び、その間を埋める点が
 * 震度0（床下）で脱落したため、K=7 では連結経路が断たれて非検知になった。
 */
function denseChainLayout(): { defs: StationDef[]; shakeIdx: number[] } {
  const defs: StationDef[] = []
  const shakeIdx: number[] = []
  for (let c = 0; c < 3; c++) {
    const lng = 139.0 + c * CHAIN_LNG_PITCH
    shakeIdx.push(defs.length)
    defs.push({ lat: 35.0, lng })
    for (const d of CROWD_LAT_OFFSETS) defs.push({ lat: 35.0 + d, lng })
  }
  return { defs, shakeIdx }
}

describe('buildStationMeta: 密網でも離れた点へ橋を架ける（K）', () => {
  it('至近の静穏点が 8 点あっても隣の揺れる点を近傍に含める（K=7 なら溢れる配置）', () => {
    const { defs, shakeIdx } = denseChainLayout()
    const meta = buildStationMeta(sitesOf(defs))
    const left = defs[shakeIdx[0]!]!
    const mid = defs[shakeIdx[1]!]!
    const right = defs[shakeIdx[2]!]!
    const midKey = siteKey(mid.lat, mid.lng)
    const leftKey = siteKey(left.lat, left.lng)
    const rightKey = siteKey(right.lat, right.lng)

    // 中央の点から見て「隣の揺れる点より近い点」がいくつあるか。8 点あるので K=7 では
    // 隣が近傍リストに載らず、この配置の揺れは連結できない（＝福岡の非検知の再現条件）。
    const dToLeft = haversineKm(mid.lat, mid.lng, left.lat, left.lng)
    const closer = defs.filter(
      (d) =>
        !(d.lat === mid.lat && d.lng === mid.lng) &&
        haversineKm(mid.lat, mid.lng, d.lat, d.lng) < dToLeft,
    ).length
    expect(closer).toBeGreaterThanOrEqual(8)
    expect(dToLeft).toBeLessThan(PARAMS.R_KM)

    // 現行の K なら両隣が近傍に入り、鎖状に繋がる
    expect(meta.neighbors[midKey]).toContain(leftKey)
    expect(meta.neighbors[midKey]).toContain(rightKey)
    expect(meta.neighbors[leftKey]).toContain(midKey)
    // 1 つ飛ばし（約 45km）は R_KM の外なので繋がらない＝橋は隣どうしだけ
    expect(meta.neighbors[leftKey]).not.toContain(rightKey)
  })

  it('K に余裕があっても近傍は R_KM 以内に限る（遠い点を引き込まない）', () => {
    // R_KM(40km) 内に 3 点だけの疎な配置＋約 47km 先に 1 点。K の枠は空いているが距離で切る。
    const defs: StationDef[] = [
      { lat: 35.0, lng: 139.0 },
      { lat: 35.1, lng: 139.0 },
      { lat: 35.2, lng: 139.0 },
      { lat: 35.3, lng: 139.0 },
      { lat: 35.42, lng: 139.0 },
    ]
    const meta = buildStationMeta(sitesOf(defs))
    const key = siteKey(35.0, 139.0)
    expect(haversineKm(35.0, 139.0, 35.42, 139.0)).toBeGreaterThan(PARAMS.R_KM)
    expect(meta.neighbors[key]).toHaveLength(3)
    expect(meta.neighbors[key]).not.toContain(siteKey(35.42, 139.0))
    expect(meta.avail[key]).toBe(3)
  })
})

describe('step: 密網で間隔のある揺れ（福岡型）', () => {
  /**
   * 揺れる 3 点を震度1(value 0.5)へ上げるフレーム列。
   *
   * @param neighborsRise 間を埋める静穏点も床下で一段（-1.0 → -0.5）持ち上げるか。
   *   実地震は震度0 に届かない点まで一斉に動かすので true が実データの形（§32）。
   *   false は「1 点だけが跳ね、周囲は微動だにしない」都市部の局所ノイズの形。
   * @param tailFrames 揺れの後に置く「周囲が静まったフレーム」の数（ラッチの確認用）
   */
  function chainFrames(
    defs: StationDef[],
    shake: Set<number>,
    neighborsRise: boolean,
    tailFrames = 0,
  ): Frame[] {
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 6; i++, t += 1000) {
      frames.push(frameWith(defs, t, (idx) => (shake.has(idx) ? 0 : -1.0)))
    }
    for (let i = 0; i < 4; i++, t += 1000) {
      frames.push(frameWith(defs, t, (idx) => (shake.has(idx) ? 0.5 : neighborsRise ? -0.5 : -1.0)))
    }
    // 周囲が上がりきって静まった後（上昇量が 0 になる）。ラッチが無いとここで faint へ落ちる
    for (let i = 0; i < tailFrames; i++, t += 1000) {
      frames.push(frameWith(defs, t, (idx) => (shake.has(idx) ? 0.5 : neighborsRise ? -0.5 : -1.0)))
    }
    return frames
  }

  it('20〜30km 間隔の 3 点が立ち上がり、周囲も床下で一緒に上がれば likely になる', () => {
    const { defs, shakeIdx } = denseChainLayout()
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(chainFrames(defs, new Set(shakeIdx), true), meta)

    expect(detections.some((d) => d.confidence === 'likely')).toBe(true)
    // 密な網では確定点数（CONFIRM_POINTS）に届かないので confirmed には上げない。
    // 実際の福岡も likely 止まりで、これが妥当な確信度（音は鳴らさず画面には出す）。
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
  })

  it('同じ 3 点が立ち上がっても、周囲が微動だにしなければ faint に留まる（§32・対照）', () => {
    // 立ち上がる点も連結の仕方も上のテストと同一で、違うのは「周囲が一緒に動いたか」だけ。
    // 瞬間の値の並び（震度1 が 1〜3 点・周囲は床下）では両者を区別できず、ここでしか分かれない。
    const { defs, shakeIdx } = denseChainLayout()
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(chainFrames(defs, new Set(shakeIdx), false), meta)

    expect(detections.some((d) => d.confidence === 'likely')).toBe(false)
    expect(detections.some((d) => d.confidence === 'faint')).toBe(true)
  })

  it('一度 likely に達したら、周囲が静まっても likely を保つ（候補音の鳴り直し防止のラッチ・§32）', () => {
    // 周囲の上昇は揺れの広がり方で上下する。毎フレーム判定にすると likely と faint を往復し、
    // useKyoshinAlerts が候補音の立ち上がりを何度も検出して鳴らし直す。
    const { defs, shakeIdx } = denseChainLayout()
    const meta = buildStationMeta(sitesOf(defs))
    const { detections } = drive(chainFrames(defs, new Set(shakeIdx), true, 5), meta)

    expect(detections.some((d) => d.confidence === 'likely')).toBe(true)
  })

  it('欠測から復帰した点は「上がった」と数えない（欠測グリッチで裏付けが立たない・§32 の安全弁）', () => {
    // 全国の反応局が急落復帰するグリッチでは、復帰フレームで多数の点が見かけ上そろって上昇する。
    // 周囲の同時上昇は分母から欠測点を外すため、分母が縮んだところへ復帰点が分子に入ると
    // 割合が跳ね上がりうる。実際には復帰点は hist を捨てられており上昇量を測れない（rate=null）ので
    // 数えられない。この不変条件を固定する。
    const { defs, shakeIdx } = denseChainLayout()
    const meta = buildStationMeta(sitesOf(defs))
    const shake = new Set(shakeIdx)
    const frames: Frame[] = []
    let t = 0
    // 静穏（揺れる点は 0、周囲は床下）
    for (let i = 0; i < 6; i++, t += 1000) {
      frames.push(frameWith(defs, t, (idx) => (shake.has(idx) ? 0 : -1.0)))
    }
    // 周囲だけが 2 秒間まるごと欠測する
    for (let i = 0; i < 2; i++, t += 1000) {
      frames.push({
        dataTimeMs: t,
        sites: sitesOf(defs),
        values: defs.map((_, idx) => (shake.has(idx) ? valueToIndex(0) : -1)),
        missing: defs.map((_, idx) => !shake.has(idx)),
      })
    }
    // 復帰と同時に揺れる 3 点が震度1 へ。周囲は復帰しただけで上昇量を測れない
    for (let i = 0; i < 4; i++, t += 1000) {
      frames.push(frameWith(defs, t, (idx) => (shake.has(idx) ? 0.5 : -1.0)))
    }
    const { detections } = drive(frames, meta)

    // 復帰点を「上がった」と数えていたら likely になってしまう
    expect(detections.some((d) => d.confidence === 'likely')).toBe(false)
  })

  it('周囲が動かなくても、確定の条件を満たせば confirmed になる（周囲の裏付けは likely にだけ課す・§32）', () => {
    // 7×7・間隔 0.05°（約 5.5km）。5 点が震度1 へ上がり、残り 44 点は床下で静止する。
    // 周囲の上昇率は 5/49 = 約 10% で likely のバー（NEIGHBOR_RISE_FRAC）を下回るが、
    // confirmed は点数・最大震度・確定震度到達点数だけで決まるため影響を受けない。
    const defs: StationDef[] = []
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) defs.push({ lat: 35.0 + i * 0.05, lng: 139.0 + j * 0.05 })
    const meta = buildStationMeta(sitesOf(defs))
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 6; i++, t += 1000) frames.push(uniformFrame(defs, t, -1.0))
    for (let i = 0; i < 5; i++, t += 1000) {
      frames.push(frameWith(defs, t, (idx) => (idx < PARAMS.CONFIRM_POINTS ? 0.5 : -1.0)))
    }
    const { detections } = drive(frames, meta)

    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(true)
  })

  it('網が密で全点が相互に近傍でも、立ち上がりが 2 点なら検知しない（K では救えない限界）', () => {
    // 3×3・間隔 0.1° は隣どうしが 9〜11km。立ち上がる 2 点は互いに近傍で、連結自体はしている。
    // それでも検知しないのは近傍の数が足りないからではなく「立ち上がった点数が MIN_CLUSTER に
    // 届かない」ため。つまり K をいくら増やしても救えない型の非検知（滋賀 M2.5・福島会津 M2.4）。
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const firstKey = siteKey(defs[0]!.lat, defs[0]!.lng)
    const secondKey = siteKey(defs[1]!.lat, defs[1]!.lng)
    expect(meta.neighbors[firstKey]).toContain(secondKey)

    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 6; i++, t += 1000) frames.push(uniformFrame(defs, t, 0))
    for (let i = 0; i < 4; i++, t += 1000) {
      frames.push(frameWith(defs, t, (idx) => (idx < PARAMS.MIN_CLUSTER - 1 ? 0.5 : 0)))
    }
    const { state, detections } = drive(frames, meta)

    expect(state.events).toHaveLength(0)
    expect(detections).toHaveLength(0)
  })
})

describe('step: likely/faint のティア保持（LIKELY_HOLD_MS・設計書§16）', () => {
  /** 先頭 shakeCount 点だけを value へ動かし、残りを quiet に置くフレームを作る。 */
  function partialShake(
    defs: StationDef[],
    t: number,
    value: number,
    quiet: number,
    shakeCount: number,
  ): Frame {
    return frameWith(defs, t, (idx) => (idx < shakeCount ? value : quiet))
  }

  it('faint も広がりを失った後 LIKELY_HOLD_MS は維持され、過ぎるとイベントは生きたまま weak へ落ちる', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    // 静穏 value -0.5 → 3 点だけ震度0(value 0.0)へ。震度1 未満なので faint（無音の可視化）
    for (let i = 0; i < 6; i++, t += 1000) state = step(state, uniformFrame(defs, t, -0.5), meta).state
    for (let i = 0; i < 2; i++, t += 1000) {
      state = step(state, partialShake(defs, t, 0.0, -0.5, PARAMS.MIN_CLUSTER), meta).state
    }
    expect(state.events[0]?.confidence).toBe('faint')

    // ここから 1 点だけを床下と震度0 の間で振動させ続ける。onset が続くので size>0 が保たれ
    // （＝`lastOnsetAtMs` が更新され続け）イベントは HOLD_MS では消えない。一方 onset が 1 点では
    // 広がり（MIN_CLUSTER）に届かないので、**イベントの生存とティア保持を切り離して**
    // LIKELY_HOLD_MS だけを見られる。震度0級は床＋SUSTAIN_MARGIN に届かず sustained になれない
    // （値は 0.5 刻みなので実質震度1 が必要）ため、この形でしかこの状態を作れない。
    // 2 フレームずつ床下→震度0 を繰り返す。`windowRate` の起点は「now − RATE_DT_MS(＋0.5s 許容)
    // 以前の直近サンプル」＝ now−2000 付近なので、1 秒交互では起点が同じ位相の値を拾って
    // 上昇量が 0 になり onset しない。2 フレーム周期にすると起点が必ず床下側に落ちる。
    const flicker = (tt: number, phase: number): Frame =>
      frameWith(defs, tt, (idx) => (idx === 0 && phase % 4 >= 2 ? 0.0 : -0.5))
    const samples: { dt: number; tier: string; alive: boolean }[] = []
    let spreadLostAt: number | null = null
    for (let i = 0; i < 40; i++, t += 1000) {
      state = step(state, flicker(t, i), meta).state
      const ev = state.events[0]
      if (spreadLostAt === null && ev && ev.lastSize < PARAMS.MIN_LIKELY_POINTS) spreadLostAt = t
      if (spreadLostAt !== null) {
        samples.push({ dt: t - spreadLostAt, tier: ev?.confidence ?? 'none', alive: state.events.length > 0 })
      }
    }
    const at = (dt: number) => samples.find((s) => s.dt === dt)

    // 広がりを失った直後も、その 5 秒後もまだ faint（保持が効いている）
    expect(at(0)?.tier).toBe('faint')
    expect(at(5_000)?.tier).toBe('faint')
    // 保持を過ぎれば weak へ。ただしイベント自体は生きている＝これはティア保持の期限切れであり、
    // HOLD_MS によるイベント解除ではない（両者を混同しないための対照）。
    expect(at(15_000)?.tier).toBe('weak')
    expect(at(15_000)?.alive).toBe(true)
  })

  it('likely はラッチしないので、保持中に震度0級まで弱まれば faint に下がる（confirmed との対比）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    let state = initState(-1000)
    let t = 0
    for (let i = 0; i < 6; i++, t += 1000) state = step(state, uniformFrame(defs, t, 0), meta).state
    // 3 点が震度1(0.5) → likely（密網なので確定点数には届かない）
    for (let i = 0; i < 3; i++, t += 1000) {
      state = step(state, partialShake(defs, t, 0.5, 0, PARAMS.MIN_CLUSTER), meta).state
    }
    expect(state.events[0]?.confidence).toBe('likely')
    expect(state.events[0]?.everConfirmed).toBe(false)

    // 震度0級(0.0)まで弱まったまま継続。confirmed は everConfirmed でラッチされるが
    // likely にラッチは無く、保持中のティアはその時点の最大震度で決まる。
    for (let i = 0; i < 12; i++, t += 1000) {
      state = step(state, partialShake(defs, t, 0.0, 0, PARAMS.MIN_CLUSTER), meta).state
    }
    // 12 フレーム後は面が縮み（震度0級は sustained にならず直近 onset も切れる）、
    // LIKELY_HOLD_MS の保持だけで生きている状態。ここが weak なら保持が効いていない。
    expect(state.events[0]?.lastSize).toBeLessThan(PARAMS.MIN_LIKELY_POINTS)
    expect(state.events[0]?.confidence).toBe('faint')
  })
})

describe('メンバーの刈り取り（pruneFadedMembers）', () => {
  const defs = grid3x3(35.0, 139.0)
  const meta = buildStationMeta(sitesOf(defs))
  const keys = defs.map((d) => siteKey(d.lat, d.lng))

  /**
   * 全点で揺らして confirmed にした後、点0 だけ揺れ続け残りを床下（value -1.0）へ落とし、
   * `fadeMs` だけ経過させる。`missing` を true にすると残りを欠測として送る。
   */
  function fade(fadeMs: number, opts: { missing?: boolean } = {}) {
    const frames = quietThenShake(defs, { quietCount: 5, shakeCount: 4, shakeValue: 2.0 })
    let t = frames[frames.length - 1].dataTimeMs
    for (let elapsed = 0; elapsed < fadeMs; elapsed += 1000) {
      t += 1000
      frames.push({
        dataTimeMs: t,
        sites: sitesOf(defs),
        values: defs.map((_, i) => valueToIndex(i === 0 ? 2.0 : -1.0)),
        missing: opts.missing ? defs.map((_, i) => i !== 0) : undefined,
      })
    }
    return drive(frames, meta)
  }

  it('正: levelActive を割ってから MEMBER_DROP_MS を超えた点はメンバーから外れる', () => {
    const { detections } = fade(PARAMS.MEMBER_DROP_MS + 2000)
    const e = detections.find((d) => d.confidence === 'confirmed')
    expect(e).toBeDefined()
    expect(e!.memberKeys).toEqual([keys[0]])
  })

  it('対照: 猶予の手前（MEMBER_DROP_MS 未満）では外さない', () => {
    const { detections } = fade(PARAMS.MEMBER_DROP_MS - 2000)
    const e = detections.find((d) => d.confidence === 'confirmed')
    expect(e!.memberKeys).toHaveLength(defs.length)
  })

  it('安全弁: 刈り取りは点数・最大震度を変えない（外れる点はどちらにも寄与していない）', () => {
    const before = fade(PARAMS.MEMBER_DROP_MS - 2000).detections.find(
      (d) => d.confidence === 'confirmed',
    )!
    const after = fade(PARAMS.MEMBER_DROP_MS + 2000).detections.find(
      (d) => d.confidence === 'confirmed',
    )!
    expect(before.memberKeys.length).not.toBe(after.memberKeys.length) // 刈り取りは起きている
    expect(after.lastSize).toBe(before.lastSize)
    expect(after.maxIntensity).toBeCloseTo(before.maxIntensity)
  })

  it('安全弁: 欠測では刈らない（1秒の瞬断でメンバーが落ちない）', () => {
    const { detections } = fade(PARAMS.MEMBER_DROP_MS + 2000, { missing: true })
    const e = detections.find((d) => d.confidence === 'confirmed')
    expect(e!.memberKeys).toHaveLength(defs.length)
  })

  it('安全弁: イベントが生存している間はメンバーが空にならない', () => {
    // 全点を一斉に床下へ落とすと、size は「直近 TRIG_ACTIVE_MS の onset」で数えるため onset の
    // 8 秒後まで 0 にならず、イベントはさらに HOLD_MS 生き延びる。一方メンバーの刈り取りは
    // levelActive を最後に満たした時刻から数えるので、猶予が短いと**イベントが生きているのに
    // メンバーだけ空になる**窓ができる。その窓では `deriveKyoshinView` の `detectedPoints` が
    // 空になり、地図側の `hasDetection` が false へ落ちてカメラが全国表示へ戻る
    // （CameraFollowsGL の FitToDetectionGL）。検知中に画が戻るという逆の不整合になる。
    const frames = quietThenShake(defs, { quietCount: 5, shakeCount: 4, shakeValue: 2.0 })
    let t = frames[frames.length - 1].dataTimeMs
    let state = initState(frames[0].dataTimeMs - 1000)
    for (const f of frames) state = step(state, f, meta).state
    // 全点を床下へ落として、イベントが消えるまで観察する
    const observed: { conf: number; members: number }[] = []
    for (let i = 0; i < 30; i++) {
      t += 1000
      const r = step(state, uniformFrame(defs, t, -1.0), meta)
      state = r.state
      const conf = r.detections.filter((d) => d.confidence === 'confirmed')
      if (conf.length === 0) break
      observed.push({ conf: conf.length, members: Math.max(...conf.map((d) => d.memberKeys.length)) })
    }
    expect(observed.length).toBeGreaterThan(0) // confirmed が生存する窓は存在する
    expect(observed.every((o) => o.members > 0)).toBe(true)
  })

  it('安全弁: MEMBER_DROP_MS は TRIG_ACTIVE_MS + HOLD_MS 以上', () => {
    // 下限の根拠: ある点が onset した直後に沈んだ場合、その点は onset から TRIG_ACTIVE_MS の間
    // size に寄与し続け、イベントはそこから HOLD_MS 生存する。刈り取りの猶予がこの和より短いと、
    // イベント生存中にメンバーが空になる（上のテストが落ちる）。
    expect(PARAMS.MEMBER_DROP_MS).toBeGreaterThanOrEqual(PARAMS.TRIG_ACTIVE_MS + PARAMS.HOLD_MS)
  })

  it('刈られた点が単独で震度0まで立ち上がり直しても、成分にならずメンバーに戻らない', () => {
    // 2024-01-01 能登本震の再生で観測した現象の再現: 本震から数分後、値が -0.5 で居座っていた
    // 平戸の点が量子化1段（-0.5 → 0.0）上がっただけで onset 判定になり、震度0が1点だけ
    // 地図に描かれてカメラフィットを引っ張った。メンバーから外れていれば単点・震度0では
    // requiredClusterSize(MIN_CLUSTER=3) を満たさず成分にならない。
    const frames = quietThenShake(defs, { quietCount: 5, shakeCount: 4, shakeValue: 2.0 })
    let t = frames[frames.length - 1].dataTimeMs
    const fadeFrame = (v4: number): Frame => ({
      dataTimeMs: (t += 1000),
      sites: sitesOf(defs),
      values: defs.map((_, i) => valueToIndex(i === 0 ? 2.0 : i === 4 ? v4 : -1.0)),
    })
    for (let elapsed = 0; elapsed < PARAMS.MEMBER_DROP_MS + 2000; elapsed += 1000) {
      frames.push(fadeFrame(-0.5))
    }
    const pruned = drive(frames, meta).detections.find((d) => d.confidence === 'confirmed')!
    expect(pruned.memberKeys).toEqual([keys[0]]) // 点4 は刈られている
    // 点4 が -0.5 → 0.0 へ1段上がる（rate 0.5 = RATE_MIN・levelActive も同時に成立）
    frames.push(fadeFrame(0.0), fadeFrame(0.0))
    const after = drive(frames, meta).detections.find((d) => d.confidence === 'confirmed')!
    expect(after.memberKeys).not.toContain(keys[4])
  })
})

// ============================================================
// 単点のまま居座る確定を降ろす（§33）
// ============================================================

describe('単点確定の降格', () => {
  /**
   * 1 点だけが `value` に張り付いたまま `holdSec` 秒続くフレーム列。
   * 上限に張り付いた観測点（センサー故障）の姿を合成で再現する。
   */
  function soloStuck(defs: StationDef[], value: number, holdSec: number): Frame[] {
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(defs, t, 0))
    for (let i = 0; i < holdSec; i++, t += 1000) {
      frames.push(frameWith(defs, t, (idx) => (idx === 0 ? value : 0)))
    }
    return frames
  }

  // 正: 単点のまま猶予を過ぎたら降りる
  it('単点のまま SOLO_CONFIRM_GRACE_MS を過ぎたら confirmed を降ろす', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const holdSec = PARAMS.SOLO_CONFIRM_GRACE_MS / 1000 + 5
    const { detections } = drive(soloStuck(defs, 3.5, holdSec), meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
  })

  // 対照: 猶予の手前では降りない（鳴らす条件は変えていない）
  it('猶予の手前では confirmed のまま（発報を遅らせない）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    // 確定は揺れ始めの 2 フレーム目。猶予の半分だけ持たせる
    const holdSec = PARAMS.SOLO_CONFIRM_GRACE_MS / 1000 / 2
    const { detections } = drive(soloStuck(defs, 3.5, holdSec), meta)
    const confirmed = detections.filter((d) => d.confidence === 'confirmed')
    expect(confirmed.length).toBe(1)
    expect(confirmed[0].lastSize).toBe(1)
  })

  // 対照: 遅れて周囲が続けば降りない（能登型の初動を殺さない）
  it('猶予内に 2 点目が続けば降ろさない（遅れて伝播する実地震）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(defs, t, 0))
    // 単点で確定 → 猶予の内側で 2 点目が立ち上がる → その後ずっと 2 点
    const beforeSec = PARAMS.SOLO_CONFIRM_GRACE_MS / 1000 - 5
    for (let i = 0; i < beforeSec; i++, t += 1000) frames.push(frameWith(defs, t, (idx) => (idx === 0 ? 3.5 : 0)))
    for (let i = 0; i < 15; i++, t += 1000) frames.push(frameWith(defs, t, (idx) => (idx < 2 ? 3.5 : 0)))
    const { detections } = drive(frames, meta)
    const confirmed = detections.filter((d) => d.confidence === 'confirmed')
    expect(confirmed.length).toBe(1)
    expect(confirmed[0].everMultiPoint).toBe(true)
  })

  // 安全弁: 一度でも単点でなくなれば、その後に痩せても降りない
  it('2 点になった後で単点へ痩せても降ろさない（本物の余韻を切らない）', () => {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const meta = buildStationMeta(sitesOf(defs))
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(defs, t, 0))
    // 2 点で確定 → 以後ずっと 1 点だけが張り付く
    for (let i = 0; i < 4; i++, t += 1000) frames.push(frameWith(defs, t, (idx) => (idx < 2 ? 3.5 : 0)))
    const holdSec = PARAMS.SOLO_CONFIRM_GRACE_MS / 1000 + 10
    for (let i = 0; i < holdSec; i++, t += 1000) frames.push(frameWith(defs, t, (idx) => (idx === 0 ? 3.5 : 0)))
    const { detections } = drive(frames, meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(true)
  })

  // 安全弁: 降ろした確定が下位ティアへ回り込まない
  it('降格した確定は faint / likely にも上がらない（鎖状の併合で size が伸びても）', () => {
    // 併合は「重心間 100km」で greedy に連なるため、互いに 40km 超でも 3 つ以上が 1 本化しうる。
    // size が MIN_LIKELY_POINTS に届くと spreadHeld が立ち、降ろしたはずのものが faint や
    // likely として出てくる。likely は候補音を鳴らす
    // 0.6°（約 55km）間隔。互いに R_KM(40km) の外だが、併合の重心移動を経ても
    // MERGE_EVENT_KM(100km) に収まるため 1 本化する（間隔を広げると重心が離れて併合しない）
    const chain: StationDef[] = [
      ...grid3x3(35.0, 139.0, 0.1),
      ...grid3x3(35.0, 139.6, 0.1),
      ...grid3x3(35.0, 140.2, 0.1),
    ]
    const meta = buildStationMeta(sitesOf(chain))
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(chain, t, 0))
    const holdSec = PARAMS.SOLO_CONFIRM_GRACE_MS / 1000 + 10
    // 各群の代表点だけが張り付く（互いに R_KM の外）
    for (let i = 0; i < holdSec; i++, t += 1000) {
      frames.push(frameWith(chain, t, (idx) => (idx === 0 || idx === 9 || idx === 18 ? 3.5 : 0)))
    }
    let state = initState(frames[0].dataTimeMs - 1000)
    const tiers: string[] = []
    const sizes: number[] = []
    for (const f of frames) {
      const r = step(state, f, meta)
      state = r.state
      tiers.push(r.detections[0]?.confidence ?? '-')
      sizes.push(r.detections[0]?.lastSize ?? 0)
    }
    const firstDrop = tiers.findIndex((c, i) => i > 0 && tiers[i - 1] === 'confirmed' && c !== 'confirmed')
    expect(firstDrop).toBeGreaterThan(0)
    // 併合が実際に起きて size が MIN_LIKELY_POINTS に届いていること
    // （届かないと spreadHeld が立たず、このテストが何も検証しなくなる）
    expect(sizes[firstDrop]).toBeGreaterThanOrEqual(PARAMS.MIN_LIKELY_POINTS)
    // 降りた後は weak だけ（faint / likely / confirmed のいずれも現れない）
    expect([...new Set(tiers.slice(firstDrop))]).toEqual(['weak'])
  })

  // 安全弁: 併合が走ったフレームでも復活しない
  it('併合のフレームで confirmed が付け直されない（判定は 1 箇所に集約する）', () => {
    // 確信度を書く箇所は updateEventMetrics と mergeAdjacentEvents の 2 つある。後者は
    // everConfirmed だけを見て付け直すため、判定を前者にしか置かないと、併合が走った
    // フレームだけ 1 フレーム confirmed へ跳ねる。1 フレームでも立ち上がれば検知音が鳴る
    const far: StationDef[] = [
      ...grid3x3(35.0, 139.0, 0.1),
      ...grid3x3(35.0, 139.8, 0.1), // R_KM の外・MERGE_EVENT_KM の内（併合される）
    ]
    const meta = buildStationMeta(sitesOf(far))
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(far, t, 0))
    // 片方だけで確定させ、猶予を過ぎてからもう片方を立ち上げる（そこで併合が走る）
    const graceSec = PARAMS.SOLO_CONFIRM_GRACE_MS / 1000
    for (let i = 0; i < graceSec + 5; i++, t += 1000) frames.push(frameWith(far, t, (idx) => (idx === 0 ? 3.5 : 0)))
    let state = initState(frames[0].dataTimeMs - 1000)
    const tiers: string[] = []
    for (const f of frames) {
      const r = step(state, f, meta)
      state = r.state
      tiers.push(r.detections[0]?.confidence ?? '-')
    }
    // 降りた後、離れた点が加わっても confirmed へ戻らないこと
    const firstDrop = tiers.findIndex((c, i) => i > 0 && tiers[i - 1] === 'confirmed' && c !== 'confirmed')
    expect(firstDrop).toBeGreaterThan(0)
    // 併合で 2 点目が加わるフレームを含めて、以後 confirmed が現れない
    for (let i = 0; i < 10; i++, t += 1000) frames.push(frameWith(far, t, (idx) => (idx === 0 || idx === 9 ? 3.5 : 0)))
    let s2 = initState(frames[0].dataTimeMs - 1000)
    const tiers2: string[] = []
    for (const f of frames) {
      const r = step(s2, f, meta)
      s2 = r.state
      tiers2.push(r.detections[0]?.confidence ?? '-')
    }
    const drop2 = tiers2.findIndex((c, i) => i > 0 && tiers2[i - 1] === 'confirmed' && c !== 'confirmed')
    expect(tiers2.slice(drop2)).not.toContain('confirmed')
  })

  // 安全弁: 降ろした後で明滅しない（一度降りたら戻らない）
  it('降格後に confirmed と weak を往復しない（明滅は居座りより悪い）', () => {
    // everConfirmed を書き換える実装では、降ろした直後に確定条件を満たし直して再確定し、
    // 猶予の周期で往復した。往復すると useKyoshinAlerts が確定の立ち上がりを検出し直して
    // 検知音を鳴らす。ここでは「降りたら降りたまま」であることを固定する
    const far: StationDef[] = [
      ...grid3x3(35.0, 139.0, 0.1),
      ...grid3x3(35.0, 139.8, 0.1), // 約 73km 東（R_KM の外・MERGE_EVENT_KM の内）
    ]
    const meta = buildStationMeta(sitesOf(far))
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(far, t, 0))
    // 猶予の 3 倍持たせる。往復する実装なら途中で何度も confirmed へ戻る
    const holdSec = (PARAMS.SOLO_CONFIRM_GRACE_MS / 1000) * 3
    for (let i = 0; i < holdSec; i++, t += 1000) {
      frames.push(frameWith(far, t, (idx) => (idx === 0 || idx === 9 ? 3.5 : 0)))
    }
    // 各フレームの確信度を集めて、confirmed から落ちた後に戻っていないことを見る
    let state = initState(frames[0].dataTimeMs - 1000)
    const tiers: string[] = []
    for (const f of frames) {
      const r = step(state, f, meta)
      state = r.state
      tiers.push(r.detections[0]?.confidence ?? '-')
    }
    const firstDrop = tiers.findIndex((c, i) => i > 0 && tiers[i - 1] === 'confirmed' && c !== 'confirmed')
    expect(firstDrop).toBeGreaterThan(0) // 降りていること
    expect(tiers.slice(firstDrop)).not.toContain('confirmed') // 以後戻らないこと
  })

  // 安全弁: 離れた 2 点が併合されても「単点でなくなった」とはみなさない
  it('離れた 2 点が併合されても降格を免れない（隣接性を要求する）', () => {
    // メンバーは併合（MERGE_EVENT_KM=100km）で和集合になるため、点数だけを見ると
    // 別々に張り付いた 2 点でも 2 になり、対策が丸ごと素通しになる
    const far: StationDef[] = [
      ...grid3x3(35.0, 139.0, 0.1),
      ...grid3x3(35.0, 139.8, 0.1), // 約 73km 東（R_KM=40km の外・MERGE_EVENT_KM=100km の内）
    ]
    const meta = buildStationMeta(sitesOf(far))
    const frames: Frame[] = []
    let t = 0
    for (let i = 0; i < 5; i++, t += 1000) frames.push(uniformFrame(far, t, 0))
    // 2 つの群の代表点（index 0 と 9）だけが張り付く
    const holdSec = PARAMS.SOLO_CONFIRM_GRACE_MS / 1000 + 10
    for (let i = 0; i < holdSec; i++, t += 1000) {
      frames.push(frameWith(far, t, (idx) => (idx === 0 || idx === 9 ? 3.5 : 0)))
    }
    const { detections } = drive(frames, meta)
    expect(detections.some((d) => d.confidence === 'confirmed')).toBe(false)
  })

  // 安全弁: 猶予は SOLO_DECAY_SIZE と噛み合っていること
  it('SOLO_DECAY_SIZE は MIN_CLUSTER 未満（本物の 2 点止まりを巻き込まない）', () => {
    // 実データでは size 2 で終わる本物（能登・福島の成分）が 4 件あった。MIN_CLUSTER(3) を
    // 要求すると、それらを降ろしてしまう
    expect(PARAMS.SOLO_DECAY_SIZE).toBeLessThan(PARAMS.MIN_CLUSTER)
    expect(PARAMS.SOLO_DECAY_SIZE).toBeGreaterThan(1)
  })

  // 安全弁: 猶予は確定に要する時間より十分長いこと
  it('SOLO_CONFIRM_GRACE_MS は確定に要する時間より長い（確定と同時に降ろさない）', () => {
    expect(PARAMS.SOLO_CONFIRM_GRACE_MS).toBeGreaterThan(PARAMS.CONFIRM_FRAMES * 1000)
    expect(PARAMS.SOLO_CONFIRM_GRACE_MS).toBeGreaterThan(PARAMS.HOLD_MS)
  })
})
