import type * as maplibregl from 'maplibre-gl'
import { paneShortSidePx, zoomForSpanKm } from './viewSpan'

// 複数レイヤーで共有する表示ズーム閾値のうち、**視野の実距離で決まるもの**（＝「対象がどれだけ画に
// 収まっているか」で出し入れするもの）。px あたりの密度で決まる閾値は各レイヤー側に置く
// （地名ラベルの粒度切替 REGION_MAX_ZOOM / CITY_LABEL_MIN_ZOOM は LabelsGL、ヒートマップの
// HEAT_MAX_ZOOM は QuakeHeatmapGL）。使い分けの理由は gl/viewSpan.ts 冒頭。
//
// いずれも「視野の短辺が何 km を超えたら消すか」で持ち、その端末での等価ズームへ実行時に換算する。
// レイヤーへの反映は生成時の minzoom と、ペイン寸法が変わったときの張り替え
// （`bindDynamicZoomRange`）の 2 経路。片方だけにすると初回かリサイズ後のどちらかが崩れる。

/**
 * 国内の細かい線（活断層・県境・一次細分区域の境界）を描画しなくなる視野の広さ（短辺・km）。
 *
 * 遠地地震を選ぶとカメラは震源と日本全体の両方を収めるため世界規模まで引く。その広さでは
 * これらの線が潰れ、日本列島が塗り潰された塊にしか見えなくなるため描画しない。
 * 陸地の塗り（`land-fill`）とプレート境界は対象外で、引いた画でも列島の位置は分かる。
 *
 * 4400km は「日本全体（短辺 1443km）の約 3 倍まで引いたら消す」水準。基準ペイン（短辺 800px）では
 * 従来のズーム値 3.5 とほぼ同じ画になる。ズーム値ではなく視野の実距離で持つのは、ズーム値だと
 * 同じ 3.5 が「スマホでは 2045km、2K では 7089km で消える」という別々の基準になってしまうため。
 */
export const DETAIL_MAX_SPAN_KM = 4400

/**
 * 地方名ラベルを出さなくなる視野の広さ（短辺・km）。
 *
 * 2200km は日本全体（短辺 1443km）に余裕を持たせた水準で、基準ペイン（短辺 800px）では従来の
 * ズーム値 4.5 とほぼ同じ画になる。ズーム値で固定していた間は、狭いペインの日本全体表示が閾値に
 * 届かず地名が一切出ない状態だった（スマホ幅で着地 3.6 に対し閾値 4.5）。
 */
export const LABEL_MAX_SPAN_KM = 2200

/** この端末で細線を描き始める下限ズーム。ペインが小さいほど浅くなる。 */
export function detailMinZoom(map: maplibregl.Map): number {
  return detailMinZoomForPane(paneShortSidePx(map))
}

/** 短辺 shortSidePx のペインで細線を描き始める下限ズーム（`detailMinZoom` の実体）。 */
export function detailMinZoomForPane(shortSidePx: number): number {
  return zoomForSpanKm(DETAIL_MAX_SPAN_KM, shortSidePx)
}

/** この端末で地方名ラベルを出し始める下限ズーム。ペインが小さいほど浅くなる。 */
export function labelMinZoom(map: maplibregl.Map): number {
  return labelMinZoomForPane(paneShortSidePx(map))
}

/** 短辺 shortSidePx のペインで地方名ラベルを出し始める下限ズーム（`labelMinZoom` の実体）。 */
export function labelMinZoomForPane(shortSidePx: number): number {
  return zoomForSpanKm(LABEL_MAX_SPAN_KM, shortSidePx)
}
