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
  room: [0.2, 0.2],
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
  /** 省略時は id と同じ。続報（id は変わるが同じ地震）を作るときに分ける。 */
  eventId?: string
  serial?: string
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
    issue: {
      eventId: over.eventId ?? over.id,
      serial: over.serial ?? '1',
      time: '2024-01-01T16:18:51+09:00',
    },
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

// 震源×印の差分更新キー。`eew.id` は `dmdata-eew-<eventId>-<serial>` で続報ごとに変わるため、
// そのまま使うと描画側（EewEpicentersGL）がマーカーを作り直し、点滅アニメーションが 0% から
// 始まり直す。実際の続報間隔（1 秒前後）は点滅周期（1.2 秒）より短いので、濃い側に留まった
// まま＝点滅が止まって見える。ポップアップが続報で閉じるのも同じ原因だった。
describe('useEewLayerData: eewEpicenters の差分更新キー', () => {
  // 正: 続報でキーが変わらない。
  it('同じ地震の続報では id が変わらない（報番号を含めない）', () => {
    const [first] = epicentersOf([
      makeEEW({ id: 'dmdata-eew-ev1-1', eventId: 'ev1', serial: '1', areas: [area()] }),
    ])
    const [second] = epicentersOf([
      makeEEW({ id: 'dmdata-eew-ev1-2', eventId: 'ev1', serial: '2', areas: [area()] }),
    ])
    expect(first.id).toBe('ev1')
    expect(second.id).toBe('ev1')
    // 報番号そのものは別フィールドで運ぶ（ポップアップの「第N報」表示に使う）。
    expect(first.serial).toBe('1')
    expect(second.serial).toBe('2')
  })

  // 対照: 別の地震は別のキー。ここが同じになると 2 本の EEW が 1 つのマーカーを奪い合う。
  it('別の地震は別の id になる', () => {
    const list = epicentersOf([
      makeEEW({ id: 'dmdata-eew-ev1-1', eventId: 'ev1', areas: [area()] }),
      makeEEW({ id: 'dmdata-eew-ev2-1', eventId: 'ev2', areas: [area()] }),
    ])
    expect(list).toHaveLength(2)
    expect(new Set(list.map((e) => e.id)).size).toBe(2)
  })

  // 安全弁: eventId が欠けたときのフォールバック。**実データでは通らない**
  // （DMDATA・P2PQuake・Yahoo のいずれの経路も eventId を持つ）。欠けても一意性を失わないことだけ固定する。
  it('eventId が無ければ eew.id を使う', () => {
    const base = makeEEW({ id: 'no-issue', areas: [area()] })
    const [ep] = epicentersOf([{ ...base, issue: undefined }])
    expect(ep.id).toBe('no-issue')
  })
})
