export interface HeatPoint {
  lat: number
  lng: number
  weight: number
}

// マグニチュードをヒートマップの重みに変換する。
// 震度は震源からの距離に左右され月単位の集計には向かないため、地震そのものの規模を表す
// マグニチュードを重みに採用する（M1〜M8 を 0〜1 に正規化）。
// マグニチュードは対数尺度（+1で放出エネルギーが約31.6倍）なため単純な線形では
// 大地震のインパクトが実態より圧縮されすぎる。二乗して差を強調する。
export function magnitudeToWeight(magnitude: number): number {
  const normalized = Math.min(1, Math.max(0, (magnitude - 1) / 7))
  return Math.max(0.1, normalized ** 2)
}
