import { describe, it, expect } from 'vitest'
import * as maplibregl from 'maplibre-gl'
import {
  rasterizeEstimatedIntensity,
  buildEstimatedIntensityMesh,
  SI_RANGE,
  MESH_DIVISIONS,
} from './estimatedIntensityRaster'
import { CELL_LAT_DEG, CELL_LON_DEG } from '../../../utils/bufrEstimatedIntensity'
import { getIntensityColor } from '../../../utils/intensity'
import type { JMAEstimatedIntensity, JMAEstimatedIntensityGrade } from '../../../types/earthquake'

// 気象庁が電文で配る凡例（階級震度と計測震度の対応）。実電文と同じ区切り。
const GRADES: JMAEstimatedIntensityGrade[] = [
  { scale: 4, modifier: 'none', lower: 35, upper: 44 },
  { scale: 5, modifier: 'weak', lower: 45, upper: 49 },
  { scale: 5, modifier: 'strong', lower: 50, upper: 54 },
  { scale: 6, modifier: 'weak', lower: 55, upper: 59 },
  { scale: 6, modifier: 'strong', lower: 60, upper: 64 },
  { scale: 7, modifier: 'none', lower: 65, upper: 127 },
]

interface Cell {
  lat: number
  lon: number
  si: number
}

/** セルの一覧から電文相当のデータを作る。`bounds` は復号側と同じ規則（北東端まで含む）。 */
function makeData(cells: Cell[], grades: JMAEstimatedIntensityGrade[] = GRADES): JMAEstimatedIntensity {
  const south = Math.min(...cells.map((c) => c.lat))
  const west = Math.min(...cells.map((c) => c.lon))
  const north = Math.max(...cells.map((c) => c.lat)) + CELL_LAT_DEG
  const east = Math.max(...cells.map((c) => c.lon)) + CELL_LON_DEG
  return {
    id: 'test',
    time: '2026-01-01T00:10:00Z',
    arrivalTime: '2026-01-01T00:00:00Z',
    hypocenter: { lat: 35, lon: 135, depthKm: 10 },
    magnitude: 6.5,
    areaCode: 0,
    telegramKind: 0,
    grades,
    count: cells.length,
    lat: new Float32Array(cells.map((c) => c.lat)),
    lon: new Float32Array(cells.map((c) => c.lon)),
    si: new Uint8Array(cells.map((c) => c.si)),
    cellLatDeg: CELL_LAT_DEG, cellLonDeg: CELL_LON_DEG,
    bounds: { south, north, west, east },
  }
}

/** 南西端 (35, 135) を原点に、格子座標 (ix, iy) のセルを作る（iy は北向き）。 */
function cellAt(ix: number, iy: number, si: number): Cell {
  return { lat: 35 + iy * CELL_LAT_DEG, lon: 135 + ix * CELL_LON_DEG, si }
}

/** 画素の R（計測震度）と G（有効フラグ）を読む。 */
function px(r: { pixels: Uint8Array; width: number }, x: number, y: number): [number, number] {
  const k = (y * r.width + x) * 2
  return [r.pixels[k], r.pixels[k + 1]]
}

const BIG = 4096

describe('rasterizeEstimatedIntensity', () => {
  it('セル 1 つを、縁の余白を挟んだ 3x3 の中央へ置く', () => {
    const r = rasterizeEstimatedIntensity(makeData([cellAt(0, 0, 47)]), BIG)
    expect(r).not.toBeNull()
    // 幅・高さはセル数 + 両端の余白 1 画素ずつ。
    expect(r!.width).toBe(3)
    expect(r!.height).toBe(3)
    expect(px(r!, 1, 1)).toEqual([47, 255])
    expect(r!.painted).toBe(1)
    expect(r!.colored).toBe(1)
  })

  it('セルと画素が 1 対 1 に並ぶ（縮小しない範囲では）', () => {
    const cells = [cellAt(0, 0, 40), cellAt(1, 0, 50), cellAt(0, 1, 60), cellAt(1, 1, 70)]
    const r = rasterizeEstimatedIntensity(makeData(cells), BIG)!
    expect([r.width, r.height]).toEqual([4, 4])
    expect(r.scaled).toBe(false)
    // 画像の y は北が 0。iy=1（北側）が y=1、iy=0（南側）が y=2 に来る。
    expect(px(r, 1, 2)).toEqual([40, 255])
    expect(px(r, 2, 2)).toEqual([50, 255])
    expect(px(r, 1, 1)).toEqual([60, 255])
    expect(px(r, 2, 1)).toEqual([70, 255])
    expect(r.painted).toBe(4)
  })

  it('貼る範囲はセルの外接矩形を余白 1 画素分だけ広げたもの（等倍ではセル 1 つ分）', () => {
    const r = rasterizeEstimatedIntensity(makeData([cellAt(0, 0, 47)]), BIG)!
    expect(r.west).toBeCloseTo(135 - CELL_LON_DEG, 9)
    expect(r.east).toBeCloseTo(135 + 2 * CELL_LON_DEG, 9)
    expect(r.south).toBeCloseTo(35 - CELL_LAT_DEG, 9)
    expect(r.north).toBeCloseTo(35 + 2 * CELL_LAT_DEG, 9)
  })

  it('縮めた画でも余白は 1 画素ぶん残る（セルの幅では測らない）', () => {
    const cells: Cell[] = []
    for (let ix = 0; ix < 100; ix++) cells.push(cellAt(ix, 0, 45))
    const data = makeData(cells)
    const r = rasterizeEstimatedIntensity(data, 16)!
    expect(r.scaled).toBe(true)
    const pxLon = (r.east - r.west) / r.width
    // 縮めた画では 1 画素がセルより粗い。余白をセルの幅で取ると 1 画素に満たなくなる。
    expect(pxLon).toBeGreaterThan(CELL_LON_DEG)
    expect(r.west).toBeCloseTo(data.bounds.west - pxLon, 9)
    expect(r.east).toBeCloseTo(data.bounds.east + pxLon, 9)
    // 左右の端の列は余白なので、セルは入らない。
    for (let y = 0; y < r.height; y++) {
      expect(px(r, 0, y)[1]).toBe(0)
      expect(px(r, r.width - 1, y)[1]).toBe(0)
    }
  })

  // 安全弁: **セルの無い画素へ値を写さない。** 値を線形補間していた頃は、縁で階級が 1 段
  // 落ちるのを防ぐために隣の値を外側へ広げていた（`spreadValues`）。最近傍で引くいまは
  // 有効フラグが 0 の画素は描かれないので、写しても**絵は変わらない**——だからこそ残ると
  // 「この値には意味がある」と読めてしまう。持たせないことを固定しておく。
  it('セルの無い画素は値も持たない（縁の外へ広げない）', () => {
    const r = rasterizeEstimatedIntensity(makeData([cellAt(0, 0, 47)]), BIG)!
    for (const [x, y] of [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]]) {
      expect(px(r, x, y)).toEqual([0, 0])
    }
  })

  it('離れたセルのあいだは空のまま（隣へも滲ませない）', () => {
    const cells = [cellAt(0, 0, 40), cellAt(4, 0, 70)]
    const r = rasterizeEstimatedIntensity(makeData(cells), BIG)!
    expect(r.width).toBe(7)
    // セルは x=1 と x=5。あいだの 3 画素はどれも空。
    for (const x of [2, 3, 4]) expect(px(r, x, 1)).toEqual([0, 0])
    expect(px(r, 1, 1)).toEqual([40, 255])
    expect(px(r, 5, 1)).toEqual([70, 255])
  })

  it('1 画素へ複数のセルが重なるときは最も大きい計測震度を残す', () => {
    // 上限 16 に対してセルを 100 個並べる（1 画素へ 6 個あまりが畳まれる）。
    const cells: Cell[] = []
    for (let ix = 0; ix < 100; ix++) cells.push(cellAt(ix, 0, 40))
    // 大きい値を中ほどへ置く。同じ画素へ畳まれる相手が前後の両方にいるので、
    // 配列の並び順に依らず最大値が残ることを確かめられる。
    cells[10] = cellAt(10, 0, 63)
    const r = rasterizeEstimatedIntensity(makeData(cells), 16)!
    expect(r.scaled).toBe(true)
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(16)
    // 畳まれている（有効な画素がセル数より少ない）。
    expect(r.painted).toBeLessThan(100)
    // どこかの画素に最大値が残っている（畳み先の位置は縮小率で変わるので位置は問わない）。
    let best = 0
    for (let i = 0; i < r.width * r.height; i++) {
      if (r.pixels[i * 2 + 1] !== 0) best = Math.max(best, r.pixels[i * 2])
    }
    expect(best).toBe(63)
  })

  it('上限を超える範囲は両辺を上限まで縮める', () => {
    // 経度 4 度ぶん（1280 セル）を上限 64 で焼く。
    const cells: Cell[] = []
    for (let ix = 0; ix < 1280; ix += 64) cells.push(cellAt(ix, 0, 45))
    const r = rasterizeEstimatedIntensity(makeData(cells), 64)!
    expect(r.scaled).toBe(true)
    expect(r.width).toBeLessThanOrEqual(64)
    expect(r.height).toBeLessThanOrEqual(64)
    expect(r.painted).toBeGreaterThan(0)
  })

  it('セルが無い電文は焼かない', () => {
    const data = makeData([cellAt(0, 0, 45)])
    data.count = 0
    expect(rasterizeEstimatedIntensity(data, BIG)).toBeNull()
  })

  it('範囲が退化している電文は焼かない', () => {
    const data = makeData([cellAt(0, 0, 45)])
    data.bounds = { south: 35, north: 35, west: 135, east: 139 }
    expect(rasterizeEstimatedIntensity(data, BIG)).toBeNull()
  })

  it('計測震度 0 のセルは有効にしない（配信されない値なので塗る対象が無い）', () => {
    const r = rasterizeEstimatedIntensity(makeData([cellAt(0, 0, 0), cellAt(1, 0, 45)]), BIG)!
    expect(r.painted).toBe(1)
  })

  it('すべてのセルが計測震度 0 なら、有効な画素を 1 つも作らない', () => {
    const r = rasterizeEstimatedIntensity(makeData([cellAt(0, 0, 0), cellAt(1, 0, 0)]), BIG)
    // 焼くこと自体は成功する（呼び出し側が painted を見て「描くものが無い」と判断する）。
    expect(r).not.toBeNull()
    expect(r!.painted).toBe(0)
    expect(r!.colored).toBe(0)
  })

  it('凡例のどの範囲にも入らない計測震度は、有効でも色が付かない', () => {
    // 震度4 の下限（35）未満。凡例に無いので colored には数えない。
    const r = rasterizeEstimatedIntensity(makeData([cellAt(0, 0, 20)]), BIG)!
    expect(r.painted).toBe(1)
    expect(r.colored).toBe(0)
  })

  it('凡例テクスチャは電文の区切りで階級の色を引く', () => {
    const r = rasterizeEstimatedIntensity(makeData([cellAt(0, 0, 45)]), BIG)!
    expect(r.legend.length).toBe(SI_RANGE * 4)
    const at = (si: number) => Array.from(r.legend.subarray(si * 4, si * 4 + 4))
    const rgbOf = (hex: string) => {
      const v = Number.parseInt(hex.slice(1), 16)
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
    }
    expect(at(35)).toEqual([...rgbOf(getIntensityColor(40)), 255])
    expect(at(44)).toEqual([...rgbOf(getIntensityColor(40)), 255])
    expect(at(45)).toEqual([...rgbOf(getIntensityColor(45)), 255])
    expect(at(65)).toEqual([...rgbOf(getIntensityColor(70)), 255])
    // 凡例の下限より下は透明（塗らない）。
    expect(at(34)).toEqual([0, 0, 0, 0])
  })

  it('凡例が空の電文では、有効な画素があっても色は付かない', () => {
    const r = rasterizeEstimatedIntensity(makeData([cellAt(0, 0, 45)], []), BIG)!
    expect(r.painted).toBe(1)
    expect(r.colored).toBe(0)
  })
})

describe('buildEstimatedIntensityMesh', () => {
  const RANGE = { west: 135, east: 139, south: 34, north: 38 }

  it('緯度経度で等分した格子を作り、頂点は Mercator 座標で置く', () => {
    const m = buildEstimatedIntensityMesh(RANGE)
    const n = MESH_DIVISIONS
    expect(m.vertexCount).toBe((n + 1) * (n + 1))
    expect(m.positions.length).toBe(m.vertexCount * 2)
    expect(m.uvs.length).toBe(m.vertexCount * 2)
    expect(m.indices.length).toBe(n * n * 6)
  })

  it('頂点の Mercator 座標は MapLibre の換算と一致する', () => {
    const m = buildEstimatedIntensityMesh(RANGE)
    const n = MESH_DIVISIONS
    // 四隅と中央で突き合わせる。ここがずれると面が地図の別の場所へ貼られる。
    const corners: [number, number, number, number][] = [
      [0, 0, RANGE.west, RANGE.north],
      [n, 0, RANGE.east, RANGE.north],
      [0, n, RANGE.west, RANGE.south],
      [n, n, RANGE.east, RANGE.south],
      [n / 2, n / 2, (RANGE.west + RANGE.east) / 2, 0],
    ]
    for (const [i, j, lng, lat] of corners) {
      const k = (j * (n + 1) + i) * 2
      const expectLat = j === n / 2 ? (RANGE.north + RANGE.south) / 2 : lat
      const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng, lat: expectLat })
      expect(m.positions[k]).toBeCloseTo(mc.x, 6)
      expect(m.positions[k + 1]).toBeCloseTo(mc.y, 6)
    }
  })

  it('テクスチャ座標は等間隔で、四隅が 0 と 1 になる', () => {
    const m = buildEstimatedIntensityMesh(RANGE)
    const n = MESH_DIVISIONS
    const uvAt = (i: number, j: number) => {
      const k = (j * (n + 1) + i) * 2
      return [m.uvs[k], m.uvs[k + 1]]
    }
    expect(uvAt(0, 0)).toEqual([0, 0])
    expect(uvAt(n, n)).toEqual([1, 1])
    expect(uvAt(n / 2, n / 2)[0]).toBeCloseTo(0.5, 9)
    expect(uvAt(n / 2, n / 2)[1]).toBeCloseTo(0.5, 9)
  })

  it('三角形の索引は Uint16 に収まる（頂点数が上限を超えない）', () => {
    const m = buildEstimatedIntensityMesh(RANGE)
    expect(m.vertexCount).toBeLessThanOrEqual(65536)
    expect(m.indices).toBeInstanceOf(Uint16Array)
    for (let i = 0; i < m.indices.length; i++) {
      expect(m.indices[i]).toBeLessThan(m.vertexCount)
    }
  })
})
