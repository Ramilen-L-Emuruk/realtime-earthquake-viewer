import { describe, it, expect } from 'vitest'
import { buildDayNightGrid, MERCATOR_MAX_LAT, POLAR_EDGE_LAT, FLOATS_PER_VERTEX } from './dayNightGrid'

const grid = buildDayNightGrid()

/**
 * その緯度が Mercator が表せる範囲の内側か。
 *
 * 頂点は `Float32Array` に入るので単精度へ丸められ、端の行（±`MERCATOR_MAX_LAT`）が
 * 1e-6 ほど超える。素直に `<=` で見ると上端・下端の 2 行が外側に数えられる。
 * 極冠でいちばん内側の行は 86.3° なので、この許容と混ざることはない。
 */
function isInsideMercator(lat: number): boolean {
  return Math.abs(lat) <= MERCATOR_MAX_LAT + 1e-4
}

/** 緯度（度）を Mercator の y へ。実装と同じ式をテスト側で独立に組み立てる。 */
function mercatorYOf(latDeg: number): number {
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + ((latDeg * Math.PI) / 180) / 2)) / (2 * Math.PI)
}

/** 頂点 i の `[mercatorX, mercatorY, 経度, 緯度]`。 */
function vertexAt(i: number): [number, number, number, number] {
  const o = i * FLOATS_PER_VERTEX
  return [grid.vertices[o], grid.vertices[o + 1], grid.vertices[o + 2], grid.vertices[o + 3]]
}

describe('buildDayNightGrid', () => {
  it('頂点と三角形の数が噛み合っている', () => {
    expect(grid.vertices.length).toBe(grid.vertexCount * FLOATS_PER_VERTEX)
    expect(grid.indices.length).toBe(grid.indexCount)
    // 格子のマスは (列 - 1) × (行 - 1) で、1 マスが三角形 2 枚 ＝ index 6 つ。
    expect(grid.indexCount % 6).toBe(0)
  })

  it('index が頂点の範囲に収まる（Uint16 で指せる）', () => {
    expect(grid.vertexCount).toBeLessThanOrEqual(65536)
    let max = 0
    for (const i of grid.indices) if (i > max) max = i
    expect(max).toBe(grid.vertexCount - 1)
  })

  it('経度 -180 と 180 の両端に頂点がある（日付変更線で隙間が空かない）', () => {
    const lons = new Set<number>()
    for (let i = 0; i < grid.vertexCount; i++) lons.add(vertexAt(i)[2])
    expect(lons.has(-180)).toBe(true)
    expect(lons.has(180)).toBe(true)
  })

  // 以前は Mercator が表せる範囲（±85.05°）で切っていた。球で描くと MapLibre が最上端の
  // タイル行を極まで引き延ばすため、その帯に地形だけが残って夜が掛からなかった（旧実装は
  // 面が極まで届いており、実測で ±85.05° の外も覆えていた）。
  it('緯度は極の近くまで届く（Mercator が表せる範囲では切らない）', () => {
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < grid.vertexCount; i++) {
      const lat = vertexAt(i)[3]
      if (lat < min) min = lat
      if (lat > max) max = lat
    }
    expect(max).toBeCloseTo(POLAR_EDGE_LAT, 4)
    expect(min).toBeCloseTo(-POLAR_EDGE_LAT, 4)
    // 対照: Mercator の限界より外まで出ていること（ここで切っていた頃との差）。
    expect(max).toBeGreaterThan(MERCATOR_MAX_LAT)
    expect(min).toBeLessThan(-MERCATOR_MAX_LAT)
  })

  it('Mercator が表せる範囲の内側にも行が残っている（極冠で置き換えていない）', () => {
    // 安全弁: 極まで伸ばすときに内側の刻みを作り直すと、濃さの補間誤差の前提が変わる。
    let inside = 0
    for (let i = 0; i < grid.vertexCount; i++) {
      if (isInsideMercator(vertexAt(i)[3])) inside++
    }
    // 内側は 87 行 × 181 列。極冠を足しても内側の頂点数は変わらない。
    expect(inside).toBe(87 * 181)
  })

  it('Mercator の x が経度に、y が緯度に対応している', () => {
    // 逆変換で経度緯度へ戻し、頂点が持つ値と一致することを見る。
    for (let i = 0; i < grid.vertexCount; i += 137) {
      const [x, y, lon, lat] = vertexAt(i)
      expect((x - 0.5) * 360).toBeCloseTo(lon, 3)
      const backLat = (Math.atan(Math.sinh((0.5 - y) * 2 * Math.PI)) * 180) / Math.PI
      expect(backLat).toBeCloseTo(lat, 3)
    }
  })

  it('Mercator の x は 0〜1 に収まり、y は極冠のぶんだけ外へ出る', () => {
    // y を 0〜1 へ丸めると極の帯が潰れて Mercator の限界と同じ場所へ重なる。**外へ出るのが正しい。**
    let outside = 0
    for (let i = 0; i < grid.vertexCount; i++) {
      const [x, y, , lat] = vertexAt(i)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
      if (isInsideMercator(lat)) {
        // 内側は 0〜1（`MERCATOR_MAX_LAT` が近似値なので端の丸めぶんだけ許す）。
        expect(y).toBeGreaterThan(-1e-6)
        expect(y).toBeLessThan(1 + 1e-6)
      } else {
        outside++
      }
    }
    expect(outside).toBeGreaterThan(0)
  })

  it('三角形が隙間なく覆う（面積が Mercator 空間の高さと一致する）', () => {
    // 三角形の面積を足し上げる。重なりも隙間もなければ、幅 1 × y の高さと一致する。
    // **1 と比べない** —— 極冠を足したぶん Mercator 空間では 1×1 より縦に長い。
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < grid.vertexCount; i++) {
      const y = vertexAt(i)[1]
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    let area = 0
    for (let i = 0; i < grid.indices.length; i += 3) {
      const [ax, ay] = vertexAt(grid.indices[i])
      const [bx, by] = vertexAt(grid.indices[i + 1])
      const [cx, cy] = vertexAt(grid.indices[i + 2])
      area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2
    }
    expect(area).toBeCloseTo(maxY - minY, 4)
    // 対照: 内側だけを覆っていた頃（面積 1）より広いこと。
    expect(area).toBeGreaterThan(1)
  })

  it('三角形の向きが揃っている（表裏が混ざらない）', () => {
    let positive = 0
    let negative = 0
    for (let i = 0; i < grid.indices.length; i += 3) {
      const [ax, ay] = vertexAt(grid.indices[i])
      const [bx, by] = vertexAt(grid.indices[i + 1])
      const [cx, cy] = vertexAt(grid.indices[i + 2])
      const signed = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
      if (signed > 0) positive++
      else if (signed < 0) negative++
    }
    // 面の裏表を使う描き方はしていないが、向きが混ざるのは格子の組み方が壊れた印。
    expect(Math.min(positive, negative)).toBe(0)
    expect(Math.max(positive, negative)).toBe(grid.indices.length / 3)
  })

  it('緯度の刻みが濃さの変わり方に対して十分細かい', () => {
    // 日の入りから天文薄明の下限までが 17.2°。1 マスの緯度差がそれに近いと、
    // 1 つの三角形の中で夜の濃さが端から端まで変わってしまう。
    // 行の切れ目は「経度が -180 へ戻るところ」で見つける。
    let cols = 0
    for (let i = 1; i < grid.vertexCount; i++) {
      if (vertexAt(i)[2] === -180) {
        cols = i
        break
      }
    }
    expect(cols).toBeGreaterThan(0)
    const step = Math.abs(vertexAt(0)[3] - vertexAt(cols)[3])
    expect(step).toBeGreaterThan(0)
    expect(step).toBeLessThan(3)
  })

  it('緯度の補間誤差が、極冠でも内側と同じ程度に収まる', () => {
    // 安全弁。フラグメントへ渡る緯度は Mercator の y に対して線形に補われるので、
    // **y の中点での「補間した緯度」と「真の緯度」の差**が誤差になる。極冠は y が急に伸びるため、
    // 内側と同じ刻み幅では足りない（4 段だと最外周で 0.52°・内側の 6 倍）。段数で詰める設計で、
    // 詰め方を緩めたらここで止まる。
    const latFromY = (y: number) => (Math.atan(Math.sinh((0.5 - y) * 2 * Math.PI)) * 180) / Math.PI
    const rowLats: number[] = []
    let previous = Number.NaN
    for (let i = 0; i < grid.vertexCount; i++) {
      const lat = vertexAt(i)[3]
      if (lat !== previous) {
        rowLats.push(lat)
        previous = lat
      }
    }
    const errorAt = (i: number) => {
      const a = rowLats[i]
      const b = rowLats[i + 1]
      const midY = (mercatorYOf(a) + mercatorYOf(b)) / 2
      return Math.abs((a + b) / 2 - latFromY(midY))
    }
    let insideWorst = 0
    let polarWorst = 0
    for (let i = 0; i + 1 < rowLats.length; i++) {
      const outside = !isInsideMercator(rowLats[i]) || !isInsideMercator(rowLats[i + 1])
      const e = errorAt(i)
      if (outside) polarWorst = Math.max(polarWorst, e)
      else insideWorst = Math.max(insideWorst, e)
    }
    // 内側の最大は緯度 85 付近の 0.083°（低緯度では 0.002° 未満）。
    expect(insideWorst).toBeLessThan(0.1)
    // 極冠がそれを上回らないこと。上回るなら段数が足りない。
    expect(polarWorst).toBeLessThan(insideWorst * 1.2)
    // 日の入りから天文薄明までの 17.2° に対して 1% 未満であること。
    expect(polarWorst).toBeLessThan(0.18)
  })

  it('同じ行の頂点は緯度が揃い、経度だけが増える', () => {
    let cols = 0
    for (let i = 1; i < grid.vertexCount; i++) {
      if (vertexAt(i)[2] === -180) {
        cols = i
        break
      }
    }
    const lat = vertexAt(0)[3]
    let previousLon = -Infinity
    for (let col = 0; col < cols; col++) {
      const [, , lon, rowLat] = vertexAt(col)
      expect(rowLat).toBe(lat)
      expect(lon).toBeGreaterThan(previousLon)
      previousLon = lon
    }
  })
})
