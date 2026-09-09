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
 *
 * `white-space:nowrap` は必須。幅は中身に合わせて伸びるが、狭い親の中では折り返してしまい、
 * 「4以上」のような 2 文字を超えるラベル（EEW の上限を定めない予想震度）が縦に割れる。
 */
export function badgeHtml(label: string, color: string): string {
  return (
    `<span style="display:inline-block;min-width:20px;padding:0 5px;text-align:center;font-weight:700;` +
    `border-radius:3px;color:${readableTextColor(color)};font-size:10px;line-height:16px;` +
    `white-space:nowrap;background:${color}">${escapeHtml(label)}</span>`
  )
}

/**
 * 「気象庁以外が運用する観測点」のバッジに書く語。
 *
 * 地図の吹き出しと地震カードの両方で使う。**同じ事実を別の語で書かない** —— 片方だけ
 * 直すと、利用者には別のことを言っているように見える。
 */
export const NON_JMA_BADGE_LABEL = '気象庁以外'

/** 上のバッジに添える説明。**語だけでは何と対比しているのか分からない。** */
export const NON_JMA_BADGE_TITLE = '気象庁以外の機関が運用する観測点です'

/**
 * 「気象庁以外が運用する観測点」のバッジ。
 *
 * 電文は観測点名の末尾に `＊` を付け、固定付加文で「＊印は気象庁以外の震度観測点についての
 * 情報です。」と断っている（→ `EarthquakePoint.nonJma`）。アプリは印を名前から外して
 * 引き当てに使うため、**事実はこのバッジで伝える**。
 *
 * **震度・階級のバッジと見た目を分ける。** あちらは値の重さを色で表すもので、こちらは
 * 出所の注記。色を持たせると重さの一種に見える。
 *
 * **「自治体」と言い換えないこと** —— 気象庁以外には防災科研なども含まれる。
 */
export function nonJmaBadgeHtml(): string {
  return (
    `<span style="display:inline-block;padding:0 5px;font-weight:600;border-radius:3px;` +
    `color:#cbd5e1;font-size:10px;line-height:16px;white-space:nowrap;` +
    `border:1px solid #475569;background:transparent" `+
    `title="${NON_JMA_BADGE_TITLE}">${NON_JMA_BADGE_LABEL}</span>`
  )
}
