import type * as maplibregl from 'maplibre-gl'
import type { TsunamiArrivalMarker } from '../../../hooks/useTsunamiLayerData'
import { isOnVisibleSide } from './tsunamiObsBar'
import { log } from '../../../utils/logger'

// 津波の到達確認マーカー（TsunamiArrivalMarkersGL）の寸法と、共有カードへの描き直し。
//
// 対象は「到達は確認されたが最大波高がまだ出ていない」観測点。波高が無いので、観測棒
// （gl/tsunamiObsBar.ts）のように高さで量を示せない。
//
// **量を示さない形にすることが要点。** 輪だけの円に固定してあるのは、塗った円にすると隣の
// 観測棒と並んだときに「小さい波高の棒」に見えてしまうため。色も気象庁の観測階級色（紫・赤・
// オレンジ・シアン）から外して無彩色にしてある——階級色を借りると、値が出ていないのに
// 波高の大小を伝えることになる。
//
// 倍率（設定の `mapIconScale`）の乗算をここへ集約するのは観測棒と同じ理由。マーカー本体と
// ツールチップ位置が同じ値を見る必要がある。

/** 輪の半径（px・倍率適用前の基準値）。 */
export const RING_RADIUS = 7
/** 輪の線幅（px・同上）。 */
export const RING_STROKE = 2
/** 中心の点の半径（px・同上）。観測点そのものの位置を示す。 */
export const CENTER_DOT_RADIUS = 1.5
/**
 * 到達確認マーカーの色。観測階級色を使わない（上記の理由）。
 * 暗い地形の上でも読める明度を選んである。
 */
export const ARRIVAL_COLOR = '#e2e8f0'
/** ツールチップの横オフセット（px）。輪の右脇に出す。倍率に連動しない。 */
export const POPUP_OFFSET_X = 10

export interface ArrivalMetrics {
  /** 輪の半径（px）。 */
  r: number
  /** 輪の線幅（px）。 */
  stroke: number
  /** 中心の点の半径（px）。 */
  dot: number
  /** マーカー要素の一辺（px）。輪の直径に線幅を足した外形。 */
  size: number
}

/** 倍率適用後の実寸を返す。 */
export function arrivalMetrics(iconScale: number): ArrivalMetrics {
  const r = RING_RADIUS * iconScale
  const stroke = RING_STROKE * iconScale
  return { r, stroke, dot: CENTER_DOT_RADIUS * iconScale, size: r * 2 + stroke }
}

/** ツールチップの表示位置（輪の右脇）。マーカーは中心アンカーなので縦は 0。 */
export function popupOffset(iconScale: number): [number, number] {
  return [POPUP_OFFSET_X + arrivalMetrics(iconScale).r, 0]
}

/**
 * 到達確認マーカーを撮影した画像へ描き足す。
 *
 * 観測棒と同じく `maplibregl.Marker`（DOM 要素）なので **WebGL のキャンバスには写らない**。
 * 形と不透明度は `TsunamiArrivalMarkersGL` の DOM と対応させてある——片方だけ変えると、
 * 画面と画像で印の見た目がずれる。
 *
 * 呼ぶのは撮影の同期窓の中だけ（`gl/captureMap.ts`）。
 */
export function drawTsunamiArrivalMarkers(
  ctx: CanvasRenderingContext2D,
  map: maplibregl.Map,
  scale: number,
  markers: TsunamiArrivalMarker[],
  iconScale: number,
): void {
  if (markers.length === 0) return
  const { r, stroke, dot } = arrivalMetrics(iconScale)
  ctx.save()
  // 以降は論理 px で書く（map.project() が返す単位に合わせる）。
  ctx.scale(scale, scale)
  ctx.strokeStyle = ARRIVAL_COLOR
  ctx.fillStyle = ARRIVAL_COLOR
  ctx.lineWidth = stroke
  let drawn = 0
  for (const m of markers) {
    const p = map.project([m.lng, m.lat])
    if (!isOnVisibleSide(map, p, m)) continue
    ctx.globalAlpha = 0.9
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(p.x, p.y, dot, 0, Math.PI * 2)
    ctx.fill()
    drawn++
  }
  ctx.restore()
  // 観測棒と同じ理由で 0 件を記録する（`drawTsunamiObsBars`）。「対象が無い」なら手前で返して
  // いるので、ここで 0 件なら「対象はあるのに全部弾かれた」——画像から印が消えた理由が残らない。
  if (drawn === 0) {
    log.warn('[shareCard] 到達確認マーカーが 1 つも描かれませんでした（すべて地球の裏側と判定された可能性）', {
      markers: markers.length,
    })
  }
}
