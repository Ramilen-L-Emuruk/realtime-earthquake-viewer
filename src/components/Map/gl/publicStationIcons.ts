import type { Map as MapLibreMap } from 'maplibre-gl'
import { readableTextColor } from '../../../utils/contrast'

// 公開観測点（下部の波形に出している気象庁の観測点）の地図の印を Canvas2D で事前ラスタライズし、symbol レイヤーの
// icon-image として登録する（`docs/public-waveform-design.md` §0・§7）。
//
// **焼き方は震度バッジ（gl/intensityIcons.ts）に揃える** —— 基準の大きさで 1 回だけ焼いて `icon-size` で縮める・
// 影（黒 0.7・ぼかし 3）・白フチ（0.7）・数字の色は塗りから白黒を選ぶ・太字の sans-serif。数字を地図の文字
// （symbol の text-field）で重ねないのも同じ理由で、CJK フォントの上下の余白で中心がずれる。
//
// **形は三角、番号は三角の真ん中（重心）に焼き込む**（2026-10-15 ユーザー承認）。番号は波形の見出しの「#1」と同じ。

/** 焼くときの大きさ（外接円の半径・px）。表示の大きさは `icon-size` でこの半径からの比で決める。 */
export const PUBLIC_STATION_ICON_BASE_RADIUS = 32
// 影のにじみ分の余白（震度バッジと同じ）。
const PADDING = 8
/**
 * 白フチの太さ（外接円の半径に対する比）。震度バッジの既定（2/32）だと、表示の大きさ（14 px）では 1px を割って消える。
 * 津波の到達確認マーカーのフチ（1.5 px）と同じ水準になるよう、表示で約 1.75 px になる比にする。
 */
const RING_RATIO = 4 / 32

/**
 * 塗り（2026-10-15 ユーザー承認）。選び方の基準は 2 つ ——
 *
 * - **数字と 4.5:1 以上**（WCAG AA。`utils/contrast.ts` が白黒の高い方を選ぶ。この色では黒で 7.9:1）
 * - **暗い陸地（`BaseMapGL` の `LAND_FILL` = `#161b24`）と 3:1 以上**（WCAG の図形の基準。この色で 6.5:1）
 *
 * 震度の色（気象庁の配色）・津波の色・P/S 線の色・値の無い印の灰と別の系統から選んだ。
 */
export const PUBLIC_STATION_COLOR = '#f472b6'

/** 番号ごとの印の id。番号は 1 から（`publicStationSelection.ts` が振る）。 */
export function publicStationIconId(number: number): string {
  return `public-station-${number}`
}

/** 焼いておく番号の上限。運用中の観測点は 20 点（表の全部が選ばれても足りる）。 */
const MAX_NUMBER = 32

function drawTriangle(number: number): ImageData {
  const r = PUBLIC_STATION_ICON_BASE_RADIUS
  const size = (r + PADDING) * 2
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2
  const cy = size / 2
  // 外接円の半径 r の正三角形（頂点が上）。重心＝外接円の中心なので、番号は (cx, cy) に置けば真ん中に来る。
  const half = (r * Math.sqrt(3)) / 2
  const path = (): void => {
    ctx.beginPath()
    ctx.moveTo(cx, cy - r)
    ctx.lineTo(cx + half, cy + r / 2)
    ctx.lineTo(cx - half, cy + r / 2)
    ctx.closePath()
  }

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.7)'
  ctx.shadowBlur = 3
  ctx.fillStyle = PUBLIC_STATION_COLOR
  path()
  ctx.fill()
  ctx.restore()

  // 白フチは内側へ引く（外へ出すと、印の外形が塗りより大きくなり番号の入る余地が見た目より狭く見える）。
  // 三角は角が尖るので、内側に切り抜いてから倍の太さで引く。
  const ring = r * RING_RATIO
  ctx.save()
  path()
  ctx.clip()
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'
  ctx.lineWidth = ring * 2
  ctx.lineJoin = 'round'
  path()
  ctx.stroke()
  ctx.restore()

  const label = String(number)
  ctx.fillStyle = readableTextColor(PUBLIC_STATION_COLOR)
  // 三角は丸より中が狭いので、震度バッジ（1 文字 1.15・2 文字 0.85）より一段小さく取る。
  ctx.font = `700 ${label.length > 1 ? r * 0.62 : r * 0.8}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // `middle` は字面の中心よりわずかに上へ寄るので、半径の 8% だけ下げて重心に合わせる（描いて確かめた値）。
  ctx.fillText(label, cx, cy + r * 0.08)

  return ctx.getImageData(0, 0, size, size)
}

/** map インスタンスへ公開観測点の印を一括登録する（既に登録済みなら何もしない）。 */
export function ensurePublicStationIcons(map: MapLibreMap): void {
  for (let n = 1; n <= MAX_NUMBER; n += 1) {
    const id = publicStationIconId(n)
    if (map.hasImage(id)) continue
    map.addImage(id, drawTriangle(n))
  }
}
