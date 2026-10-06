// 3x3 の行列の計算（行列式・逆行列・逆行列を持つかの判定）。
//
// **設定の検証（`stationConfig.ts`）と履歴の書き出し（`stationXml.ts`）が同じ判定を通す。**
// 別々に持つと、検証を通った回転行列を履歴が書けない（あるいはその逆の）すき間ができる。
// Node 専用のコードを持たない（管理コンソールからも読めるように）。

import type { Mat3 } from './stationConfigTypes'

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
 * 回転行列が逆行列を持つと言えるか。**列の長さで割った行列式（アダマール比）で見る** ——
 * 行列式そのものは列の長さに比例するので、倍率を含む行列では閾値が決められない。
 */
export function isInvertibleRotation(m: Mat3): boolean {
  const norm = (j: number): number => Math.hypot(m[0][j], m[1][j], m[2][j])
  const scale = norm(0) * norm(1) * norm(2)
  if (!Number.isFinite(scale) || scale === 0) return false
  return Math.abs(det3(m)) / scale >= MIN_HADAMARD_RATIO
}
