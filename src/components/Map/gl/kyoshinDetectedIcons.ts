import type { Map as MapLibreMap } from 'maplibre-gl'
import { getIntensityColor } from '../../../utils/intensity'
import { SHINDO0_COLOR } from '../../../utils/kyoshinIntensity'
import { readableTextColor } from '../../../utils/contrast'

// 揺れ検知点（KyoshinDetectedPointsGL の confirmed=確定／likely=候補）の丸バッジ（震度ラベル込み）を
// Canvas2D で事前ラスタライズし、symbol レイヤーの icon-image として登録する。
// 震度観測点（QuakeIntensityPointsGL、gl/intensityIcons.ts）と同じ「丸背景＋文字を1枚の画像に
// 統合する」方式。丸背景を circle レイヤーで、震度ラベルを別の symbol レイヤーで重ねる旧実装は、
// circle が衝突判定に一切参加しない仕様のため丸同士の重なりを防げず、文字レイヤーも丸レイヤーとは
// 独立に描画されるため「下に完全に隠れた丸の文字まで表示してしまう」問題があった
// （2026-08-10 の実機検証）。丸ごと1枚の画像にすることで、icon-allow-overlap:true のまま
// （重なりは許容）でも、symbol-sort-key で前面に来た1点は「丸＋文字セット」で必ず正しく読める。

/** アイコン生成のベース半径(px)。実際の表示サイズは icon-size でこの半径からの比率をかけて決める。 */
export const KYOSHIN_DETECTED_ICON_BASE_RADIUS = 32
const PADDING = 8
// confirmed の白フチ幅（旧 circle 版 CONFIRMED_STROKE_WIDTH の見た目を踏襲、ベース半径基準で少し太め）。
const CONFIRMED_RING_WIDTH = 4

// kyoshinIndexToJma の rank(0〜9) と対応するラベル・代表 scale（震度0は色を別途 SHINDO0_COLOR にする）。
const RANK_LABELS = ['0', '1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7']
const RANK_SCALES = [10, 10, 20, 30, 40, 45, 50, 55, 60, 70]

export function kyoshinDetectedIconId(rank: number, confirmed: boolean): string {
  return `kyoshin-detected-badge-${rank}-${confirmed ? 'confirmed' : 'candidate'}`
}

function rankColor(rank: number): string {
  return rank === 0 ? SHINDO0_COLOR : getIntensityColor(RANK_SCALES[rank] ?? 10)
}

function drawBadge(rank: number, confirmed: boolean): ImageData {
  const r = KYOSHIN_DETECTED_ICON_BASE_RADIUS
  const size = (r + PADDING) * 2
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2
  const cy = size / 2

  const fill = rankColor(rank)

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.7)'
  ctx.shadowBlur = 3
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // confirmed は太めの白フチで一段目立たせる（旧 circle 版の confidence 差別化を踏襲）。
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = confirmed ? CONFIRMED_RING_WIDTH : 2
  ctx.globalAlpha = confirmed ? 1 : 0.7
  ctx.beginPath()
  ctx.arc(cx, cy, r - ctx.lineWidth / 2, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 1

  const label = RANK_LABELS[rank] ?? '?'
  // 文字色は丸の塗り色から決める（白固定だと震度4 の黄で 1.30:1 まで落ちる。intensityIcons.ts と同様）。
  ctx.fillStyle = readableTextColor(fill)
  // "Noto Sans JP" は @font-face 未登録で効いておらず、同梱も撤去済み（理由は intensityIcons.ts 参照）。
  ctx.font = `700 ${label.length > 1 ? r * 0.85 : r * 1.15}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, cx, cy)

  return ctx.getImageData(0, 0, size, size)
}

/** map インスタンスへ揺れ検知点バッジ画像（rank 0〜9 × confirmed/candidate）を一括登録する。 */
export function ensureKyoshinDetectedIcons(map: MapLibreMap): void {
  for (let rank = 0; rank < RANK_LABELS.length; rank++) {
    for (const confirmed of [true, false]) {
      const id = kyoshinDetectedIconId(rank, confirmed)
      if (map.hasImage(id)) continue
      map.addImage(id, drawBadge(rank, confirmed))
    }
  }
}
