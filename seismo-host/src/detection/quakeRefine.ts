// 管理コンソールの「波形の記録」へ重ねる気象庁の地震を、秒まで分かる形に寄せる（#621 段 f）。
//
// **地震情報の発生時刻は分までしか無い**（電文が秒を 00 へ丸めている。`p2pQuake.ts` は 60 秒の幅として持つ）。
// そのまま P・S を引くと 60 秒幅の帯になり、揺れの区間をまるごと覆ってしまう。秒を持つ出どころを次の順に使う
// （2026-10-08 ユーザー承認）。
//
// 1. **気象庁の震源リスト**（日別・2 日前まで）。発生時刻は 0.1 秒・震源と深さも細かい
// 2. **緊急地震速報の発生時刻**（DMDATA の `/v2/gd/eew`・最終報）。秒まで。震源は地震情報のまま
// 3. どちらも無ければ地震情報のまま（分の幅）
//
// **決めきれないときは補わない。** 同じ分・同じあたりに規模の近い候補が 2 つあれば、どちらとも決めない ——
// 取り違えると線が数十秒ずれ、「その揺れはこの地震ではない」と読ませてしまう。分の幅の帯のほうが嘘が少ない。
//
// **走時は JMA2001 走時表から引く**（`src/utils/travelTime.ts`。予報円・地震カードの到達線と同じ表）。
// 求めるのは既に過ぎた時刻で、予報ではない（`docs/forecast-computation-audit.md`）。

import { haversineKm } from '../../../src/utils/geo'
import { TT_MAX_DISTANCE_KM, travelTimeSec } from '../../../src/utils/travelTime'
import type { P2pReferenceQuake } from './p2pQuake'
import { UNKNOWN_DEPTH_RANGE_KM } from './quakeMatch'

/** 発生時刻をどこから採ったか。 */
export type OriginSource = 'hypocenter-list' | 'eew' | 'quake-info'

/** 震源リストの 1 行（使う欄だけ）。 */
export interface HypocenterRow {
  readonly timeMs: number
  readonly lat: number
  readonly lon: number
  readonly depthKm: number
  readonly magnitude: number | null
}

/** 緊急地震速報の最終報の発生時刻。震源が読めなければ緯度経度は null。 */
export interface EewOrigin {
  readonly originMs: number
  readonly lat: number | null
  readonly lon: number | null
}

export interface RecordQuake {
  /** 同じ地震の報をまとめる鍵（地震情報のもの）。 */
  readonly key: string
  readonly name: string
  readonly originMs: number
  /** 発生時刻の幅（ミリ秒）。震源リストは 100、緊急地震速報は 1000、地震情報は 60_000。 */
  readonly originPrecisionMs: number
  readonly originSource: OriginSource
  readonly lat: number
  readonly lon: number
  /** 分からなければ null（0 は「ごく浅い」という有効な値なので代わりに使わない）。 */
  readonly depthKm: number | null
  readonly magnitude: number | null
  /** 最大震度（P2PQuake の 10・20・…・70 の形）。 */
  readonly maxScale: number | null
}

/** 候補を探す時刻の幅。地震情報の分の頭より前・分の終わりより後ろへ広げる（丸め方を決め打たない）。 */
export const REFINE_TIME_MARGIN_MS = 60_000
/** 震源リストの候補とみなす震央の離れ（地震情報の震央は 0.1 度へ丸めてある）。 */
export const REFINE_DISTANCE_KM = 50
/** 緊急地震速報の候補とみなす震央の離れ（最終報の震源は地震情報と少しずれる）。 */
export const REFINE_EEW_DISTANCE_KM = 100
/** 規模の差がこれより大きい行は候補にしない。 */
export const REFINE_MAGNITUDE_TOLERANCE = 1.0
/** いちばん近い候補と次の候補の規模の差がこれ未満なら、どちらとも決めない。 */
export const REFINE_AMBIGUITY_MAGNITUDE = 0.3
/** 規模が分からない組の差として扱う値（候補には残すが、規模の分かる組より後ろに並べる）。 */
const UNKNOWN_MAGNITUDE_GAP = 0.5

const HYPOCENTER_LIST_PRECISION_MS = 100
const EEW_PRECISION_MS = 1000

function inWindow(q: P2pReferenceQuake, ms: number): boolean {
  return ms >= q.originMs - REFINE_TIME_MARGIN_MS && ms < q.originMs + q.originPrecisionMs + REFINE_TIME_MARGIN_MS
}

function base(q: P2pReferenceQuake): RecordQuake {
  return {
    key: q.key,
    name: q.name,
    originMs: q.originMs,
    originPrecisionMs: q.originPrecisionMs,
    originSource: 'quake-info',
    lat: q.lat,
    lon: q.lon,
    depthKm: q.depthKm,
    magnitude: q.magnitude,
    maxScale: q.maxScale,
  }
}

function pickHypocenter(q: P2pReferenceQuake, rows: readonly HypocenterRow[]): HypocenterRow | null {
  const candidates: { row: HypocenterRow; gap: number; km: number }[] = []
  for (const row of rows) {
    if (!inWindow(q, row.timeMs)) continue
    const km = haversineKm(q.lat, q.lon, row.lat, row.lon)
    if (!(km <= REFINE_DISTANCE_KM)) continue
    const gap = q.magnitude === null || row.magnitude === null ? UNKNOWN_MAGNITUDE_GAP : Math.abs(q.magnitude - row.magnitude)
    if (gap > REFINE_MAGNITUDE_TOLERANCE) continue
    candidates.push({ row, gap, km })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.gap - b.gap || a.km - b.km)
  const [best, second] = candidates
  if (second !== undefined && second.gap - best!.gap < REFINE_AMBIGUITY_MAGNITUDE) return null
  return best!.row
}

function pickEew(q: P2pReferenceQuake, eews: readonly EewOrigin[]): EewOrigin | null {
  const candidates = eews.filter(
    (e) =>
      inWindow(q, e.originMs) &&
      (e.lat === null || e.lon === null || haversineKm(q.lat, q.lon, e.lat, e.lon) <= REFINE_EEW_DISTANCE_KM),
  )
  return candidates.length === 1 ? candidates[0]! : null
}

/** 地震情報 1 件を、震源リスト・緊急地震速報で秒まで寄せる。寄せられなければ地震情報のまま。 */
export function refineQuake(q: P2pReferenceQuake, rows: readonly HypocenterRow[], eews: readonly EewOrigin[]): RecordQuake {
  const row = pickHypocenter(q, rows)
  if (row !== null) {
    return {
      ...base(q),
      originMs: row.timeMs,
      originPrecisionMs: HYPOCENTER_LIST_PRECISION_MS,
      originSource: 'hypocenter-list',
      lat: row.lat,
      lon: row.lon,
      depthKm: row.depthKm,
    }
  }
  const eew = pickEew(q, eews)
  if (eew !== null) return { ...base(q), originMs: eew.originMs, originPrecisionMs: EEW_PRECISION_MS, originSource: 'eew' }
  return base(q)
}

/** 観測点に P 波・S 波が届きうる時刻の幅。 */
export interface ArrivalSpans {
  readonly distanceKm: number
  readonly pFromMs: number
  readonly pToMs: number
  readonly sFromMs: number
  readonly sToMs: number
}

/**
 * 観測点 `at` に P・S が届きうる時刻の幅。発生時刻の幅と、深さが分からなければ 0〜100 km の幅を足す。
 * **走時表の外（遠い地震）は null** —— 表の端から先は直線で延ばした値で、遠い地震の走時としては当たらない。
 */
export function arrivalSpans(q: RecordQuake, at: { readonly lat: number; readonly lon: number }): ArrivalSpans | null {
  const distanceKm = haversineKm(q.lat, q.lon, at.lat, at.lon)
  if (!Number.isFinite(distanceKm) || distanceKm > TT_MAX_DISTANCE_KM) return null
  const [shallow, deep] = q.depthKm === null ? UNKNOWN_DEPTH_RANGE_KM : [q.depthKm, q.depthKm]
  const span = (phase: 'P' | 'S'): [number, number] => {
    const a = travelTimeSec(phase, distanceKm, shallow) * 1000
    const b = travelTimeSec(phase, distanceKm, deep) * 1000
    return [q.originMs + Math.min(a, b), q.originMs + q.originPrecisionMs + Math.max(a, b)]
  }
  const [pFromMs, pToMs] = span('P')
  const [sFromMs, sToMs] = span('S')
  return { distanceKm, pFromMs, pToMs, sFromMs, sToMs }
}
