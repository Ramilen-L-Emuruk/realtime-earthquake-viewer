export interface HeatPoint {
  lat: number
  lng: number
  weight: number
}

// マグニチュードをヒートマップの重みに変換する。
// 震度は震源からの距離に左右され月単位の集計には向かないため、地震そのものの規模を表す
// マグニチュードを重みに採用する（M1〜M8 を 0.1〜1.0 にクランプして正規化）。
export function magnitudeToWeight(magnitude: number): number {
  if (magnitude < 0) return 0.1
  return Math.min(1, Math.max(0.1, (magnitude - 1) / 7))
}
