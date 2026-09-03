import type * as maplibregl from 'maplibre-gl'
import type { TsunamiMissingMarker } from '../../../hooks/useTsunamiLayerData'
import { isOnVisibleSide } from './tsunamiObsBar'
import { arrivalMetrics, ARRIVAL_RING_COLOR, ARRIVAL_OPACITY } from './tsunamiArrivalMarker'
import { TSUNAMI_MISSING_COLOR } from '../../../utils/tsunamiStyle'
import { log } from '../../../utils/logger'

// 津波の欠測マーカー（TsunamiMissingMarkersGL）の寸法と、共有カードへの描き直し。
//
// 対象は「観測データが欠測となっている」観測点。到達確認マーカー（gl/tsunamiArrivalMarker.ts）と
// **別の印にしてある**——あちらは到達した事実が確定していて波高だけが未確定という意味で、
// こちらは観測そのものが届いていない。同じ印にすると、津波が来ていないことの保証のように読める。
//
// **寸法は到達確認マーカーと共有する**（`arrivalMetrics`）。海岸線に並ぶ印どうしで大きさが違うと、
// 大きい方が重要だと読めてしまう。違えてあるのは色と、中央の横棒だけ。

/**
 * 中央の横棒の長さ（灰色の芯の直径に対する割合）。
 *
 * 「値が無い」を表す慣用の記号として置いてある。斜線にしないのは、倍率の下限（0.5）で直径が
 * 4.5px まで縮んだときに向きが読めず、点にしか見えないため。
 */
export const MISSING_MARK_LENGTH_RATIO = 0.62
/** 中央の横棒の太さ（丸の半径に対する割合）。 */
export const MISSING_MARK_THICKNESS_RATIO = 0.26

export interface MissingMarkMetrics {
  /** 横棒の長さ（px）。 */
  length: number
  /** 横棒の太さ（px）。 */
  thickness: number
}

/**
 * 横棒が潰れない下限（px）。
 *
 * **倍率 1 でこの下限が効く。** 芯の直径は 6px しかないため、割合だけで決めると 3.7×1.2px に
 * なり、拡大しないと横棒があること自体が判らない（実測で確認した）。丸の輪郭を割って
 * 「値が無い」と読めるところまで、下限で持ち上げる。
 */
export const MISSING_MARK_MIN_LENGTH = 5
export const MISSING_MARK_MIN_THICKNESS = 2

/** 倍率適用後の横棒の実寸を返す。丸そのものの寸法は `arrivalMetrics` が持つ。 */
export function missingMarkMetrics(iconScale: number): MissingMarkMetrics {
  const { r, ring } = arrivalMetrics(iconScale)
  const core = (r - ring) * 2
  return {
    length: Math.max(MISSING_MARK_MIN_LENGTH, core * MISSING_MARK_LENGTH_RATIO),
    thickness: Math.max(MISSING_MARK_MIN_THICKNESS, r * MISSING_MARK_THICKNESS_RATIO),
  }
}

/**
 * 欠測マーカーを撮影した画像へ描き足す。
 *
 * `maplibregl.Marker`（DOM 要素）なので **WebGL のキャンバスには写らない**。形と不透明度は
 * `TsunamiMissingMarkersGL` の DOM と対応させてある——片方だけ変えると画面と画像でずれる。
 *
 * 呼ぶのは撮影の同期窓の中だけ（`gl/captureMap.ts`）。
 */
export function drawTsunamiMissingMarkers(
  ctx: CanvasRenderingContext2D,
  map: maplibregl.Map,
  scale: number,
  markers: TsunamiMissingMarker[],
  iconScale: number,
): void {
  if (markers.length === 0) return
  const { r, ring } = arrivalMetrics(iconScale)
  const { length, thickness } = missingMarkMetrics(iconScale)
  ctx.save()
  // 以降は論理 px で書く（map.project() が返す単位に合わせる）。
  ctx.scale(scale, scale)
  let drawn = 0
  for (const m of markers) {
    const p = map.project([m.lng, m.lat])
    if (!isOnVisibleSide(map, p, m)) continue
    // 芯とフチを重ねずに描く理由は到達確認マーカーと同じ（重ねると帯だけ濃くなる）。
    ctx.save()
    ctx.globalAlpha = ARRIVAL_OPACITY
    ctx.shadowColor = 'rgba(0,0,0,0.7)'
    ctx.shadowBlur = 3
    ctx.strokeStyle = ARRIVAL_RING_COLOR
    ctx.lineWidth = ring
    ctx.beginPath()
    ctx.arc(p.x, p.y, Math.max(0, r - ring / 2), 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
    ctx.save()
    ctx.globalAlpha = ARRIVAL_OPACITY
    ctx.fillStyle = TSUNAMI_MISSING_COLOR
    ctx.beginPath()
    ctx.arc(p.x, p.y, Math.max(0, r - ring), 0, Math.PI * 2)
    ctx.fill()
    // 中央の横棒。
    ctx.fillStyle = ARRIVAL_RING_COLOR
    ctx.fillRect(p.x - length / 2, p.y - thickness / 2, length, thickness)
    ctx.restore()
    drawn++
  }
  ctx.restore()
  // 到達確認マーカーと同じ理由で 0 件を記録する（対象があるのに全部弾かれた場合だけここへ来る）。
  if (drawn === 0) {
    log.warn('[shareCard] 欠測マーカーが 1 つも描かれませんでした（すべて地球の裏側と判定された可能性）', {
      markers: markers.length,
    })
  }
}
