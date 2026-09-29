// 自作地震計の波形グラフを自動で出す条件の回帰テスト。
//
// 固定するのは 3 経路の or と、そのそれぞれの境界。**とくに「静穏時に出っぱなしに
// ならない」ことを対照として置く** —— 自作地震計は平常時も毎秒 1 件の震度を出し、
// その値は負にもなる（実機で `-0.04`）。震度0 の帯を通してしまうと絵が消えなくなる。

import { describe, it, expect } from 'vitest'
import { seismoWaveTriggered } from './seismoWaveTrigger'
import { NO_SCOPE, type NearbyScope } from './actionChecklistTrigger'
import type { EEWAlert } from '../types/earthquake'
import type { DetectedPoint } from './kyoshinDetectionView'

function scope(partial: Partial<NearbyScope>): NearbyScope {
  const merged = { ...NO_SCOPE, ...partial }
  return {
    ...merged,
    knownStationNames: partial.knownStationNames ?? merged.stationNames,
    knownRegionNames: partial.knownRegionNames ?? merged.regionNames,
  }
}

function eew(areas: EEWAlert['areas'], cancelled = false): EEWAlert {
  return { id: 'e1', cancelled, areas } as unknown as EEWAlert
}

/** Yahoo のインデックス → 震度: value = -3.0 + index * 0.5。index 8 で 1.0（震度1）。 */
function pt(key: string, index: number): DetectedPoint {
  return { key, lat: 35, lng: 139, index }
}

const HOME_KEY = '35.700,139.700'
const FAR_KEY = '34.700,135.500'

/** 何も起きていない状態。各テストはここから 1 つだけ動かす。 */
const QUIET = {
  scope: NO_SCOPE,
  eews: [] as readonly EEWAlert[],
  detectedPoints: [] as readonly DetectedPoint[],
  stations: [] as readonly { intensity: number | null }[],
}

describe('seismoWaveTriggered', () => {
  it('何も起きていなければ出さない', () => {
    expect(seismoWaveTriggered(QUIET)).toBe(false)
  })

  describe('自作地震計自身の震度', () => {
    it('震度1 以上なら出す', () => {
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ intensity: 0.5 }] })).toBe(true)
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ intensity: 4.2 }] })).toBe(true)
    })

    // 対照: 震度0 の帯（計測震度 0.5 未満）は平常時そのもの。ここを通すと絵が消えなくなる。
    it('震度0 では出さない', () => {
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ intensity: 0.49 }] })).toBe(false)
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ intensity: 0 }] })).toBe(false)
    })

    // 静穏時の実機はここにいる（計測震度は 2*log10(a) + 0.94 なので a < 0.34 gal で負）。
    it('負の計測震度でも出さない', () => {
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ intensity: -0.04 }] })).toBe(false)
    })

    it('震度を出せていない観測点は数えない', () => {
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ intensity: null }] })).toBe(false)
    })

    it('複数の観測点のうち 1 つでも揺れていれば出す', () => {
      expect(
        seismoWaveTriggered({ ...QUIET, stations: [{ intensity: -0.1 }, { intensity: 1.2 }] }),
      ).toBe(true)
    })
  })

  describe('EEW の有感範囲', () => {
    const NEAR = scope({ regionNames: new Set(['東京都23区']) })
    const areas = (name: string, s: number) =>
      [{ pref: '東京都', name, scaleFrom: s, scaleTo: s }] as EEWAlert['areas']

    it('自宅の区域が震度1 以上なら出す', () => {
      expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, eews: [eew(areas('東京都23区', 10))] })).toBe(true)
    })

    // 対照: 区域はあるが自宅が対象外。遠方の地震でいちいち出さない。
    it('自宅の区域が対象外なら出さない', () => {
      expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, eews: [eew(areas('静岡県中部', 60))] })).toBe(false)
    })

    // 安全弁: 取り消された報で出さない（行動チェックリストと同じ扱い）。
    it('取り消された報では出さない', () => {
      expect(
        seismoWaveTriggered({ ...QUIET, scope: NEAR, eews: [eew(areas('東京都23区', 60), true)] }),
      ).toBe(false)
    })
  })

  describe('強震モニタの検知', () => {
    const NEAR = scope({ kyoshinKeys: new Set([HOME_KEY]) })

    it('半径内の確定メンバーが震度1 以上なら出す', () => {
      expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, detectedPoints: [pt(HOME_KEY, 8)] })).toBe(true)
    })

    // 対照: 遠方だけが揺れているのは「近所は揺れていない」。
    it('半径内に確定メンバーが無ければ出さない', () => {
      expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, detectedPoints: [pt(FAR_KEY, 19)] })).toBe(false)
    })

    // 対照: 震度0 は強震モニタでも階級値が震度1 と同値（どちらも 10）。ここを通すと
    // 平常時のノイズで出っぱなしになる（`actionChecklistTrigger.ts` の `scanPoints`）。
    it('震度0 のメンバーでは出さない', () => {
      expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, detectedPoints: [pt(HOME_KEY, 6)] })).toBe(false)
    })
  })

  // 3 経路は or。どれか 1 つで足りる（行動チェックリストのように 1 つを選ぶ必要が無い）。
  it('経路をまたいで or になる', () => {
    const near = scope({ kyoshinKeys: new Set([HOME_KEY]) })
    expect(
      seismoWaveTriggered({
        ...QUIET,
        scope: near,
        stations: [{ intensity: -0.04 }],
        detectedPoints: [pt(FAR_KEY, 19)],
        eews: [eew([{ pref: '東京都', name: '東京都23区', scaleFrom: 10, scaleTo: 10 }] as EEWAlert['areas'])],
      }),
    ).toBe(true)
  })
})
