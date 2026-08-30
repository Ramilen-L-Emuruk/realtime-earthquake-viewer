import { describe, it, expect } from 'vitest'
import {
  scaleToInstrumental,
  bandScaleOf,
  mercatorY,
  latFromMercatorY,
  rowLatitudes,
  columnLongitudes,
  buildIsoseismalGrid,
  INSTRUMENTAL_BANDS,
  type IsoseismalPoint,
} from './isoseismal'

const BOUNDS = { north: 38.0, south: 36.0, west: 136.0, east: 138.0 }

describe('scaleToInstrumental', () => {
  it('階級値を計測震度の代表値へ写す', () => {
    expect(scaleToInstrumental(40)).toBe(4.0)
    expect(scaleToInstrumental(45)).toBe(4.75)
    expect(scaleToInstrumental(50)).toBe(5.25)
    expect(scaleToInstrumental(70)).toBe(6.75)
  })

  it('階級のあいだが不等間隔にならない（4→5弱 と 3→4 の比が階級値のままではない）', () => {
    const d34 = scaleToInstrumental(40)! - scaleToInstrumental(30)!
    const d45 = scaleToInstrumental(45)! - scaleToInstrumental(40)!
    // 階級値では 10 と 5 で 2 倍差。計測震度では 1.0 と 0.75 に縮まる。
    expect(d34).toBeCloseTo(1.0, 6)
    expect(d45).toBeCloseTo(0.75, 6)
  })

  it('階級表に無い値は null（震度0・不明・経路外の値）', () => {
    expect(scaleToInstrumental(0)).toBeNull()
    expect(scaleToInstrumental(-1)).toBeNull()
    expect(scaleToInstrumental(46)).toBeNull()
    expect(scaleToInstrumental(99)).toBeNull()
  })
})

describe('bandScaleOf', () => {
  it('帯の下限ちょうどはその帯に入る', () => {
    expect(bandScaleOf(4.5)).toBe(45)
    expect(bandScaleOf(5.0)).toBe(50)
    expect(bandScaleOf(6.5)).toBe(70)
  })

  it('下限をわずかに下回ると 1 つ下の帯', () => {
    expect(bandScaleOf(4.4999)).toBe(40)
    expect(bandScaleOf(4.9999)).toBe(45)
  })

  it('震度1 の下限に満たなければ帯を持たない', () => {
    expect(bandScaleOf(0.49)).toBeNull()
    expect(bandScaleOf(0)).toBeNull()
  })

  it('帯の下限は昇順で、階級値も昇順', () => {
    for (let i = 1; i < INSTRUMENTAL_BANDS.length; i++) {
      expect(INSTRUMENTAL_BANDS[i].from).toBeGreaterThan(INSTRUMENTAL_BANDS[i - 1].from)
      expect(INSTRUMENTAL_BANDS[i].scale).toBeGreaterThan(INSTRUMENTAL_BANDS[i - 1].scale)
    }
  })
})

describe('Mercator の往復', () => {
  it('mercatorY と latFromMercatorY が逆関数', () => {
    for (const lat of [-60, -20, 0, 24.5, 35.7, 45.4, 60]) {
      expect(latFromMercatorY(mercatorY(lat))).toBeCloseTo(lat, 9)
    }
  })

  it('北ほど y が小さい', () => {
    expect(mercatorY(45)).toBeLessThan(mercatorY(35))
  })
})

describe('rowLatitudes', () => {
  it('緯度等間隔ではなく Mercator 等間隔（貼り付け先の座標系に合わせる）', () => {
    const lats = rowLatitudes(BOUNDS, 4)
    const gaps = [lats[0] - lats[1], lats[1] - lats[2], lats[2] - lats[3]]
    // 北のほうが Mercator では引き伸ばされるので、同じ y 幅に対する緯度差は北ほど小さい。
    expect(gaps[0]).toBeLessThan(gaps[2])
    // 緯度等間隔なら 3 つとも等しくなる。そうなっていないことを固定する。
    expect(gaps[0]).not.toBeCloseTo(gaps[2], 6)
  })

  it('先頭・末尾はセル中心なので範囲の内側に入る', () => {
    const lats = rowLatitudes(BOUNDS, 10)
    expect(lats[0]).toBeLessThan(BOUNDS.north)
    expect(lats[9]).toBeGreaterThan(BOUNDS.south)
  })
})

describe('columnLongitudes', () => {
  it('経度は等間隔（Mercator でも経度は線形）', () => {
    const lngs = columnLongitudes(BOUNDS, 4)
    expect(lngs[1] - lngs[0]).toBeCloseTo(lngs[3] - lngs[2], 9)
  })
})

describe('buildIsoseismalGrid', () => {
  const at = (g: ReturnType<typeof buildIsoseismalGrid>, i: number, j: number) =>
    g.values[j * g.width + i]

  it('観測点が 1 つも無ければ全セルが NaN', () => {
    const g = buildIsoseismalGrid([], BOUNDS, 8, 8)
    expect([...g.values].every(Number.isNaN)).toBe(true)
  })

  it('観測点のすぐ近くのセルはその観測点の値に寄る', () => {
    const center = { lat: 37.0, lng: 137.0, scale: 55 }
    const g = buildIsoseismalGrid([center], BOUNDS, 21, 21)
    // 中央のセル（21x21 の中心）は観測点とほぼ同座標。
    expect(at(g, 10, 10)).toBeCloseTo(5.75, 2)
  })

  it('2 点の中間は 2 値のあいだに入る', () => {
    const points: IsoseismalPoint[] = [
      { lat: 37.0, lng: 136.8, scale: 30 }, // 3.0
      { lat: 37.0, lng: 137.2, scale: 55 }, // 5.75
    ]
    const g = buildIsoseismalGrid(points, BOUNDS, 21, 21)
    const mid = at(g, 10, 10)
    expect(mid).toBeGreaterThan(3.0)
    expect(mid).toBeLessThan(5.75)
  })

  it('最寄り観測点まで maskKm を超えるセルには値を作らない（海へ外挿しない）', () => {
    const g = buildIsoseismalGrid([{ lat: 37.0, lng: 137.0, scale: 55 }], BOUNDS, 21, 21, {
      maskKm: 10,
    })
    // 中央は値を持つが、四隅は 100km 以上離れているので NaN。
    expect(Number.isNaN(at(g, 10, 10))).toBe(false)
    expect(Number.isNaN(at(g, 0, 0))).toBe(true)
    expect(Number.isNaN(at(g, 20, 20))).toBe(true)
  })

  it('maskKm を広げると外側にも値が出る（マスクが効いていることの対照）', () => {
    const opts = { maskKm: 500, influenceKm: 500 }
    const g = buildIsoseismalGrid([{ lat: 37.0, lng: 137.0, scale: 55 }], BOUNDS, 21, 21, opts)
    expect(Number.isNaN(at(g, 0, 0))).toBe(false)
  })

  it('階級表に無い値の観測点は補間に混ざらない', () => {
    const points: IsoseismalPoint[] = [
      { lat: 37.0, lng: 137.0, scale: 55 },
      { lat: 37.0, lng: 137.02, scale: -1 }, // 震度不明
      { lat: 37.0, lng: 136.98, scale: 0 }, // 震度0
    ]
    const g = buildIsoseismalGrid(points, BOUNDS, 21, 21)
    // 不明・震度0 が混ざると中央の値が 5.75 から下へ引かれる。混ざっていないことを固定する。
    expect(at(g, 10, 10)).toBeCloseTo(5.75, 2)
  })

  it('階級表に無い値だけを渡したら全セルが NaN', () => {
    const g = buildIsoseismalGrid([{ lat: 37.0, lng: 137.0, scale: 0 }], BOUNDS, 8, 8)
    expect([...g.values].every(Number.isNaN)).toBe(true)
  })

  it('影響半径の外にある観測点は重みに入らない', () => {
    const points: IsoseismalPoint[] = [
      { lat: 37.0, lng: 137.0, scale: 30 }, // 3.0（近い）
      { lat: 37.4, lng: 137.0, scale: 70 }, // 6.75（約 44km 北）
    ]
    const near = buildIsoseismalGrid(points, BOUNDS, 21, 21, { influenceKm: 60 })
    const far = buildIsoseismalGrid(points, BOUNDS, 21, 21, { influenceKm: 20 })
    // 影響半径を縮めると、遠い高震度が中央のセルへ効かなくなる。
    expect(at(near, 10, 10)).toBeGreaterThan(at(far, 10, 10))
    expect(at(far, 10, 10)).toBeCloseTo(3.0, 2)
  })

  it('格子の外（西）にある観測点も拾える（探索が格子内に閉じていない）', () => {
    // 範囲の外（西 135.5）にだけ観測点を置く。範囲西端のセルは 45km 程度なので拾えるはず。
    const g = buildIsoseismalGrid([{ lat: 37.0, lng: 135.5, scale: 40 }], BOUNDS, 21, 21, {
      maskKm: 60,
      influenceKm: 80,
    })
    expect(Number.isNaN(at(g, 0, 10))).toBe(false)
  })

  // 経度方向の下端（`Math.max(0, Math.ceil(...))`）と上端（`Math.min(width - 1, Math.floor(...))`）は
  // 別々の式なので、西だけでは東の回帰を止められない。
  it('格子の外（東）にある観測点も拾える', () => {
    const g = buildIsoseismalGrid([{ lat: 37.0, lng: 138.5, scale: 40 }], BOUNDS, 21, 21, {
      maskKm: 60,
      influenceKm: 80,
    })
    expect(Number.isNaN(at(g, 20, 10))).toBe(false)
  })

  // 緯度方向の走査範囲は二分探索、経度方向は弦の直接計算と、実装が非対称。
  // 片方だけ検証しても他方の回帰は止められないので、南北も同じ形で固定する。
  it('格子の外（北）にある観測点も拾える', () => {
    const g = buildIsoseismalGrid([{ lat: 38.4, lng: 137.0, scale: 40 }], BOUNDS, 21, 21, {
      maskKm: 60,
      influenceKm: 80,
    })
    // 最上段（北端）のセルは観測点から 45km 程度。
    expect(Number.isNaN(at(g, 10, 0))).toBe(false)
  })

  it('格子の外（南）にある観測点も拾える', () => {
    const g = buildIsoseismalGrid([{ lat: 35.6, lng: 137.0, scale: 40 }], BOUNDS, 21, 21, {
      maskKm: 60,
      influenceKm: 80,
    })
    expect(Number.isNaN(at(g, 10, 20))).toBe(false)
  })

  it('緯度方向の走査は影響半径を超えた観測点を拾わない（上の対照）', () => {
    // 北へ 1.4 度（約 155km）。maskKm/influenceKm を既定のまま（25/30km）にすれば届かない。
    const g = buildIsoseismalGrid([{ lat: 39.4, lng: 137.0, scale: 40 }], BOUNDS, 21, 21)
    expect([...g.values].every(Number.isNaN)).toBe(true)
  })

  describe('usedPoints', () => {
    it('補間に使えた点の数を返す', () => {
      const points: IsoseismalPoint[] = [
        { lat: 37.0, lng: 137.0, scale: 40 },
        { lat: 37.1, lng: 137.1, scale: 50 },
      ]
      expect(buildIsoseismalGrid(points, BOUNDS, 8, 8).usedPoints).toBe(2)
    })

    it('有効な点と無効な点が混ざっていれば有効な分だけを数える', () => {
      const points: IsoseismalPoint[] = [
        { lat: 37.0, lng: 137.0, scale: 40 },
        { lat: 37.1, lng: 137.1, scale: 0 },
        { lat: 37.2, lng: 137.2, scale: -1 },
      ]
      expect(buildIsoseismalGrid(points, BOUNDS, 8, 8).usedPoints).toBe(1)
    })

    it('階級表に無い値の点は数えない（点はあるのに面が空になる状態を呼び出し側が検知できる）', () => {
      const points: IsoseismalPoint[] = [
        { lat: 37.0, lng: 137.0, scale: 0 },
        { lat: 37.1, lng: 137.1, scale: -1 },
      ]
      const g = buildIsoseismalGrid(points, BOUNDS, 8, 8)
      expect(g.usedPoints).toBe(0)
      expect([...g.values].every(Number.isNaN)).toBe(true)
    })

    it('点を 1 件も渡さなければ 0', () => {
      expect(buildIsoseismalGrid([], BOUNDS, 8, 8).usedPoints).toBe(0)
    })
  })
})
