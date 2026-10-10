import { describe, expect, it } from 'vitest'

import { eigenSym3, minEigenvalueSym3 } from './matrix3'
import type { Mat3 } from './stationConfigTypes'

/** 向き（長さ 1 でなくてよい）を並べた行から `Σ d dᵀ` を作る。 */
function gram(rows: readonly (readonly [number, number, number])[]): Mat3 {
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (const d of rows) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r]![c]! += d[r] * d[c]
  return m as unknown as Mat3
}

describe('minEigenvalueSym3', () => {
  it('正: 対角行列なら対角の最小', () => {
    expect(minEigenvalueSym3([
      [3, 0, 0],
      [0, 0.5, 0],
      [0, 0, 2],
    ])).toBeCloseTo(0.5, 12)
  })

  it('正: 東・北・上を 1 本ずつ測る並びは 1', () => {
    expect(minEigenvalueSym3(gram([[1, 0, 0], [0, 1, 0], [0, 0, 1]]))).toBeCloseTo(1, 12)
  })

  it('正: 回した直交の 3 本でも 1（向きの選び方によらない）', () => {
    const c = Math.cos(0.7)
    const s = Math.sin(0.7)
    expect(minEigenvalueSym3(gram([[c, s, 0], [-s, c, 0], [0, 0, 1]]))).toBeCloseTo(1, 12)
  })

  it('対照: 水平の 2 本だけなら上の向きが測れず 0', () => {
    expect(minEigenvalueSym3(gram([[1, 0, 0], [0, 1, 0]]))).toBeCloseTo(0, 12)
  })

  it('正: 平面から θ だけ外れた 1 本を足すと、最小は sin²θ に近い', () => {
    const t = 0.2
    // 東・北に加えて、東から上へ θ 傾けた 1 本。外れた向きの情報は sin²θ を東と分け合う。
    const v = minEigenvalueSym3(gram([[1, 0, 0], [0, 1, 0], [Math.cos(t), 0, Math.sin(t)]]))
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(Math.sin(t) ** 2)
  })

  it('安全弁: 数でない値を含むなら NaN（解けるとは言わない）', () => {
    expect(minEigenvalueSym3([
      [1, 0, 0],
      [0, Number.NaN, 0],
      [0, 0, 1],
    ])).toBeNaN()
  })
})

describe('eigenSym3', () => {
  /** `V diag(λ) Vᵀ` で組み直す。 */
  function rebuild(e: NonNullable<ReturnType<typeof eigenSym3>>): number[][] {
    const out = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]
    e.vectors.forEach((v, k) => {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r]![c]! += e.values[k]! * v[r] * v[c]
    })
    return out
  }

  it('正: 小さい順に並べ、組み直すと元の行列に戻る（向きは長さ 1 で互いに直交）', () => {
    const m = gram([
      [1, 0.2, 0],
      [0.1, 1, 0.3],
      [0, 0.4, 0.2],
    ])
    const e = eigenSym3(m)
    expect(e).not.toBeNull()
    expect(e!.values[0]).toBeLessThanOrEqual(e!.values[1]!)
    expect(e!.values[1]).toBeLessThanOrEqual(e!.values[2]!)
    const back = rebuild(e!)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) expect(back[r]![c]).toBeCloseTo(m[r]![c]!, 10)
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        const d = e!.vectors[a]!.reduce((s, x, i) => s + x * e!.vectors[b]![i]!, 0)
        expect(d).toBeCloseTo(a === b ? 1 : 0, 10)
      }
    }
  })

  it('対照: 最小の固有値は閉じた式（minEigenvalueSym3）と一致する', () => {
    const m = gram([
      [1, 0, 0],
      [0, 1, 0],
      [Math.cos(0.2), 0, Math.sin(0.2)],
    ])
    expect(eigenSym3(m)!.values[0]).toBeCloseTo(minEigenvalueSym3(m), 10)
  })

  it('正: 水平の 2 本だけなら、いちばん小さい固有値 0 の向きは上', () => {
    const e = eigenSym3(gram([
      [1, 0, 0],
      [0, 1, 0],
    ]))!
    expect(e.values[0]).toBeCloseTo(0, 12)
    expect(Math.abs(e.vectors[0]![2])).toBeCloseTo(1, 10)
  })

  it('安全弁: 数でない値を含むなら null', () => {
    expect(eigenSym3([
      [1, 0, 0],
      [0, Number.POSITIVE_INFINITY, 0],
      [0, 0, 1],
    ])).toBeNull()
  })
})
