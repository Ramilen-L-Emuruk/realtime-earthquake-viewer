import type { JMATsunami, TsunamiGrade } from '../types/earthquake'

const GRADE_PRIORITY: Record<TsunamiGrade, number> = {
  MajorWarning: 3, Warning: 2, Watch: 1, Unknown: 0,
}

/** 発表中エリアの最高グレードを返す。エリアが無ければ 'Unknown'。 */
export function tsunamiMaxGrade(tsunami: JMATsunami): TsunamiGrade {
  let max: TsunamiGrade = 'Unknown'
  for (const area of tsunami.areas) {
    if (GRADE_PRIORITY[area.grade] > GRADE_PRIORITY[max]) max = area.grade
  }
  return max
}

/** 複数の津波イベントを横断して最大グレードを返す。解除済み・Unknown は除外。なければ null。 */
export function tsunamiOverallGrade(tsunamis: JMATsunami[]): 'MajorWarning' | 'Warning' | 'Watch' | null {
  let max: TsunamiGrade | null = null
  for (const t of tsunamis) {
    if (t.cancelled) continue
    const g = tsunamiMaxGrade(t)
    if (g !== 'Unknown' && (max === null || GRADE_PRIORITY[g] > GRADE_PRIORITY[max])) max = g
  }
  return max as 'MajorWarning' | 'Warning' | 'Watch' | null
}
