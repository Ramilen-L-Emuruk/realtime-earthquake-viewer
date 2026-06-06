import type { DomesticTsunami, IssueType, TsunamiGrade } from '../types/earthquake'

export function formatDateTime(isoString: string): string {
  const date = new Date(isoString)
  const y = date.getFullYear()
  const M = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${y}/${M}/${d} ${h}:${m}:${s}`
}

/**
 * 地震の発生時刻。元データに秒が含まれないため、秒を出さず「ごろ」を付ける。
 * 例: 6月6日 8:47ごろ
 */
export function formatQuakeTime(isoString: string): string {
  const date = new Date(isoString)
  const M = date.getMonth() + 1
  const d = date.getDate()
  const h = date.getHours()
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${M}月${d}日 ${h}:${m}ごろ`
}

export function formatTime(isoString: string): string {
  const date = new Date(isoString)
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

export function formatDepth(depth: number): string {
  if (depth === 0) return 'ごく浅い'
  if (depth < 0) return '不明'
  return `${depth}km`
}

export function formatMagnitude(magnitude: number): string {
  if (magnitude < 0) return '不明'
  return `M${magnitude.toFixed(1)}`
}

export function formatDomesticTsunami(type: DomesticTsunami): { text: string; color: string } {
  const map: Record<DomesticTsunami, { text: string; color: string }> = {
    None: { text: '津波の心配なし', color: '#22c55e' },
    Unknown: { text: '調査中', color: '#94a3b8' },
    Checking: { text: '調査中', color: '#94a3b8' },
    NonEffective: { text: '若干の海面変動', color: '#f59e0b' },
    Watch: { text: '津波注意報', color: '#f97316' },
    Warning: { text: '津波警報', color: '#ef4444' },
  }
  return map[type] ?? { text: '不明', color: '#94a3b8' }
}

export function formatIssueType(type: IssueType): string {
  const map: Record<IssueType, string> = {
    ScalePrompt: '震度速報',
    Destination: '震源情報',
    ScaleAndDestination: '震源・震度情報',
    DetailScale: '各地の震度情報',
    Foreign: '遠地地震',
    Other: 'その他',
  }
  return map[type] ?? type
}

export function formatTsunamiGrade(grade: TsunamiGrade): { text: string; color: string; bg: string } {
  const map: Record<TsunamiGrade, { text: string; color: string; bg: string }> = {
    MajorWarning: { text: '大津波警報', color: '#ffffff', bg: '#9d0099' },
    Warning: { text: '津波警報', color: '#ffffff', bg: '#f00000' },
    Watch: { text: '津波注意報', color: '#000000', bg: '#ffa000' },
    Unknown: { text: '不明', color: '#ffffff', bg: '#666666' },
  }
  return map[grade] ?? { text: grade, color: '#ffffff', bg: '#666666' }
}
