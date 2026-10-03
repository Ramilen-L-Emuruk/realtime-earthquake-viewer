import { describe, expect, it } from 'vitest'

import { GAL_PER_G } from '../intensity/units'
import { fitSixFace, FACE_ORDER } from './sixFaceFit'
import type { FitWindow } from './sixFaceFit'
import type { Vec3 } from '../receiver/stationConfigTypes'

/**
 * 校正前の値を作る。**本物のセンサーの逆向き**: 真の加速度 `a` に対し、センサーは
 * `a / s + o` を出す（`calibration.ts` の `(raw - o) * s = a` を解いた形）。
 */
function sensorReads(a: Vec3, offset: Vec3, sensitivity: Vec3): Vec3 {
  return [0, 1, 2].map((i) => a[i]! / sensitivity[i]! + offset[i]!) as unknown as Vec3
}

/** 単位ベクトル `dir` の向きへ 1 g。 */
function g(dir: Vec3): Vec3 {
  const n = Math.hypot(dir[0], dir[1], dir[2])
  return [(dir[0] / n) * GAL_PER_G, (dir[1] / n) * GAL_PER_G, (dir[2] / n) * GAL_PER_G]
}

/** 6 面ぶん。**わざと数度ずつ傾けて置く**（机の上に手で置いた形）。 */
const SIX: readonly Vec3[] = [
  [1, 0.03, -0.02],
  [-1, 0.02, 0.04],
  [0.05, 1, 0.01],
  [-0.03, -1, 0.02],
  [0.02, -0.04, 1],
  [0.01, 0.03, -1],
]

function windowsFor(dirs: readonly Vec3[], offset: Vec3, sensitivity: Vec3): FitWindow[] {
  return dirs.map((d) => ({ meanGal: sensorReads(g(d), offset, sensitivity), sampleCount: 3000 }))
}

/** 実機の 1c8f / i2c0-69 に近いずれ（Z のゼロ点が −315 gal）。 */
const OFFSET: Vec3 = [-82, 5, -315]
const SENS: Vec3 = [1.02, 0.98, 1.01]

describe('fitSixFace', () => {
  it('正: 6 面が揃えば、ゼロ点と感度を軸ごとに戻す（置き方が数度傾いていても）', () => {
    const r = fitSixFace(windowsFor(SIX, OFFSET, SENS))
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    for (const i of [0, 1, 2]) {
      expect(r.offset[i]).toBeCloseTo(OFFSET[i]!, 6)
      expect(r.sensitivity[i]).toBeCloseTo(SENS[i]!, 9)
    }
    expect(r.faces).toEqual({ '+x': true, '-x': true, '+y': true, '-y': true, '+z': true, '-z': true })
    expect(r.poseCount).toBe(6)
  })

  it('正: 同じ面の窓が何本あってもまとめて 1 姿勢として扱う', () => {
    const ws = windowsFor([...SIX, ...SIX, SIX[4]!], OFFSET, SENS)
    const r = fitSixFace(ws)
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    expect(r.poseCount).toBe(6)
    expect(r.offset[2]).toBeCloseTo(OFFSET[2]!, 6)
  })

  it('正: 7 姿勢以上あれば検算の残差が出て、模型どおりなら 0 に近い', () => {
    const r = fitSixFace(windowsFor([...SIX, [1, 1, 1]], OFFSET, SENS))
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    expect(r.poseCount).toBe(7)
    expect(r.maxResidualGal).not.toBeNull()
    expect(r.maxResidualGal!).toBeLessThan(1e-6)
  })

  it('対照: 6 姿勢ちょうどなら残差は出さない（未知数 6 で必ず 0 になり、検算にならない）', () => {
    const r = fitSixFace(windowsFor(SIX, OFFSET, SENS))
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    expect(r.maxResidualGal).toBeNull()
  })

  it('安全弁: 面が欠けていれば計算せず、足りない面を返す', () => {
    const r = fitSixFace(windowsFor(SIX.slice(0, 5), OFFSET, SENS))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('missing-faces')
    expect(r.faces['-z']).toBe(false)
    expect(r.faces['+z']).toBe(true)
  })

  it('安全弁: 窓が 1 つも無ければ全部の面が欠けている', () => {
    const r = fitSixFace([])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('missing-faces')
    expect(FACE_ORDER.every((f) => !r.faces[f])).toBe(true)
  })

  it('安全弁: 模型に合わない姿勢が混ざれば、残差が大きいとして拒む', () => {
    // 7 本目だけ 5% 長い（別のセンサーの値が紛れた・揺れていた窓が通った、を模す）。
    const ws = windowsFor([...SIX, [1, 1, 1]], OFFSET, SENS)
    const bad = ws[6]!.meanGal
    ws[6] = { ...ws[6]!, meanGal: [bad[0] * 1.05, bad[1] * 1.05, bad[2] * 1.05] }
    const r = fitSixFace(ws)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('residual-too-large')
  })

  it('安全弁: 出た値が MPU6050 の個体差では説明できないほど外れていれば拒む', () => {
    // X が 2.5 倍に出る形（レンジの取り違えを模す。面は揃うので、範囲の判定まで届く）。
    const r = fitSixFace(windowsFor(SIX, [0, 0, 0], [0.4, 1, 1]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('out-of-range')
  })

  it('安全弁: 読めない値の混ざった窓は使わない', () => {
    const ws = windowsFor(SIX, OFFSET, SENS)
    ws.push({ meanGal: [Number.NaN, 0, GAL_PER_G], sampleCount: 3000 })
    const r = fitSixFace(ws)
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    expect(r.offset[2]).toBeCloseTo(OFFSET[2]!, 6)
  })
})
