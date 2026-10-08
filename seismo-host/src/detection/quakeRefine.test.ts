import { describe, expect, it } from 'vitest'

import { travelTimeSec } from '../../../src/utils/travelTime'
import type { P2pReferenceQuake } from './p2pQuake'
import { arrivalSpans, refineQuake, type EewOrigin, type HypocenterRow, type RecordQuake } from './quakeRefine'

const T0 = Date.UTC(2026, 9, 1, 3, 26, 0)

function p2p(extra: Partial<P2pReferenceQuake> = {}): P2pReferenceQuake {
  return {
    originMs: T0,
    originPrecisionMs: 60_000,
    lat: 35.0,
    lon: 140.0,
    depthKm: 40,
    magnitude: 4.2,
    name: '千葉県北西部',
    maxScale: 30,
    key: `${T0}|千葉県北西部`,
    ...extra,
  }
}

function row(extra: Partial<HypocenterRow> = {}): HypocenterRow {
  return { timeMs: T0 + 12_340, lat: 35.03, lon: 140.02, depthKm: 43.5, magnitude: 4.2, ...extra }
}

describe('refineQuake', () => {
  it('震源リストの同じ地震で、発生時刻・震源・深さを秒まで補う（名前・規模・最大震度は地震情報のまま）', () => {
    const q = refineQuake(p2p(), [row(), row({ timeMs: T0 - 3_600_000, magnitude: 1.0 })], [])
    expect(q).toMatchObject({
      originSource: 'hypocenter-list',
      originMs: T0 + 12_340,
      originPrecisionMs: 100,
      lat: 35.03,
      lon: 140.02,
      depthKm: 43.5,
      name: '千葉県北西部',
      magnitude: 4.2,
      maxScale: 30,
    })
  })

  it('対照: 同じ分でも離れた地震・規模の違いすぎる地震では補わない', () => {
    // 1 度は 111 km ほど
    expect(refineQuake(p2p(), [row({ lat: 36.0 })], []).originSource).toBe('quake-info')
    expect(refineQuake(p2p(), [row({ magnitude: 2.9 })], []).originSource).toBe('quake-info')
    // 規模が分からない行は規模で弾かない
    expect(refineQuake(p2p(), [row({ magnitude: null })], []).originSource).toBe('hypocenter-list')
  })

  it('同じ分に規模の近い候補が 2 つあれば、どちらとも決めない（取り違えると線が数十秒ずれる）', () => {
    const q = refineQuake(p2p(), [row({ timeMs: T0 + 5_000, magnitude: 4.1 }), row({ timeMs: T0 + 40_000, magnitude: 4.3 })], [])
    expect(q.originSource).toBe('quake-info')
    // 規模の差がはっきりしていれば近いほうを採る
    const r = refineQuake(p2p(), [row({ timeMs: T0 + 5_000, magnitude: 4.2 }), row({ timeMs: T0 + 40_000, magnitude: 3.2 })], [])
    expect(r.originMs).toBe(T0 + 5_000)
  })

  it('震源リストに無ければ緊急地震速報の発生時刻（秒）を使う。震源は地震情報のまま', () => {
    const eew: EewOrigin = { originMs: T0 + 11_000, lat: 35.1, lon: 140.1 }
    const q = refineQuake(p2p(), [], [eew])
    expect(q).toMatchObject({ originSource: 'eew', originMs: T0 + 11_000, originPrecisionMs: 1000, lat: 35.0, lon: 140.0, depthKm: 40 })
  })

  it('対照: 緊急地震速報が離れていたり、窓の中に 2 つあれば使わない', () => {
    expect(refineQuake(p2p(), [], [{ originMs: T0 + 11_000, lat: 37.0, lon: 140.0 }]).originSource).toBe('quake-info')
    const two: EewOrigin[] = [
      { originMs: T0 + 11_000, lat: null, lon: null },
      { originMs: T0 + 50_000, lat: null, lon: null },
    ]
    expect(refineQuake(p2p(), [], two).originSource).toBe('quake-info')
  })

  it('どれも無ければ地震情報の分の幅のまま', () => {
    const q = refineQuake(p2p(), [], [])
    expect(q).toMatchObject({ originSource: 'quake-info', originMs: T0, originPrecisionMs: 60_000 })
  })
})

describe('arrivalSpans', () => {
  const at = { lat: 35.5, lon: 139.5 }

  function quake(extra: Partial<RecordQuake> = {}): RecordQuake {
    return {
      key: 'k',
      name: '千葉県北西部',
      originMs: T0,
      originPrecisionMs: 100,
      originSource: 'hypocenter-list',
      lat: 35.0,
      lon: 140.0,
      depthKm: 40,
      magnitude: 4.2,
      maxScale: 30,
      ...extra,
    }
  }

  it('発生時刻と深さが分かれば、P・S の幅は発生時刻の幅だけ', () => {
    const a = arrivalSpans(quake(), at)!
    expect(a.pToMs - a.pFromMs).toBeCloseTo(100, 6)
    expect(a.sToMs - a.sFromMs).toBeCloseTo(100, 6)
    expect(a.pFromMs).toBeCloseTo(T0 + travelTimeSec('P', a.distanceKm, 40) * 1000, 6)
    expect(a.sFromMs).toBeGreaterThan(a.pFromMs)
  })

  it('分の幅の地震は 60 秒の幅、深さが分からなければ 0〜100 km の幅を足す（0 で代用しない）', () => {
    const minute = arrivalSpans(quake({ originPrecisionMs: 60_000 }), at)!
    expect(minute.sToMs - minute.sFromMs).toBeCloseTo(60_000, 6)
    const noDepth = arrivalSpans(quake({ depthKm: null }), at)!
    const shallow = travelTimeSec('S', noDepth.distanceKm, 0)
    const deep = travelTimeSec('S', noDepth.distanceKm, 100)
    expect(noDepth.sFromMs).toBeCloseTo(T0 + Math.min(shallow, deep) * 1000, 6)
    expect(noDepth.sToMs).toBeCloseTo(T0 + 100 + Math.max(shallow, deep) * 1000, 6)
  })

  it('走時表の外（遠い地震）は線を引かない', () => {
    expect(arrivalSpans(quake({ lat: -20, lon: -70 }), at)).toBeNull()
  })
})
