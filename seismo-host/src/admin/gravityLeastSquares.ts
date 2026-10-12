// 軸の向きとゼロ点が分かっているとき、静止して読んだ値から重力を最小二乗で解く。
//
// ```
// 軸 j:   m_j = h_j · g + o_j      →      (Σ h hᵀ) g = Σ h (m − o)
// ```
//
// **「鉛直を合わせる」（`calibrationSuggest.ts` の `boardGravityForTilt`）と、基板の 6 面法の姿勢ごとの重力
// （`boardSixFace.ts` の `poseDirection`）が同じ式を解く。** 別々に持つと、片方だけ直したときに食い違うので、
// ここに 1 つだけ置く。どちらも基板に載った全部のセンサーの全部の軸を一緒に入れる（2 軸のセンサーも入る）。
//
// **単位は渡した値のまま**（gal で渡せば gal、g で渡せば g で返る）。
//
// **Node 専用のコードを持たない**（管理コンソールが使う）。

import type { Vec3 } from '../receiver/stationConfigTypes'

/** 軸 1 本ぶんの材料。 */
export interface GravityReading {
  /** 軸の測る向き（基板の座標）。**長さが倍率。** */
  readonly vector: readonly number[]
  /** ゼロ点。 */
  readonly offset: number
  /** 静止して読んだ値（校正前）。 */
  readonly value: number
}

/**
 * n×n の連立方程式を部分ピボットつきの消去法で解く。**ピボットが対角の最大の `1e-12` 倍に届かなければ
 * 解けないとして null**（向きの散り方が足りない・未知数が式で決まらない）。`a`・`b` は書き換えない。
 */
export function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]!])
  let maxDiag = 0
  for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, Math.abs(a[i]![i]!))
  const tiny = maxDiag * 1e-12
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r
    if (!(Math.abs(m[pivot]![col]!) > tiny)) return null
    ;[m[col], m[pivot]] = [m[pivot]!, m[col]!]
    for (let r = col + 1; r < n; r++) {
      const f = m[r]![col]! / m[col]![col]!
      if (f === 0) continue
      for (let k = col; k <= n; k++) m[r]![k]! -= f * m[col]![k]!
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = m[i]![n]!
    for (let k = i + 1; k < n; k++) s -= m[i]![k]! * x[k]!
    x[i] = s / m[i]![i]!
  }
  return x.every(Number.isFinite) ? x : null
}

/**
 * 重力を解く。**長さは揃えない**（倍率の確かめ・向きだけ使うかは呼ぶ側が決める）。
 *
 * **解けなければ null**（軸が 1 つの面に寄っている・軸の長さが桁で食い違う・材料が無い）。どれにあたるかは
 * 見分けない —— 散り具合を確かめたい呼び出し元は、向きだけで作った物差しを自分で持つ（`directionInfo.ts`）。
 */
export function solveGravity(readings: readonly GravityReading[]): Vec3 | null {
  const n: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const b = [0, 0, 0]
  for (const r of readings) {
    const h = r.vector
    const d = r.value - r.offset
    for (let i = 0; i < 3; i++) {
      b[i]! += h[i]! * d
      for (let k = 0; k < 3; k++) n[i]![k]! += h[i]! * h[k]!
    }
  }
  const g = solveLinear(n, b)
  return g === null ? null : [g[0]!, g[1]!, g[2]!]
}
