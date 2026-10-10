// 3x3 の行列の計算（行列式・逆行列・逆行列を持つかの判定）。
//
// **設定の検証（`stationConfig.ts`）と履歴の書き出し（`stationXml.ts`）が同じ判定を通す。**
// 別々に持つと、検証を通った回転行列を履歴が書けない（あるいはその逆の）すき間ができる。
// Node 専用のコードを持たない（管理コンソールからも読めるように）。

import type { Mat3, Vec3 } from './stationConfigTypes'

export function det3(m: Mat3): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  )
}

/** 逆行列。**行列式が 0（または数でない）なら `null`。** ほぼ特異かどうかは `isInvertibleRotation` で見る。 */
export function invert3(m: Mat3): Mat3 | null {
  const d = det3(m)
  if (!Number.isFinite(d) || d === 0) return null
  const c = (r0: number, c0: number, r1: number, c1: number): number => m[r0][c0] * m[r1][c1] - m[r0][c1] * m[r1][c0]
  return [
    [c(1, 1, 2, 2) / d, -c(0, 1, 2, 2) / d, c(0, 1, 1, 2) / d],
    [-c(1, 0, 2, 2) / d, c(0, 0, 2, 2) / d, -c(0, 0, 1, 2) / d],
    [c(1, 0, 2, 1) / d, -c(0, 0, 2, 1) / d, c(0, 0, 1, 1) / d],
  ]
}

/**
 * 逆行列を持つと言える最小のアダマール比。純粋な回転なら 1、列のどれかが他の 2 本の
 * 張る面へ寄るほど 0 へ近づく。**ここを下回る行列は、その向きの揺れをほぼ消す。**
 */
const MIN_HADAMARD_RATIO = 1e-6

/**
 * 行列が逆行列を持つと言えるか。**列の長さで割った行列式（アダマール比）で見る** ——
 * 行列式そのものは列の長さに比例するので、倍率を含む行列では閾値が決められない。
 * 行列式は転置しても変わらないので、行の長さで割っても同じ判定になる（行と列で比の値は
 * 違いうるが、どちらも 0 になるのは特異なときだけ）。
 */
export function isInvertibleRotation(m: Mat3): boolean {
  const norm = (j: number): number => Math.hypot(m[0][j], m[1][j], m[2][j])
  const scale = norm(0) * norm(1) * norm(2)
  if (!Number.isFinite(scale) || scale === 0) return false
  return Math.abs(det3(m)) / scale >= MIN_HADAMARD_RATIO
}

/**
 * 2 本の向きが平行でないと言えるか。**長さで割った外積の大きさ（挟む角の sin）で見る** ——
 * 3 本のときのアダマール比と同じ閾値を使う。
 */
export function isIndependentPair(a: Vec3, b: Vec3): boolean {
  const scale = Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2])
  if (!Number.isFinite(scale) || scale === 0) return false
  return Math.hypot(...cross3(a, b)) / scale >= MIN_HADAMARD_RATIO
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function transpose3(m: Mat3): Mat3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ]
}

export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const cell = (r: number, c: number): number => a[r]![0] * b[0][c] + a[r]![1] * b[1][c] + a[r]![2] * b[2][c]
  return [
    [cell(0, 0), cell(0, 1), cell(0, 2)],
    [cell(1, 0), cell(1, 1), cell(1, 2)],
    [cell(2, 0), cell(2, 1), cell(2, 2)],
  ]
}

export function multiplyMatVec3(m: Mat3, v: Vec3): Vec3 {
  return [dot3(m[0], v), dot3(m[1], v), dot3(m[2], v)]
}

/**
 * 純粋な回転と見なせる値の幅（`BᵀB` の各成分と単位行列の差）。**丸めた行列・前に提案した行列も
 * 受ける** —— 実機の設定の履歴に残る鉛直合わせの行列（2026-10-03）は非対角で 1.8e-4 ずれている。
 * 一方、軸の倍率の個体差は 0.5% 前後あるので、1e-3 なら倍率を基板の向きへ紛れ込ませた値は通らない。
 */
const ROTATION_TOLERANCE = 1e-3

/** 純粋な回転か（`BᵀB = I`・行列式が正）。**幅は `ROTATION_TOLERANCE`。** */
export function isProperRotation(m: Mat3): boolean {
  if (!m.every((row) => row.every((x) => Number.isFinite(x)))) return false
  const g = multiplyMat3(transpose3(m), m)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs(g[r]![c]! - (r === c ? 1 : 0)) > ROTATION_TOLERANCE) return false
    }
  }
  return det3(m) > 0
}

/**
 * 対称な 3x3 行列のいちばん小さい固有値。**数でない値を含むなら NaN。**
 *
 * 観測点の合成（`sensorFusion.ts`）が「測る向きがどれだけ 3 方向へ散っているか」を測るのに使う
 * （向きを並べた `Σ d dᵀ` の最小固有値が、いちばん測られていない方向の情報量になる）。
 * 閉じた式（Smith 1961）で解く —— 反復を回さないので、目盛り 1 点ごとに呼んでも重くない。
 * **対称であることは確かめない**（上三角だけを読む）。
 */
export function minEigenvalueSym3(m: Mat3): number {
  const a00 = m[0][0]
  const a11 = m[1][1]
  const a22 = m[2][2]
  const a01 = m[0][1]
  const a02 = m[0][2]
  const a12 = m[1][2]
  if (![a00, a11, a22, a01, a02, a12].every((x) => Number.isFinite(x))) return Number.NaN
  const p1 = a01 * a01 + a02 * a02 + a12 * a12
  if (p1 === 0) return Math.min(a00, a11, a22)
  const q = (a00 + a11 + a22) / 3
  const p2 = (a00 - q) ** 2 + (a11 - q) ** 2 + (a22 - q) ** 2 + 2 * p1
  const p = Math.sqrt(p2 / 6)
  const b: Mat3 = [
    [(a00 - q) / p, a01 / p, a02 / p],
    [a01 / p, (a11 - q) / p, a12 / p],
    [a02 / p, a12 / p, (a22 - q) / p],
  ]
  // 丸めで ±1 をわずかに越えることがあるので詰める（越えたまま acos へ渡すと NaN になる）。
  const r = Math.max(-1, Math.min(1, det3(b) / 2))
  const phi = Math.acos(r) / 3
  return q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3)
}

/** {@link eigenSym3} の答え。`values` は小さい順、`vectors[k]` が `values[k]` の向き（長さ 1・互いに直交）。 */
export interface SymEigen3 {
  readonly values: readonly [number, number, number]
  readonly vectors: readonly [Vec3, Vec3, Vec3]
}

/** Jacobi 法の回転を回す上限。3x3 なら 10 回もかからず収まる（非対角が丸め誤差の大きさまで落ちる）。 */
const JACOBI_MAX_SWEEPS = 50

/**
 * 対称な 3x3 行列の固有値と固有の向き。**数でない値を含むなら null。**
 *
 * 観測点の合成（`sensorFusion.ts`）が、測る向きの散らばりから「解けない向き」を取り出すのに使う
 * （値だけなら {@link minEigenvalueSym3} の閉じた式で足りるが、向きが要る）。Jacobi 法で解く ——
 * 収まりが速く、向きが互いに直交したまま出てくる。**対称であることは確かめない**（上三角だけを読む）。
 */
export function eigenSym3(m: Mat3): SymEigen3 | null {
  const a = [
    [m[0][0], m[0][1], m[0][2]],
    [m[0][1], m[1][1], m[1][2]],
    [m[0][2], m[1][2], m[2][2]],
  ]
  if (!a.every((row) => row.every((x) => Number.isFinite(x)))) return null
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  const scale = Math.max(1e-300, ...a.flat().map((x) => Math.abs(x)))
  for (let sweep = 0; sweep < JACOBI_MAX_SWEEPS; sweep++) {
    const off = Math.abs(a[0]![1]!) + Math.abs(a[0]![2]!) + Math.abs(a[1]![2]!)
    if (off <= scale * 1e-15) break
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p]![q]!
      if (apq === 0) continue
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq)
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1)
      const s = t * c
      for (let k = 0; k < 3; k++) {
        const akp = a[k]![p]!
        const akq = a[k]![q]!
        a[k]![p] = c * akp - s * akq
        a[k]![q] = s * akp + c * akq
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p]![k]!
        const aqk = a[q]![k]!
        a[p]![k] = c * apk - s * aqk
        a[q]![k] = s * apk + c * aqk
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k]![p]!
        const vkq = v[k]![q]!
        v[k]![p] = c * vkp - s * vkq
        v[k]![q] = s * vkp + c * vkq
      }
    }
  }
  const order = [0, 1, 2].sort((x, y) => a[x]![x]! - a[y]![y]!)
  const vec = (k: number): Vec3 => [v[0]![k]!, v[1]![k]!, v[2]![k]!]
  return {
    values: [a[order[0]!]![order[0]!]!, a[order[1]!]![order[1]!]!, a[order[2]!]![order[2]!]!],
    vectors: [vec(order[0]!), vec(order[1]!), vec(order[2]!)],
  }
}
