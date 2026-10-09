// センサー校正（REQUIREMENTS.md §16）の計算。形は `stationConfigTypes.ts` の冒頭。
//
// ```
// 軸 j:   m_j − o_j = h_j · a_基板        基板:  a_地面 = B × a_基板
// ```
//
// 地面の座標で書き直すと `m_j − o_j = w_j · a_地面`、`w_j = B⁻ᵀ h_j`（`B` が回転なら `B h_j` と
// 同じ）。**3 軸のセンサーは `a_地面 = W⁻¹ (m − o)` で 3 成分を解く**（`W` は `w_j` を行に並べた
// 行列）—— 震度もセンサー単体の波形もこれで出す。2 軸のセンサーは 3 成分を解けないので、ここでは
// 地面での測る向きまでを出し、観測点の合成（§7）が他のセンサーの軸と一緒に解く。
//
// ## 前の形（2026-10-09 まで）との関係
//
// 前はセンサーごとに `a = R × diag(s) × (m − o)` で持っていた（`R`: 回転行列、`s`: 軸ごとの倍率）。
// 両辺に `(R diag(s))⁻¹` を掛けると `m − o = diag(1/s) R⁻¹ a` なので、軸 j の測る向きは
// **`h_j = (R⁻¹ の第 j 行) / s_j`**、基板の向きは単位行列になる（`legacyAxes`）。同じ変換を
// 表しているので、前の設定で動いていた MPU6050 の値は丸めの誤差（1e-15 ほど）しか変わらない。
//
// **`enabled` はここでは見ない。** 校正を適用するかどうかと、そのセンサーの値を
// そもそも使うかどうかは別の判断で、後者は呼び出し側（`intensityPipeline.ts`）の仕事。
//
// **Node 専用のコードを持たない**（管理コンソールも同じ計算を使う）。

import {
  invert3,
  isIndependentPair,
  isInvertibleRotation,
  multiplyMat3,
  multiplyMatVec3,
  transpose3,
} from './matrix3'
import type { AxisCalibration, Mat3, SensorCalibration, Vec3 } from './stationConfigTypes'

/** 3 成分ぶんのサンプル列。`toGal()` の戻り値と同じ形。 */
export type GalTriple = readonly [readonly number[], readonly number[], readonly number[]]

/** 地面（東・北・上）で見た軸 1 本。 */
export interface GroundAxis {
  /** この軸が地面の座標で測る向き `w_j`（長さが倍率）。 */
  readonly vector: Vec3
  readonly offset: number
}

/** 基板の向きを掛け終えた、実際に使う校正値。 */
export interface ResolvedSensorCalibration {
  readonly enabled: boolean
  readonly noiseDensity: number | null
  /**
   * 地面で見た各軸。並びはパケットの `channels` と同じ。**空なら校正の形を持たない**
   * （2・3 軸以外のパケット。`StationDirectory.resolveSensor`）。
   */
  readonly axes: readonly GroundAxis[]
  /**
   * 3 軸のときだけ: 校正前の値から地面の加速度へ戻す行列 `W⁻¹`（`a = unmix × (m − o)`）。
   * 2 軸なら `null`。
   */
  readonly unmix: Mat3 | null
}

/**
 * 軸の測る向きが解ける形か。**3 本なら 1 つの面に寄っていないこと、2 本なら平行でないこと。**
 * 本数が 2・3 以外なら false。
 */
export function axesAreIndependent(vectors: readonly Vec3[]): boolean {
  if (vectors.length === 3) return isInvertibleRotation(transpose3(vectors as unknown as Mat3))
  if (vectors.length === 2) return isIndependentPair(vectors[0]!, vectors[1]!)
  return false
}

/**
 * 基板の向きを掛けて、実際に使う形へ。**解けない形なら `null`**（設定の検証を通っていれば起きない）。
 * `orientation` に回転以外の行列を渡しても式は成り立つ（`B⁻ᵀ` を使う）が、設定の検証は回転しか通さない。
 */
export function resolveCalibration(orientation: Mat3, sensor: SensorCalibration): ResolvedSensorCalibration | null {
  const inv = invert3(orientation)
  if (inv === null) return null
  const toGround = transpose3(inv)
  const axes = sensor.axes.map((a) => ({ vector: multiplyMatVec3(toGround, a.vector), offset: a.offset }))
  if (!axesAreIndependent(axes.map((a) => a.vector))) return null
  let unmix: Mat3 | null = null
  if (axes.length === 3) {
    // `W⁻¹ = B × H⁻¹`。`W` を直接逆にしても同じだが、こちらは基板の向きが単位行列のとき
    // `H⁻¹` だけになり、前の形から写した値で前と同じ計算に近い順で掛かる。
    const hInv = invert3(sensor.axes.map((a) => a.vector) as unknown as Mat3)
    if (hInv === null) return null
    unmix = multiplyMat3(orientation, hInv)
  }
  return { enabled: sensor.enabled, noiseDensity: sensor.noiseDensity, axes, unmix }
}

/**
 * 3 軸のセンサーの校正を適用し、地面の加速度（東・北・上）にする。**投げない。**
 * `offset` は軸の並び、`unmix` は `resolveCalibration` が出した `W⁻¹`。
 */
export function applyCalibration(
  gal: GalTriple,
  offsets: readonly [number, number, number],
  unmix: Mat3,
): [number[], number[], number[]] {
  const n = gal[0].length
  const out: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
  const [o0, o1, o2] = offsets
  for (let i = 0; i < n; i++) {
    const a0 = gal[0][i] - o0
    const a1 = gal[1][i] - o1
    const a2 = gal[2][i] - o2
    out[0][i] = unmix[0][0] * a0 + unmix[0][1] * a1 + unmix[0][2] * a2
    out[1][i] = unmix[1][0] * a0 + unmix[1][1] * a1 + unmix[1][2] * a2
    out[2][i] = unmix[2][0] * a0 + unmix[2][1] * a1 + unmix[2][2] * a2
  }
  return out
}

/**
 * 前の形（`a = R × diag(s) × (m − o)`）の値を軸ごとの形へ写す。**`R` が逆行列を持たなければ `null`。**
 * 基板の向きは単位行列として読む（前の形は基板の向きを持たなかった）。
 */
export function legacyAxes(rotation: Mat3, sensitivity: Vec3, offset: Vec3): AxisCalibration[] | null {
  const inv = invert3(rotation)
  if (inv === null || !isInvertibleRotation(rotation)) return null
  return ([0, 1, 2] as const).map((j) => {
    const row = inv[j]
    const s = sensitivity[j]
    // **`-0` を `0` へ揃える**（`+ 0`）。逆行列は `-0` を作るが、書き出した数を読み直すと `0` になる
    // ので、揃えないと旧形式から読んだ設定と、それを書き直して読んだ設定が別物になる。
    return { vector: [row[0] / s + 0, row[1] / s + 0, row[2] / s + 0] as Vec3, offset: offset[j] }
  })
}
