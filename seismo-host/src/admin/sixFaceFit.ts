// 6 面法（REQUIREMENTS.md §16）: 基板を 6 方向へ向けて静止させた窓から、センサーの
// ゼロ点（`offset`）と感度（`sensitivity`）を軸ごとに出す。
//
// **使うのは校正を掛ける前の値**（`gravityCheck.ts` の `RestWindow`）。出す値は
// 「いまの設定を置き換える値」で、いまの設定に上乗せするものではない。
//
// **当てはめは「どの姿勢でも長さが 1 g」という条件で解く。** 各軸の ＋ と − の差を
// 2 g で割る素朴な形は、置き方が θ 傾けば cos θ だけ感度を見誤る（5 度で 0.4%）。
// 長さの条件なら傾きは打ち消し合うので、机の上に手で置く精度で足りる。
//
//   Σ_i A_i x_i² + Σ_i B_i x_i = 1     （x は校正前の値を g 単位で・A, B が未知数 6 つ）
//
// を姿勢ごとに 1 本立てて最小二乗で解き、`offset_i = −B_i / (2 A_i)`、
// `sensitivity_i = √(A_i / G)`（`G = 1 + Σ A_i offset_i²`）へ戻す —— 式を
// `Σ (A_i / G)(x_i − offset_i)² = 1` と書き直すと、校正後の長さが 1 g になる倍率がこれ。
//
// **決めないもの:** 軸どうしの直角のずれ（§16 で未決）と、取り付けの向き（`rotation`）。
// 向きは、校正を保存して元の場所へ据え直してから「鉛直を合わせる」で出し直す。

import { GAL_PER_G } from '../intensity/units'
import type { Vec3 } from '../receiver/stationConfigTypes'

/** 当てはめに使う静止窓 1 つ。 */
export interface FitWindow {
  /** 校正前の軸ごとの平均（gal）。 */
  readonly meanGal: Vec3
  /** まとめるときの重み。 */
  readonly sampleCount: number
}

export type Face = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'

/** 画面に並べる順。 */
export const FACE_ORDER: readonly Face[] = ['+x', '-x', '+y', '-y', '+z', '-z']

export type FaceCoverage = Readonly<Record<Face, boolean>>

export interface SixFaceFit {
  readonly ok: true
  readonly offset: Vec3
  readonly sensitivity: Vec3
  readonly faces: FaceCoverage
  /** まとめた後の姿勢の数。 */
  readonly poseCount: number
  /**
   * 各姿勢で、校正後の長さが 1 g からどれだけ離れたかの最大（gal）。
   *
   * **6 姿勢ちょうどのときは null。** 未知数も 6 つなので必ず 0 に解け、検算にならない。
   * 7 姿勢目（斜めに置いた 1 回など）があって初めて意味を持つ。
   */
  readonly maxResidualGal: number | null
}

export type SixFaceRefusalReason =
  /** 6 面のどれかが揃っていない。 */
  | 'missing-faces'
  /** 連立方程式が解けない・解が物理的に意味を持たない（長さの条件が成り立たない）。 */
  | 'degenerate'
  /** 出た値が MPU6050 の個体差として説明できない幅にある。 */
  | 'out-of-range'
  /** 検算の残差が大きい（揺れていた窓や、別の値が混ざっている疑い）。 */
  | 'residual-too-large'

export interface SixFaceRefusal {
  readonly ok: false
  readonly reason: SixFaceRefusalReason
  readonly faces: FaceCoverage
  /** `residual-too-large` のときの残差（gal）。それ以外は null。 */
  readonly maxResidualGal: number | null
}

/**
 * 同じ姿勢とみなす向きの差（度）。
 *
 * 面どうしは 90 度離れている。手で置き直したときのぶれ（数度）より十分大きく、
 * 隣の面より十分小さい値。**ゼロ点がずれていても向きは大きく変わらない**
 * （実機の最大 −315 gal でも、1 g に対して 20 度に届かない）。
 */
const SAME_POSE_DEG = 25

/**
 * その面に置いたとみなす、その軸の成分の下限（1 g に対する比）。
 *
 * ゼロ点が −0.32 g ずれた実機の上向き軸でも 0.68 g 出るので、その下に置く。
 */
const FACE_MIN_RATIO = 0.5

/**
 * 受け入れる値の幅。**画面の文言もここから引く**（書き写すと、片方だけ変えたときに食い違う）。
 *
 * 感度は MPU6050 の個体差（±3%）と実機の外れ方より十分広く、桁の誤りは弾く。
 * ゼロ点は 1 g に対する比で、実機の最大は 0.32 g。
 */
export const SIX_FACE_LIMITS = {
  sensitivityMin: 0.5,
  sensitivityMax: 2,
  offsetMaxGal: GAL_PER_G * 0.5,
} as const

/**
 * 検算の残差の上限（1 g に対する比）。
 *
 * 静止した窓の平均のぶれは 0.1 gal に満たないが、軸どうしの直角のずれ（MPU6050 で ±2%）は
 * この模型に入っていないので、斜めの姿勢ではその分が残差に出る。それを超える分は
 * 窓のほうが疑わしい。
 */
const RESIDUAL_MAX_RATIO = 0.02

interface Pose {
  sum: [number, number, number]
  weight: number
}

function norm(v: readonly number[]): number {
  return Math.hypot(v[0]!, v[1]!, v[2]!)
}

function meanOf(p: Pose): Vec3 {
  return [p.sum[0] / p.weight, p.sum[1] / p.weight, p.sum[2] / p.weight]
}

/** 向きが近い窓を 1 つの姿勢へまとめる。 */
function groupPoses(windows: readonly FitWindow[]): Vec3[] {
  const cosLimit = Math.cos((SAME_POSE_DEG * Math.PI) / 180)
  const poses: Pose[] = []
  for (const w of windows) {
    const m = w.meanGal
    if (!m.every(Number.isFinite) || !(w.sampleCount > 0)) continue
    const n = norm(m)
    if (!(n > 0)) continue
    let home: Pose | null = null
    for (const p of poses) {
      const c = meanOf(p)
      const cos = (c[0] * m[0] + c[1] * m[1] + c[2] * m[2]) / (norm(c) * n)
      if (cos >= cosLimit) {
        home = p
        break
      }
    }
    if (home === null) {
      home = { sum: [0, 0, 0], weight: 0 }
      poses.push(home)
    }
    for (const i of [0, 1, 2] as const) home.sum[i] += m[i] * w.sampleCount
    home.weight += w.sampleCount
  }
  return poses.map(meanOf)
}

function coverageOf(poses: readonly Vec3[]): FaceCoverage {
  const min = GAL_PER_G * FACE_MIN_RATIO
  const has = (axis: 0 | 1 | 2, sign: 1 | -1) => poses.some((p) => p[axis] * sign >= min)
  return {
    '+x': has(0, 1),
    '-x': has(0, -1),
    '+y': has(1, 1),
    '-y': has(1, -1),
    '+z': has(2, 1),
    '-z': has(2, -1),
  }
}

/** 6×6 の連立方程式を部分ピボットつきの消去法で解く。解けなければ null。 */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]!])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r
    if (!(Math.abs(m[pivot]![col]!) > 1e-300)) return null
    ;[m[col], m[pivot]] = [m[pivot]!, m[col]!]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = m[r]![col]! / m[col]![col]!
      for (let k = col; k <= n; k++) m[r]![k]! -= f * m[col]![k]!
    }
  }
  const x = m.map((row, i) => row[n]! / row[i]!)
  return x.every(Number.isFinite) ? x : null
}

/**
 * 静止窓からゼロ点と感度を出す。**投げない。** 出せなければ理由を返す。
 */
export function fitSixFace(windows: readonly FitWindow[]): SixFaceFit | SixFaceRefusal {
  const poses = groupPoses(windows)
  const faces = coverageOf(poses)
  if (!FACE_ORDER.every((f) => faces[f])) return { ok: false, reason: 'missing-faces', faces, maxResidualGal: null }

  // **桁を揃えてから解く。** x² が 10⁶、x が 10³ の列を並べると正規方程式の桁が 10¹² 離れる。
  const unit = GAL_PER_G
  const rows = poses.map((p) => {
    const x = p.map((v) => v / unit)
    return [x[0]! * x[0]!, x[1]! * x[1]!, x[2]! * x[2]!, x[0]!, x[1]!, x[2]!]
  })
  const ata = Array.from({ length: 6 }, (_, i) =>
    Array.from({ length: 6 }, (_, j) => rows.reduce((s, r) => s + r[i]! * r[j]!, 0)),
  )
  const atb = Array.from({ length: 6 }, (_, i) => rows.reduce((s, r) => s + r[i]!, 0))
  const p = solve(ata, atb)
  if (p === null) return { ok: false, reason: 'degenerate', faces, maxResidualGal: null }

  const A = [p[0]!, p[1]!, p[2]!]
  const B = [p[3]!, p[4]!, p[5]!]
  if (!A.every((v) => v > 0)) return { ok: false, reason: 'degenerate', faces, maxResidualGal: null }
  const offsetUnit = A.map((a, i) => -B[i]! / (2 * a))
  const G = 1 + A.reduce((s, a, i) => s + a * offsetUnit[i]! * offsetUnit[i]!, 0)
  if (!(G > 0)) return { ok: false, reason: 'degenerate', faces, maxResidualGal: null }

  const offset: Vec3 = [offsetUnit[0]! * unit, offsetUnit[1]! * unit, offsetUnit[2]! * unit]
  const sensitivity: Vec3 = [Math.sqrt(A[0]! / G), Math.sqrt(A[1]! / G), Math.sqrt(A[2]! / G)]
  if (
    !sensitivity.every((s) => s >= SIX_FACE_LIMITS.sensitivityMin && s <= SIX_FACE_LIMITS.sensitivityMax) ||
    !offset.every((o) => Math.abs(o) <= SIX_FACE_LIMITS.offsetMaxGal)
  ) {
    return { ok: false, reason: 'out-of-range', faces, maxResidualGal: null }
  }

  let maxResidualGal: number | null = null
  if (poses.length > 6) {
    maxResidualGal = 0
    for (const pose of poses) {
      const len = norm(pose.map((v, i) => (v - offset[i]!) * sensitivity[i]!))
      maxResidualGal = Math.max(maxResidualGal, Math.abs(len - GAL_PER_G))
    }
    if (maxResidualGal > GAL_PER_G * RESIDUAL_MAX_RATIO) {
      return { ok: false, reason: 'residual-too-large', faces, maxResidualGal }
    }
  }

  return { ok: true, offset, sensitivity, faces, poseCount: poses.length, maxResidualGal }
}
