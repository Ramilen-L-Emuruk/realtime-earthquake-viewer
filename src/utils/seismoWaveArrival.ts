// 有感の地震について、自作地震計の観測点へ P 波・S 波が届いた時刻を出す。
//
// **これは「予報」ではない。** 気象業務法が許可を要するとする予報は「将来の現象の予想」で、
// ここで解いているのは**既に発表された地震情報**（震源・深さ・発生時刻が確定した後の電文）に
// 対して、**既に過ぎた到達時刻**を後から求めるもの。波形の絵へ目盛りを引くための解析であって、
// これから起きることを言っていない（2026-09-30 のユーザー判断）。
// 棚卸しは [`docs/forecast-computation-audit.md`](../../docs/forecast-computation-audit.md)。
//
// **構造的な歯止めもある。** 絵は「値のある最後の列」で切ってあるので
// （`seismoWaveColumns.ts` の `trimTrailingGap`）、まだ来ていない時刻の区間はそもそも
// 描かれない —— 線を引ける範囲は必ず過去にある。
//
// **走時は JMA2001 走時表から引く**（`travelTime.ts`）。予報円・主要動の到達予測と同じ表で、
// ここだけ別の速度モデルを持たない —— 持てば、同じ地震について画面の 2 箇所が別の根拠で
// 別の時刻を名乗ることになる。

import { hasDepth } from './formatters'
import { hasKnownEpicenter, haversineKm } from './geo'
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
  if (!hasKnownEpicenter(stationLat, stationLon)) return null

  // **震央距離（地表の弧長）で渡す。** 表がその形で作られているので、弦への換算
  // （`hypocentralDistanceKm`）は通さない ——通すと球の補正が二重に掛かる。
  const distKm = haversineKm(hypocenter.latitude, hypocenter.longitude, stationLat, stationLon)
  if (!Number.isFinite(distKm)) return null

  return {
    pMs: originMs + travelTimeSec('P', distKm, hypocenter.depth) * 1000,
    sMs: originMs + travelTimeSec('S', distKm, hypocenter.depth) * 1000,
  }
}
