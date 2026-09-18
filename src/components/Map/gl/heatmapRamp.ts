// 地震活動ヒートマップの色。
//
// **描画（`QuakeHeatmapGL`）と凡例（`MapLegend`）で同じ段を使うためにここへ置く。**
// 片方へ書き写すと、色を調整したときにもう片方だけが古くなる。
//
// **折れ点は対数的に配置してある**（等間隔にしない）。地震活動は場所によって桁で違い、
// 実データでは 0.1 度メッシュあたりの重み合計が中央値 0.15 に対し最大 16.6 と 100 倍以上開く。
// 等間隔のランプで写すと濃い側は上限に張り付いて一様な赤になり、薄い側は透明に潰れる。
// 判断の背景は `QuakeHeatmapGL` の `heatmap-intensity` まわりのコメント。

/** 密度（0〜1）とその位置の色。位置は昇順。 */
export interface HeatmapStop {
  at: number
  color: string
}

export const HEATMAP_DENSITY_STOPS: readonly HeatmapStop[] = [
  { at: 0, color: 'rgba(0,0,255,0)' },
  { at: 0.005, color: 'rgba(0,0,255,0.45)' },
  { at: 0.02, color: 'rgba(0,170,255,0.6)' },
  { at: 0.08, color: 'rgba(0,255,128,0.7)' },
  { at: 0.3, color: 'rgba(255,238,0,0.8)' },
  { at: 0.9, color: 'rgba(255,0,0,0.9)' },
]

/**
 * MapLibre の `heatmap-color` 式を組む。
 *
 * 戻り値の型を `unknown[]` にしているのは、式の配列が位置ごとに数値と文字列の混在になり
 * MapLibre の型定義（`DataDrivenPropertyValueSpecification`）へそのままは通らないため。
 * 呼び出し側でキャストする。
 */
export function heatmapColorExpression(): unknown[] {
  const expr: unknown[] = ['interpolate', ['linear'], ['heatmap-density']]
  for (const stop of HEATMAP_DENSITY_STOPS) {
    expr.push(stop.at, stop.color)
  }
  return expr
}
