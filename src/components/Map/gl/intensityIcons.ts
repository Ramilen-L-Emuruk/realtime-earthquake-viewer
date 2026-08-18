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
// shadow のにじみ分の余白。
const PADDING = 8

// getIntensityLabel が定義している震度スケールの全種類（utils/intensity.ts の INTENSITY_LABELS キー）。
const SCALES = [-1, 10, 20, 30, 40, 45, 50, 55, 60, 70]

export function intensityIconId(scale: number): string {
  return `quake-badge-${scale}`
}

function drawBadge(scale: number): ImageData {
  const r = INTENSITY_ICON_BASE_RADIUS
  const size = (r + PADDING) * 2
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2
  const cy = size / 2

  const fill = getIntensityColor(scale)

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.7)'
  ctx.shadowBlur = 3
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.strokeStyle = 'rgba(255,255,255,0.7)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2)
  ctx.stroke()

  const label = getIntensityLabel(scale)
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

/** map インスタンスへ震度バッジ画像を一括登録する（既に登録済みなら何もしない）。 */
export function ensureIntensityIcons(map: MapLibreMap): void {
  for (const scale of SCALES) {
    const id = intensityIconId(scale)
    if (map.hasImage(id)) continue
    map.addImage(id, drawBadge(scale))
  }
}
