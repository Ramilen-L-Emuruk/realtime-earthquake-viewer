import { describe, expect, it } from 'vitest'

import { solveGravity, solveLinear, type GravityReading } from './gravityLeastSquares'

/** 真の重力 `g` を、向き `vector`・ゼロ点 `offset` の軸で読んだ値。 */
function read(vector: readonly number[], offset: number, g: readonly number[]): GravityReading {
  return { vector, offset, value: vector[0]! * g[0]! + vector[1]! * g[1]! + vector[2]! * g[2]! + offset }
}

function expectClose(got: readonly number[] | null, want: readonly number[]): void {
  expect(got).not.toBeNull()
  got!.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 9))
}

describe('solveGravity', () => {
  const g = [120, -340, 905]

  it('正: 3 軸 1 個なら、ゼロ点を引いてその 3 軸を解いた値になる（倍率・斜めの軸も込み）', () => {
    const readings = [read([1.02, 0, 0], 15, g), read([0.03, 0.98, 0], -40, g), read([0, 0.05, 1.1], 220, g)]
    expectClose(solveGravity(readings), g)
  })

  it('正: 2 軸のセンサー 2 個でも、軸が 3 方向へ散っていれば一緒に解ける', () => {
    const readings = [read([1, 0, 0], 3, g), read([0, 1, 0], -2, g), read([0, 0.7, 0.7], 5, g), read([0.7, 0, -0.7], 1, g)]
    expectClose(solveGravity(readings), g)
  })

  it('正: 式が未知数より多ければ最小二乗で解く（読みのずれを両側へ分ける）', () => {
    // 上向きの軸 2 本が 900 と 910 を読む。真ん中の 905 になる。
    const readings: GravityReading[] = [
      { vector: [1, 0, 0], offset: 0, value: 0 },
      { vector: [0, 1, 0], offset: 0, value: 0 },
      { vector: [0, 0, 1], offset: 0, value: 900 },
      { vector: [0, 0, 1], offset: 0, value: 910 },
    ]
    expectClose(solveGravity(readings), [0, 0, 905])
  })

  it('対照: 軸が 1 つの面に寄っていれば解けない', () => {
    const readings = [read([1, 0, 0], 0, g), read([0, 1, 0], 0, g), read([1, 1, 0], 0, g)]
    expect(solveGravity(readings)).toBeNull()
  })

  it('対照: 材料が無ければ解けない', () => {
    expect(solveGravity([])).toBeNull()
  })

  it('安全弁: 1 本だけ桁違いに短い軸があると、その向きは決まらないとして解かない', () => {
    // 向きは 3 方向へ散っているが、Z の長さが 10⁻⁷（正規方程式の対角では 10⁻¹⁴）。
    const readings = [read([1, 0, 0], 0, g), read([0, 1, 0], 0, g), { vector: [0, 0, 1e-7], offset: 0, value: 980 }]
    expect(solveGravity(readings)).toBeNull()
  })
})

describe('solveLinear', () => {
  it('正: 部分ピボットで解く（先頭の対角が 0 でも入れ替えて解ける）', () => {
    expect(solveLinear([[0, 1], [1, 0]], [2, 3])).toEqual([3, 2])
  })

  it('対照: 渡した行列と右辺は書き換えない', () => {
    const a = [[2, 1], [1, 3]]
    const b = [3, 5]
    solveLinear(a, b)
    expect(a).toEqual([[2, 1], [1, 3]])
    expect(b).toEqual([3, 5])
  })

  it('安全弁: ピボットが対角の最大の 1e-12 倍に届かなければ null', () => {
    expect(solveLinear([[1, 0], [0, 1e-13]], [1, 1])).toBeNull()
    expect(solveLinear([[1, 0], [0, 1e-11]], [1, 1])).not.toBeNull()
  })
})
