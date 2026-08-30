/**
 * 緯度経度の組。**幾何の側で定義する。**
 *
 * 以前は `prefectures.ts`（生成データを fetch する層）に置いていたが、そちらは
 * `import.meta.env` を使うためブラウザ向けの型が要る。純粋な幾何であるこのファイルが
 * データ取得層へ依存していると、**スクリプト側のプロジェクトから使えなくなる**
 * （`tsc -b` が `import.meta.env` で落ちる）。
 */
export type LatLng = [number, number]

/**
 * 地球半径（km・平均半径）。
 *
 * **距離を測る側と、距離から点を作る側で同じ値を使うこと。** EEW の予報円は「S 波がここまで来た」を
 * 表すので、`haversineKm` が返す距離と円の半径が別の半径から出ていると、線の位置と距離の表示が
 * 静かに食い違う（`components/Map/PsWaveGL.tsx`）。
 */
export const EARTH_RADIUS_KM = 6371

/**
 * 震源が乗っている球の半径。
 *
 * **1km 未満まで下げない。** 実データの深さは深くても数百 km だが、壊れた値が来たとき
 * 0 以下になると `sqrt` の中身が負になって NaN が出る。NaN はカメラ追従の矩形へ流れ込むと
 * **他の EEW や検知点まで巻き込んで範囲全体を壊す**（gl/bounds.ts の同種の防御と揃える）。
 */
function innerRadiusKm(depthKm: number): number {
  return Math.max(EARTH_RADIUS_KM - depthKm, 1)
}

/**
 * 地表距離（震央距離）から震源距離（震源までの直線距離）へ。
 *
 * **平らな直角三角形（√(地表距離² + 深さ²)）ではない。** 地表は曲がっているので、震央から離れる
 * ほど地表の点は震源から見て「下がって」いく。球の上で 2 点を結ぶ弦の長さで解く。
 *
 * 誤差は浅い地震では 0.1% 未満だが、深発地震で遠方を見ると効く（地表 800km・深さ 700km で 3.3%）。
 *
 * 式は弦の長さ `√(深さ² + 4·R·(R−深さ)·sin²(Δ/2))`（Δ は震央角）。**この形を使うのは
 * 数値の都合**——余弦定理をそのまま使うと、近距離で `cos(Δ)` が 1 に張り付いて桁が落ちる。
 */
export function hypocentralDistanceKm(surfaceDistKm: number, depthKm: number): number {
  const inner = innerRadiusKm(depthKm)
  const halfDelta = surfaceDistKm / (2 * EARTH_RADIUS_KM)
  return Math.sqrt(depthKm ** 2 + 4 * EARTH_RADIUS_KM * inner * Math.sin(halfDelta) ** 2)
}

/**
 * 震源距離から地表距離へ（`hypocentralDistanceKm` の逆関数）。
 *
 * 震源距離が深さに満たない＝波はまだ地表のどこにも達していないので 0 を返す
 * （真上へ抜けるのが最短で、その長さがちょうど深さ）。
 */
export function surfaceDistanceKm(hypoDistKm: number, depthKm: number): number {
  const inner = innerRadiusKm(depthKm)
  const sinHalf2 = (hypoDistKm ** 2 - depthKm ** 2) / (4 * EARTH_RADIUS_KM * inner)
  if (!(sinHalf2 > 0)) return 0
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(sinHalf2)))
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = EARTH_RADIUS_KM
  const toRad = (deg: number) => deg * (Math.PI / 180)
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * 地点1から地点2への初期方位（great-circle bearing）を返す。
 * 真北を 0° とし時計回りに [0, 360) で返す（東=90°・南=180°・西=270°）。
 * 強震モニタ検知エンジンの片側配置判定・震源方位推定で使用する。
 */
export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => deg * (Math.PI / 180)
  const phi1 = toRad(lat1)
  const phi2 = toRad(lat2)
  const dLng = toRad(lng2 - lng1)
  const y = Math.sin(dLng) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng)
  const deg = (Math.atan2(y, x) * 180) / Math.PI
  return (deg + 360) % 360
}

/**
 * 震源の位置が判っているか。**否定形（`lat <= -200`）で書かないこと。**
 *
 * 位置が判らない震源の表れ方は情報源で 2 通りある。DMDATA・P2PQuake は `-200` のセンチネルを
 * 入れる（震度速報のように震源を伴わない電文・取消電文）。一方 Yahoo 強震モニタ（標準版の EEW）は
 * 座標の文字列が空だと `NaN` になる（`services/kyoshin.ts` の `parseCoord`）。
 *
 * `NaN` はどの比較演算でも false になるため、`lat > -200` と書けば弾けるが、否定形の
 * `lat <= -200` では**素通りする**。素通りした `NaN` を地図の寄り先に渡すと、MapLibre の `LngLat` が
 * `isNaN` で例外を投げる（ライブラリのコンストラクタが直接そうしている）。このアプリに
 * ErrorBoundary は無いので画面ごと落ちる。判定はこの関数に寄せること。
 */
export function hasKnownEpicenter(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat > -200 && lng > -200
}

/**
 * 地図中心経度から見て最も近い側に経度を補正する。
 * 日本中心（137.7°）からベネズエラ（-68.8°）→ 291.2° に補正するケースで使用。
 */
export function normalizeEpicenterLng(lng: number, mapCenterLng: number): number {
  const candidates = [lng - 360, lng, lng + 360]
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - mapCenterLng) < Math.abs(best - mapCenterLng) ? candidate : best
  )
}

/**
 * 点 [lat, lng] が、複数リングからなる領域の内側にあるか判定する（even-odd / ray casting）。
 * MultiPolygon（複数の外周）・穴あきポリゴンにも対応（全リングのエッジ交差を通算）。
 */
export function pointInRings(lat: number, lng: number, rings: LatLng[][]): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][0], xi = ring[i][1]
      const yj = ring[j][0], xj = ring[j][1]
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside
      }
    }
  }
  return inside
}
