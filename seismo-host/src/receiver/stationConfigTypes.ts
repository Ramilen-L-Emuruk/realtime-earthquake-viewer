// `stationConfig.ts` が扱う値の型と既定値だけを持つ。**Node 専用コードを一切
// 含まない**（`node:fs` 等を import しない）——管理コンソール（`src/admin/`。
// ブラウザ向け・DOM 型のプロジェクト）がこれらの型を `import type` すると、
// tsc は型を解決するためにインポート元のファイル全体を型チェック対象へ含める。
// 実装（`node:fs` の読み書き）まで同じファイルに置くと、admin 側のプロジェクトが
// Node の型を持たないため解決できずに壊れる——このファイルを分けているのはそのため。

import type { BoardKey } from '../protocol/types'

/** 3 成分。順序は `SensorPacket.channels` と揃える。 */
export type Vec3 = readonly [number, number, number]

/** 3x3 の回転行列。`a_world = R × a_sensor`（REQUIREMENTS.md §16）。 */
export type Mat3 = readonly [Vec3, Vec3, Vec3]

/** `stationConfig.ts` の `parseSensors` も既定値として使う。 */
export const IDENTITY_ROTATION: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
export const ZERO_OFFSET: Vec3 = [0, 0, 0]
export const UNIT_SENSITIVITY: Vec3 = [1, 1, 1]

/** 観測点 1 つ。**座標は PWA が地図へ出すための前提**（段 5 / #261）。 */
export interface StationInfo {
  readonly stationId: string
  readonly displayName: string
  readonly lat: number
  readonly lon: number
}

/**
 * センサー 1 個の校正値（REQUIREMENTS.md §15・§16）。
 *
 * **`rotation` に直交性（純粋な回転であること）は求めない。** 補正の対象が
 * 「取り付けの向き」なのか「軸どうしの直角のずれ」なのかはまだ決まっていない
 * （REQUIREMENTS.md §16 の注記）。前者だけを直すなら回転行列で足りるが、後者まで
 * 直すなら軸間のせん断を持つ行列になり、直交行列ではなくなる。ここで直交性を
 * 強制すると、その判断の余地を設定ファイルの形自体で塞いでしまう。
 */
export interface SensorCalibration {
  readonly enabled: boolean
  readonly rotation: Mat3
  readonly offset: Vec3
  /** 各軸の倍率。**必ず正**（0 や負は軸を殺す・反転するので `enabled` と役割が重複する）。 */
  readonly sensitivity: Vec3
  /**
   * 公称ノイズ密度（µg/√Hz）。**複数センサーの合成（§7）で重みに使う。**
   * 未設定なら null —— #298 の実測が出ていない・品種が分からない場合はここが null のまま。
   */
  readonly noiseDensity: number | null
}

/** 校正値が設定に無いセンサーへ渡す既定値。**単位行列・補正なし・有効。** */
export const DEFAULT_SENSOR_CALIBRATION: SensorCalibration = {
  enabled: true,
  rotation: IDENTITY_ROTATION,
  offset: ZERO_OFFSET,
  sensitivity: UNIT_SENSITIVITY,
  noiseDensity: null,
}

export interface SensorEntry extends SensorCalibration {
  readonly sensorId: string
}

export interface BoardEntry {
  readonly boardKey: BoardKey
  readonly stationId: string
  readonly sensors: readonly SensorEntry[]
}

export interface StationConfig {
  readonly stations: readonly StationInfo[]
  readonly boards: readonly BoardEntry[]
}

/** 空の設定。**全ての基板が未割当・全てのセンサーが既定値**（ファイルが無いときの既定値）。 */
export const EMPTY_STATION_CONFIG: StationConfig = { stations: [], boards: [] }
