import { describe, it, expect } from 'vitest'
import {
  dynamicRegionThresholdKm, isSameEarthquake, isRegionWithinAnyEew,
  createAlertRegionState, stepAlertRegions,
  REGION_MATCH_KM, DEFAULT_VIRTUAL_DEPTH_KM, DYNAMIC_THRESHOLD_SAFETY_FACTOR,
  OUTBREAK_PROPAGATION_WINDOW_MS, NEW_REGION_COOLDOWN_MS, NEW_REGION_MIN_INDEX,
  PROPAGATION_MAX_KM, type AlertRegion,
} from './useKyoshinAlerts'
import { computeSWaveRadiusAtTime } from './usePsWaveCalc'
import type { EEWAlert, Hypocenter } from '../types/earthquake'

function fakeRegion(overrides: Partial<AlertRegion> = {}): AlertRegion {
  return {
    lat: 37.5,
    lng: 137.0, // 能登半島付近
    fired: false,
    lastSeenAtMs: 0,
    firstSeenAtMs: 0,
    absorbedByEew: false,
    ...overrides,
  }
}

function fakeEEW(id: string, originTime: string, hypocenter: Hypocenter, condition = '以上'): EEWAlert {
  return {
    kind: 'eew',
    id,
    time: originTime,
    test: false,
    severity: 'Warning',
    cancelled: false,
    earthquake: { originTime, arrivalTime: originTime, condition, hypocenter },
  }
}

describe('dynamicRegionThresholdKm', () => {
  it('EEW無し・経過時間0なら REGION_MATCH_KM を返す', () => {
    const region = fakeRegion({ firstSeenAtMs: 1000 })
    expect(dynamicRegionThresholdKm(region, 1000, null)).toBe(REGION_MATCH_KM)
  })

  it('EEW無し・経過時間が負（時計逆行）なら REGION_MATCH_KM を返す', () => {
    const region = fakeRegion({ firstSeenAtMs: 5000 })
    expect(dynamicRegionThresholdKm(region, 1000, null)).toBe(REGION_MATCH_KM)
  })

  it('EEW無し・経過時間が十分長ければ DEFAULT_VIRTUAL_DEPTH_KM での S波半径×安全マージンまで拡大する', () => {
    const region = fakeRegion({ firstSeenAtMs: 0 })
    const nowMs = 90_000 // 90秒経過
    const expectedRadius = computeSWaveRadiusAtTime(90, DEFAULT_VIRTUAL_DEPTH_KM) * DYNAMIC_THRESHOLD_SAFETY_FACTOR
    expect(expectedRadius).toBeGreaterThan(REGION_MATCH_KM)
    expect(dynamicRegionThresholdKm(region, nowMs, null)).toBeCloseTo(expectedRadius, 5)
  })

  it('動的半径が下限を下回る場合は REGION_MATCH_KM を返す（発生直後）', () => {
    const region = fakeRegion({ firstSeenAtMs: 0 })
    const nowMs = 1_000 // 発生1秒後はまだS波が広がっていない
    expect(dynamicRegionThresholdKm(region, nowMs, null)).toBe(REGION_MATCH_KM)
  })
})

describe('isSameEarthquake', () => {
  it('EEW無し・下限距離(REGION_MATCH_KM)以内なら同一地震とみなす', () => {
    const region = fakeRegion({ lat: 37.5, lng: 137.0, firstSeenAtMs: 0 })
    // 300km未満の近傍点
    expect(isSameEarthquake(region, 38.0, 137.5, 1000, new Map())).toBe(true)
  })

  it('EEW無し・下限距離を超えていれば別地震とみなす', () => {
    const region = fakeRegion({ lat: 37.5, lng: 137.0, firstSeenAtMs: 0 })
    // 沖縄あたり、能登から1000km超
    expect(isSameEarthquake(region, 26.0, 127.7, 1000, new Map())).toBe(false)
  })

  it('EEW があり、region・新規点の両方がその動的閾値内なら同一地震とみなす', () => {
    const region = fakeRegion({ lat: 37.5, lng: 137.0, firstSeenAtMs: 0 })
    const originTime = '2024-01-01T00:00:00.000Z'
    const hypocenter: Hypocenter = { name: '石川県能登地方', latitude: 37.5, longitude: 137.0, depth: 10, magnitude: 7.6 }
    const eew = fakeEEW('eew-1', originTime, hypocenter)
    const nowMs = new Date(originTime).getTime() + 90_000 // 発生90秒後
    // 90秒後の動的閾値(下限超)以内に収まる、能登から少し離れた点
    const radius = computeSWaveRadiusAtTime(90, 10) * DYNAMIC_THRESHOLD_SAFETY_FACTOR
    expect(radius).toBeGreaterThan(REGION_MATCH_KM)
    // 経度方向に radius の半分程度ずらした点（同一緯度なので近似的に km ≒ 度 * 111 * cos(lat)）
    const dLng = (radius * 0.8) / (111 * Math.cos((37.5 * Math.PI) / 180))
    const result = isSameEarthquake(region, 37.5, 137.0 + dLng, nowMs, new Map([[eew.id, eew]]))
    expect(result).toBe(true)
  })

  it('地理的に近いだけの、経過時間が短い別の EEW に判定を乗っ取られない', () => {
    // 2026-08-10 能登半島地震リプレイ検証で発覚した回帰: 94秒経過した遠い震源(能登)より、
    // 地理的にわずかに近いだけの19秒経過の震源(新島・神津島近海)を誤って基準にされ、
    // 動的閾値がまだ拡大しきっていないタイミングで「別地点」と誤判定された。
    const region = fakeRegion({ lat: 37.6, lng: 137.2, firstSeenAtMs: 0 }) // 能登の震源そのもの
    const notoOrigin = '2024-01-01T00:00:00.000Z'
    const notoHypo: Hypocenter = { name: '能登半島沖', latitude: 37.6, longitude: 137.2, depth: 10, magnitude: 7.6 }
    const notoEEW = fakeEEW('noto', notoOrigin, notoHypo)

    const nowMs = new Date(notoOrigin).getTime() + 94_000 // 能登発生から94秒後
    const nearbyOrigin = new Date(nowMs - 19_000).toISOString() // 新島・神津島近海は19秒前に発生
    const nearbyHypo: Hypocenter = { name: '新島・神津島近海', latitude: 34.1, longitude: 138.7, depth: 10, magnitude: 4.0 }
    const nearbyEEW = fakeEEW('nearby', nearbyOrigin, nearbyHypo)

    const activeEEWs = new Map([['noto', notoEEW], ['nearby', nearbyEEW]])
    // 近畿地方の揺れ（能登からは341km、新島・神津島近海からも341km程度の地点を模す）
    const targetLat = 34.88
    const targetLng = 135.09

    // 能登(94秒経過)の動的閾値なら十分カバーできる距離であることを前提として確認
    const notoRadius = computeSWaveRadiusAtTime(94, 10) * DYNAMIC_THRESHOLD_SAFETY_FACTOR
    const distFromNoto = Math.sqrt(
      ((targetLat - 37.6) * 111) ** 2 + ((targetLng - 137.2) * 111 * Math.cos((37.6 * Math.PI) / 180)) ** 2,
    )
    expect(distFromNoto).toBeLessThan(notoRadius)

    const result = isSameEarthquake(region, targetLat, targetLng, nowMs, activeEEWs)
    expect(result).toBe(true)
  })

  it('仮定震源要素の EEW は無視され、EEW無しの近似計算にフォールバックする', () => {
    const region = fakeRegion({ lat: 37.5, lng: 137.0, firstSeenAtMs: 0 })
    const hypocenter: Hypocenter = { name: '', latitude: 37.5, longitude: 137.0, depth: 10, magnitude: 0 }
    const eew = fakeEEW('eew-assumed', '2024-01-01T00:00:00.000Z', hypocenter, '仮定震源要素')
    // 沖縄あたり、能登から1000km超 → EEWが無視されればフォールバックで false になる
    const result = isSameEarthquake(region, 26.0, 127.7, 90_000, new Map([[eew.id, eew]]))
    expect(result).toBe(false)
  })
})

describe('isRegionWithinAnyEew', () => {
  it('EEW が無ければ false を返す', () => {
    const region = fakeRegion({ lat: 37.5, lng: 137.0 })
    expect(isRegionWithinAnyEew(region, 90_000, new Map())).toBe(false)
  })

  it('region が EEW の動的閾値内に収まっていれば true を返す（未発報地域の吸収判定に使う）', () => {
    const region = fakeRegion({ lat: 37.5, lng: 137.0 })
    const originTime = '2024-01-01T00:00:00.000Z'
    const hypocenter: Hypocenter = { name: '石川県能登地方', latitude: 37.5, longitude: 137.0, depth: 10, magnitude: 7.6 }
    const eew = fakeEEW('eew-1', originTime, hypocenter)
    const nowMs = new Date(originTime).getTime() + 90_000
    expect(isRegionWithinAnyEew(region, nowMs, new Map([[eew.id, eew]]))).toBe(true)
  })
})

// 能登(37.5,137.0) から福岡(33.6,130.4) までは約 738km。EEW が無いときの下限 300km を超えるため、
// 「地震全体の起点」を渡さない限り別地震と判定される距離関係にある。
/**
 * テストは 1 秒刻みでフレームを流すため、クールダウンの秒数がそのままフレーム数になる。
 * `NEW_REGION_COOLDOWN_MS` を 1000 の倍数でない値に変えるとここが小数になり、フレーム数として
 * 使っているループが黙って境界をずれる。値を変えるときはこの換算も見直すこと。
 */
const COOLDOWN_FRAMES = NEW_REGION_COOLDOWN_MS / 1000

const NOTO = { lat: 37.5, lng: 137.0, index: 20 }
const FUKUOKA = { lat: 33.6, lng: 130.4, index: 12 }
const OKINAWA = { lat: 26.2, lng: 127.7, index: 12 }

describe('isSameEarthquake の起点（地震全体 vs 地域自身）', () => {
  it('地域自身の起点だけでは、遅れて確定した遠方の地域を伝播として吸収できない', () => {
    const region = fakeRegion({ lat: FUKUOKA.lat, lng: FUKUOKA.lng, firstSeenAtMs: 160_000 })
    expect(isSameEarthquake(region, NOTO.lat, NOTO.lng, 165_000, new Map())).toBe(false)
  })

  it('地震全体の起点を渡せば、同じ状況を伝播として吸収する', () => {
    const region = fakeRegion({ lat: FUKUOKA.lat, lng: FUKUOKA.lng, firstSeenAtMs: 160_000 })
    expect(isSameEarthquake(region, NOTO.lat, NOTO.lng, 165_000, new Map(), 0)).toBe(true)
  })

  it('起点から OUTBREAK_PROPAGATION_WINDOW_MS を超えて経過したら地域自身の起点に戻す', () => {
    const startMs = OUTBREAK_PROPAGATION_WINDOW_MS + 160_000
    const region = fakeRegion({ lat: FUKUOKA.lat, lng: FUKUOKA.lng, firstSeenAtMs: startMs })
    expect(isSameEarthquake(region, NOTO.lat, NOTO.lng, startMs + 5_000, new Map(), 0)).toBe(false)
  })

  it('起点の窓の内側でも、PROPAGATION_MAX_KM を超える距離は伝播として吸収しない', () => {
    // 能登〜沖縄は約 1500km。起点から 250 秒（窓 5 分の内側）でも上限 800km で打ち止めになる
    const region = fakeRegion({ lat: OKINAWA.lat, lng: OKINAWA.lng, firstSeenAtMs: 240_000 })
    const nowMs = 250_000
    expect(nowMs).toBeLessThan(OUTBREAK_PROPAGATION_WINDOW_MS) // 窓超過のフォールバックではないこと
    expect(isSameEarthquake(region, NOTO.lat, NOTO.lng, nowMs, new Map(), 0)).toBe(false)
  })

  it('動的閾値は PROPAGATION_MAX_KM を超えない', () => {
    const region = fakeRegion({ firstSeenAtMs: 0 })
    expect(dynamicRegionThresholdKm(region, 600_000, null)).toBe(PROPAGATION_MAX_KM)
  })
})

describe('stepAlertRegions', () => {
  /** 進行中の検知に、遠方の地域が未発報のまま残っている状態を作る。 */
  function ongoingState(nowMs: number, farRegion: Partial<AlertRegion>) {
    const state = createAlertRegionState()
    state.anyConfirmedPrev = true
    state.regions = [
      fakeRegion({ lat: NOTO.lat, lng: NOTO.lng, fired: true, lastSeenAtMs: nowMs, firstSeenAtMs: nowMs - 60_000 }),
      fakeRegion({ lat: FUKUOKA.lat, lng: FUKUOKA.lng, fired: false, lastSeenAtMs: nowMs, firstSeenAtMs: nowMs - 10_000, ...farRegion }),
    ]
    return state
  }

  it('検知の途中から加わった遠方の地域が持続すれば、別地点として発報する', () => {
    const t = 1_000_000
    const state = createAlertRegionState()
    expect(stepAlertRegions(state, [NOTO], t, new Map())).toBeNull()               // 初検知フレーム
    expect(stepAlertRegions(state, [NOTO, FUKUOKA], t + 1000, new Map())).toBeNull() // 遠方を登録
    expect(stepAlertRegions(state, [NOTO, FUKUOKA], t + 2000, new Map())).toBeNull() // 持続 2 フレーム
    // 発報した地域自身の座標と震度を返す（通知の「推定最大震度」に使う）
    expect(stepAlertRegions(state, [NOTO, FUKUOKA], t + 3000, new Map())).toEqual(FUKUOKA)
  })

  it('震度が NEW_REGION_MIN_INDEX 未満の地域は鳴らさない（遠地へ届いた弱い揺れ）', () => {
    const t = 1_000_000
    const weakFar = { ...FUKUOKA, index: NEW_REGION_MIN_INDEX - 1 }
    const state = createAlertRegionState()
    stepAlertRegions(state, [NOTO], t, new Map())
    let fired: unknown = null
    for (let i = 1; i <= COOLDOWN_FRAMES + 5; i++) {
      fired = stepAlertRegions(state, [NOTO, weakFar], t + i * 1000, new Map()) ?? fired
    }
    expect(fired).toBeNull()
  })

  it('EEW に吸収済みと記録された地域は、EEW が解除された後も鳴らさない', () => {
    const t = 1_000_000
    const state = ongoingState(t, { absorbedByEew: true })
    let fired: unknown = null
    // EEW は解除済み（空の Map）。クールダウンを超えるフレーム数を流しても鳴らない
    for (let i = 1; i <= COOLDOWN_FRAMES + 10; i++) {
      fired = stepAlertRegions(state, [NOTO, FUKUOKA], t + i * 1000, new Map()) ?? fired
    }
    expect(fired).toBeNull()
  })

  it('吸収の記録が無ければ、同じ状況で別地点として鳴る（吸収の記録が抑制していることの対比）', () => {
    const t = 1_000_000
    const state = ongoingState(t, { absorbedByEew: false })
    expect(stepAlertRegions(state, [NOTO, FUKUOKA], t + 1000, new Map())).not.toBeNull()
  })

  it('クールダウン中は、条件を満たす別の地域があっても続けて鳴らさない', () => {
    const t = 1_000_000
    const state = ongoingState(t, { absorbedByEew: false })
    state.regions.push(
      fakeRegion({ lat: OKINAWA.lat, lng: OKINAWA.lng, fired: false, lastSeenAtMs: t, firstSeenAtMs: t - 10_000 }),
    )
    expect(stepAlertRegions(state, [NOTO, FUKUOKA, OKINAWA], t + 1000, new Map())).not.toBeNull()
    let again: unknown = null
    for (let i = 2; i <= COOLDOWN_FRAMES; i++) {
      again = stepAlertRegions(state, [NOTO, FUKUOKA, OKINAWA], t + i * 1000, new Map()) ?? again
    }
    expect(again).toBeNull()
  })

  it('クールダウンで見送った地域は、明けた後に発報する（取りこぼさない）', () => {
    const t = 1_000_000
    const state = ongoingState(t, { absorbedByEew: false })
    state.regions.push(
      fakeRegion({ lat: OKINAWA.lat, lng: OKINAWA.lng, fired: false, lastSeenAtMs: t, firstSeenAtMs: t - 10_000 }),
    )
    const first = stepAlertRegions(state, [NOTO, FUKUOKA, OKINAWA], t + 1000, new Map())
    expect(first).not.toBeNull()
    // 揺れが続いている限り、クールダウン明けにもう一方が鳴る
    let second: unknown = null
    for (let i = 2; i <= COOLDOWN_FRAMES + 2 && second == null; i++) {
      second = stepAlertRegions(state, [NOTO, FUKUOKA, OKINAWA], t + i * 1000, new Map())
    }
    expect(second).not.toBeNull()
    expect(second).not.toEqual(first)
  })

  it('EEW の伝播範囲内にある地域は、EEW が続いている間も鳴らさず吸収の記録が立つ', () => {
    const origin = '2024-01-01T07:10:00.000Z'
    const t0 = new Date(origin).getTime()
    const hypocenter: Hypocenter = { name: '石川県能登地方', latitude: NOTO.lat, longitude: NOTO.lng, depth: 10, magnitude: 7.6 }
    const eews = new Map([['eew-noto', fakeEEW('eew-noto', origin, hypocenter)]])
    const state = createAlertRegionState()
    // 発生から 170 秒後。EEW の伝播半径は上限（800km）まで育ち、福岡（約 738km）も内側に入る
    const t = t0 + 170_000
    stepAlertRegions(state, [NOTO], t, eews)
    let fired: unknown = null
    for (let i = 1; i <= COOLDOWN_FRAMES + 5; i++) {
      fired = stepAlertRegions(state, [NOTO, FUKUOKA], t + i * 1000, eews) ?? fired
    }
    expect(fired).toBeNull()
    expect(state.regions.some((r) => r.absorbedByEew)).toBe(true)
  })

  it('同一フレーム内の確定点の並び順で、できる地域の数が変わらない', () => {
    const t = 1_000_000
    const run = (shocks: { lat: number; lng: number; index: number }[]) => {
      const state = createAlertRegionState()
      stepAlertRegions(state, shocks, t, new Map())
      return state.regions.length
    }
    expect(run([NOTO, FUKUOKA, OKINAWA])).toBe(run([OKINAWA, FUKUOKA, NOTO]))
  })

  it('確定地域が無くなったら地域と起点を破棄する（次の地震で前回の残骸に合流させない）', () => {
    const t = 1_000_000
    const state = ongoingState(t, {})
    stepAlertRegions(state, [], t + 1000, new Map())
    expect(state.regions).toHaveLength(0)
    expect(state.outbreakAtMs).toBeNull()
    expect(state.anyConfirmedPrev).toBe(false)
  })

  it('データ時刻が壊れたフレームは地域を増やさずに見送る', () => {
    const t = 1_000_000
    const state = createAlertRegionState()
    stepAlertRegions(state, [NOTO], t, new Map())
    const before = state.regions.length
    for (let i = 0; i < 20; i++) {
      expect(stepAlertRegions(state, [NOTO, FUKUOKA], Number.NaN, new Map())).toBeNull()
    }
    expect(state.regions).toHaveLength(before)
  })

  it('時刻が巻き戻ったらエピソードを切り替える（リプレイのやり直しで抑制を持ち越さない）', () => {
    const t = 1_000_000
    const state = ongoingState(t, { absorbedByEew: true, fired: true })
    stepAlertRegions(state, [NOTO, FUKUOKA], t + 1000, new Map())
    expect(state.regions.length).toBeGreaterThan(0)
    // 再生をやり直して過去の時刻が来た
    stepAlertRegions(state, [NOTO], t - 600_000, new Map())
    expect(state.regions.every((r) => !r.absorbedByEew)).toBe(true)
    expect(state.lastNewRegionAtMs).toBeNull()
  })

  // --- コマ飛び（ライブで取得が遅れたときのデータ時刻のジャンプ）に対する固定 ---
  // ライブは取得が遅れると次のデータ時刻へジャンプしてコマを飛ばす（kyoshinSource.ts の
  // ライブ分岐）。リプレイは常に 1 秒ずつ進むため、この状況はリプレイでも
  // `npm run probe-kyoshin` でも再現できない。合成フレームで固定する。

  /** 福岡で 1 度発報を済ませ、沖縄が持続待ちに入った状態まで進める。 */
  function firedOnceThenPending(t: number) {
    const state = createAlertRegionState()
    stepAlertRegions(state, [NOTO], t, new Map())
    stepAlertRegions(state, [NOTO, FUKUOKA], t + 1000, new Map())
    stepAlertRegions(state, [NOTO, FUKUOKA], t + 2000, new Map())
    expect(stepAlertRegions(state, [NOTO, FUKUOKA], t + 3000, new Map())).toEqual(FUKUOKA)
    stepAlertRegions(state, [NOTO, FUKUOKA, OKINAWA], t + 4000, new Map()) // 沖縄を登録
    expect(stepAlertRegions(state, [NOTO, FUKUOKA, OKINAWA], t + 5000, new Map())).toBeNull() // 持続待ち
    return state
  }

  it('[正・クールダウン] コマ飛びでデータ時刻が進めば、フレームが 1 つしか進まなくても明ける', () => {
    const t = 1_000_000
    const state = firedOnceThenPending(t)
    // 前回発報（t+3000）からデータ時刻で 5 秒。フレーム数では 1 つしか進んでいない
    expect(stepAlertRegions(state, [NOTO, FUKUOKA, OKINAWA], t + 8000, new Map())).toEqual(OKINAWA)
  })

  it('[正・持続] コマ飛びでデータ時刻が進めば、出現フレーム数が足りなくても持続を満たす', () => {
    const t = 1_000_000
    const state = createAlertRegionState()
    stepAlertRegions(state, [NOTO], t, new Map())
    stepAlertRegions(state, [NOTO, FUKUOKA], t + 1000, new Map()) // 福岡を登録
    // 3 秒のコマ飛び。福岡が現れたのは 2 フレームだが、データ時刻では 3 秒続いている
    expect(stepAlertRegions(state, [NOTO, FUKUOKA], t + 4000, new Map())).toEqual(FUKUOKA)
  })

  it('[正・破棄猶予] コマ飛びで猶予を超えた地域は、次のフレームまで残らず破棄される', () => {
    const t = 1_000_000
    const state = createAlertRegionState()
    stepAlertRegions(state, [NOTO], t, new Map())
    stepAlertRegions(state, [NOTO, FUKUOKA], t + 1000, new Map())
    expect(state.regions).toHaveLength(2)
    // 4 秒のコマ飛び。福岡は現れないまま猶予（3 秒）を超えた
    stepAlertRegions(state, [NOTO], t + 5000, new Map())
    expect(state.regions).toHaveLength(1)
  })

  it('[正・持続] 観測が 1 フレーム欠けても、データ時刻の幅が足りれば持続を満たす', () => {
    const t = 1_000_000
    const state = createAlertRegionState()
    stepAlertRegions(state, [NOTO], t, new Map())
    stepAlertRegions(state, [NOTO, FUKUOKA], t + 1000, new Map()) // 福岡を登録（1 回目）
    stepAlertRegions(state, [NOTO], t + 2000, new Map())          // 福岡が現れない（猶予内なので残る）
    // 実観測は 2 回だけ。数えているのは回数ではなく初検知からの幅
    expect(stepAlertRegions(state, [NOTO, FUKUOKA], t + 3000, new Map())).toEqual(FUKUOKA)
  })

  it('[対照] 欠落が破棄猶予を超えたら地域は捨てられ、持続はやり直しになる', () => {
    const t = 1_000_000
    const state = createAlertRegionState()
    stepAlertRegions(state, [NOTO], t, new Map())
    stepAlertRegions(state, [NOTO, FUKUOKA], t + 1000, new Map())
    stepAlertRegions(state, [NOTO], t + 5000, new Map()) // 4 秒現れず（猶予 3 秒を超過）
    expect(state.regions).toHaveLength(1)
    // 登録し直しになるため、幅を貯め直すまで鳴らない
    expect(stepAlertRegions(state, [NOTO, FUKUOKA], t + 6000, new Map())).toBeNull()
    expect(stepAlertRegions(state, [NOTO, FUKUOKA], t + 7000, new Map())).toBeNull()
    expect(stepAlertRegions(state, [NOTO, FUKUOKA], t + 8000, new Map())).toEqual(FUKUOKA)
  })

  it('[対照] 1 秒刻みのフレームではクールダウンの境界が動かない', () => {
    const t = 1_000_000
    const state = firedOnceThenPending(t)
    expect(stepAlertRegions(state, [NOTO, FUKUOKA, OKINAWA], t + 6000, new Map())).toBeNull()  // 3 秒
    expect(stepAlertRegions(state, [NOTO, FUKUOKA, OKINAWA], t + 7000, new Map())).toBeNull()  // 4 秒
    expect(stepAlertRegions(state, [NOTO, FUKUOKA, OKINAWA], t + 8000, new Map())).toEqual(OKINAWA) // 5 秒
  })

  it('[安全弁] コマ飛びを挟んでも発報済みの記録は保たれ、同じ地域が二度鳴らない', () => {
    const t = 1_000_000
    const state = firedOnceThenPending(t)
    // 1 分のコマ飛び。現れている地域は照合されて生き延び、発報済みの印を持ち越す
    expect(stepAlertRegions(state, [NOTO, FUKUOKA], t + 60_000, new Map())).toBeNull()
    expect(state.regions.filter((r) => r.fired)).toHaveLength(2)
  })

  it('[正・破棄猶予] コマ飛びの後、現れなかった地域はデータ時刻で猶予を測って捨てられる', () => {
    const t = 1_000_000
    const state = firedOnceThenPending(t)
    expect(state.regions).toHaveLength(3) // 能登・福岡・沖縄
    // 沖縄は現れない。フレームは 1 つしか進まないが、データ時刻では 55 秒が過ぎている
    stepAlertRegions(state, [NOTO, FUKUOKA], t + 60_000, new Map())
    expect(state.regions).toHaveLength(2)
  })
})
