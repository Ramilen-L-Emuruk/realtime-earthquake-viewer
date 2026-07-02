import type { JMATsunami, TsunamiGrade, TsunamiObservation } from '../types/earthquake'

const GRADE_PRIORITY: Record<TsunamiGrade, number> = {
  MajorWarning: 4, Warning: 3, Watch: 2, Forecast: 1, Unknown: 0,
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
    if (g !== 'Unknown' && g !== 'Forecast' && (max === null || GRADE_PRIORITY[g] > GRADE_PRIORITY[max])) max = g
  }
  return max as 'MajorWarning' | 'Warning' | 'Watch' | null
}

/**
 * 前回・今回の観測情報をマージする。VTSE51②/VTSE52（観測のみ電文）が届くたびに
 * 全観測点が再送されるとは限らないため、区域コード+観測点名をキーに upsert し、
 * 今回の電文に含まれない観測点は前回の値を保持する。
 */
export function mergeTsunamiObservations(
  prev: TsunamiObservation[] | undefined,
  next: TsunamiObservation[] | undefined,
): TsunamiObservation[] | undefined {
  if (!next || next.length === 0) return prev
  if (!prev || prev.length === 0) return next

  const key = (o: TsunamiObservation) => `${o.districtCode ?? o.districtName ?? ''}|${o.name}`
  const merged = new Map<string, TsunamiObservation>()
  for (const o of prev) merged.set(key(o), o)
  for (const o of next) merged.set(key(o), o)
  return Array.from(merged.values())
}
