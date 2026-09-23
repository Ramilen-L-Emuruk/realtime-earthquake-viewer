// 地震波の走時を JMA2001 走時表から引く。
//
// **気象庁と同じ表を引く。** 気象庁は緊急地震速報の主要動到達予測時刻を、速度構造 JMA2001 を
// 基に作った走時表から出している —— 原文は「気象庁で使用している速度構造(JMA2001)を基に
// 深さ・震央距離ごとに作成した走時表を使用して、対象となる地点単位で S 波の到達予測時刻を
// 算出し、主要動到達時刻としている」（「緊急地震速報の概要や処理手法に関する技術的参考資料」
// 気象庁地震火山部・令和 6 年 4 月 11 日、**印刷ページ 15**（PDF の物理ページは 16）
// https://www.jma.go.jp/jma/kishou/know/jishin/eew/katsuyou/reference.pdf）。自前の速度モデルで解くと、同じ地震について電文が名乗る時刻と
// アプリが描く波面が別の根拠から出ることになる。
//
// **表はバンドルへ埋め込む（`data/jma2001TravelTime.ts`）。** 予報円と自動解除は電文を受け取った
// 瞬間に同期で決まるので、「表がまだ読み込めていない」状態を作れない。遅延読込にすると、その
// あいだ何を返すかを決める必要が生じ、結局 2 つ目の速度モデルを残すことになる。埋め込む代わりに
// `vite.config.ts` の `manualChunks` で専用チャンクへ分ける —— main チャンクへ足すと
// Service Worker の precache 上限（2 MiB）を超えてビルドが落ちる。
//
// **表の格子は不等間隔**（深さ・震央距離とも 0-50km は 2km・50-200km は 5km・以降 10km 刻み）。
// 端の外の扱いは下記 `rowTravelSec` のコメントを見ること。

import { TT_DEPTHS_KM, TT_DISTANCES_KM, TT_DELTAS_BASE64 } from '../data/jma2001TravelTime'

/** 引く相手の波。P は初動、S は主要動。 */
export type TravelPhase = 'P' | 'S'

const DEPTHS = TT_DEPTHS_KM
const DISTS = TT_DISTANCES_KM
/** 1 つの波・1 つの深さぶんの列数。 */
const D = DISTS.length
/** 1 つの波ぶんの要素数。前半が P・後半が S。 */
const PHASE_STRIDE = DEPTHS.length * D

/**
 * 走時 [0.01 秒単位]。`[P の全格子..., S の全格子...]` の並びで、
 * それぞれ深さの昇順 × 震央距離の昇順。
 *
 * **距離方向の一次差分で持っているので、読む前に足し戻す。** 生の値を並べると gzip 後
 * 95KB だが、差分にすると 20KB まで縮む（実測）。
 */
const TABLE: Uint16Array = decodeTable()

function decodeTable(): Uint16Array {
  const bin = atob(TT_DELTAS_BASE64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  // **`Int16Array` のビューで読まず `DataView` でバイト順を明示する。** 型付き配列のビューは
  // 実行環境のバイト順に従うので、書き出した環境（リトルエンディアン）と読む環境が違うと
  // 値が化ける。現実のブラウザはどれもリトルエンディアンだが、暗黙の前提にすると
  // 「なぜか走時だけ狂う」形でしか表に出ない。
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = bytes.byteLength / 2
  const out = new Uint16Array(count)
  let acc = 0
  for (let i = 0; i < count; i += 1) {
    // 距離方向の行が変わるところで足し込みを切る。`PHASE_STRIDE` は `D` の倍数なので、
    // この判定だけで P と S の境目も拾える。
    if (i % D === 0) acc = 0
    acc += view.getInt16(i * 2, true)
    out[i] = acc
  }
  return out
}

/** 表が持つ最大の震央距離 [km]。これを超える距離は末端の見かけ速度で外挿する。 */
export const TT_MAX_DISTANCE_KM = DISTS[D - 1]
/** 表が持つ最大の深さ [km]。これより深い地震は観測されていないので端へ張り付ける。 */
export const TT_MAX_DEPTH_KM = DEPTHS[DEPTHS.length - 1]

function centiAt(phase: TravelPhase, depthIndex: number, distIndex: number): number {
  const base = phase === 'P' ? 0 : PHASE_STRIDE
  return TABLE[base + depthIndex * D + distIndex]
}

/**
 * `grid` の中で `v` を挟む添字と重みを返す。範囲の外では端へ張り付く（重み 0 か 1）。
 *
 * **格子が不等間隔なので、割り算では添字を出せない。** 二分探索で挟む。
 */
function bracket(grid: readonly number[], v: number): { lo: number; hi: number; w: number } {
  if (v <= grid[0]) return { lo: 0, hi: 0, w: 0 }
  const last = grid.length - 1
  if (v >= grid[last]) return { lo: last, hi: last, w: 0 }
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (grid[mid] <= v) lo = mid
    else hi = mid
  }
  return { lo, hi, w: (v - grid[lo]) / (grid[hi] - grid[lo]) }
}

/**
 * ある深さの行について、震央距離 `dist` の走時 [秒] を返す。
 *
 * **表の右端（2000km）より遠い距離は末端の見かけ速度で外挿する。** 予報円は自動解除まで
 * 伸び続け、**浅い震源でも M8 で P 円が約 2500km・M9 で約 3900km、深い震源では 5400km に達する**
 * （実測。`calcEEWAutoCancelSec(M, 深さ)` が返す秒数を `reachRadiusKm('P', …)` へ通し、
 * 深さ 0–700km を走査した。**深さで 2 倍以上動く**ので、値を書くときは深さの条件も一緒に書くこと）。
 * 表で打ち切ると、そこから外が描かれないか値が固まる。末端 2 点の傾きは深さ 0 で P 約 8.9 / S 約 4.9 km/s に相当し、
 * 球のモデルらしく距離とともに見かけ速度が上がり続けている区間なので、傾きの据え置きは
 * 遠方をやや遅く見積もる側（安全側）へ倒れる。
 */
function rowTravelSec(phase: TravelPhase, depthIndex: number, dist: number): number {
  if (dist <= DISTS[0]) return centiAt(phase, depthIndex, 0) / 100
  const last = D - 1
  if (dist >= DISTS[last]) {
    const endCenti = centiAt(phase, depthIndex, last)
    const slope = (endCenti - centiAt(phase, depthIndex, last - 1)) / (DISTS[last] - DISTS[last - 1])
    return (endCenti + (dist - DISTS[last]) * slope) / 100
  }
  const { lo, hi, w } = bracket(DISTS, dist)
  const a = centiAt(phase, depthIndex, lo)
  const b = centiAt(phase, depthIndex, hi)
  return (a + (b - a) * w) / 100
}


/**
 * 震央距離 `surfaceDistKm`・深さ `depthKm` の地点へ波が届くまでの走時 [秒]。
 *
 * **距離は震央距離（地表の弧長）で渡す。** 表がその形で作られているので、`utils/geo.ts` の
 * 弦への換算（`hypocentralDistanceKm`）は通さない —— 通すと球の補正が二重に掛かる。
 *
 * 有限でない入力は 0 として扱う。**`NaN` を返させない** —— 走時はカメラの追従範囲へ流れ込み、
 * `NaN` が 1 つ混ざると他の緊急地震速報や検知点まで巻き込んで範囲全体が壊れる
 * （`utils/geo.ts` の同種の防御と揃える）。
 */
export function travelTimeSec(phase: TravelPhase, surfaceDistKm: number, depthKm: number): number {
  const dist = Number.isFinite(surfaceDistKm) ? Math.max(0, surfaceDistKm) : 0
  const depth = Number.isFinite(depthKm) ? Math.min(Math.max(0, depthKm), TT_MAX_DEPTH_KM) : 0
  const { lo, hi, w } = bracket(DEPTHS, depth)
  const a = rowTravelSec(phase, lo, dist)
  if (lo === hi) return a
  return a + (rowTravelSec(phase, hi, dist) - a) * w
}

/**
 * 発生から `t` 秒の時点で波面が届いている震央距離 [km]。**`travelTimeSec` の逆関数。**
 *
 * **`travelTimeSec` をそのまま二分探索で逆引きする。** 深さの格子の間では、
 * 「行ごとに逆引きしてから距離を混ぜる」やり方は `travelTimeSec`（走時を深さ方向へ混ぜる）の
 * 逆関数にならない —— **2 つは別の演算**で、格子点では一致するのに間では離れる。
 *
 * **その差は小さくない。** 以前はそちらで実装していて、往復（距離 → 走時 → 半径）の誤差が
 * **深さ 693.5km・震央距離 0km で 43.94km**、深さ 96.5km でも 11.48km あった（深さを 0.5km
 * 刻みで走査した実測）。深い震源の震央近傍は距離に対して走時がほぼ平坦なので、行ごとに解いた
 * わずかな走時の差が大きな距離差へ化ける。**格子点の深さでは誤差 0 なので、格子点だけを
 * 走査するテストでは見えない**（緊急地震速報の深さは整数 km で届き、50km 以深の格子は
 * 5km・10km 刻みなので実運用では普通に格子から外れる）。
 *
 * 単調性の前提は保たれている —— 各行が距離について**非減少**（生成スクリプトが全格子で検査）
 * なので、2 行の凸結合も非減少で、二分探索が成り立つ。**厳密な増加ではない** —— 走時を 0.01 秒へ
 * 丸めているので、隣り合う格子が同値になる平坦部がある（隣接 24,910 組のうち P が 296・S が 172 組。
 * 実測）。平坦部では「走時が `t` 以下になる最も遠い距離」＝平坦部の外端を返す（下の比較が `<=` なので
 * `lo` が平坦部を通り抜ける）。波面をわずかに先へ描く側で、警報としては安全側。
 */
export function reachRadiusKm(phase: TravelPhase, t: number, depthKm: number): number {
  if (!Number.isFinite(t) || t <= 0) return 0
  const depth = Number.isFinite(depthKm) ? Math.min(Math.max(0, depthKm), TT_MAX_DEPTH_KM) : 0
  if (t <= travelTimeSec(phase, 0, depth)) return 0
  // 上限を探す。表の右端より遠くは末端の見かけ速度で外挿されるので、`t` に届くまで倍々に広げる。
  // **上限を置く** —— 走時が伸びない壊れた表を渡されたときに無限に広げない。
  let hi = DISTS[D - 1]
  for (let i = 0; i < 24 && travelTimeSec(phase, hi, depth) < t; i += 1) hi *= 2
  let lo = 0
  // 40 回で幅は初期値の 2^40 分の 1（約 9.1e-13）まで縮む。初期値 2000km なら残差 1.8e-9 km
  // ＝ **約 1.8μm**（倍々の拡張が上限まで走った場合でも 30m 級）。**単位は km なので、
  // 2000/2^40 の値をそのまま nm と読まないこと** —— どちらも実用上は無視できる桁だが、
  // 下の安全弁テストが見る許容値（1e-6 km ＝ 1mm）と比べるときに 3 桁ずれる。
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2
    if (travelTimeSec(phase, mid, depth) <= t) lo = mid
    else hi = mid
  }
  return lo
}
