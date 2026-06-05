// 強震モニタのリアルタイム震度インデックス（0〜20, 計測震度 = index * 0.5 - 3.0）を
// JMA 震度階級へ変換する。計測震度 0.0 未満（震度0未満）は null。
//
// 地図のラベルバッジ（KyoshinPoints）と右パネルの検知カード（RealtimeTab）で
// 共通利用し、変換ロジックの二重管理を避ける。

export interface KyoshinJma {
  /** 震度階級ラベル（0〜7・5弱/5強 等） */
  label: string
  /** JMA 震度スケール値（マーカー半径算出 getScaleRadius 用: 10〜70） */
  scale: number
}

export function kyoshinIndexToJma(index: number | undefined): KyoshinJma | null {
  if (index == null || Number.isNaN(index)) return null
  const value = -3.0 + index * 0.5
  if (value < 0.0) return null
  if (value < 0.5) return { label: '0', scale: 10 }
  if (value < 1.5) return { label: '1', scale: 10 }
  if (value < 2.5) return { label: '2', scale: 20 }
  if (value < 3.5) return { label: '3', scale: 30 }
  if (value < 4.5) return { label: '4', scale: 40 }
  if (value < 5.0) return { label: '5弱', scale: 45 }
  if (value < 5.5) return { label: '5強', scale: 50 }
  if (value < 6.0) return { label: '6弱', scale: 55 }
  if (value < 6.5) return { label: '6強', scale: 60 }
  return { label: '7', scale: 70 }
}

/** 震度階級ラベルのみが必要なときの簡易版。 */
export function kyoshinIndexToLabel(index: number | undefined): string | null {
  return kyoshinIndexToJma(index)?.label ?? null
}
