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
