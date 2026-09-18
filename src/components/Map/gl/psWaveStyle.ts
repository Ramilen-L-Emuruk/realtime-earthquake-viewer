// 予報円（P 波・S 波）の配色。
//
// **描画と凡例で同じ値を使うためにここへ置く。** 描画（`PsWaveGL`）はシェーダーへ 0〜1 の RGB を
// 渡し、凡例（`MapLegend`）は CSS の色を使う。片方へ書き写すと、色を変えたときにもう片方だけが
// 古くなる。
//
// このファイルは色だけを持つ（MapLibre も React も読み込まない）。凡例の組み立てはテストから
// 直接呼ぶので、重い依存を引き込まないこと。

/** 0〜1 の RGB を `#rrggbb` へ。 */
function toCssColor(rgb: readonly [number, number, number]): string {
  const hex = (v: number) => {
    const n = Math.round(Math.min(Math.max(v, 0), 1) * 255)
    return n.toString(16).padStart(2, '0')
  }
  return `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`
}

/**
 * S 波の塗りと縁。
 *
 * **塗りと縁を別の定数で持つ。** いまは同じ値だが、シェーダーは両者を混色する作りなので
 * （`PsWaveGL` の FRAG_SRC）、1 つへまとめると別色にしたくなったときに境界の扱いを見落とす。
 */
export const S_WAVE_FILL_RGB: readonly [number, number, number] = [255 / 255, 60 / 255, 0]
export const S_WAVE_STROKE_RGB: readonly [number, number, number] = [255 / 255, 60 / 255, 0]
/** S 波の塗りの濃さ。縁は不透明。 */
export const S_WAVE_FILL_ALPHA = 0.12
/** P 波は破線の縁だけで塗らない。 */
export const P_WAVE_STROKE_RGB: readonly [number, number, number] = [56 / 255, 189 / 255, 248 / 255]

/** 凡例が使う CSS の色。縁の色を採る（塗りは薄すぎて色見本にならない）。 */
export const S_WAVE_COLOR = toCssColor(S_WAVE_STROKE_RGB)
export const P_WAVE_COLOR = toCssColor(P_WAVE_STROKE_RGB)
