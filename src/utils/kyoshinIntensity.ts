// 強震モニタのリアルタイム震度インデックス（0〜20, 計測震度 = index * 0.5 - 3.0）を
// JMA 震度階級へ変換する。
//
// **階級の境目はここに持たない。** 表は `measuredIntensity.ts` が単一情報源で、
// ここはインデックスを計測震度へ直してから渡すだけ（同じ表を自作地震計の震度も通る）。
//
// 地図のラベルバッジ（KyoshinPoints）と右パネルの検知カード（RealtimeTab）で
// 共通利用し、変換ロジックの二重管理を避ける。

import { intensityGradeColor, measuredIntensityToGrade, type IntensityGrade } from './measuredIntensity'

export function kyoshinIndexToJma(index: number | undefined): IntensityGrade | null {
  if (index == null) return null
  const value = -3.0 + index * 0.5
  // **震度0 未満は描かない。** これは強震モニタ側の決め事（地図に点を出す下限）で、
  // 気象庁の階級表の話ではない —— あちらの震度0 に下限は無い。
  if (!(value >= 0.0)) return null
  return measuredIntensityToGrade(value)
}

/** 震度階級ラベルのみが必要なときの簡易版。 */
export function kyoshinIndexToLabel(index: number | undefined): string | null {
  return kyoshinIndexToJma(index)?.label ?? null
}

/**
 * 計測震度からリアルタイム震度インデックス(0〜20)を求める（kyoshinIndexToJmaの逆変換）。
 * ローカル生成の強震モニタ風アーカイブ（scripts/capture-kyoshin-waveform.ts）が、実波形から
 * 算出した計測震度をこのインデックス形式へ変換する際に使う。範囲外は0/20へクランプする
 * （観測点集合の型はYahoo由来・NIED由来を問わず同じ0〜20の規約に統一しているため）。
 *
 * **画面へ出す階級を引くのにこれを噛ませないこと。** 0.5 刻みへ丸めるので、
 * 計測震度 4.4 が「5弱」になる（`round(7.4/0.5)=15` → 4.5）。計測震度を持っているなら
 * `measuredIntensityToGrade` を直に呼ぶ。
 */
export function kyoshinValueToIndex(value: number): number {
  const index = Math.round((value + 3.0) / 0.5)
  return Math.max(0, Math.min(20, index))
}

/**
 * リアルタイム震度インデックスの表示色（気象庁の震度配色に統一）。
 *   震度0未満 → null（表示しない）
 *   震度0     → 灰色（SHINDO0_COLOR）
 *   震度1以上 → 気象庁の震度配色（getIntensityColor）
 */
export function kyoshinIntensityColor(index: number | undefined): string | null {
  const jma = kyoshinIndexToJma(index)
  if (!jma) return null
  return intensityGradeColor(jma)
}
