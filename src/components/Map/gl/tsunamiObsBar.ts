import type * as maplibregl from 'maplibre-gl'
import type { TsunamiObsBar } from '../../../hooks/useTsunamiLayerData'
import { log } from '../../../utils/logger'

// 津波観測棒（波高バー・TsunamiObsBarsGL）の寸法計算。
//
// バー幅・脚・高さは地図アイコン倍率（設定の `mapIconScale`）で拡縮する。角丸だけは倍率に
// 連動させない——枠線・影と同じ「装飾のヘアライン」の扱いに揃えるため（index.css の方針と同じ）。
//
// 倍率の乗算をここに集約するのは、バー本体・コンテナ・ツールチップ位置が同じ値を見る必要が
// あるため。各所に式を散らすと、片方だけ直したときにバーと吹き出しの位置が静かにズレる。

/** バー本体の幅（px・倍率適用前の基準値）。 */
export const BAR_WIDTH = 6
/** 脚の張り出し（px・同上）。バー下端に台座として左右へ出る。 */
export const BAR_FOOT = 3
/** バー上端・脚の角丸（px）。装飾のため倍率に連動しない。 */
export const BAR_RADIUS = 3
/** ツールチップの横オフセット（px）。バーの右脇に出す。倍率に連動しない。 */
export const POPUP_OFFSET_X = 10

export interface BarMetrics {
  /** バー本体の幅（px）。 */
  w: number
  /** 脚の張り出し（px）。 */
  foot: number
  /** バー本体の高さ（px）。波高に比例する。 */
  barPx: number
}

/** 倍率適用後の実寸を返す。 */
export function barMetrics(bar: TsunamiObsBar, iconScale: number): BarMetrics {
  return {
    w: BAR_WIDTH * iconScale,
    foot: BAR_FOOT * iconScale,
    barPx: bar.barPx * iconScale,
  }
}

/**
 * ツールチップの表示位置（バーの中ほどの高さ・右脇）。
 * 縦は負値＝アンカー（バー下端）から上方向。
 */
export function popupOffset(bar: TsunamiObsBar, iconScale: number): [number, number] {
  return [POPUP_OFFSET_X, -barMetrics(bar, iconScale).barPx / 2]
}
/**
 * 観測棒を撮影した画像へ描き足す。
 *
 * バーは `maplibregl.Marker`（DOM 要素）なので **WebGL のキャンバスには写らない**。
 * 共有カードでは撮影後の 2D キャンバスへ同じ形を描き直す（`gl/captureMap.ts` の `drawOverlay`）。
 * 形と不透明度は上記 `updateBarEl` の DOM と対応させてある——片方だけ変えると、画面と画像で
 * 棒の見た目がずれる。
 *
 * 呼ぶのは撮影の同期窓の中だけ。`map.project()` が撮影寸法で答える必要があるため。
 */
export function drawTsunamiObsBars(
  ctx: CanvasRenderingContext2D,
  map: maplibregl.Map,
  scale: number,
  bars: TsunamiObsBar[],
  iconScale: number,
): void {
  if (bars.length === 0) return
  ctx.save()
  // 以降は論理 px で書く（map.project() が返す単位に合わせる）。
  ctx.scale(scale, scale)
  let drawn = 0
  for (const bar of bars) {
    const p = map.project([bar.lng, bar.lat])
    if (!isOnVisibleSide(map, p, bar)) continue
    const { w, foot, barPx } = barMetrics(bar, iconScale)
    ctx.fillStyle = bar.color
    // 脚（下端が観測点。Marker の anchor:'bottom' と揃える）。
    ctx.globalAlpha = 0.3
    fillRoundRect(ctx, p.x - (w + foot) / 2, p.y - foot, w + foot, foot, [0, 0, BAR_RADIUS, BAR_RADIUS])
    // 本体（脚の上に立つ）。
    ctx.globalAlpha = 0.9
    fillRoundRect(ctx, p.x - w / 2, p.y - foot - barPx, w, barPx, [BAR_RADIUS, BAR_RADIUS, 0, 0])
    drawn++
  }
  ctx.restore()
  // **「観測点が無いから描かない」と「観測点はあるのに全部弾かれた」を見分けられるようにする。**
  // 前者はここへ来る前に返しているので、ここで 0 件なら後者——画像から棒が消えた理由が
  // 残らないと、次に同じことが起きたとき手がかりが無い。
  if (drawn === 0) {
    log.warn('[shareCard] 観測棒が 1 本も描かれませんでした（すべて地球の裏側と判定された可能性）', {
      bars: bars.length,
    })
  }
}

/**
 * 地球の手前側にある点か。
 *
 * 球投影では `map.project()` が**裏側の点にも画面内の座標を返す**
 * （docs/spec/map-rendering-spec.md §6）。投影して戻す往復で確かめる。
 *
 * 到達確認マーカー（`gl/tsunamiArrivalMarker.ts`）も同じ判定を通す。観測棒と同じ
 * `maplibregl.Marker` で、共有カードでは同じように 2D で描き直すため。
 */
export function isOnVisibleSide(
  map: maplibregl.Map,
  p: { x: number; y: number },
  point: { lat: number; lng: number },
): boolean {
  const back = map.unproject([p.x, p.y])
  return Math.abs(back.lng - point.lng) < VISIBLE_SIDE_TOLERANCE_DEG && Math.abs(back.lat - point.lat) < VISIBLE_SIDE_TOLERANCE_DEG
}

/** 往復の投影で許す誤差（度）。裏側に回った点はこの桁では収まらないほど大きくずれる。 */
const VISIBLE_SIDE_TOLERANCE_DEG = 0.5

/**
 * 角丸の矩形を塗る。`roundRect` を持たない環境では角丸を諦めて矩形で描く
 * （角丸は装飾で、無くても波高の高さは正しく伝わる）。
 */
function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: [number, number, number, number],
): void {
  if (w <= 0 || h <= 0) return
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, radii)
  else ctx.rect(x, y, w, h)
  ctx.fill()
}
