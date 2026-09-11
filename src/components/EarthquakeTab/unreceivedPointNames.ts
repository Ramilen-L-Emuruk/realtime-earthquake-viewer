import type { EarthquakePoint } from '../../types/earthquake'

/** 「震度を入手していない地点」の 1 行分。 */
export interface UnreceivedPointName {
  name: string
  /** 気象庁以外が運用する観測点か（→ {@link EarthquakePoint.nonJma}）。 */
  nonJma: boolean
}

/**
 * 未入電の地点を、画面に並べる 1 行ずつへまとめる。
 *
 * 電文には同じ名前の点が複数入りうる（都道府県のロールアップ点と観測点、複数の県にまたがる
 * 同名の市町村）。行を重ねても読み手に伝わるものが増えないので 1 行にまとめる。
 * **渡された順序をそのまま保つ** —— 並びは呼び出し側が気象庁の標準順で決めている。
 *
 * **「気象庁以外」の印は、その名前の点が全部そうだったときだけ付ける。** 同名で出所の違う
 * 点が混ざったときに、気象庁の観測点へ他所の印を付けないため（逆向きの取り違えなら、
 * 印が出ないだけで嘘は言わない）。
 */
export function mergeUnreceivedPointNames(
  points: Pick<EarthquakePoint, 'addr' | 'nonJma'>[],
): UnreceivedPointName[] {
  const byName = new Map<string, boolean>()
  for (const p of points) {
    const prev = byName.get(p.addr)
    byName.set(p.addr, prev === undefined ? !!p.nonJma : prev && !!p.nonJma)
  }
  return [...byName].map(([name, nonJma]) => ({ name, nonJma }))
}
