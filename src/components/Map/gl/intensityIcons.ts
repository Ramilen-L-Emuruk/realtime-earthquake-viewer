import type { Map as MapLibreMap } from 'maplibre-gl'
import { getIntensityColor, getIntensityLabel } from '../../../utils/intensity'
import { readableTextColor } from '../../../utils/contrast'

// 震度観測点の丸バッジを Canvas2D で事前ラスタライズし、symbol レイヤーの icon-image として登録する。
//
// symbol の text-field（フォントのグリフ）で文字を丸の中心に揃えようとすると、CJK フォント
// （Noto Sans JP）の Ascent/Descent 特性により text-anchor:center の視覚的な中心が丸の幾何中心と
// 一致せず、text-offset で当て推量の補正をしても devicePixelRatio・ズームレベル・文字種によって
// ズレ量が変わってしまい安定しなかった（2026-08-10 の実機検証で判明）。Canvas2D の
// textAlign:'center'・textBaseline:'middle' はブラウザが正確に中央揃えしてくれるため、
// 丸背景＋ラベル文字を画像として1回だけ焼いて icon-image で表示する方式に切り替えた。
// DOM 要素は生成しないため、HTML Marker 版で問題になった描画コストも避けられる。

/** アイコン生成のベース半径(px)。実際の表示サイズは icon-size でこの半径からの比率をかけて決める。 */
export const INTENSITY_ICON_BASE_RADIUS = 32
/**
 * 白フチの太さ（半径に対する比）。震度バッジの従来値（基準半径 32px に対して 2px）。
 */
const DEFAULT_RING_RATIO = 2 / 32
/**
 * 未入電バッジの白フチの比。津波の到達確認マーカー（半径 4.5px・フチ 1.5px）と同じ 1/3 に合わせ、
 * 小さく出しても丸バッジの家族に見えるようにする。
 */
const UNRECEIVED_RING_RATIO = 1 / 3
// shadow のにじみ分の余白。
const PADDING = 8

// getIntensityLabel が定義している震度スケールの全種類（utils/intensity.ts の INTENSITY_LABELS キー）。
const SCALES = [-1, 10, 20, 30, 40, 45, 50, 55, 60, 70]

export function intensityIconId(scale: number): string {
  return `quake-badge-${scale}`
}

/**
 * 震度が届いていない観測点（「震度５弱以上未入電」）のバッジ。
 *
 * **観測値のバッジと同じ丸の家族に置き、色だけで分ける。** 形を変えると地図の語彙が 1 つ増える
 * （津波の到達確認マーカーも同じ理由で丸バッジに合わせてある → gl/tsunamiArrivalMarker.ts）。
 */
export const UNRECEIVED_ICON_ID = 'quake-badge-unreceived'

/**
 * 未入電バッジの塗り。
 *
 * 気象庁の震度階級色を借りない —— 観測できていないのに震度の大小を伝えることになる。この地図が
 * 「意味のある量が無い」に使っている無彩色に合わせてある。**薄くはしない**（不透明度を下げるのは
 * 「値が古い・確定していない」の意味で、未入電は場所も「5弱以上」という下限も確定している）。
 *
 * **到達確認マーカーの `ARRIVAL_COLOR` と共有しない。** 値が同じでも意味が違うものを 1 つの定数に
 * 束ねると、片方の都合で色を変えたときにもう片方が黙って変わる。
 */
export const UNRECEIVED_COLOR = '#9ca3af'

/**
 * 丸バッジを 1 枚描く。
 *
 * `label` が null のときは文字を入れない（未入電バッジ）。「5弱」と書けば観測値と見分けが付かず、
 * 「5弱以上」は丸に入らず、「?」は新しい記号を作ることになる。**値が無いことは色が担う**
 * （到達確認マーカーと同じ判断）。地点名と「5弱以上」は吹き出しとカードの一覧が受け持つ。
 *
 * `ringRatio` は白フチの太さを半径に対する比で指定する。**焼いた画像を `icon-size` で縮めて使う**
 * ので、太さは表示半径に比例して縮む。震度バッジは表示半径が 7〜19px あるため既定の細さで足りるが、
 * 小さく出す印（未入電）では同じ比だとフチが 1px を割って消え、ただの灰色の点に見える。
 */
function drawBadge(fill: string, label: string | null, ringRatio = DEFAULT_RING_RATIO): ImageData {
  const r = INTENSITY_ICON_BASE_RADIUS
  const size = (r + PADDING) * 2
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2
  const cy = size / 2

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.7)'
  ctx.shadowBlur = 3
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  const ring = r * ringRatio
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'
  ctx.lineWidth = ring
  ctx.beginPath()
  ctx.arc(cx, cy, r - ring / 2, 0, Math.PI * 2)
  ctx.stroke()

  if (label === null) return ctx.getImageData(0, 0, size, size)

  // 文字色は丸の塗り色から決める。白固定だと震度4（黄 #f5e600）で 1.30:1 まで落ちて読めない。
  ctx.fillStyle = readableTextColor(fill)
  // 以前は "Noto Sans JP" を先頭に指定していたが、@font-face 登録は一度も無く、同名フォントの同梱も
  // 撤去済みのため実態どおり sans-serif のみにする。通常の閲覧環境では描画は変わらない（ただし OS に
  // 同名フォントを手動インストールしている端末では、これまでそちらが使われていたぶん字形が変わる）。
  ctx.font = `700 ${label.length > 1 ? r * 0.85 : r * 1.15}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, cx, cy)

  return ctx.getImageData(0, 0, size, size)
}

/**
 * map インスタンスへ震度バッジ画像を一括登録する（既に登録済みなら何もしない）。
 * 未入電バッジも同じ家族なのでここでまとめて登録する。
 */
export function ensureIntensityIcons(map: MapLibreMap): void {
  for (const scale of SCALES) {
    const id = intensityIconId(scale)
    if (map.hasImage(id)) continue
    map.addImage(id, drawBadge(getIntensityColor(scale), getIntensityLabel(scale)))
  }
  if (!map.hasImage(UNRECEIVED_ICON_ID)) {
    map.addImage(UNRECEIVED_ICON_ID, drawBadge(UNRECEIVED_COLOR, null, UNRECEIVED_RING_RATIO))
  }
}
