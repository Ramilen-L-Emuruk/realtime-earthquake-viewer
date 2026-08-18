import { readableTextColor } from '../../../utils/contrast'

// maplibregl.Popup の本文を組み立てる際に各レイヤーで共有する小道具。
// エスケープ処理と震度／階級バッジは複数のレイヤーが同じものを必要とするため、
// レイヤーごとに書き写さず一箇所に置く。

/**
 * ポップアップ本文へプレーンテキストを埋め込む際のエスケープ。
 * 埋め込む値は自前生成の public/data・気象庁電文由来だが、HTML 文字列を組み立てる以上
 * 表示側で必ず通す（電文の地名に & が含まれても壊れないようにするため）。
 * SEC-1: 属性値内で使う場合を想定して " と ' もエスケープする（要素内テキストとしても無害）。
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 見出し＋補足の2段組み本文（活断層・プレート境界・津波海岸線などの共通形）。 */
export function twoLinePopupHtml(title: string, subtitle: string): string {
  return (
    `<div class="text-sm"><div class="font-bold">${escapeHtml(title)}</div>` +
    `<div class="text-xs" style="color:#94a3b8">${escapeHtml(subtitle)}</div></div>`
  )
}

/**
 * 震度・長周期地震動階級を示す色付きバッジ（震源ポップアップの県別震度と同じ見た目）。
 * 文字色は塗り色から自動で決める（気象庁配色は明度の幅が広く、白固定だと黄・橙系で読めないため）。
 */
export function badgeHtml(label: string, color: string): string {
  return (
    `<span style="display:inline-block;min-width:20px;padding:0 5px;text-align:center;font-weight:700;` +
    `border-radius:3px;color:${readableTextColor(color)};font-size:10px;line-height:16px;` +
    `background:${color}">${escapeHtml(label)}</span>`
  )
}
