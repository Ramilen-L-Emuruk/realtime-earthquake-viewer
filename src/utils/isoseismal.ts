// 観測点の震度から「揺れの面」を作る補間。地震情報タブで観測点ごとの震度を表示している
// ズーム帯（区域集約を外れた寄りの画）に、点の背景として敷く面の元データを作る。
//
// 設計上の要点が 4 つある。いずれも外すと絵が嘘になるので、値を触るときはここを読むこと。
// （仕様書側の単一情報源は docs/spec/map-rendering-spec.md §17。変えるときは両方を追従させる）
//
// 1. **階級値をそのまま補間しない。** 気象庁震度階級の階級値（intensity.ts の 10/20/…/45/50/…）は
//    不等間隔で、震度4→5弱は 5 だが震度3→4 は 10。この数列で内挿すると震度4 と 5弱 のあいだだけ
//    等値線の間隔が半分になる。計測震度（0.0〜7.0 の連続量）へ写してから補間し、色の境目も
//    計測震度側の階級境界（3.5 / 4.5 / 5.0 …）で切る。
// 2. **区域の代表点を混ぜない。** 電文の `isArea: true` は一次細分区域の最大震度であって
//    その座標で観測された値ではない。呼び出し側は観測点だけを渡すこと（useQuakeLayerData の
//    `stationMarkers` は既に分離済み）。
// 3. **外挿しない。** 観測点は陸にしかないため、素朴に補間すると海に面が広がる。最寄りの
//    観測点まで `maskKm` を超えるセルは値を作らない。
// 4. **格子は Mercator 空間で等間隔に取る。** 描画先の canvas を MapLibre の canvas source として
//    貼ると、画像は Mercator 空間で線形に引き伸ばされる。緯度で等間隔に作ると、貼った結果が
//    南北にずれる（視野が広いほど効く）。

import { EARTH_RADIUS_KM } from './geo'

/** 気象庁震度階級の階級値 → 計測震度の代表値（その階級がとりうる範囲の中央）。 */
const SCALE_TO_INSTRUMENTAL: Readonly<Record<number, number>> = {
  10: 1.0, // 震度1: 0.5〜1.5
  20: 2.0,
  30: 3.0,
  40: 4.0,
  45: 4.75, // 5弱: 4.5〜5.0
  50: 5.25, // 5強: 5.0〜5.5
  55: 5.75, // 6弱: 5.5〜6.0
  60: 6.25, // 6強: 6.0〜6.5
  70: 6.75, // 7: 6.5 以上（上限が無いので便宜的に 6.75 を置く）
}

/**
 * 階級値を計測震度の代表値へ写す。階級表に無い値（震度0 の `0`・不明の `-1`・
 * 電文以外の経路から来た値）は `null` を返す。
 *
 * 震度0 を持たないのは意図的。震度0 は「観測はしたが 0.5 未満」であり、面の下限
 * （震度1 の境界 0.5）より下にしか置けない。混ぜても色は付かず、周囲の値を薄める副作用だけが残る。
 */
export function scaleToInstrumental(scale: number): number | null {
  return SCALE_TO_INSTRUMENTAL[scale] ?? null
}

/** 面の色を切り替える境目（計測震度）と、その帯に割り当てる階級値。弱い順。 */
export const INSTRUMENTAL_BANDS: readonly { readonly from: number; readonly scale: number }[] = [
  { from: 0.5, scale: 10 },
  { from: 1.5, scale: 20 },
  { from: 2.5, scale: 30 },
  { from: 3.5, scale: 40 },
  { from: 4.5, scale: 45 },
  { from: 5.0, scale: 50 },
  { from: 5.5, scale: 55 },
  { from: 6.0, scale: 60 },
  { from: 6.5, scale: 70 },
]

/** 計測震度が属する帯の階級値。下限（震度1 の 0.5）に満たなければ null。 */
export function bandScaleOf(instrumental: number): number | null {
  let hit: number | null = null
  for (const b of INSTRUMENTAL_BANDS) {
    if (instrumental >= b.from) hit = b.scale
    else break
  }
  return hit
}

/** 補間に使う観測点。 */
export interface IsoseismalPoint {
  lat: number
  lng: number
  /** 気象庁震度階級の階級値。 */
  scale: number
}

/** 面を張る範囲（緯度経度）。 */
export interface IsoseismalBounds {
  north: number
  south: number
  west: number
  east: number
}

export interface IsoseismalGridOptions {
  /** 逆距離加重の指数。既定 2。 */
  power?: number
  /**
   * この距離を超える観測点は重みに入れない（km）。既定 30。
   *
   * 観測点の間隔（10〜20km）に対して広げすぎても、遠い点の重みは 1/d² で潰れるため絵は変わらず、
   * 走査量だけが増える。`maskKm` を少し上回る程度に置く。
   */
  influenceKm?: number
  /** 最寄り観測点までこの距離を超えるセルは値を作らない（km）。既定 25。 */
  maskKm?: number
}

export interface IsoseismalGrid {
  width: number
  height: number
  bounds: IsoseismalBounds
  /**
   * 各セルの計測震度（行優先・北から南へ、西から東へ）。値を作らなかったセルは `NaN`。
   * 行の緯度は Mercator 空間で等間隔（`rowLatitudes` が実際の緯度を返す）。
   */
  values: Float32Array
  /**
   * 補間に実際に使えた観測点の数（階級表に無い値の点を除いたもの）。
   *
   * **渡した点が 1 件以上あるのにこれが 0 のとき、面は全面が透明になる。** その状態は
   * 「震度0 ばかりで色を付ける対象が無かった」場合と、「電文の階級コードが増えて
   * `scaleToInstrumental` の表から漏れた」場合の両方で起こりうるが、絵の上では見分けが付かない。
   * 呼び出し側がこの値を見て記録できるように返している。
   */
  usedPoints: number
}

const DEG = Math.PI / 180

/** Web Mercator の y（0=北端, 1=南端）。 */
export function mercatorY(lat: number): number {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat))
  const s = Math.sin(clamped * DEG)
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
}

/** `mercatorY` の逆。 */
export function latFromMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - Math.PI / 2) / DEG
}

/**
 * 格子の各行に対応する緯度。Mercator 空間で等分し、各セルの中心の緯度を返す。
 * canvas をそのまま MapLibre の canvas/image source として貼るための座標系（冒頭 4 を参照）。
 */
export function rowLatitudes(bounds: IsoseismalBounds, height: number): Float64Array {
  const yTop = mercatorY(bounds.north)
  const yBottom = mercatorY(bounds.south)
  const out = new Float64Array(height)
  for (let j = 0; j < height; j++) {
    out[j] = latFromMercatorY(yTop + ((yBottom - yTop) * (j + 0.5)) / height)
  }
  return out
}

/** 格子の各列に対応する経度（セル中心）。 */
export function columnLongitudes(bounds: IsoseismalBounds, width: number): Float64Array {
  const out = new Float64Array(width)
  for (let i = 0; i < width; i++) {
    out[i] = bounds.west + ((bounds.east - bounds.west) * (i + 0.5)) / width
  }
  return out
}

/**
 * 観測点の震度を逆距離加重で補間し、格子を返す。
 *
 * **セルごとに観測点を探すのではなく、観測点ごとに影響範囲のセルへ配る。** 逆にすると、
 * 観測点が密な地域（関東・近畿）で 1 セルあたり数百点を走査することになり、寄った画ほど
 * 遅くなる。配る側にすれば走査量は「視野内の観測点数 × 影響円のセル数」で頭打ちになり、
 * 寄って 1 セルが細かくなるぶんは視野内の観測点が減って相殺される。
 *
 * 距離は緯度経度の局所平面近似（緯度差 × 111km、経度差 × 111km × cos緯度）で測る。
 * 数十 km の範囲では球面距離との差が 0.1% に満たず、ここでは球で解く必要がない。
 */
export function buildIsoseismalGrid(
  points: readonly IsoseismalPoint[],
  bounds: IsoseismalBounds,
  width: number,
  height: number,
  options: IsoseismalGridOptions = {},
): IsoseismalGrid {
  const power = options.power ?? 2
  const influenceKm = options.influenceKm ?? 30
  const maskKm = options.maskKm ?? 25
  const values = new Float32Array(width * height).fill(Number.NaN)
  const grid: IsoseismalGrid = { width, height, bounds, values, usedPoints: 0 }
  if (width <= 0 || height <= 0) return grid

  // 走査半径は「重みを配る距離」と「最寄り距離を測る距離」の広いほう。マスクのほうが広い設定でも
  // 最寄り距離が測れなくなって面が消える、ということが起きないようにする。
  const scanKm = Math.max(influenceKm, maskKm)
  const influenceSq = influenceKm * influenceKm
  const maskSq = maskKm * maskKm
  const scanSq = scanKm * scanKm

  const lats = rowLatitudes(bounds, height)
  const lngs = columnLongitudes(bounds, width)
  const kmPerDegLat = EARTH_RADIUS_KM * DEG
  // 行ごとの経度スケール（cos 緯度）。行数ぶん先に持っておく。
  const kmPerDegLngByRow = new Float64Array(height)
  for (let j = 0; j < height; j++) kmPerDegLngByRow[j] = kmPerDegLat * Math.cos(lats[j] * DEG)

  const num = new Float64Array(width * height)
  const den = new Float64Array(width * height)
  const nearestSq = new Float64Array(width * height).fill(Number.POSITIVE_INFINITY)
  // セル中心が観測点とほぼ重なったセル。重みが発散するので、そのセルは観測値をそのまま採る。
  const exact = new Float32Array(width * height).fill(Number.NaN)

  const lngStep = (bounds.east - bounds.west) / width

  for (const p of points) {
    const v = scaleToInstrumental(p.scale)
    if (v === null) continue
    grid.usedPoints++

    // 影響範囲が掛かる行の範囲。緯度は Mercator で不等間隔なので、緯度差から直接は引けない。
    // 上下の緯度を出してから二分探索する（行数はたかだか数百なので線形でも足りるが、
    // 観測点ごとに走るため二分で押さえる）。
    const dLat = scanKm / kmPerDegLat
    const j0 = lowerBoundDesc(lats, p.lat + dLat)
    const j1 = upperBoundDesc(lats, p.lat - dLat)

    for (let j = j0; j < j1; j++) {
      const kmPerDegLng = kmPerDegLngByRow[j]
      const dy = (p.lat - lats[j]) * kmPerDegLat
      const dy2 = dy * dy
      if (dy2 > scanSq) continue
      // この行で走査すべき経度の幅（円の弦）。
      const halfKm = Math.sqrt(scanSq - dy2)
      const halfDeg = halfKm / kmPerDegLng
      const i0 = Math.max(0, Math.ceil((p.lng - halfDeg - bounds.west) / lngStep - 0.5))
      const i1 = Math.min(width - 1, Math.floor((p.lng + halfDeg - bounds.west) / lngStep - 0.5))
      const rowBase = j * width
      for (let i = i0; i <= i1; i++) {
        const dx = (p.lng - lngs[i]) * kmPerDegLng
        const d2 = dx * dx + dy2
        if (d2 > scanSq) continue
        const k = rowBase + i
        if (d2 < nearestSq[k]) nearestSq[k] = d2
        if (d2 > influenceSq) continue
        if (d2 < 1e-6) {
          exact[k] = v
          continue
        }
        const w = power === 2 ? 1 / d2 : 1 / Math.pow(Math.sqrt(d2), power)
        num[k] += w * v
        den[k] += w
      }
    }
  }
  if (grid.usedPoints === 0) return grid

  for (let k = 0; k < values.length; k++) {
    if (nearestSq[k] > maskSq) continue
    if (!Number.isNaN(exact[k])) values[k] = exact[k]
    else if (den[k] > 0) values[k] = num[k] / den[k]
  }
  return grid
}

/** 降順に並んだ緯度配列で、`value` 以下になる最初の位置（＝走査を始める行）。 */
function lowerBoundDesc(lats: Float64Array, value: number): number {
  let lo = 0
  let hi = lats.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (lats[mid] > value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** 降順に並んだ緯度配列で、`value` を下回る最初の位置（＝走査を終える行の次）。 */
function upperBoundDesc(lats: Float64Array, value: number): number {
  let lo = 0
  let hi = lats.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (lats[mid] >= value) lo = mid + 1
    else hi = mid
  }
  return lo
}
