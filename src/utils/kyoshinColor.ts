// Yahoo 強震モニタのリアルタイム震度（インデックス 0〜20 = 計測震度 -3.0〜7.0）を
// 強震モニタ風のカラースケールに変換する。

const PALETTE = [
  '#2a4a8c', // 0  (-3.0) 暗い地図でも見えるよう低震度側を明るめに
  '#2b54a8',
  '#2a60c4',
  '#246ee0',
  '#1f86f0',
  '#1fa0f0', // 5  (-0.5)
  '#10bce8',
  '#00d2b4',
  '#00dc78',
  '#28e03c',
  '#6ee000', // 10 (2.0)
  '#a8e000',
  '#d2e000',
  '#f0dc00',
  '#ffc400',
  '#ffa000', // 15 (4.5)
  '#ff7000',
  '#ff3c00',
  '#e00000',
  '#c00050',
  '#a000a0', // 20 (7.0)
]

const BASELINE = PALETTE[0]

/**
 * リアルタイム震度インデックス（charCode - 100, 0〜20）を色に変換する。
 * 範囲外・未定義はベースライン色を返す。
 */
export function kyoshinColor(index: number | undefined): string {
  if (index == null || Number.isNaN(index)) return BASELINE
  if (index < 0) return BASELINE
  if (index > 20) return PALETTE[20]
  return PALETTE[index]
}
