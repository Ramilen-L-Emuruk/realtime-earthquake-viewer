// どの公開観測点の波形を出すか（`docs/public-waveform-design.md` §4）。
//
// **震源があるとき**は予測計測震度が −1.5 以上の観測点を全部（§4.1）。**揺れ検知だけ**のときは、いちばん強い検知点から
// 150 km の中（§4.2）。**震源の要素が欠けるとき**（仮定震源・規模不明）は、揺れ検知があればその仮の選び方、無ければ
// 震央に近い順に数点。深さだけが不明なら浅いとみなして予測する（§0）。
//
// **一度選んだ観測点は、その揺れが終わるまで出し続ける**（選び直しで有感範囲から外れても消さない。§0）。番号は
// 震央（揺れ検知だけなら検知点）に近い順に振り、選び直しても一度振った番号は変えない（§4.3）。「揺れが終わった」を
// 決めるのは呼び出し側で、そのときは {@link EMPTY_PUBLIC_SELECTION} から始め直す。
//
// **選んだ結果は利用者に出さない**（予想した震度の値は画面に出ず、出すのは観測点の位置と波形）。予報業務の棚卸しでは
// 12 件目（`docs/forecast-computation-audit.md`）。

import { predictMeasuredIntensity } from './eew'
import { haversineKm } from './geo'
import type { PublicStationEpoch } from './publicStations'

/** 有感範囲のしきい値（予測計測震度）。実測で決めた（§3.4・§0。2026-10-14 ユーザー承認）。 */
export const PUBLIC_STATION_MIN_PREDICTED_INTENSITY = -1.5

/** 揺れ検知だけのときに選ぶ範囲（km）。いちばん強い検知点からの距離（§0・§4.2）。 */
export const PUBLIC_STATION_DETECTION_RADIUS_KM = 150

/**
 * 震源の要素が欠け、揺れ検知も無いときに震央の近い順に出す点数。**§0 は「数点」とだけ決めていて、数は決まっていない**
 * （§12）。仮に 3 点。
 */
export const PUBLIC_STATION_NEAREST_COUNT = 3

/** 選ぶ材料。 */
export type PublicSelectionSource =
  | {
      readonly kind: 'hypocenter'
      readonly lat: number
      readonly lon: number
      /** 深さ（km）。**不明なら `null`**（浅いとみなす）。 */
      readonly depthKm: number | null
      /** 規模（気象庁マグニチュード）。**不明なら `null`。** */
      readonly magnitude: number | null
      /** 仮定震源要素（震源が確定していない）。 */
      readonly assumed: boolean
    }
  | { readonly kind: 'detection'; readonly lat: number; readonly lon: number }

/** 選んだ観測点と振った番号の記憶（揺れが続く間持ち越す）。 */
export interface PublicSelectionState {
  /** 観測点のコード → 番号（1 始まり）。 */
  readonly numbers: ReadonlyMap<string, number>
}

export const EMPTY_PUBLIC_SELECTION: PublicSelectionState = { numbers: new Map() }

export interface SelectedPublicStation {
  readonly epoch: PublicStationEpoch
  readonly number: number
}

/**
 * 今回の材料で新たに入る観測点のコード（材料の点に近い順）。**ここでは記憶を見ない**（足すのは {@link selectPublicStations}）。
 *
 * 震源の要素が揃っていない（仮定・規模不明）ときは、揺れ検知の点が渡されていればそちらで選び、無ければ震央の近い順に
 * {@link PUBLIC_STATION_NEAREST_COUNT} 点。
 */
export function candidateCodes(
  epochs: readonly PublicStationEpoch[],
  source: PublicSelectionSource,
  detection: { readonly lat: number; readonly lon: number } | null,
): string[] {
  const byDistanceFrom = (lat: number, lon: number) =>
    epochs
      .map((e) => ({ code: e.code, km: haversineKm(lat, lon, e.lat, e.lon) }))
      .filter((d) => Number.isFinite(d.km))
      .sort((a, b) => a.km - b.km || (a.code < b.code ? -1 : 1))
  const withinDetection = (lat: number, lon: number) =>
    byDistanceFrom(lat, lon)
      .filter((d) => d.km <= PUBLIC_STATION_DETECTION_RADIUS_KM)
      .map((d) => d.code)

  if (source.kind === 'detection') return withinDetection(source.lat, source.lon)

  const complete = !source.assumed && source.magnitude !== null && Number.isFinite(source.magnitude)
  if (!complete) {
    if (detection !== null) return withinDetection(detection.lat, detection.lon)
    return byDistanceFrom(source.lat, source.lon)
      .slice(0, PUBLIC_STATION_NEAREST_COUNT)
      .map((d) => d.code)
  }
  // 深さだけが不明なら浅いとみなす（§0）。
  const depth = source.depthKm !== null && Number.isFinite(source.depthKm) && source.depthKm >= 0 ? source.depthKm : 0
  const magnitude = source.magnitude as number
  return byDistanceFrom(source.lat, source.lon)
    .filter((d) => predictMeasuredIntensity(magnitude, depth, d.km) >= PUBLIC_STATION_MIN_PREDICTED_INTENSITY)
    .map((d) => d.code)
}

/**
 * 出す観測点を決める。前回までに選んだ観測点は残し（いまの時刻で有効なエポックがあるものだけ）、新たに入った観測点へ
 * 続きの番号を振る。**戻り値は番号順。**
 */
export function selectPublicStations(params: {
  prev: PublicSelectionState
  /** いまの時刻で有効なエポック（`activeEpochsAt`）。 */
  epochs: readonly PublicStationEpoch[]
  source: PublicSelectionSource
  /** 震源の要素が欠けたときに使う揺れ検知の点（いちばん強いもの）。無ければ `null`。 */
  detection: { readonly lat: number; readonly lon: number } | null
}): { state: PublicSelectionState; selected: SelectedPublicStation[] } {
  const { prev, epochs, source, detection } = params
  const numbers = new Map(prev.numbers)
  let next = 1
  for (const n of numbers.values()) next = Math.max(next, n + 1)
  for (const code of candidateCodes(epochs, source, detection)) {
    if (numbers.has(code)) continue
    numbers.set(code, next)
    next += 1
  }
  const byCode = new Map(epochs.map((e) => [e.code, e]))
  const selected: SelectedPublicStation[] = []
  for (const [code, number] of numbers) {
    const epoch = byCode.get(code)
    if (epoch !== undefined) selected.push({ epoch, number })
  }
  selected.sort((a, b) => a.number - b.number)
  return { state: { numbers }, selected }
}
