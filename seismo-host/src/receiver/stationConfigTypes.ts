// `stationConfig.ts` が扱う値の型と既定値だけを持つ。**Node 専用コードを一切
// 含まない**（`node:fs` 等を import しない）——管理コンソール（`src/admin/`。
// ブラウザ向け・DOM 型のプロジェクト）がこれらの型を `import type` すると、
// tsc は型を解決するためにインポート元のファイル全体を型チェック対象へ含める。
// 実装（`node:fs` の読み書き）まで同じファイルに置くと、admin 側のプロジェクトが
// Node の型を持たないため解決できずに壊れる——このファイルを分けているのはそのため。
//
// ## 校正の形（REQUIREMENTS.md §16）
//
// **センサーの軸ごとに「何を測っているか」を持ち、基板の向きは基板に 1 つだけ持つ。**
//
// ```
// 軸 j:   m_j − o_j = h_j · a_基板        m: 校正前の加速度（gal）  o: ゼロ点  h: 測る向き（長さが倍率）
// 基板:   a_地面 = B × a_基板             B: 基板の向き（基板の座標 → 東・北・上）
// ```
//
// 同じ基板に載ったセンサーは後から向きが変わらないので、取り付けの向き（`h_j`）は基板の座標で持ち、
// 地面に対する向き（鉛直・方角）は基板ごとに 1 回だけ合わせる。**軸を 1 本ずつ持つので、2 軸の
// センサー（IIS2ICLX）も 3 軸と同じ形で書ける** —— 2 軸の値から 3 成分の加速度は決まらないが、
// 「その軸が何を測ったか」は決まっていて、観測点の合成は軸ごとの測定をまとめて解く。

import type { BoardKey } from '../protocol/types'

/** 3 成分。 */
export type Vec3 = readonly [number, number, number]

/** 3x3 の行列（行の並び）。 */
export type Mat3 = readonly [Vec3, Vec3, Vec3]

export const IDENTITY_MATRIX: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

/** 観測点 1 つ。**座標は PWA が地図へ出すための前提**（段 5 / #261）。 */
export interface StationInfo {
  readonly stationId: string
  readonly displayName: string
  readonly lat: number
  readonly lon: number
}

/** センサーの軸 1 本の校正値。 */
export interface AxisCalibration {
  /**
   * この軸が測る向き（**基板の座標**）。**長さが倍率** —— 向き `û` に沿って 1 gal の加速度が
   * 掛かったとき、この軸は校正前の値で `|vector|` gal を読む。軸どうしが直交している必要は無い
   * （軸の直角のずれも、この向きのずれとして書ける）。
   */
  readonly vector: Vec3
  /** ゼロ点（gal）。加速度が 0 のときに読む値。 */
  readonly offset: number
}

/** センサー 1 個の校正値（REQUIREMENTS.md §15・§16）。 */
export interface SensorCalibration {
  readonly enabled: boolean
  /**
   * 軸ごとの校正値。**並びはパケットの `channels` と同じ**で、本数も同じ（2 か 3）。
   * 3 本なら測る向きが 1 つの面に寄っていない（3 成分を解ける）こと、2 本なら平行でないことを
   * 設定の検証が確かめる。
   */
  readonly axes: readonly AxisCalibration[]
  /**
   * 公称ノイズ密度（µg/√Hz）。**複数センサーの合成（§7）で重みに使う。**
   * 未設定なら null —— 実測が出ていない・品種が分からない場合はここが null のまま。
   */
  readonly noiseDensity: number | null
}

/** 軸の本数。 */
export type AxisCount = 2 | 3

/** 補正なしの軸（基板の X・Y・Z をそのまま測る・倍率 1・ゼロ点 0）。 */
export function defaultAxes(count: AxisCount): AxisCalibration[] {
  return IDENTITY_MATRIX.slice(0, count).map((row) => ({ vector: row, offset: 0 }))
}

/** 校正値が設定に無いセンサーへ渡す既定値。**補正なし・有効。** */
export function defaultSensorCalibration(count: AxisCount): SensorCalibration {
  return { enabled: true, axes: defaultAxes(count), noiseDensity: null }
}

export interface SensorEntry extends SensorCalibration {
  readonly sensorId: string
}

export interface BoardEntry {
  readonly boardKey: BoardKey
  readonly stationId: string
  /**
   * 基板の向き。`a_地面 = orientation × a_基板` で、**列が基板の X・Y・Z 軸の向き**（東・北・上）。
   * **純粋な回転だけを受ける**（設定の検証）—— 軸の倍率や直角のずれは各軸の `vector` が持つ。
   * 単位行列なら、基板の X・Y・Z が東・北・上を向いている。
   */
  readonly orientation: Mat3
  readonly sensors: readonly SensorEntry[]
}

export interface StationConfig {
  readonly stations: readonly StationInfo[]
  readonly boards: readonly BoardEntry[]
}

/** 空の設定。**全ての基板が未割当・全てのセンサーが既定値**（ファイルが無いときの既定値）。 */
export const EMPTY_STATION_CONFIG: StationConfig = { stations: [], boards: [] }
