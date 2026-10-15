// 自作地震計の観測点へ P 波・S 波が届いた時刻を出す。呼び手は 2 つあり、材料が違う
// （棚卸しは [`docs/forecast-computation-audit.md`](../../docs/forecast-computation-audit.md) の 7 と 10）。
//
// - **地震カード・詳細の窓（棚卸しの 7）**: **既に発表された地震情報**（震源・深さ・発生時刻が確定した後の電文）に
//   対して、**既に過ぎた到達時刻**を後から求める。波形の絵へ目盛りを引くための解析であって、これから起きることを
//   言っていない（2026-09-30 のユーザー判断）。絵は「値のある最後の列」で切ってあるので
//   （`seismoQuakeWindow.ts` の `selectQuakeWindow` が最初に `trimTrailingGap` を通す）、線を引ける範囲は必ず過去にある
// - **地図の下端の波形（棚卸しの 11）**: **発表中の緊急地震速報**（震源は推定途中）から解く。到達予想キーの門は掛けない
//   （2026-10-14 ユーザー承認）。歯止めは「右端＝いま、それより先の線は描かない」（`SeismoWaveChart/liveLanes.ts` の
//   `liveArrivalMarks`）—— 線は到達時刻を過ぎてから現れる
//
// **走時は JMA2001 走時表から引く**（`travelTime.ts`）。予報円・主要動の到達予測と同じ表で、
// ここだけ別の速度モデルを持たない —— 持てば、同じ地震について画面の 2 箇所が別の根拠で
// 別の時刻を名乗ることになる。

import { hasDepth } from './formatters'
import { hasKnownEpicenter, haversineKm, hypocentralDistanceKm } from './geo'
import { travelTimeSec } from './travelTime'
import type { Hypocenter } from '../types/earthquake'

/** 観測点へ届いた時刻（エポックミリ秒）。 */
export interface WaveArrival {
  /** P 波（初動）。 */
  readonly pMs: number
  /** S 波（主要動）。 */
  readonly sMs: number
}

/**
 * 震源と観測点の組から到達時刻を出す。**求まらなければ `null`。**
 *
 * 求まらないのは 4 つ ——発生時刻が読めない・震源の位置が判らない（センチネル `-200`）・
 * **深さが判らない**（センチネル `-1`。`0` は「ごく浅い」という有効値）・観測点の座標を
 * ホストが持っていない。**いずれも線を引かない** ——根拠のない目盛りを波形へ重ねると、
 * 実測の絵そのものまで疑わしくなる。
 */
export function computeWaveArrival(params: {
  originMs: number
  hypocenter: Hypocenter
  /** 観測点の緯度・経度（ホストの設定に無ければ `null`）。 */
  stationLat: number | null
  stationLon: number | null
}): WaveArrival | null {
  const { originMs, hypocenter, stationLat, stationLon } = params
  if (!Number.isFinite(originMs)) return null
  // **位置の判定は `hasKnownEpicenter` に通す。** 有限性だけでは足りない ——位置不明は
  // センチネル `-200` で表され、`Number.isFinite(-200)` は真なのですり抜ける。
  if (!hasKnownEpicenter(hypocenter.latitude, hypocenter.longitude)) return null
  // **深さ不明を 0 と読み替えない。** 最も浅い地震の速さで解くことになり、深い地震ほど
  // 早い時刻へ線を引く（`usePsWaveCalc` が予報円で弾いているのと同じ理由）。
  if (!hasDepth(hypocenter.depth)) return null
  if (stationLat === null || stationLon === null) return null
  if (!isStationCoordinate(stationLat, stationLon)) return null

  // **震央距離（地表の弧長）で渡す。** 表がその形で作られているので、弦への換算
  // （`hypocentralDistanceKm`）は通さない ——通すと球の補正が二重に掛かる。
  const distKm = haversineKm(hypocenter.latitude, hypocenter.longitude, stationLat, stationLon)
  if (!Number.isFinite(distKm)) return null

  return {
    pMs: originMs + travelTimeSec('P', distKm, hypocenter.depth) * 1000,
    sMs: originMs + travelTimeSec('S', distKm, hypocenter.depth) * 1000,
  }
}

/**
 * 震源から観測点までの距離（震源距離・km）。**求まらなければ `null`。**
 *
 * **求まらない条件は {@link computeWaveArrival} と揃える**（発生時刻は要らない）——震源の位置か
 * 深さが判らない・観測点の座標が無い。深さ不明（`-1`）を 0 と読むと、深い地震ほど近く出る。
 */
export function computeHypocentralDistanceKm(params: {
  hypocenter: Hypocenter
  stationLat: number | null
  stationLon: number | null
}): number | null {
  const { hypocenter, stationLat, stationLon } = params
  if (!hasKnownEpicenter(hypocenter.latitude, hypocenter.longitude)) return null
  if (!hasDepth(hypocenter.depth)) return null
  if (stationLat === null || stationLon === null) return null
  if (!isStationCoordinate(stationLat, stationLon)) return null
  const surfaceKm = haversineKm(hypocenter.latitude, hypocenter.longitude, stationLat, stationLon)
  const km = hypocentralDistanceKm(surfaceKm, hypocenter.depth)
  return Number.isFinite(km) ? km : null
}

/**
 * 観測点の座標として使えるか。**緯度・経度の取りうる範囲まで見る**（`hasKnownEpicenter` は有限性と
 * センチネル `-200` しか見ない）。ホストの設定の書き損じで範囲外の値が来たとき、根拠のない線を引かない。
 */
function isStationCoordinate(lat: number, lon: number): boolean {
  return hasKnownEpicenter(lat, lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
}
