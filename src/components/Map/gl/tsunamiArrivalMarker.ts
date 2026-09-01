import type * as maplibregl from 'maplibre-gl'
import type { TsunamiArrivalMarker } from '../../../hooks/useTsunamiLayerData'
import { isOnVisibleSide, BAR_WIDTH, BAR_FOOT } from './tsunamiObsBar'
import { log } from '../../../utils/logger'

// 津波の到達確認マーカー（TsunamiArrivalMarkersGL）の寸法と、共有カードへの描き直し。
//
// 対象は「到達は確認されたが最大波高がまだ出ていない」観測点。波高が無いので、観測棒
// （gl/tsunamiObsBar.ts）のように高さで量を示せない。
//
// **形はこの地図が既に持っている丸バッジに合わせる。** 塗り丸＋白フチ＋影という作りは
// 震度観測点（gl/intensityIcons.ts）と揺れ検知点（gl/kyoshinDetectedIcons.ts）が共通で使っており、
// ここで新しい形を作ると地図の語彙が 1 つ増える。丸は高さを持たないので、波高を誤って主張しない
// （観測棒の形を借りると、固定の高さでも「小さな波高」に読まれる）。
//
// **薄くはしない。** 不透明度をこの地図で下げるのは「示している値が古い・確定していない」意味
// （欠測ホールド中の点・EEW の仮定震源要素）。到達確認は到達した事実も場所も確定していて、
// 判っていないのは波高だけなので、薄くすると観測そのものを疑わせる。値が無いことは色が担う。

/**
 * 丸の半径（px・倍率適用前の基準値）。
 *
 * **観測棒との関係で決める。** 直径を台座の幅（`BAR_WIDTH + BAR_FOOT`）に揃えると、海岸線に
 * 並んだときの足元の専有幅が棒と一致する。さらに白フチを内側に引くと、残る灰色の芯が棒の本体幅
 * （`BAR_WIDTH`）と等しくなる。数字を単独で決めると棒より大きく見え、値を持たない印のほうが
 * 目立ってしまう。
 */
export const BADGE_RADIUS = (BAR_WIDTH + BAR_FOOT) / 2
/**
 * 白フチの太さの上限（px）。**倍率で太らせない**——枠線・影は装飾のヘアラインとして扱う
 * （settings-pwa-spec.md §2「倍率の適用範囲」。観測棒の角丸と同じ扱い）。
 *
 * ただし**細らせることはする**。倍率の下限 0.5 では直径が 4.5px まで縮み、この太さのまま内側へ
 * 引くと灰色の芯が 1.5px しか残らず、印が「ほぼ白い丸」になって色が担っていた「値が無い」の
 * 合図が消える。芯の取り分は `MIN_CORE_RATIO` で保つ。
 */
export const BADGE_RING = BAR_FOOT / 2
/**
 * 直径のうち灰色の芯が占める最小の割合。等倍がちょうどこの比（芯 6px / 直径 9px）なので、
 * 等倍以上では上記の上限が効き、下回る倍率でだけフチが細くなる。
 */
export const MIN_CORE_RATIO = 2 / 3
/**
 * 塗りの色。
 *
 * 気象庁の観測階級色（紫・赤・オレンジ・シアン）を借りない——値が出ていないのに波高の大小を
 * 伝えることになる。この地図が「意味のある量が無い」に使っている無彩色に合わせてある
 * （`utils/kyoshinIntensity.ts` の `SHINDO0_COLOR` と同値）。**共有はしない**——あちらは震度0 の色で、
 * 意味が違うものを 1 つの定数に束ねると、片方の都合で色を変えたときにもう片方が黙って変わる。
 */
export const ARRIVAL_COLOR = '#9ca3af'
/** 白フチの色。丸バッジの家族と揃える。 */
export const ARRIVAL_RING_COLOR = '#ffffff'
/** 塗りの不透明度。観測棒の本体（0.9）と揃える（薄くしない理由は上記）。 */
export const ARRIVAL_OPACITY = 0.9
/** ツールチップの横オフセット（px）。丸の右脇に出す。倍率に連動しない。 */
export const POPUP_OFFSET_X = 10

export interface ArrivalMetrics {
  /** 丸の半径（px）。 */
  r: number
  /** 白フチの太さ（px）。丸の内側に描くので外形には足さない。 */
  ring: number
  /** マーカー要素の一辺（px）＝丸の直径。 */
  size: number
}

/** 倍率適用後の実寸を返す。 */
export function arrivalMetrics(iconScale: number): ArrivalMetrics {
  const r = BADGE_RADIUS * iconScale
  // 芯の取り分を割り込むならフチを細くする（上記 MIN_CORE_RATIO）。
  const maxRing = (r * 2 * (1 - MIN_CORE_RATIO)) / 2
  return { r, ring: Math.min(BADGE_RING, maxRing), size: r * 2 }
}

/** ツールチップの表示位置（丸の右脇）。マーカーは中心アンカーなので縦は 0。 */
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
  const { r, ring } = arrivalMetrics(iconScale)
  ctx.save()
  // 以降は論理 px で書く（map.project() が返す単位に合わせる）。
  ctx.scale(scale, scale)
  let drawn = 0
  for (const m of markers) {
    const p = map.project([m.lng, m.lat])
    if (!isOnVisibleSide(map, p, m)) continue
    // **芯とフチを重ねずに描く。** 塗り丸の上へフチを重ねると、フチの帯だけ 2 回合成されて
    // 実効の濃さが 0.9 → 0.99 に上がる。DOM 側は 1 つの要素へまとめて不透明度を掛けるので
    // 芯もフチも 0.9 のまま——重ねると画面と画像でフチの濃さがずれる。
    //
    // 白フチ（外側の帯）。影はいちばん外の要素に付ける（丸バッジと同じ落とし方）。
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
    // 灰色の芯（フチの内側だけを塗る）。
    ctx.globalAlpha = ARRIVAL_OPACITY
    ctx.fillStyle = ARRIVAL_COLOR
    ctx.beginPath()
    ctx.arc(p.x, p.y, Math.max(0, r - ring), 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
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
