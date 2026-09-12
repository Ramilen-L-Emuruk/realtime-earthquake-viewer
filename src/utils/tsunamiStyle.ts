import type { TsunamiGrade } from '../types/earthquake'

// 津波等級ごとの海岸線スタイル（Leaflet 版 JapanMap の TSUNAMI_STYLE と一致）。
// 同一区域に複数等級が来た場合にどちらを採るかは `utils/tsunami.ts` の `GRADE_PRIORITY` で決める
// （等級の重さを表す値をここにも置くと、等級を増やしたときに片方だけ漏れる）。

export const TSUNAMI_STYLE: Record<TsunamiGrade, { color: string; weight: number; label: string }> = {
  MajorWarning: { color: '#c026d3', weight: 6, label: '大津波警報' },
  Warning: { color: '#ef4444', weight: 5, label: '津波警報' },
  Watch: { color: '#f59e0b', weight: 4, label: '津波注意報' },
  Forecast: { color: '#22d3ee', weight: 3, label: '津波予報' },
  Unknown: { color: '#9ca3af', weight: 2, label: '津波予報' },
}

/**
 * 欠測（観測できていない観測点）の色。カードのバッジと地図の印で共有する。
 *
 * **無彩色にしない。** この画面で灰色は「意味のある量が無い」（波高が未確定の到達確認マーカー・
 * 震度0）に使っている。欠測は量が無いのではなく**観測そのものが届いていない**状態で、
 * 津波が来ていないことの保証にはならないため、注意を引く色を当てる。
 *
 * 等級色（紫・赤・橙・シアン）は借りない ―― 観測できていない観測点に等級の重さを持たせると、
 * 波高を観測したように読める。
 */
export const TSUNAMI_MISSING_COLOR = '#fbbf24'
