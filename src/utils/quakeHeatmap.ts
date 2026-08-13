import type { JMAQuake } from '../types/earthquake'
import { extractQuakeEventIdFromId } from './quakeMerge'

export interface HeatPoint {
  lat: number
  lng: number
  weight: number
  /** 震源地名。DMDSS の GD Earthquake List が返さない場合は空文字。 */
  name: string
  /** 発生時刻（ISO 文字列）。 */
  time: string
  /** 深さ(km)。不明・未取得は -1（formatDepth が「不明」に落とす）。 */
  depth: number
  magnitude: number
}

// 地震の同一性判定キー。DMDSS版の id には14桁の eventId が埋め込まれておりそれを使う
// （GD Earthquake List の eventId フィールドも同じ14桁形式のため突き合わせ可能）。
// 通常版（P2PQuake）の id はこの形式を持たないため earthquake.time にフォールバックする。
export function quakeIdentityKey(q: Pick<JMAQuake, 'id' | 'earthquake'>): string {
  const dmdataEventId = extractQuakeEventIdFromId(q.id)
  return dmdataEventId ?? q.earthquake.time
}

// 震源が未確定（震度速報段階など）のプレースホルダー座標を判定する。
export function hasValidHypocenter(lat: number, lng: number): boolean {
  return lat > -200 && lng > -200
}

// マグニチュードをヒートマップの重みに変換する。
// 震度は震源からの距離に左右され月単位の集計には向かないため、地震そのものの規模を表す
// マグニチュードを重みに採用する（M1〜M8 を 0〜1 に正規化）。
// マグニチュードは対数尺度（+1で放出エネルギーが約31.6倍）なため単純な線形では
// 大地震のインパクトが実態より圧縮されすぎる。二乗して差を強調する。
export function magnitudeToWeight(magnitude: number): number {
  const normalized = Math.min(1, Math.max(0, (magnitude - 1) / 7))
  return Math.max(0.1, normalized ** 2)
}
