// 計測震度（気象庁の算出式が返す実数）から JMA 震度階級を引く。
//
// **この表が階級の境目の単一情報源。** 使う側は 2 つある ——
//   - 強震モニタのリアルタイム震度（`kyoshinIntensity.ts`。インデックスを計測震度へ直してから通す）
//   - 自作地震計ホストの震度（`hooks/useSeismoStation.ts` が持つ値）
//
// **書き写して増やさないこと。** 表が 2 つになると、片方だけ直したときに同じ揺れが
// 画面の場所によって違う階級で出る。

import { getIntensityColor } from './intensity'

/** 震度0（計測震度 0.0 以上 0.5 未満）の表示色。気象庁配色に震度0 の色は無いため灰色とする。 */
export const SHINDO0_COLOR = '#9ca3af'

export interface IntensityGrade {
  /** 震度階級ラベル（0〜7・5弱/5強 等） */
  label: string
  /** JMA 震度スケール値（マーカー半径算出 getScaleRadius 用: 10〜70） */
  scale: number
  /**
   * 震度階級の順序（0=震度0 … 9=震度7）。scale は震度0/1がともに10で同値になるため、
   * 「表示階級が実際に1段階上がったか」を判定する用途（例: 波紋エフェクトの発生トリガー）には
   * scale ではなくこちらを使う。
   */
  rank: number
}

/**
 * 計測震度から震度階級を引く。**返さないのは値が数でないときだけ。**
 *
 * **気象庁の震度0 に下限は無い** —— 階級表が定めるのは「計測震度 0.5 未満」だけで、
 * 負の計測震度もそこへ入る。強震モニタが震度0 未満を描かないのはあちらの都合なので、
 * その判定は `kyoshinIndexToJma` が自分で持つ。
 *
 * **非有限値は `null` で弾く。** ここを省くと `NaN` がすべての比較を素通りして
 * 最後の枝（震度7）に落ちる —— 値が壊れたときに、いちばん強い階級が出る形になる。
 */
export function measuredIntensityToGrade(value: number): IntensityGrade | null {
  if (!Number.isFinite(value)) return null
  if (value < 0.5) return { label: '0', scale: 10, rank: 0 }
  if (value < 1.5) return { label: '1', scale: 10, rank: 1 }
  if (value < 2.5) return { label: '2', scale: 20, rank: 2 }
  if (value < 3.5) return { label: '3', scale: 30, rank: 3 }
  if (value < 4.5) return { label: '4', scale: 40, rank: 4 }
  if (value < 5.0) return { label: '5弱', scale: 45, rank: 5 }
  if (value < 5.5) return { label: '5強', scale: 50, rank: 6 }
  if (value < 6.0) return { label: '6弱', scale: 55, rank: 7 }
  if (value < 6.5) return { label: '6強', scale: 60, rank: 8 }
  return { label: '7', scale: 70, rank: 9 }
}

/**
 * 震度階級の表示色（気象庁の震度配色に統一）。
 *   震度0     → 灰色（{@link SHINDO0_COLOR}）
 *   震度1以上 → 気象庁の震度配色（`getIntensityColor`）
 */
export function intensityGradeColor(grade: IntensityGrade): string {
  if (grade.rank === 0) return SHINDO0_COLOR
  return getIntensityColor(grade.scale)
}
