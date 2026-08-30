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
// 観測点リストごとの座標キー。**同じ配列に対しては作り直さない。**
//
// この関数は強震モニタが 1 秒ごとに値を配るたび、全 1725 点ぶん呼ばれる。座標キーの生成は
// `toFixed` を 2 回と文字列の連結で、1 秒あたり 3450 回に達していた。渡ってくる観測点リストは
// 同じ配列（`fetchSiteList` がキャッシュしたもの）で座標も変わらないため、キーも変わらない。
//
// 配列そのものを鍵にする（中身は比較しない）。リストが差し替わるときは必ず別の配列になる。
//
// **返す配列は `readonly`。** 同じ配列を使い回す以上、書き換えれば次の呼び出しから全点の対応が
// ずれる。例外もログも出ないので型で止める（`kyoshinDetector` の `computeSiteKeys` と同じ理由）。
const siteKeyCache = new WeakMap<SiteCoords, readonly string[]>()

function cachedSiteKeys(sites: SiteCoords): readonly string[] {
  const cached = siteKeyCache.get(sites)
  if (cached) return cached
  const keys = sites.map((s) => (s ? siteKey(s[0], s[1]) : ''))
  siteKeyCache.set(sites, keys)
  return keys
}

export function filterSubThresholdIndices(
  sites: SiteCoords,
  indices: number[],
  floors: Record<string, number>,
): number[] {
  if (Object.keys(floors).length === 0) return indices
  const keys = cachedSiteKeys(sites)
  return indices.map((idx, i) => {
    if (!sites[i]) return idx
    const floor = floors[keys[i]] ?? 0
    return indexToValue(idx) >= floor + PARAMS.SUSTAIN_MARGIN ? idx : 0
  })
}
