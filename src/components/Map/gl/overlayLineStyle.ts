// 地図に重ねる線（活断層・プレート境界）の配色。
//
// **描画（`ActiveFaultsGL` / `PlateBoundariesGL`）と凡例（`MapLegend`）で同じ値を使うために
// ここへ置く。** 色だけを持つモジュールにしているのは、凡例の組み立てをテストから直接呼ぶため
// （描画コンポーネントを読み込むと React と MapLibre まで引き込む）。

/** 活断層。 */
export const FAULT_COLOR = '#96421f'

/** プレート境界のうち沈み込み帯。 */
export const SUBDUCTION_COLOR = '#b91c1c'

/** プレート境界のうち沈み込み帯以外（発散・すれ違い等）。 */
export const PLATE_OTHER_COLOR = '#1d4ed8'
