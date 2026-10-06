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
  return `±${formatGal(scaleGal)} gal`
}

/**
 * 強調して描いたときの縦の表示（`±W〜±T gal`）。**W は潰したノイズの幅、T は縦の上端。**
 *
 * 潰した量が数字で見えるようにする（2026-10-03 のユーザー判断）。縦は W から T までしか
 * 描いていないので、上端だけを出すと「0 から T まで」と読まれる。
 */
export function formatEmphasizedScaleGal(widthGal: number, topGal: number): string {
  if (!Number.isFinite(widthGal) || !Number.isFinite(topGal)) return '—'
  return `±${formatGal(widthGal)}〜±${formatGal(topGal)} gal`
}

/** 桁を値の大きさで変える（10 以上は整数・未満は小数 1 桁）。 */
function formatGal(gal: number): string {
  const abs = Math.abs(gal)
  return abs >= 10 ? String(Math.round(abs)) : abs.toFixed(1)
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
