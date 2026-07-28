// 震度0ドット（KyoshinSubThresholdGL）表示専用のフィルタ。
// 検知エンジン（kyoshinDetector）が観測点ごとに学習した慢性ノイズ床（chronicNoiseFloor）を使い、
// 大阪・岡山のような常時ノイジーな観測点は平常時ほぼ非表示にし、実際に揺れが床を超えたときだけ
// 表示する。震度1以上のドット・最大効果表示（実測値をそのまま見せる）には適用しない。

import type { SiteCoords } from '../services/kyoshin'
import { indexToValue, siteKey, PARAMS } from './kyoshinDetector'

/**
 * 観測点ごとの慢性ノイズ床（value・座標キー→floor）を使い、床＋SUSTAIN_MARGIN を超えた点だけを
 * 通す（それ以外は index 0 ＝非表示）。floors が空（検知エンジン未学習・起動直後の最初のフレーム）
 * のときはフィルタをかけず生データをそのまま返す（学習が整うまで誤って消さないため）。
 */
export function filterSubThresholdIndices(
  sites: SiteCoords,
  indices: number[],
  floors: Record<string, number>,
): number[] {
  if (Object.keys(floors).length === 0) return indices
  return indices.map((idx, i) => {
    const site = sites[i]
    if (!site) return idx
    const floor = floors[siteKey(site[0], site[1])] ?? 0
    return indexToValue(idx) >= floor + PARAMS.SUSTAIN_MARGIN ? idx : 0
  })
}
