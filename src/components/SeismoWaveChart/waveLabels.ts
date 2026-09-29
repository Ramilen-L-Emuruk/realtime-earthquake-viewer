// 波形グラフに添える短い文字列。**描画から切り離してテストする。**

import type { SeismoWaveTally } from '../../utils/seismoWaveBuffer'

/**
 * 縦の振れ幅の表示（`±N gal`）。
 *
 * **桁を揃えず、値の大きさで刻みを変える。** 静穏時は 1 gal を下回るところで
 * 動くので小数が要る一方、揺れているときの 3 桁に小数は要らない。
 */
export function formatScaleGal(scaleGal: number): string {
  if (!Number.isFinite(scaleGal)) return '—'
  const abs = Math.abs(scaleGal)
  if (abs >= 10) return `±${Math.round(abs)} gal`
  return `±${abs.toFixed(1)} gal`
}

/**
 * 波形を抱えている間に起きたことの要約。**何も起きていなければ `null`。**
 *
 * **0 でないものだけを並べる。** 常時「欠測 0」を出すと、本当に起きたときの
 * 変化が目に入らない。
 *
 * **色や語で「異常」を主張しない。** 正常運転でも合成のまとまりの末尾で
 * 裏付けが 1〜3 本欠ける（#374）ように、ここに数字が立つこと自体は
 * 故障を意味しない —— 起きた回数を見せるところまでが役目。
 */
export function formatWaveTally(tally: SeismoWaveTally): string | null {
  const parts: string[] = []
  if (tally.gapSamples > 0) parts.push(`欠測 ${tally.gapSamples}`)
  if (tally.restarts > 0) parts.push(`引き直し ${tally.restarts}`)
  if (tally.droppedSamples > 0) parts.push(`重複 ${tally.droppedSamples}`)
  return parts.length === 0 ? null : parts.join(' / ')
}
