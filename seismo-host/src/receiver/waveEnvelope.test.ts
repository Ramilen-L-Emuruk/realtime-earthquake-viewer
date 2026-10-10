import { describe, expect, it } from 'vitest'

import type { ArchivedWaveChunk } from './waveArchive'
import { buildWaveEnvelope } from './waveEnvelope'

const T0 = Date.parse('2026-09-25T14:00:00.000Z')

function chunk(params: {
  firstSampleMs?: number
  msPerSample?: number
  ns: readonly number[]
  ew?: readonly number[]
  ud?: readonly number[]
  members?: readonly number[]
}): ArchivedWaveChunk {
  const n = params.ns.length
  return {
    firstSampleMs: params.firstSampleMs ?? T0,
    msPerSample: params.msPerSample ?? 10,
    gal: [
      Float32Array.from(params.ns),
      Float32Array.from(params.ew ?? params.ns),
      Float32Array.from(params.ud ?? params.ns),
    ],
    dcGal: [0, 0, 980],
    memberCount: Uint8Array.from(params.members ?? new Array(n).fill(3)),
    revised: false,
  }
}

describe('buildWaveEnvelope', () => {
  it('列ごとに上下の端を取る（間引かない）', () => {
    // 10ms 刻みで 10 点、100ms を 2 列に落とす。前半に単発の跳ね上がりを置く。
    const got = buildWaveEnvelope({
      chunks: [chunk({ ns: [0, 0, 50, 0, 0, 0, 0, 0, 0, 0] })],
      fromMs: T0,
      toMs: T0 + 100,
      columnCount: 2,
    })
    expect(got.columns).toHaveLength(2)
    // **間引く形ならここで消えている。** 2 点目以外を見ない実装では 50 が拾えない。
    expect(got.columns[0]?.max[0]).toBe(50)
    expect(got.columns[0]?.min[0]).toBe(0)
    expect(got.peakGal).toBe(50)
  })

  it('値の無い列は null で返す', () => {
    const got = buildWaveEnvelope({
      chunks: [chunk({ ns: [1, 2] })],
      fromMs: T0,
      toMs: T0 + 100,
      columnCount: 4,
    })
    expect(got.columns[0]).not.toBeNull()
    expect(got.columns[3]).toBeNull()
    expect(got.hasAnyValue).toBe(true)
  })

  it('正（2026-10-09 に覆した）: 1 成分だけ読めないサンプルは、読めた成分だけを列へ入れる', () => {
    // 観測点の合成が、解けない成分だけを NaN にして残りを出すようになった（2026-10-09 ユーザー承認）。
    // 以前は 1 成分でも読めなければサンプルごと捨てていた。
    const got = buildWaveEnvelope({
      chunks: [chunk({ ns: [Number.NaN], ew: [5], ud: [-3] })],
      fromMs: T0,
      toMs: T0 + 100,
      columnCount: 1,
    })
    // `chunk()` は 1 番目の成分へ `ns` を入れる（読めない成分）。
    expect(got.columns[0]?.max[1]).toBe(5)
    expect(got.columns[0]?.min[2]).toBe(-3)
    expect(got.columns[0]?.min[0]).toBeNaN()
    expect(got.columns[0]?.max[0]).toBeNaN()
    expect(got.hasAnyValue).toBe(true)
    expect(got.peakGal).toBe(5)
  })

  it('対照: 3 成分とも読めないサンプルだけの列は、列ごと値を持たない', () => {
    const got = buildWaveEnvelope({
      chunks: [chunk({ ns: [Number.NaN], ew: [Number.NaN], ud: [Number.NaN] })],
      fromMs: T0,
      toMs: T0 + 100,
      columnCount: 1,
    })
    expect(got.columns[0]).toBeNull()
    expect(got.hasAnyValue).toBe(false)
    expect(got.peakGal).toBe(0)
  })

  it('安全弁: 読めない成分が JSON では null になる（受け手が「無い」と読める形）', () => {
    const got = buildWaveEnvelope({
      chunks: [chunk({ ns: [Number.NaN], ew: [5], ud: [5] })],
      fromMs: T0,
      toMs: T0 + 100,
      columnCount: 1,
    })
    expect(JSON.parse(JSON.stringify(got.columns[0])).min).toEqual([null, 5, 5])
  })

  it('範囲の右端のサンプルも最後の列へ入れる', () => {
    const got = buildWaveEnvelope({
      chunks: [chunk({ firstSampleMs: T0 + 100, ns: [7] })],
      fromMs: T0,
      toMs: T0 + 100,
      columnCount: 2,
    })
    // **素直に割るとここが範囲外の列へ落ちて、いちばん新しい値が消える。**
    expect(got.columns[1]?.max[0]).toBe(7)
  })

  it('範囲の外のサンプルは入れない', () => {
    const got = buildWaveEnvelope({
      chunks: [chunk({ firstSampleMs: T0 - 1_000, ns: [99] })],
      fromMs: T0,
      toMs: T0 + 100,
      columnCount: 2,
    })
    expect(got.hasAnyValue).toBe(false)
  })

  it('効いた本数はいちばん少ないものを採る', () => {
    const got = buildWaveEnvelope({
      chunks: [chunk({ ns: [1, 2, 3], members: [3, 1, 3] })],
      fromMs: T0,
      toMs: T0 + 100,
      columnCount: 1,
    })
    expect(got.columns[0]?.minMembers).toBe(1)
  })

  it('まとまりを跨いでも同じ列へまとめる', () => {
    const got = buildWaveEnvelope({
      chunks: [
        chunk({ firstSampleMs: T0, ns: [1] }),
        chunk({ firstSampleMs: T0 + 10, ns: [9] }),
      ],
      fromMs: T0,
      toMs: T0 + 100,
      columnCount: 1,
    })
    expect(got.columns[0]?.min[0]).toBe(1)
    expect(got.columns[0]?.max[0]).toBe(9)
  })

  it('1 列の幅を返す（受け手に割り算をさせない）', () => {
    const got = buildWaveEnvelope({ chunks: [], fromMs: T0, toMs: T0 + 300, columnCount: 3 })
    expect(got.fromMs).toBe(T0)
    expect(got.columnSpanMs).toBe(100)
  })

  it('幅が無い・列が無い問い合わせでは何も作らない', () => {
    expect(buildWaveEnvelope({ chunks: [], fromMs: T0, toMs: T0, columnCount: 3 }).columns).toHaveLength(0)
    expect(buildWaveEnvelope({ chunks: [], fromMs: T0, toMs: T0 + 100, columnCount: 0 }).columns).toHaveLength(0)
  })
})
