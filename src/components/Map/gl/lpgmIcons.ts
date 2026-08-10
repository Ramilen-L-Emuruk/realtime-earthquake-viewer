import type { Map as MapLibreMap } from 'maplibre-gl'
import { getLpgmClassColor } from '../../../utils/lpgm'

// 長周期地震動観測点の階級バッジを Canvas2D で事前ラスタライズし、symbol レイヤーの icon-image として
// 登録する。震度バッジ（gl/intensityIcons.ts）と同じ理由（CJK フォントのベースライン特性により
// text-field＋text-offset では安定した中央揃えができない）で画像方式にしている。

/** アイコン生成のベース半径(px)相当（正方形の一辺の半分）。icon-size でこの比率をかけて表示する。 */
export const LPGM_ICON_BASE_RADIUS = 16
const PADDING = 6

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

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.7)'
  ctx.shadowBlur = 3
  ctx.fillStyle = getLpgmClassColor(lgInt)
  roundedRect(ctx, cx - half, cy - half, half * 2, half * 2, 3)
  ctx.fill()
  ctx.restore()

  ctx.strokeStyle = 'rgba(255,255,255,0.8)'
  ctx.lineWidth = 2
  roundedRect(ctx, cx - half + 1, cy - half + 1, half * 2 - 2, half * 2 - 2, 3)
  ctx.stroke()

  ctx.fillStyle = '#ffffff'
  ctx.font = `700 ${r * 1.1}px "Noto Sans JP", sans-serif`
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
