// @vitest-environment jsdom
//
// EEW の区域塗り（eewAreaFills）の導出のテスト。
//
// ここで見るのは 2 点だけ。
//   1. 「〜以上」の予想（上限が定まらない報）が区域まで伝わること
//   2. S波到達の推定に使う震源が、確定震源に限られていること
//
// どちらも 2024/1/1 16:18 の余震で問題になった経路。単独観測点処理の初報が
// 「石川県能登 震度4以上（M・深さは仮定値）」を持って届き、区域塗りが震度7で出ていた。
//
// React を動かすため、このファイルだけ jsdom 環境で実行する（既定の node は変えない）。
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { EEWAlert, EEWRegion } from '../types/earthquake'
import type { SubRegion } from '../utils/subregions'

const NOTO: SubRegion = {
  name: '石川県能登',
  label: [37.0, 136.9],
  dir: 'up',
  rings: [[[37.2, 136.7], [37.2, 137.1], [36.8, 137.1], [36.8, 136.7]]],
}

// 区域データの取得はこのテストの対象外なので、読み込み済みの状態に固定する。
vi.mock('./useSubRegions', () => ({
  useSubRegions: () => ({ data: [NOTO], failed: false }),
}))

const { useEewLayerData } = await import('./useEewLayerData')

function area(overrides: Partial<EEWRegion> = {}): EEWRegion {
  return { pref: '石川県', name: '石川県能登', scaleFrom: 40, scaleTo: 40, kindCode: '11', arrivalTime: null, ...overrides }
}

function makeEEW(over: {
  id: string
  condition?: string
  areas: EEWRegion[]
  magnitude?: number
  depth?: number
}): EEWAlert {
  return {
    kind: 'eew',
    id: over.id,
    time: '2024-01-01T16:18:51+09:00',
    test: false,
    earthquake: {
      originTime: '2024-01-01T16:18:45+09:00',
      arrivalTime: '2024-01-01T16:18:45+09:00',
      condition: over.condition ?? '',
      hypocenter: {
        name: '能登半島沖',
        latitude: 37.5,
        longitude: 137.2,
        depth: over.depth ?? 20,
        magnitude: over.magnitude ?? 5.8,
      },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { eventId: over.id, serial: '1', time: '2024-01-01T16:18:51+09:00' },
    areas: over.areas,
  }
}

function fillsOf(eews: EEWAlert[]) {
  return renderHook(() => useEewLayerData(eews)).result.current.eewAreaFills
}

function epicentersOf(eews: EEWAlert[]) {
  return renderHook(() => useEewLayerData(eews)).result.current.eewEpicenters
}

describe('useEewLayerData: eewAreaFills', () => {
  it('「〜以上」の予想は区域まで伝わる（色は下限の階級のまま）', () => {
    const [fill] = fillsOf([makeEEW({ id: 'a', areas: [area({ scaleToOrAbove: true })] })])
    expect(fill.scale).toBe(40)
    expect(fill.scaleOrAbove).toBe(true)
  })

  it('上限が定まっている予想では立てない（境界の手前）', () => {
    const [fill] = fillsOf([makeEEW({ id: 'a', areas: [area({ scaleTo: 45 })] })])
    expect(fill.scale).toBe(45)
    expect(fill.scaleOrAbove).toBe(false)
  })

  it('同じ区域に複数の EEW が予想を出したら高い方を採る（既存の規則）', () => {
    const [fill] = fillsOf([
      makeEEW({ id: 'a', areas: [area({ scaleTo: 40 })] }),
      makeEEW({ id: 'b', areas: [area({ scaleTo: 55 })] }),
    ])
    expect(fill.scale).toBe(55)
  })

  it('同じ階級で片方だけ「以上」なら「以上」を採る', () => {
    const [fill] = fillsOf([
      makeEEW({ id: 'a', areas: [area({ scaleTo: 45 })] }),
      makeEEW({ id: 'b', areas: [area({ scaleTo: 45, scaleToOrAbove: true })] }),
    ])
    expect(fill.scaleOrAbove).toBe(true)
  })

  // 仮定震源要素の M・深さは仮定値（実データでは M1・深さ10km 固定）。これで走時を解くと
  // 根拠のない到達秒数が出るため、震源として採らない。
  it('仮定震源要素の震源は S 波到達の根拠にしない', () => {
    const [fill] = fillsOf([
      makeEEW({ id: 'a', condition: '仮定震源要素', magnitude: 1, depth: 10, areas: [area({ scaleToOrAbove: true })] }),
    ])
    expect(fill.origin).toBeNull()
  })

  it('確定震源なら S 波到達の根拠に使う（対照）', () => {
    const [fill] = fillsOf([makeEEW({ id: 'a', areas: [area()] })])
    expect(fill.origin).not.toBeNull()
    expect(fill.origin!.depth).toBe(20)
  })

  // 実データで起きた並び。仮定震源要素の初報と確定震源の続報が同じ階級を出す局面で、
  // 先着（仮定）の null が残ると到達秒数が出せないままになる。
  it('同じ階級を先に出したのが仮定震源要素なら、確定震源の側で震源を埋める', () => {
    const [fill] = fillsOf([
      makeEEW({ id: 'a', condition: '仮定震源要素', magnitude: 1, depth: 10, areas: [area({ scaleTo: 45 })] }),
      makeEEW({ id: 'b', depth: 20, areas: [area({ scaleTo: 45 })] }),
    ])
    expect(fill.origin).not.toBeNull()
    expect(fill.origin!.depth).toBe(20)
  })

  // 震源×印のポップアップも「以上」を出す。ここの配線を取り違えても型では捕まらない
  // （どちらも同じ useMemo の中で `eewMaxScaleInfo` を分配しているだけ）。
  it('震源の予想最大震度にも「以上」が伝わる', () => {
    const [ep] = epicentersOf([makeEEW({ id: 'a', areas: [area({ scaleToOrAbove: true })] })])
    expect(ep.maxScale).toBe(40)
    expect(ep.maxScaleOrAbove).toBe(true)
  })

  it('上限が定まっている報の震源には立てない（対照）', () => {
    const [ep] = epicentersOf([makeEEW({ id: 'a', areas: [area({ scaleTo: 45 })] })])
    expect(ep.maxScale).toBe(45)
    expect(ep.maxScaleOrAbove).toBe(false)
  })

  // 安全弁: 震源の扱いを変えても、塗る階級の選び方は据え置き（仮定震源要素の予想も塗る）。
  it('仮定震源要素でも区域の塗り自体は出す', () => {
    const fills = fillsOf([
      makeEEW({ id: 'a', condition: '仮定震源要素', areas: [area({ scaleTo: 40, scaleToOrAbove: true })] }),
    ])
    expect(fills).toHaveLength(1)
    expect(fills[0].name).toBe('石川県能登')
  })
})
