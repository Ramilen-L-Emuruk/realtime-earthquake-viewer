import { EARTH_RADIUS_KM } from '../../../utils/geo'

// EEW 予報円の頂点計算。**シェーダー（PsWaveGL.tsx の VERT_BODY）と同じ式**をここにも置く。
//
// 円は「S 波・P 波がここまで来た」を表すので、**地面の上で正しい円**でなければならない。震央から
// 方位 theta へ距離 km だけ大円上を進んだ点（測地円）を出す。
//
// 以前は「緯度 1 度 = 111.32km、経度は震央の緯度の cos で割る」という近似で置いていた。円が
// 大きいほど南北の端で縮尺がずれ、球で描くと歪みとして出る（実測: 半径 200km で 0.75%・
// 800km で 2.67%）。大円で解けばこれが 0 になる。
//
// **平面（Mercator）ではこの直しでは歪みは消えない**（半径 400km で 4%）。あちらは図法そのものが
// 南北へ引き伸ばすためで、地面の上で正しい円は Mercator 上で必ず北側が大きくなる。消すには円が
// 波の到達位置を表さなくなるのを受け入れるしかないので、消さない。

/**
 * 震央（lng0, lat0）から方位 `bearingRad`（真北から時計回り）へ距離 `km` の点。
 *
 * ここに置いてあるのは、シェーダー側の式が測地円であることを単体テストで固定するため。
 * **片方だけ直すと、テストが通ったまま地図の円だけが歪む。**
 *
 * **シェーダー側は単精度**なので、ここ（倍精度）と完全には一致しない。ブラウザで同じ式を単精度で
 * 解いて突き合わせた実測では、ずれは半径によらず **30〜320m**（半径 1km でも 171m 出るので、
 * 式の桁落ちではなく `sin`/`cos`/`asin` の実装誤差が支配的）。円の半径に対して 0.04〜0.6% で、
 * zoom 10 でも 3px 程度。**テストの許容範囲を詰めるときは、この差より緩くしておくこと。**
 */
export function ringVertex(lng0: number, lat0: number, km: number, bearingRad: number): [number, number] {
  const D = Math.PI / 180
  const d = km / EARTH_RADIUS_KM
  const p0 = lat0 * D
  const l0 = lng0 * D
  const sinLat = Math.sin(p0) * Math.cos(d) + Math.cos(p0) * Math.sin(d) * Math.cos(bearingRad)
  const lat = Math.asin(Math.min(1, Math.max(-1, sinLat)))
  const lng =
    l0 + Math.atan2(Math.sin(bearingRad) * Math.sin(d) * Math.cos(p0), Math.cos(d) - Math.sin(p0) * sinLat)
  return [lng / D, lat / D]
}

/**
 * 測地円の外接矩形（west, south, east, north の度）。
 *
 * **東西端は「真東・真west へ半径ぶん進んだ点」ではない。** 大円は東へ進むと赤道側へ曲がるので、
 * 最も東へ届くのは方位 90 度より少し極寄りの点になる。経度の最大差は解析的に
 * `asin(sin(Δ) / cos(緯度))`（Δ は角距離）で、総当たりの探索と一致することを確認済み。
 * 方位 90 度で代用すると、緯度 40 度・半径 800km で 5.8km、緯度 80 度・半径 300km で 60km 過小になる。
 *
 * 南北端のほうは方位 0・180 の点で厳密に正しい（そこで緯度の変化率が 0 になる）。
 *
 * 円が極を含む場合（`sin(Δ) >= cos(緯度)`）は経度が一周するので、全経度を返す。
 */
export function ringBounds(lng0: number, lat0: number, km: number): [number, number, number, number] {
  const [, north] = ringVertex(lng0, lat0, km, 0)
  const [, south] = ringVertex(lng0, lat0, km, Math.PI)
  const d = km / EARTH_RADIUS_KM
  const cosLat = Math.cos((lat0 * Math.PI) / 180)
  const sinHalfSpan = Math.sin(d) / cosLat
  if (!(sinHalfSpan < 1)) return [lng0 - 180, south, lng0 + 180, north]
  const halfSpan = (Math.asin(sinHalfSpan) * 180) / Math.PI
  return [lng0 - halfSpan, south, lng0 + halfSpan, north]
}
