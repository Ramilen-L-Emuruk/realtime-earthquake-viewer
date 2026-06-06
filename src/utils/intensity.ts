export const INTENSITY_LABELS: Record<number, string> = {
  '-1': '不明',
  10: '1',
  20: '2',
  30: '3',
  40: '4',
  45: '5弱',
  50: '5強',
  55: '6弱',
  60: '6強',
  70: '7',
}

export const INTENSITY_COLORS: Record<number, string> = {
  '-1': '#666666',
  10: '#7bb4c8',
  20: '#0070c8',
  30: '#00b050',
  40: '#f5e600',
  45: '#ffa000',
  50: '#ff6600',
  55: '#f00000',
  60: '#a50021',
  70: '#9d0099',
}

export const INTENSITY_BG_COLORS: Record<number, string> = {
  '-1': '#2a2a2a',
  10: '#0f2a30',
  20: '#001533',
  30: '#002010',
  40: '#2a2800',
  45: '#2a1800',
  50: '#2a1000',
  55: '#2a0000',
  60: '#1a0007',
  70: '#1a0020',
}

export function getIntensityLabel(scale: number): string {
  return INTENSITY_LABELS[scale] ?? '不明'
}

export function getIntensityColor(scale: number): string {
  return INTENSITY_COLORS[scale] ?? '#666666'
}

export function getIntensityBgColor(scale: number): string {
  return INTENSITY_BG_COLORS[scale] ?? '#2a2a2a'
}

/**
 * 深さに応じた色（浅い=赤系、深い=青系）。気象庁震度配色に準拠した段階色。
 */
export function getDepthColor(depth: number): string {
  if (depth < 0) return '#666666'     // 不明
  if (depth === 0) return '#f00000'   // ごく浅い → 赤（震度6弱相当）
  if (depth <= 20) return '#ff6600'   // 〜20km → オレンジ（震度5強相当）
  if (depth <= 40) return '#ffa000'   // 〜40km → 黄橙（震度5弱相当）
  if (depth <= 80) return '#f5e600'   // 〜80km → 黄（震度4相当）
  if (depth <= 150) return '#00b050'  // 〜150km → 緑（震度3相当）
  if (depth <= 300) return '#0070c8'  // 〜300km → 青（震度2相当）
  return '#7bb4c8'                    // 300km超 → 薄青（震度1相当）
}

/**
 * マグニチュードに応じた色。気象庁震度配色のスケールをM2〜M7+に割り当て。
 * 小さい(M2未満)=薄青(震度1相当) → 大きい(M7以上)=紫(震度7相当)
 */
export function getMagnitudeColor(magnitude: number): string {
  if (magnitude < 0) return '#666666'
  if (magnitude < 2.0) return '#7bb4c8'   // M2未満 → 薄青（震度1相当）
  if (magnitude < 3.0) return '#0070c8'   // M2〜3 → 青（震度2相当）
  if (magnitude < 4.0) return '#00b050'   // M3〜4 → 緑（震度3相当）
  if (magnitude < 5.0) return '#f5e600'   // M4〜5 → 黄（震度4相当）
  if (magnitude < 6.0) return '#ffa000'   // M5〜6 → 黄橙（震度5弱相当）
  if (magnitude < 7.0) return '#f00000'   // M6〜7 → 赤（震度6弱相当）
  return '#9d0099'                         // M7以上 → 紫（震度7相当）
}

export function isHighIntensity(scale: number): boolean {
  return scale >= 50
}

export function isCriticalIntensity(scale: number): boolean {
  return scale >= 55
}

export function getScaleRadius(scale: number): number {
  const radiusMap: Record<number, number> = {
    '-1': 4,
    10: 4,
    20: 5,
    30: 6,
    40: 7,
    45: 9,
    50: 10,
    55: 12,
    60: 14,
    70: 16,
  }
  return radiusMap[scale] ?? 4
}
