import type { Map as MapLibreMap } from 'maplibre-gl'
import { getLpgmClassColor } from '../../../utils/lpgm'
import { readableTextColor } from '../../../utils/contrast'

// 長周期地震動観測点の階級バッジを Canvas2D で事前ラスタライズし、symbol レイヤーの icon-image として
// 登録する。震度バッジ（gl/intensityIcons.ts）と同じ理由（CJK フォントのベースライン特性により
// text-field＋text-offset では安定した中央揃えができない）で画像方式にしている。

// アイコン生成のベース半径(px)相当（正方形の一辺の半分）。icon-size でこの比率をかけて表示する。
//
// 実際に要求される半径（`getLpgmClassRadius()` の 8〜14＋レイヤーごとの下駄）より必ず大きく取る。
// ベースを下回る要求しか来なければ icon-size は常に 1 以下＝縮小のみになり、ラスタライズ済みの
// 文字がぼやけない（震度バッジ intensityIcons.ts と同じ考え方）。
export const LPGM_ICON_BASE_RADIUS = 32
// 余白・フチの線幅・角丸・影のにじみはベース半径に比例させる。ベース半径だけ変えると
// 表示時（icon-size で縮小後）のフチや影の太さが変わってしまうため（ベース半径 16 のときの
// 6 / 2 / 3 / 3 と同じ見た目になる比率）。
const PADDING = (LPGM_ICON_BASE_RADIUS * 3) / 8
const STROKE_WIDTH = LPGM_ICON_BASE_RADIUS / 8
const CORNER_RADIUS = (LPGM_ICON_BASE_RADIUS * 3) / 16
const SHADOW_BLUR = (LPGM_ICON_BASE_RADIUS * 3) / 16

const CLASSES = [1, 2, 3, 4]

export function lpgmIconId(lgInt: number): string {
  return `lpgm-badge-${lgInt}`
}

function drawBadge(lgInt: number): ImageData {
  const r = LPGM_ICON_BASE_RADIUS
  const size = (r + PADDING) * 2
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2
  const cy = size / 2
  const half = r

  const fill = getLpgmClassColor(lgInt)

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.7)'
  ctx.shadowBlur = SHADOW_BLUR
  ctx.fillStyle = fill
  roundedRect(ctx, cx - half, cy - half, half * 2, half * 2, CORNER_RADIUS)
  ctx.fill()
  ctx.restore()

  ctx.strokeStyle = 'rgba(255,255,255,0.8)'
  ctx.lineWidth = STROKE_WIDTH
  const inset = STROKE_WIDTH / 2
  roundedRect(ctx, cx - half + inset, cy - half + inset, half * 2 - inset * 2, half * 2 - inset * 2, CORNER_RADIUS)
  ctx.stroke()

  // 文字色は塗り色から決める（白固定だと階級1 の #c8c800 で 1.79:1 まで落ちる）。
  ctx.fillStyle = readableTextColor(fill)
  // "Noto Sans JP" は @font-face 未登録で効いておらず、同梱も撤去済み（理由は intensityIcons.ts 参照）。
  ctx.font = `700 ${r * 1.1}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(lgInt), cx, cy)

  return ctx.getImageData(0, 0, size, size)
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/** map インスタンスへ LPGM 階級バッジ画像を一括登録する（既に登録済みなら何もしない）。 */
export function ensureLpgmIcons(map: MapLibreMap): void {
  for (const lgInt of CLASSES) {
    const id = lpgmIconId(lgInt)
    if (map.hasImage(id)) continue
    map.addImage(id, drawBadge(lgInt))
  }
}
