// 津波の観測棒（潮位観測点に立てる縦棒）の色。気象庁の津波観測階級で 4 段に分ける。
//
// **描画（`useTsunamiLayerData` → `TsunamiObsBarsGL`）と凡例（`MapLegend`）で同じ表を使うために
// ここへ置く。** 段と色を書き写すと、片方だけ古くなっても画面には「もっともらしい色」が出るだけで
// 例外もログも出ない。
//
// **等級の色（`utils/tsunamiStyle.ts`）とは別物。** 1m 以上の赤と 0.2m 未満のシアンは津波警報・
// 津波予報の色と値まで同じだが、こちらは「観測された高さ」で、あちらは「発表された等級」。
// 凡例でも別のブロックへ分け、形も棒（観測棒）と線（海岸線）で変えている。

/** 1 段ぶんの定義。`minM` はその色になる下限（m）。 */
export interface TsunamiObsHeightStep {
  minM: number
  label: string
  color: string
}

/** 高い順。判定は上から「`minM` 以上か」で当てる。 */
export const TSUNAMI_OBS_HEIGHT_STEPS: TsunamiObsHeightStep[] = [
  { minM: 3, label: '3m以上', color: '#a855f7' },
  { minM: 1, label: '1m以上', color: '#ef4444' },
  { minM: 0.2, label: '0.2m以上', color: '#f97316' },
  // 引き波で負の値が来ても最も低い段に入れる（数値として読めない値は下の関数で拾う）。
  { minM: Number.NEGATIVE_INFINITY, label: '0.2m未満', color: '#22d3ee' },
]

/** 観測した高さ（m）に対応する棒の色。 */
export function tsunamiObsBarColor(heightM: number): string {
  for (const step of TSUNAMI_OBS_HEIGHT_STEPS) {
    if (heightM >= step.minM) return step.color
  }
  // NaN はどの比較も偽になる。最も低い段へ倒す（棒の長さ側も同じ扱い）。
  return TSUNAMI_OBS_HEIGHT_STEPS[TSUNAMI_OBS_HEIGHT_STEPS.length - 1].color
}
