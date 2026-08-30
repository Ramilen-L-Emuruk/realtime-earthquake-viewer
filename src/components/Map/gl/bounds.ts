import type { LatLng } from '../../../utils/stationCoords'
import { ringBounds } from './psWaveRing'
import { calcFeltRadiusKm } from '../../../utils/eew'

// カメラ追従の目標範囲を決める純粋計算。maplibre-gl に依存しない。
//
// 追従の判定は「矩形を合成する」「収まっているかを見る」の2つだけで決まるため、
// maplibregl.LngLatBounds ではなくタプルで扱う。maplibre-gl はブラウザ専用で vitest の既定
// （node 環境）ではロードできないため、ここを分離しておくことで地図インスタンス無しに
// 単体テストできる。LngLatBounds への変換と地図操作は camera.ts が担う。
//
// 座標の並びは maplibre と同じ [west, south, east, north]（経度が先）。

export type BoundsTuple = [west: number, south: number, east: number, north: number]

/** EEW 予報円のうち追従計算に必要な要素（services/kyoshin の PsWaveCircle と互換）。 */
export interface EewFollowCircle {
  lat: number
  lng: number
  pRadius: number
  sRadius: number
  depth?: number
  magnitude?: number
}

// JapanMap.tsx の JAPAN_BOUNDS [[lat,lng],[lat,lng]] を [lng,lat] へ変換した値。
export const JAPAN_BOUNDS: [[number, number], [number, number]] = [
  [129.43, 30.99],
  [145.82, 45.52],
]

// 離島まで含めた「日本全体」の枠（先島諸島〜択捉島・小笠原諸島。南鳥島・沖ノ鳥島は含まない）。
// JAPAN_BOUNDS は本州〜北海道を囲う枠で南西諸島・小笠原を含まないため、遠地地震のように震源が
// 地球規模で離れるフィットでは列島が画面際に張り付いてしまう。
// utils/gebcoPrefetch.ts の海底地形タイル先読み範囲もこの枠を参照する（この枠へ寄せる以上、
// 先読み範囲も同じであるべきという関係のため）。
export const JAPAN_WIDE_BOUNDS: [[number, number], [number, number]] = [
  [122, 24],
  [149, 46],
]

/**
 * JAPAN_WIDE_BOUNDS の南西・北東を、本アプリ共通の LatLng（[lat,lng]）2 点で返す。
 * カメラフィットの対象座標列（`useQuakeLayerData` の `quakeFitPositions`）へ日本全体を
 * 合成するためのもの。[lng,lat] → [lat,lng] の並べ替えを呼び出し側に散らさず一箇所に閉じる。
 */
export function japanWideCornersLatLng(): [LatLng, LatLng] {
  const [[west, south], [east, north]] = JAPAN_WIDE_BOUNDS
  return [
    [south, west],
    [north, east],
  ]
}

// EEW フォローの「引きの画（ルーズ）」余白係数。有感半径を囲む際に外側へ少し余白を持たせる。
// 引き上限（`EEW_FOLLOW_MAX_RADIUS_KM`）に達した大地震では効かず、中小地震の見え方だけを整える。
export const EEW_FOLLOW_LOOSE = 1.2

/**
 * EEW 追従の引き上限（円の半径・km）。円を囲む箱は 1600km 四方になる
 * （実際に見える視野は余白のぶんもう少し広い。下記の 930km の話はそのため）。
 *
 * **上限は「半径」に置く。矩形の辺を枠で切り詰めてはならない。** かつては日本の枠
 * （`JAPAN_BOUNDS`）との交差で辺ごとに詰めていたが、辺を別々に動かすため震源が箱の中心から
 * 外れる——枠の外に震源がある地震（南西諸島・小笠原・千島・大陸寄り）では、円が枠に触れた
 * 瞬間に切り詰めが発動し、震源を含まない箱に化けていた。
 * 2026-08-19 20:44 の奄美大島北西沖 M5.2（震源 28.9N/128.0E＝枠の南西外）で、円が半径 230km
 * から 250km に育った 1 段で中心のずれが 0 → 177km へ跳び、最終報では 249km に達した。
 * 半径で持てば箱は常に震源中心の正方形になり、位置に依存した不連続が構造的に起きない。
 *
 * 800km の根拠: 旧キャップ（日本の枠）が実際に作っていた画は短辺 1443〜1617km で、その半分。
 * **見え方を変えないこと**を基準に選んだ。着地ズームが旧キャップと一致することは
 * `gl/zoomConstants.test.ts` が代表ペインで固定している。
 *
 * **この値を上げるときは地方名ラベルの閾値（`gl/zoomLevels.ts` の `LABEL_MAX_SPAN_KM` = 2200km）
 * との関係を確認すること。** 視野の短辺は余白（padding）のぶん半径の 2 倍より広くなるため、
 * 基準ペイン（短辺 800px）では半径 930km あたりが境目で、それを超えると大地震で地名が落ちる
 * （テストが固定しているのは 800km で出る・1000km で落ちるという両側の点）。
 * なお短辺が狭いペイン（上下分割など）では 800km でも閾値を超えて地名が消えるが、これは旧キャップ
 * でも同じ（同じ段へ着地するため）で、半径で持つことによる劣化ではない。
 */
export const EEW_FOLLOW_MAX_RADIUS_KM = 800

/** 2つの矩形の外接矩形。片方が null ならもう片方をそのまま返す。 */
export function mergeBounds(a: BoundsTuple | null, b: BoundsTuple | null): BoundsTuple | null {
  if (!a) return b
  if (!b) return a
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

/** outer が inner を完全に含むか（辺が一致する場合も含むとみなす）。 */
export function boundsContains(outer: BoundsTuple, inner: BoundsTuple): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
}

/** 座標群（[lat,lng]）の外接矩形。空なら null。 */
export function boundsFromPositionsTuple(positions: LatLng[]): BoundsTuple | null {
  if (positions.length === 0) return null
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const [lat, lng] of positions) {
    if (lng < west) west = lng
    if (lng > east) east = lng
    if (lat < south) south = lat
    if (lat > north) north = lat
  }
  return [west, south, east, north]
}

// EEW 予報円を追従するための bounds を算出する。追従基準は「揺れが実際に届く前線」＝S波円（sRadius・
// 無ければ pRadius）とし、速い P波円は追わない（P波を追うとカメラが揺れの到達より先へ際限なく広がるため）。
// 各波円の半径を「S波が届くと思われる範囲」＝有感半径（calcFeltRadiusKm・震度1+ が届く距離）でクランプし、
// ルーズ余白を掛け、最後に引き上限（EEW_FOLLOW_MAX_RADIUS_KM）で頭打ちにする。これにより S波前線を追い、
// 有感半径を余裕を持って囲んだところ（大地震では引き上限）でズームアウトが止まる。magnitude 不明時は
// 有感半径クランプを外し引き上限のみ効かせる。
// 各円は中心 ± 半径ぶんの箱として加える（Leaflet の L.latLng(c).toBounds(radius*2*1000) と同じく半径=箱の半幅）。
// **上限は半径にかける（箱の辺を枠で切らない）**。理由は EEW_FOLLOW_MAX_RADIUS_KM の説明。
export function boundsFromEewCircles(circles: EewFollowCircle[]): BoundsTuple | null {
  let bounds: BoundsTuple | null = null
  for (const c of circles) {
    // 揺れの前線＝S波円を基準に追従する（sRadius 優先・無ければ pRadius へフォールバック）。
    const waveRadiusKm = c.sRadius > 0 ? c.sRadius : c.pRadius
    // 半径・座標のいずれかが有限でない円は捨てる。**`<= 0` では NaN を弾けない**（NaN を含む比較は
    // 常に false になるため素通りする）。素通りさせると Math.min が NaN を返し、mergeBounds の
    // Math.min/Math.max を通って**合成後の矩形全体**が NaN になる——他の EEW の円・震源・検知点・
    // 予想区域まで巻き込むうえ、上限（EEW_FOLLOW_MAX_RADIUS_KM）も NaN はクランプできないため
    // 「必ず頭打ちになる」保証が静かに破れる。
    if (!(waveRadiusKm > 0) || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue
    // S波が届くと思われる範囲でクランプ。magnitude が有効な値のときのみ有感半径を算出する。
    // 深さも同様に有限でなければ 0 へ倒す（`?? 0` は null/undefined しか捕まえず NaN は通す）。
    const hasMag = c.magnitude != null && Number.isFinite(c.magnitude) && c.magnitude > 0
    const depthKm = Number.isFinite(c.depth) ? (c.depth as number) : 0
    const feltRadiusKm = hasMag ? calcFeltRadiusKm(c.magnitude as number, depthKm) : Infinity
    // ルーズ余白を掛けた**後**に引き上限をかける（先に上限をかけると 1.2 倍で上限を超えてしまう）。
    const radiusKm = Math.min(Math.min(waveRadiusKm, feltRadiusKm) * EEW_FOLLOW_LOOSE, EEW_FOLLOW_MAX_RADIUS_KM)
    // 円の外接矩形。**円と同じ測地の解き方で出す**（gl/psWaveRing.ts の ringBounds）。
    // 緯度 1 度 = 111.32km の近似で出していた頃は、円が測地円になったぶんだけ矩形とずれていた。
    bounds = mergeBounds(bounds, ringBounds(c.lng, c.lat, radiusKm))
  }
  return bounds
}

/**
 * EEW の円 box と震源座標一点を合成した bounds。円がまだ無い EEW（仮定震源要素・震源未確定、または
 * usePsWaveCalc の再計算が1レンダー遅れているタイミング）でも、震源座標だけは必ず含める。
 * boundsFromEewCircles だけを追従先にすると、円の無い EEW の震源が画面外に取り残されるため。
 * 円のある EEW の震源座標は円の box に包含されるので、合成しても範囲は変わらない（無害）。
 */
export function boundsFromEewCirclesAndHypocenters(
  circles: EewFollowCircle[],
  hypocenters: LatLng[],
): BoundsTuple | null {
  return mergeBounds(boundsFromEewCircles(circles), boundsFromPositionsTuple(hypocenters))
}

/**
 * EEW 発報中のライブ追従の目標 bounds（タプル）。EEW の有感半径 bounds・震源座標・揺れ検知点・
 * 予想の区域塗り（`useEewLayerData` の `eewFitPositions`）の外接矩形を合成する。
 *
 * 合成する理由: どれか一つだけを追うと、他が画面外へ取り残される。かといって別々の追従を
 * 持たせると目標が複数になり、互いに相手をはみ出させ合って振動する。目標を1つに束ねることで
 * 「EEW の予想範囲・震源・実際に揺れている観測点のすべてが必ず入る」画を単一の判定で維持できる。
 *
 * 区域塗りを含める理由: 有感半径クランプは距離減衰式による推定だが、区域塗りは気象庁が発表した
 * 予想震度そのもの。塗ってあるものが画面外にあると読めないため、実際に描いている範囲を目標に含める。
 * S波がまだ到達していない遠方の区域も入るので、円だけを追う場合より早めに引きの画へ移る。
 *
 * 検知点側と区域側には引き上限をかけない。上限（`EEW_FOLLOW_MAX_RADIUS_KM`）は円が際限なく育つのを
 * 止めるためのもので、実際に反応した観測点や気象庁が塗った区域は「そこにある事実」なので切らない。
 * そのため合成後の箱は震源中心にならないことがある——これは画に入れるべきものを入れた結果であり、
 * 円側の上限が中心を保つのとは別の話。
 */
export function boundsForLiveFollowTuple(
  circles: EewFollowCircle[],
  hypocenters: LatLng[],
  detectedPositions: LatLng[],
  forecastAreaPositions: LatLng[] = [],
): BoundsTuple | null {
  return mergeBounds(
    mergeBounds(
      boundsFromEewCirclesAndHypocenters(circles, hypocenters),
      boundsFromPositionsTuple(detectedPositions),
    ),
    boundsFromPositionsTuple(forecastAreaPositions),
  )
}
