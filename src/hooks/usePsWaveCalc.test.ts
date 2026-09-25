import { describe, it, expect } from 'vitest'
import { computeEewCircle } from './usePsWaveCalc'
import type { EEWAlert } from '../types/earthquake'

function makeEEW(overrides: Partial<EEWAlert> = {}): EEWAlert {
  return {
    kind: 'eew',
    id: 'test-eew',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '以上',
      hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
    },
    severity: 'Warning',
    cancelled: false,
    ...overrides,
  }
}

// originTime から60秒後（P波・S波とも十分地表に到達している時刻）
const NOW = new Date('2026-01-01T12:01:00Z').getTime()

describe('computeEewCircle', () => {
  it('通常の EEW から円を計算する', () => {
    const circle = computeEewCircle(makeEEW(), NOW)
    expect(circle).not.toBeNull()
    expect(circle).toMatchObject({ eventId: 'test-eew', lat: 35.0, lng: 135.0, depth: 10, magnitude: 6.0 })
    expect(circle!.pRadius).toBeGreaterThan(0)
    expect(circle!.sRadius).toBeGreaterThan(0)
  })

  it('issue.eventId があればそちらを eventId に使う', () => {
    const circle = computeEewCircle(makeEEW({ issue: { eventId: 'ev-1' } }), NOW)
    expect(circle!.eventId).toBe('ev-1')
  })

  it('issue.eventId が無ければ id を eventId に使う', () => {
    const circle = computeEewCircle(makeEEW({ id: 'fallback-id', issue: undefined }), NOW)
    expect(circle!.eventId).toBe('fallback-id')
  })

  it('cancelled な EEW は null', () => {
    expect(computeEewCircle(makeEEW({ cancelled: true }), NOW)).toBeNull()
  })

  it('cancelledAt がある EEW は null', () => {
    expect(computeEewCircle(makeEEW({ cancelledAt: new Date() }), NOW)).toBeNull()
  })

  it('座標が無効（NaN）な EEW は null', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '以上',
        hypocenter: { name: 'テスト震源', latitude: NaN, longitude: 135.0, depth: 10, magnitude: 6.0 },
      },
    })
    expect(computeEewCircle(eew, NOW)).toBeNull()
  })

  it('震源名が無い仮定震源要素の EEW は null', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '以上',
        hypocenter: { name: '', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
      },
    })
    expect(computeEewCircle(eew, NOW)).toBeNull()
  })

  it('仮定震源要素の EEW は null', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '仮定震源要素',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
      },
    })
    expect(computeEewCircle(eew, NOW)).toBeNull()
  })

  it('originTime が未来（発生前）の EEW は null', () => {
    const future = new Date('2026-01-01T12:02:00Z').getTime()
    expect(computeEewCircle(makeEEW({ earthquake: { ...makeEEW().earthquake, originTime: '2026-01-01T12:05:00Z' } }), future)).toBeNull()
  })

  it('発生直後（数秒以内）は深さぶんの走時に届かず円がまだ無い', () => {
    // Arrange: 深さ 24km の震源から P 波が地表（震央）へ届くまでの走時は JMA2001 走時表で
    // 約 4.1 秒。発生から 1 秒では届いていないので円は無い（値は表が決めるので、
    // ここでは「数秒では届かない」ことだけに依存する）。
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '以上',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 24, magnitude: 7.0 },
      },
    })
    const now = new Date('2026-01-01T12:00:01Z').getTime() // 発生から1秒後

    // Act
    const circle = computeEewCircle(eew, now)

    // Assert: 円自体は返るが半径はまだ0（bounds 計算側で無視される）
    expect(circle!.pRadius).toBe(0)
    expect(circle!.sRadius).toBe(0)
  })

  // 安全弁: 位置不明のセンチネル（-200）では円を作らない。
  //
  // **`Number.isFinite(-200)` は真なので、有限性だけを見ていると素通りする。** 素通りした値は
  // `PsWaveGL` の `map.project([lng, lat])` へ渡り、MapLibre が緯度の範囲外として例外を投げる
  // （ブラウザで実測: 「Invalid LngLat latitude value: must be between -90 and 90」）。
  // **例外は MapLibre の描画ループ（rAF）の中で起きるので ErrorBoundary は届かない。**
  // `gl/guardRender.ts` が予報円 1 枚に被害を閉じ込めるが、円が出ないこと自体は防げない。
  //
  // この状態は「震源要素不明」の電文を捨てずに通すようにして初めて届くようになった
  // （→ quake-spec.md §5）。取消電文も -200 を持つが、こちらは手前の早期 return で止まる。
  it('位置不明のセンチネルでは円を作らない', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '',
        hypocenter: { name: '茨城県沖', latitude: -200, longitude: -200, depth: -1, magnitude: 6.5 },
      },
    })
    expect(computeEewCircle(eew, NOW)).toBeNull()
  })

  // 正: 震源の深さが判らない報（センチネル -1）では円を作らない。
  //
  // **`reachRadiusKm` の内部クランプに頼ると直せない。** あちらは NaN を返さない契約のため
  // `Math.max(0, depthKm)` で丸めており、呼び出し側が -1 を渡すと最も浅い地震として円が広がる。
  // 深い地震ほど外れ、深さ 100km・発生 20 秒後なら真の半径 0 に対し 65km 先まで到達済みに描く。
  it('深さが判らない報（-1）では円を作らない', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '',
        hypocenter: { name: 'ベネズエラ沿岸', latitude: 10.4, longitude: -68.4, depth: -1, magnitude: 6.5 },
      },
    })
    expect(computeEewCircle(eew, NOW)).toBeNull()
  })

  // 対照: 深さ 0 は「ごく浅い」という有効値なので、判らない場合と同じに扱わない。
  it('深さ 0（ごく浅い）では従来どおり円を作る', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 0, magnitude: 6.0 },
      },
    })
    const circle = computeEewCircle(eew, NOW)
    expect(circle).not.toBeNull()
    expect(circle!.depth).toBe(0)
    expect(circle!.sRadius).toBeGreaterThan(0)
  })

  // 安全弁: 上の null は深さだけが理由で、他の門（座標・震源名・仮定震源要素）を
  // 巻き込んでいない。同じ報の深さを有効値へ差し替えれば円は出る。
  it('深さ以外が同じなら、深さを有効値にすると円が出る', () => {
    const base = {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '',
      hypocenter: { name: 'ベネズエラ沿岸', latitude: 10.4, longitude: -68.4, magnitude: 6.5 },
    }
    const unknown = makeEEW({ earthquake: { ...base, hypocenter: { ...base.hypocenter, depth: -1 } } })
    const known = makeEEW({ earthquake: { ...base, hypocenter: { ...base.hypocenter, depth: 30 } } })
    expect(computeEewCircle(unknown, NOW)).toBeNull()
    expect(computeEewCircle(known, NOW)).not.toBeNull()
  })

  // 対照: 座標が読めない（NaN）場合も従来どおり作らない。
  it('座標が NaN でも円を作らない', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '',
        hypocenter: { name: '茨城県沖', latitude: NaN, longitude: NaN, depth: 10, magnitude: 6.5 },
      },
    })
    expect(computeEewCircle(eew, NOW)).toBeNull()
  })
})
