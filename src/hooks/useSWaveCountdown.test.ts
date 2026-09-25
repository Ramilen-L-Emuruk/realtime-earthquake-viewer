// @vitest-environment jsdom
//
// 登録地点への主要動到達カウントダウンの**出どころの出し分け**のテスト。
//
// ここで固定したいのは 1 点だけ —— **トークンを持たない端末が自前の走時計算へ倒れないこと。**
// 自前計算で個別地点の到達時刻を出す行為は気象業務法第 17 条の許可を要する地震動の予報業務に
// 当たりうる（→ `docs/spec/eew-spec.md` §6）。公開版は気象庁の発表値を伝えるだけで、
// 発表値が無ければ**何も出さない**（自前計算は最後の手段にもしない）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { EEWAlert, EEWRegion } from '../types/earthquake'
import type { PsWaveCircle } from '../services/kyoshin'
import type { SubRegion } from '../utils/subregions'

const NOTO: SubRegion = {
  name: '石川県能登',
  label: [37.0, 136.9],
  room: [0, 0],
  rings: [[[37.5, 136.5], [37.5, 137.5], [36.5, 137.5], [36.5, 136.5]]],
}

vi.mock('./useSubRegions', () => ({ useSubRegions: () => ({ data: [NOTO], failed: false }) }))

// 残り秒数を決め打ちにするため、サーバー同期時刻を固定する。
const NOW = Date.parse('2024-01-01T16:19:00+09:00')
// `serverDate` も要る —— 記録の時刻印（`utils/logger.ts`）が呼ぶので、欠けると自前計算の経路だけ落ちる。
vi.mock('../utils/clock', () => ({ serverNow: () => NOW, serverDate: () => new Date(NOW) }))

const { useSWaveCountdown } = await import('./useSWaveCountdown')

const HOME = { lat: 37.0, lng: 136.9 }

function area(over: Partial<EEWRegion> = {}): EEWRegion {
  return {
    pref: '石川県',
    name: NOTO.name,
    scaleFrom: 40,
    scaleTo: 40,
    // 既定は「警報・未到達」。`11` を既定にすると到達予測時刻を見る経路を踏めない。
    kindCode: '10',
    arrivalTime: null,
    ...over,
  }
}

function eew(areas: EEWRegion[]): EEWAlert {
  return {
    kind: 'eew',
    id: 'e1',
    time: '2024-01-01T16:18:51+09:00',
    test: false,
    earthquake: {
      originTime: '2024-01-01T16:18:45+09:00',
      arrivalTime: '2024-01-01T16:18:45+09:00',
      condition: '',
      hypocenter: { name: '能登半島沖', latitude: 37.5, longitude: 137.2, depth: 20, magnitude: 6.0 },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { eventId: 'e1', serial: '1', time: '2024-01-01T16:18:51+09:00' },
    areas,
  }
}

/** 予報円は「震源が判っていて波面が地表に出ている」状態を 1 つだけ与える。 */
const CIRCLE: PsWaveCircle = {
  eventId: 'e1',
  lat: 37.5,
  lng: 137.2,
  pRadius: 90,
  sRadius: 40,
  depth: 20,
  magnitude: 6.0,
}

const run = (eews: EEWAlert[], allowOwn: boolean, waves: PsWaveCircle[] = [CIRCLE]) =>
  renderHook(() => useSWaveCountdown(waves, eews, HOME, true, allowOwn)).result.current

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useSWaveCountdown: 出どころの出し分け', () => {
  const ARRIVAL = '2024-01-01T16:19:20+09:00' // NOW から 20 秒後

  it('トークンが無ければ気象庁の発表値を区域名付きで伝える（既定）', () => {
    const got = run([eew([area({ arrivalTime: ARRIVAL })])], false)
    expect(got?.source).toBe('telegram')
    expect(got?.areaName).toBe(NOTO.name)
    expect(got?.etaSec).toBe(20)
  })

  it('トークンがあれば自前の走時計算へ切り替わる（正）', () => {
    const got = run([eew([area({ arrivalTime: ARRIVAL })])], true)
    expect(got?.source).toBe('own')
    // 地点そのものの値なので区域名は持たない（区域の値だと読まれないようにするため）。
    expect(got?.areaName).toBeNull()
  })

  it('トークンが無く発表値も無ければ何も出さない（安全弁）', () => {
    // **ここが自前計算へ倒れると、公開版が許可の要る形で動く。**
    // 予報円は与えてあるので、自前計算の材料は揃っている状態で確かめる。
    const got = run([eew([area({ arrivalTime: null })])], false)
    expect(got).toBeNull()
  })

  it('トークンが無く PLUM 法の区域しか無ければ何も出さない（安全弁）', () => {
    // PLUM の時刻は過去の時刻。発表値として使えないので、ここも自前計算へ倒さない。
    const got = run([eew([area({ kindCode: '19', arrivalTime: ARRIVAL })])], false)
    expect(got).toBeNull()
  })

  it('発表中の緊急地震速報が無ければ何も出さない', () => {
    const got = renderHook(() => useSWaveCountdown([CIRCLE], [], HOME, false, false)).result.current
    expect(got).toBeNull()
  })
})

// 「震源から N km」は**震源の緯度経度だけで決まる観測事実**で、深さとは関係が無い。
// 深さが判らない報では予報円を出さない（`computeEewCircle`。→ `docs/spec/eew-spec.md` §6）ので、
// 距離を円から拾う形のままだと**位置は判っているのに距離の行だけが消える**。
// 止めたかったのは根拠の無い秒数であって、距離ではない。
describe('useSWaveCountdown: 距離は予報円の有無に依存しない', () => {
  const ARRIVAL = '2024-01-01T16:19:20+09:00'

  // 正: 円が 1 つも無くても、発表値の経路は距離を出す。
  it('予報円が無くても発表値の経路は距離を出す', () => {
    const got = run([eew([area({ arrivalTime: ARRIVAL })])], false, [])
    expect(got?.source).toBe('telegram')
    expect(got?.distanceKm).not.toBeNull()
    // 震源（37.5, 137.2）から HOME（37.0, 136.9）まで。円がある場合と同じ値になる。
    const withCircle = run([eew([area({ arrivalTime: ARRIVAL })])], false)
    expect(got?.distanceKm).toBeCloseTo(withCircle!.distanceKm!, 6)
  })

  // 対照: 位置も判らない報（センチネル `-200`）では距離を出さない。
  // **「円が無い」を一律で救う形にしていない**ことを見る。
  it('位置が判らない報では距離を出さない', () => {
    const e = eew([area({ arrivalTime: ARRIVAL })])
    const hidden: EEWAlert = {
      ...e,
      earthquake: { ...e.earthquake, hypocenter: { ...e.earthquake.hypocenter, latitude: -200, longitude: -200 } },
    }
    const got = run([hidden], false, [])
    expect(got?.distanceKm).toBeNull()
  })

  // 安全弁: 取消済みの報は距離の候補に数えない（画面から消えたものの距離を出さない）。
  it('取消済みの報は距離の候補にしない', () => {
    const e = eew([area({ arrivalTime: ARRIVAL })])
    const got = run([{ ...e, cancelled: true }], false, [])
    expect(got?.distanceKm ?? null).toBeNull()
  })
})

// 仮定震源要素（震源未確定）は、地名も座標も「最初に揺れを捉えた観測点の所在地」であって
// 震源ではない（→ `docs/spec/eew-spec.md` §5）。**元から距離は出ていなかった** ——
// 予報円を出さないので円から拾えず null だった。上の受け皿を足したときに巻き込まないよう固定する。
describe('useSWaveCountdown: 仮定震源要素は距離の候補にしない', () => {
  const ARRIVAL = '2024-01-01T16:19:20+09:00'

  it('仮定震源要素しか無ければ距離を出さない', () => {
    const e = eew([area({ arrivalTime: ARRIVAL })])
    const assumed: EEWAlert = {
      ...e,
      earthquake: { ...e.earthquake, condition: '仮定震源要素' },
    }
    const got = run([assumed], false, [])
    expect(got?.distanceKm ?? null).toBeNull()
  })

  // 対照: 同じ報でも `condition` が空（確定震源）なら距離を出す。
  // **「円が無いと出さない」へ戻っていない**ことを見る。
  it('確定震源なら円が無くても距離を出す（対照）', () => {
    const got = run([eew([area({ arrivalTime: ARRIVAL })])], false, [])
    expect(got?.distanceKm).not.toBeNull()
  })
})
