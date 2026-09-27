// センサー校正（REQUIREMENTS.md §16）を、換算した gal 値へ適用する。
//
// **適用順序はバイアス除去 → 感度補正 → 座標変換の 1 通りに固定する。**
//
// ```
// x1 = gal - offset          （バイアス除去。センサー座標系・gal 単位）
// x2 = x1 * sensitivity      （軸ごとの感度補正）
// a_world = R × x2           （座標変換。§16）
// ```
//
// **`x1`・`x2` は処理の段階を指す（3 軸まとめての式）。** 下の実装コードが使う
// `a0`・`a1`・`a2` は軸そのもの（X/Y/Z）を指す変数名で、同じ添字でも意味が違う ——
// 並べて読むときは混同しないこと。
//
// 要件原文が定めるのは `a_world = R × a_sensor` （§16）だけで、`offset`・`sensitivity`
// をどの順で挟むかは書いていない。三軸センサーの校正で一般的な「バイアス→スケール→回転」の
// 形に合わせた —— `offset` はセンサー自身の出力バイアス（ゼロ点のずれ）なので、
// 換算した gal 値から直接引くのが素直。
//
// **`enabled` はここでは見ない。** 校正を適用するかどうかと、そのセンサーの値を
// そもそも使うかどうかは別の判断で、後者は呼び出し側（`intensityPipeline.ts`）の仕事。

import type { SensorCalibration } from './stationConfig'

/** 3 成分ぶんのサンプル列。`toGal()` の戻り値と同じ形。 */
export type GalTriple = readonly [readonly number[], readonly number[], readonly number[]]

/**
 * 校正を適用する。**投げない。**
 *
 * `rotation` に直交性は要求しない（`SensorCalibration` の定義を見ること）。ここは
 * 単純な行列積なので、直交行列でなくても・特異行列であっても同じ式で計算できる。
 */
export function applyCalibration(
  gal: GalTriple,
  calibration: SensorCalibration,
): [number[], number[], number[]] {
  const n = gal[0].length
  const out: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
  const { rotation, offset, sensitivity } = calibration
  for (let i = 0; i < n; i++) {
    const a0 = (gal[0][i] - offset[0]) * sensitivity[0]
    const a1 = (gal[1][i] - offset[1]) * sensitivity[1]
    const a2 = (gal[2][i] - offset[2]) * sensitivity[2]
    out[0][i] = rotation[0][0] * a0 + rotation[0][1] * a1 + rotation[0][2] * a2
    out[1][i] = rotation[1][0] * a0 + rotation[1][1] * a1 + rotation[1][2] * a2
    out[2][i] = rotation[2][0] * a0 + rotation[2][1] * a1 + rotation[2][2] * a2
  }
  return out
}
