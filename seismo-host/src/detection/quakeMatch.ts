// 検出した揺れと、気象庁の地震情報（震源・発生時刻）を照らし合わせる（REQUIREMENTS.md §6・§18）。
//
// **なぜ照らすのか。** 家の中の 1 か所の記録だけでは、M3 級の地震と生活振動を見分けきれない ——
// 2026-09-28〜10-03 の実機の記録で、5〜10 Hz の水平動に出る強さ・上下動の割合・揺れの長さが、
// 有感地震の一覧に無い揺れ（1 日に数件）と M3 級の地震とで重なっていた。いちばん確かな裏付けは、
// 気象庁がその時刻に地震を出しているかどうか。
//
// **走時は JMA2001 走時表から引く**（`src/utils/travelTime.ts`。予報円と同じ表）。自前の速度
// モデルで解くと、同じ地震について画面の予報円と別の時刻を名乗る。
//
// **地震情報の発生時刻は分単位で届くことがある**（P2PQuake の地震情報は `13:26:00` の形。
// 実際の発生は 13:26:05 頃だった）。だから窓は「発生時刻の幅（`originPrecisionMs`）」ぶん
// 後ろへ広げる。

import { haversineKm } from '../../../src/utils/geo'
import { travelTimeSec } from '../../../src/utils/travelTime'

/** 照らし合わせに使う地震 1 件（気象庁の地震情報から作る）。 */
export interface ReferenceQuake {
  /** 発生時刻（unix ミリ秒）。分単位で丸められているなら、その分の頭。 */
  readonly originMs: number
  /** 発生時刻の幅（ミリ秒）。分単位なら 60_000、秒まで分かっていれば 1000。 */
  readonly originPrecisionMs: number
  readonly lat: number
  readonly lon: number
  /** 深さ（km）。**分からなければ null**（0 は「ごく浅い」という有効な値なので代わりに使わない）。 */
  readonly depthKm: number | null
  readonly magnitude: number | null
  /** 画面や記録に出す名前（震央地名）。 */
  readonly name: string
}

export interface ObserverPoint {
  readonly lat: number
  readonly lon: number
}

/** 観測点に P 波・S 波が届きうる時刻の幅。 */
export interface ArrivalWindow {
  readonly distanceKm: number
  /** 最も早い P 波の到達（発生時刻の幅の頭・深さの幅の浅い側）。 */
  readonly earliestPMs: number
  /** 最も早い S 波の到達。 */
  readonly earliestSMs: number
  /** 最も遅い S 波の到達（発生時刻の幅の末尾・深さの幅の深い側）。 */
  readonly latestSMs: number
}

/** 深さが分からないときに見込む幅（km）。浅い側と深い側の両方で走時を引く。 */
export const UNKNOWN_DEPTH_RANGE_KM: readonly [number, number] = [0, 100]

export function arrivalWindow(quake: ReferenceQuake, at: ObserverPoint): ArrivalWindow {
  const distanceKm = haversineKm(quake.lat, quake.lon, at.lat, at.lon)
  const [shallow, deep] = quake.depthKm === null ? UNKNOWN_DEPTH_RANGE_KM : [quake.depthKm, quake.depthKm]
  const pShallow = travelTimeSec('P', distanceKm, shallow)
  const pDeep = travelTimeSec('P', distanceKm, deep)
  const sShallow = travelTimeSec('S', distanceKm, shallow)
  const sDeep = travelTimeSec('S', distanceKm, deep)
  return {
    distanceKm,
    earliestPMs: quake.originMs + Math.min(pShallow, pDeep) * 1000,
    earliestSMs: quake.originMs + Math.min(sShallow, sDeep) * 1000,
    latestSMs: quake.originMs + quake.originPrecisionMs + Math.max(sShallow, sDeep) * 1000,
  }
}

/** 照合の余裕（ミリ秒）。走時表と実際の差・引き金の遅れ・基板の時計のずれを見込む。 */
export interface MatchTolerance {
  /** 窓の頭（最も早い P）より前へ広げる幅。 */
  readonly beforeMs: number
  /** 窓の末尾（最も遅い S）より後ろへ広げる幅。 */
  readonly afterMs: number
}

export const MATCH_TOLERANCE_DEFAULT: MatchTolerance = { beforeMs: 5_000, afterMs: 15_000 }

/**
 * 揺れの区間の始まり（`onMs`）が、地震の P 波の到達から S 波の到達（＋余裕）の間に入るか。
 *
 * **区間の始まりで見る。** 終わりや最大の時刻で見ると、長く揺れた生活振動がたまたま窓に
 * 掛かっただけで「地震」と確定してしまう。引き金は P か S のどちらかで引かれるので、
 * 始まりは最も早い P から最も遅い S までに入る。
 */
export function matchesQuake(
  onMs: number,
  window: ArrivalWindow,
  tolerance: MatchTolerance = MATCH_TOLERANCE_DEFAULT,
): boolean {
  return onMs >= window.earliestPMs - tolerance.beforeMs && onMs <= window.latestSMs + tolerance.afterMs
}
