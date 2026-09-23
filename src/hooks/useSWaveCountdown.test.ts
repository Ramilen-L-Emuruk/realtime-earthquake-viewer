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
