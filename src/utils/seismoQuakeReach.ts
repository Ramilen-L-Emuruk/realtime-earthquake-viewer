// その地震の揺れが自作地震計まで届いたと見込めるか（地震カードへ自作地震計の波形を出すかの判定）。
//
// **自作地震計の場所での予測計測震度で決める**（2026-10-13 ユーザー承認）。予測は司・翠川（1999）の
// 距離減衰式（`utils/eew.ts` の `predictMeasuredIntensity`。有感半径の逆算と同じ式）。
// 予測が「その観測点の普段の計測震度 − {@link USUAL_MARGIN}」を上回れば出す。
//
// **気象庁の近所の観測点の震度では決めない。** 自作地震計は気象庁の震度 1 よりずっと弱い揺れ
// （計測震度で −1.3 ほど）まで測れるので、近所が震度 1 に届かない地震でも揺れを捉えている。
// 実測（直近 10 日・61 件）では、はっきり捉えた地震の予測は −0.3〜0、遠い地震は −3〜−7.5 で分かれた。
//
// **迷ったら出す側へ倒す**（「観測しているのに出ない」より「観測していないのに出る」ほうがよい。
// 2026-10-13 ユーザー承認）。だから下限を決め打ちせず、普段が読めない間は下限を置かない。

import { hasDepth, hasMagnitude } from './formatters'
import { hasKnownEpicenter, haversineKm } from './geo'
import { predictMeasuredIntensity } from './eew'
import type { Hypocenter } from '../types/earthquake'

/**
 * 普段の計測震度から下げる余裕。**0.5。**（2026-10-13 ユーザー承認）
 *
 * 予測は地盤の増幅を入れない工学的基盤の値で、外れる幅を持つ。実測では、はっきり捉えた地震の予測は
 * 普段より 1 ほど高く、普段そのものを下限にしても拾えるが、外れる側へ半階級ぶん広げる。
 *
 * 地図の下端の波形を出す余裕（`utils/seismoWaveTrigger.ts` の `SEISMO_WAVE_USUAL_MARGIN`）とは別物で、
 * 向きが逆（あちらは実測が普段を上回る余裕）。片方を動かすときにもう片方を合わせない。
 */
export const USUAL_MARGIN = 0.5

/** 判定に使う観測点 1 つ。 */
export interface ReachStation {
  readonly stationId: string
  /** 観測点の座標。**判らなければ `null`**（その観測点は予測できない）。 */
  readonly lat: number | null
  readonly lon: number | null
  /**
   * 普段の計測震度（ホストの `/status` の `usualIntensities`）。**読めなければ `null`**
   * （古いホスト・記録が足りない・測り直しが止まっている）—— そのときは下限を置かない。
   */
  readonly usualMeasured: number | null
}

export type QuakeReach =
  /**
   * 予測できた。`stationIds` が届いたと見込む観測点、`unknownStationIds` が座標が無くて
   * 予測できなかった観測点（**呼び出し側が別の手段で決める**）。
   */
  | { readonly kind: 'predicted'; readonly stationIds: readonly string[]; readonly unknownStationIds: readonly string[] }
  /**
   * 予測できない（震央・深さ・規模のどれかが判らない、または座標のある観測点が無い）。
   * **ここで「届かない」と決めない** —— 決めると、震源が判る前の震度速報で、観測していても出ない。
   */
  | { readonly kind: 'unknown' }

/**
 * その地震の揺れが、どの観測点まで届いたと見込めるか。
 *
 * **深さが判らない地震は予測しない。** 深さ 0 と読み替えると浅い地震として強めに出るが、
 * `0` は「ごく浅い」という有効値で、判らないことの代わりに使わない。
 */
export function judgeQuakeReach(hypocenter: Hypocenter, stations: readonly ReachStation[]): QuakeReach {
  const { latitude, longitude, depth, magnitude } = hypocenter
  if (!hasKnownEpicenter(latitude, longitude) || !hasDepth(depth) || !hasMagnitude(magnitude)) return { kind: 'unknown' }
  const reached: string[] = []
  const unknown: string[] = []
  let predictable = 0
  for (const s of stations) {
    if (s.lat === null || s.lon === null || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) {
      unknown.push(s.stationId)
      continue
    }
    predictable += 1
    const predicted = predictMeasuredIntensity(magnitude, depth, haversineKm(latitude, longitude, s.lat, s.lon))
    // **普段が読めなければ下限を置かない**（出す側へ倒す）。予測が数にならなければ届いた側へ倒す。
    const floor = s.usualMeasured === null || !Number.isFinite(s.usualMeasured) ? -Infinity : s.usualMeasured - USUAL_MARGIN
    if (!Number.isFinite(predicted) || predicted > floor) reached.push(s.stationId)
  }
  if (predictable === 0) return { kind: 'unknown' }
  return { kind: 'predicted', stationIds: reached, unknownStationIds: unknown }
}
