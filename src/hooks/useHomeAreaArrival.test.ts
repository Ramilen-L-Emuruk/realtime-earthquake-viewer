// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { EEWAlert, EEWRegion } from '../types/earthquake'

// 登録地点を囲む区域と、囲まない区域を 1 つずつ用意する。点内判定が効いていることを
// 「囲まない区域の値を拾わない」側でも確かめるため。
const INSIDE = {
  name: '石川県能登',
  label: [37.0, 136.9] as [number, number],
  room: [0, 0] as [number, number],
  rings: [[[36.5, 136.5], [37.5, 136.5], [37.5, 137.5], [36.5, 137.5], [36.5, 136.5]] as [number, number][]],
}
const OUTSIDE = {
  name: '東京都23区',
  label: [35.7, 139.7] as [number, number],
  room: [0, 0] as [number, number],
  rings: [[[35.5, 139.5], [35.9, 139.5], [35.9, 139.9], [35.5, 139.9], [35.5, 139.5]] as [number, number][]],
}

vi.mock('./useSubRegions', () => ({
  useSubRegions: () => ({ data: [INSIDE, OUTSIDE], failed: false }),
}))

const { useHomeAreaArrival } = await import('./useHomeAreaArrival')

const HOME = { lat: 37.0, lng: 136.9 }

function area(overrides: Partial<EEWRegion> = {}): EEWRegion {
  return {
    pref: '石川',
    name: INSIDE.name,
    scaleFrom: 40,
    scaleTo: 40,
    // **既定は「警報・未到達」。** 下 1 桁が主要動の状況なので、`11`（既に到達）を既定にすると
    // 到達予測時刻を見る経路をどのテストも踏めない（→ `utils/eewKind.ts` の表）。
    kindCode: '10',
    arrivalTime: null,
    ...overrides,
  }
}

function eew(areas: EEWRegion[]): EEWAlert {
  return {
    kind: 'eew',
    id: 'e1',
    time: '2026-01-01T00:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T00:00:00Z',
      arrivalTime: '2026-01-01T00:00:10Z',
      condition: '',
      hypocenter: { name: '能登半島沖', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    areas,
  } as EEWAlert
}

const run = (eews: EEWAlert[], home = HOME as { lat: number; lng: number } | null) =>
  renderHook(() => useHomeAreaArrival(eews, home)).result.current

describe('useHomeAreaArrival', () => {
  it('登録地点の区域について電文が出した到達予測時刻を返す（正）', () => {
    const got = run([eew([area({ arrivalTime: '2026-01-01T00:00:30Z' })])])
    expect(got).toEqual({
      areaName: INSIDE.name,
      arrivalMs: Date.parse('2026-01-01T00:00:30Z'),
      arrived: false,
    })
  })

  it('登録地点を囲まない区域の値は拾わない（対照）', () => {
    const got = run([eew([area({ name: OUTSIDE.name, arrivalTime: '2026-01-01T00:00:30Z' })])])
    expect(got).toBeNull()
  })

  it('到達済みの区域は時刻を持たなくても到達済みとして返す', () => {
    // 到達済みは種別コードの下 1 桁（01/11）でも伝わる。standard 版はそちらしか持たない。
    const got = run([eew([area({ kindCode: '11', arrivalTime: null, arrived: true })])])
    expect(got).toEqual({ areaName: INSIDE.name, arrivalMs: null, arrived: true })
  })

  it('PLUM 法の区域の時刻は採らない（安全弁）', () => {
    // あの時刻は到達の予測ではなく「その震度を初めて予測した時刻」＝過去の時刻。
    const got = run([eew([area({ kindCode: '19', arrivalTime: '2026-01-01T00:00:30Z' })])])
    expect(got).toBeNull()
  })

  it('日時として読めない時刻は捨てる（安全弁）', () => {
    // 引き算して NaN を通すと `NaN > 0` が偽なので「まもなく」側へ落ちる。
    const got = run([eew([area({ arrivalTime: 'こわれた値' })])])
    expect(got).toBeNull()
  })

  it('複数の報が同じ区域を名乗ったら、いちばん早い到達を採る', () => {
    const got = run([
      eew([area({ arrivalTime: '2026-01-01T00:00:40Z' })]),
      eew([area({ arrivalTime: '2026-01-01T00:00:25Z' })]),
    ])
    expect(got?.arrivalMs).toBe(Date.parse('2026-01-01T00:00:25Z'))
  })

  it('別の地震が未到達の予測を出していれば、到達済みより優先する（正）', () => {
    // **以前は到達済みを優先していたが覆した。** 収まりつつある地震の「到達済み」を採ると、
    // いまから揺れが来る別の地震の予測時刻が画面から消える（カードは出すか出さないかの
    // 二値なので、消えれば利用者には何も伝わらない）。→ `mergeEewAreaArrival`
    const got = run([
      eew([area({ kindCode: '11', arrived: true })]),
      eew([area({ arrivalTime: '2026-01-01T00:00:40Z' })]),
    ])
    expect(got).toEqual({
      areaName: INSIDE.name,
      arrivalMs: Date.parse('2026-01-01T00:00:40Z'),
      arrived: false,
    })
  })

  it('どの報も到達済みしか伝えていなければ到達済みを返す（対照）', () => {
    const got = run([
      eew([area({ kindCode: '11', arrived: true })]),
      eew([area({ kindCode: '01', arrived: true })]),
    ])
    expect(got).toEqual({ areaName: INSIDE.name, arrivalMs: null, arrived: true })
  })

  it('PLUM 法の報が先に来ても、後から来た予測時刻を弾かない（安全弁）', () => {
    // PLUM の区域は**過去時刻を持っている**ので、「時刻がある方を採る」と書くと先着が勝つ。
    const got = run([
      eew([area({ kindCode: '19', arrivalTime: '2026-01-01T00:00:05Z' })]),
      eew([area({ arrivalTime: '2026-01-01T00:00:40Z' })]),
    ])
    expect(got?.arrivalMs).toBe(Date.parse('2026-01-01T00:00:40Z'))
  })

  it('ホーム地点が未設定なら null', () => {
    expect(run([eew([area({ arrivalTime: '2026-01-01T00:00:30Z' })])], null)).toBeNull()
  })

  it('発表中の緊急地震速報が無ければ null', () => {
    expect(run([])).toBeNull()
  })
})
