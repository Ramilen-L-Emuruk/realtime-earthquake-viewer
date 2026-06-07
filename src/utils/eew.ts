import type { EEWAlert, EEWRegion } from '../types/earthquake'

// P2PQuake v2 の EEW は実データで `areas`、テスト/旧データで `regions` を使うため、
// どちらでも対象地域を取得できるよう吸収する。

export function eewAreas(eew: EEWAlert): EEWRegion[] {
  return eew.areas ?? eew.regions ?? []
}

/** 対象地域の最大予想震度（scale 値）。areas が空なら forecastMaxScale にフォールバック。 */
export function eewMaxScale(eew: EEWAlert): number {
  const areasMax = eewAreas(eew).reduce((max, r) => Math.max(max, r.scaleTo), 0)
  return areasMax > 0 ? areasMax : (eew.forecastMaxScale ?? 0)
}

/** 情報番号（第N報）。取得できなければ null。 */
export function eewSerial(eew: EEWAlert): number | null {
  const n = Number(eew.issue?.serial)
  return Number.isInteger(n) && n > 0 ? n : null
}
