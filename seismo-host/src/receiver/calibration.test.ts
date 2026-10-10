import { describe, expect, it } from 'vitest'

import { applyCalibration, axesAreIndependent, legacyAxes, resolveCalibration } from './calibration'
import { IDENTITY_MATRIX, defaultSensorCalibration, type Mat3, type SensorCalibration, type Vec3 } from './stationConfigTypes'

/** 3 サンプルぶんの gal 値。軸ごとに違う値にして取り違えに気づけるようにする。 */
function gal(): readonly [readonly number[], readonly number[], readonly number[]] {
  return [
    [10, 20, 30],
    [1, 2, 3],
    [100, 200, 300],
  ]
}

/** 前の形（`a = R × diag(s) × (m − o)`）をそのまま計算する。写した形と比べる相手。 */
function legacyApply(rotation: Mat3, sensitivity: Vec3, offset: Vec3, m: Vec3): Vec3 {
  const x = [(m[0] - offset[0]) * sensitivity[0], (m[1] - offset[1]) * sensitivity[1], (m[2] - offset[2]) * sensitivity[2]]
  return [0, 1, 2].map((r) => rotation[r]![0] * x[0]! + rotation[r]![1] * x[1]! + rotation[r]![2] * x[2]!) as unknown as Vec3
}

function resolved3(orientation: Mat3, sensor: SensorCalibration) {
  const r = resolveCalibration(orientation, sensor)
  if (r === null || r.unmix === null) throw new Error('解けない')
  return { offsets: [r.axes[0]!.offset, r.axes[1]!.offset, r.axes[2]!.offset] as const, unmix: r.unmix }
}

describe('applyCalibration', () => {
  it('対照: 補正なしの軸・単位行列の基板を通すと、元の値と一致する', () => {
    const { offsets, unmix } = resolved3(IDENTITY_MATRIX, defaultSensorCalibration(3))
    expect(applyCalibration(gal(), offsets, unmix)).toEqual(gal().map((axis) => [...axis]))
  })

  it('正: ゼロ点を各サンプルから引き、測る向きの長さで割る', () => {
    const sensor: SensorCalibration = {
      enabled: true,
      noiseDensity: null,
      axes: [
        { vector: [2, 0, 0], offset: 5 },
        { vector: [0, 1, 0], offset: 1 },
        { vector: [0, 0, 0.5], offset: 50 },
      ],
    }
    const { offsets, unmix } = resolved3(IDENTITY_MATRIX, sensor)
    const out = applyCalibration(gal(), offsets, unmix)
    expect(out[0]).toEqual([2.5, 7.5, 12.5])
    expect(out[1]).toEqual([0, 1, 2])
    expect(out[2]).toEqual([100, 300, 500])
  })

  it('正: 基板の向き（Z 軸まわりに 90°）で、基板の X が北を向くなら X の読みが北の成分になる', () => {
    // 列が基板の X・Y・Z の向き: X→北、Y→西、Z→上。
    const orientation: Mat3 = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]
    const { offsets, unmix } = resolved3(orientation, defaultSensorCalibration(3))
    const out = applyCalibration(gal(), offsets, unmix)
    expect(out[0]).toEqual([-1, -2, -3]) // 東 = −Y
    expect(out[1]).toEqual([10, 20, 30]) // 北 = X
    expect(out[2]).toEqual([100, 200, 300])
  })

  it('安全弁: 空の入力（サンプル0件）でも例外を投げず空配列を返す', () => {
    const { offsets, unmix } = resolved3(IDENTITY_MATRIX, defaultSensorCalibration(3))
    expect(applyCalibration([[], [], []], offsets, unmix)).toEqual([[], [], []])
  })
})

describe('legacyAxes（前の形からの写し）', () => {
  const cases: { name: string; rotation: Mat3; sensitivity: Vec3; offset: Vec3 }[] = [
    { name: '既定値', rotation: IDENTITY_MATRIX, sensitivity: [1, 1, 1], offset: [0, 0, 0] },
    {
      name: '実機の 6 面法の値に近い倍率とゼロ点',
      rotation: IDENTITY_MATRIX,
      sensitivity: [1.00321, 0.99784, 1.01277],
      offset: [12.3, -4.56, 38.9],
    },
    {
      name: '傾いた取り付け（鉛直を合わせた回転）',
      rotation: [
        [0.998, -0.012, 0.062],
        [0.008, 0.999, 0.041],
        [-0.063, -0.04, 0.997],
      ],
      sensitivity: [1.002, 0.997, 1.004],
      offset: [3, -2, 7],
    },
    {
      name: '直交でない行列（せん断を含む）',
      rotation: [
        [1, 0, 0],
        [1, 0, 1],
        [0, 1, 0],
      ],
      sensitivity: [2, 3, 1],
      offset: [10, 0, 0],
    },
  ]
  for (const c of cases) {
    it(`正: ${c.name} —— 写した形で解いた加速度が前の式と 1e-12 以内で一致する`, () => {
      const axes = legacyAxes(c.rotation, c.sensitivity, c.offset)
      expect(axes).not.toBeNull()
      const { offsets, unmix } = resolved3(IDENTITY_MATRIX, { enabled: true, noiseDensity: null, axes: axes! })
      for (const m of [
        [10, 1, 100],
        [-981, 3, 0.5],
        [0, 0, 981],
      ] as Vec3[]) {
        const want = legacyApply(c.rotation, c.sensitivity, c.offset, m)
        const got = applyCalibration([[m[0]], [m[1]], [m[2]]], offsets, unmix).map((a) => a[0]!)
        for (let i = 0; i < 3; i++) expect(Math.abs(got[i]! - want[i]!)).toBeLessThan(1e-12 * Math.max(1, Math.abs(want[i]!)))
      }
    })
  }

  it('安全弁: 逆行列を持たない回転行列は写さない', () => {
    const singular: Mat3 = [
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ]
    expect(legacyAxes(singular, [1, 1, 1], [0, 0, 0])).toBeNull()
  })
})

describe('resolveCalibration', () => {
  it('正: 2 軸のセンサーは地面での測る向きを出し、3 成分へは解かない（unmix が無い）', () => {
    const r = resolveCalibration(IDENTITY_MATRIX, defaultSensorCalibration(2))
    expect(r?.unmix).toBeNull()
    expect(r?.axes.map((a) => a.vector)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ])
  })

  it('正: 立てて付けた 2 軸（基板の X と Z を測る）は、基板の向きを掛けた地面の向きになる', () => {
    const sensor: SensorCalibration = {
      enabled: true,
      noiseDensity: null,
      axes: [
        { vector: [1, 0, 0], offset: 0 },
        { vector: [0, 0, 1], offset: 0 },
      ],
    }
    // 基板の X→北・Y→西・Z→上。
    const orientation: Mat3 = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]
    const r = resolveCalibration(orientation, sensor)
    expect(r?.axes[0]!.vector).toEqual([0, 1, 0])
    expect(r?.axes[1]!.vector).toEqual([0, 0, 1])
  })

  it('安全弁: 平行な 2 軸・1 つの面に寄った 3 軸は解けない', () => {
    expect(axesAreIndependent([[1, 0, 0], [2, 0, 0]])).toBe(false)
    expect(axesAreIndependent([[1, 0, 0], [0, 1, 0], [1, 1, 0]])).toBe(false)
    expect(
      resolveCalibration(IDENTITY_MATRIX, {
        enabled: true,
        noiseDensity: null,
        axes: [
          { vector: [1, 0, 0], offset: 0 },
          { vector: [-1, 0, 0], offset: 0 },
        ],
      }),
    ).toBeNull()
  })
})
