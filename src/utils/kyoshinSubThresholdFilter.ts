// 震度0ドット（KyoshinSubThresholdGL）表示専用のフィルタ。
// 検知エンジン（kyoshinDetector）が観測点ごとに学習した慢性ノイズ床（chronicNoiseFloor）を使い、
// 大阪・岡山のような常時ノイジーな観測点は平常時ほぼ非表示にし、実際に揺れが床を超えたときだけ
// 表示する。震度1以上のドット・最大効果表示（実測値をそのまま見せる）には適用しない。

import type { SiteCoords } from '../services/kyoshin'
import { indexToValue, PARAMS } from './kyoshinDetector'

/**
 * 観測点ごとの慢性ノイズ床を使い、床＋SUSTAIN_MARGIN を超えた点だけを通す（それ以外は index 0
 * ＝非表示）。
 *
 * `floors` は `sites` と同じ並びの配列で受け取る（座標から作ったキーで引かないこと）。Yahoo の
 * 公開座標は同一座標に複数の実観測点が載ることがあり（全1725点中207グループ・431点）、検知エンジンは
 * それらを `computeSiteKeys` で `#2`, `#3` と別実体に分けて床を学習している。座標だけをキーにすると
 * 2つ目以降の点が**グループ先頭の別センサーの床**で判定され、実測 15 分で 60 点の表示が食い違った
 * （多くは床の高い都市部の点が低い床で判定されて素通りする向き）。並びで対応づければ、キーの
 * 生成規則を 2 箇所で揃える必要そのものが無くなる。
 *
 * 並びで対応づけると**キーを作らずに済む**ので、毎秒 1725 点を走査しても `toFixed` も文字列の連結も
 * 走らない（以前は観測点リストごとにキーをキャッシュして再生成を避けていた。キャッシュそのものが
 * 要らなくなった）。
 *
 * 長さが揃わないとき（検知エンジン未学習の起動直後・`step()` の連続失敗で床が前フレームに凍結した
 * 直後の観測点集合の入れ替わり）はフィルタをかけず生データをそのまま返す。位置で対応づける以上、
 * 長さのずれは添字のずれ＝別地点の床での判定になるため、消すより出す方へ倒す。
 */
export function filterSubThresholdIndices(
  sites: SiteCoords,
  indices: number[],
  floors: number[],
): number[] {
  if (floors.length !== sites.length || floors.length !== indices.length) return indices
  return indices.map((idx, i) =>
    indexToValue(idx) >= floors[i] + PARAMS.SUSTAIN_MARGIN ? idx : 0,
  )
}
