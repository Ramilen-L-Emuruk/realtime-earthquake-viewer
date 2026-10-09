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
