// 発表中の緊急地震速報のうち、**「この端末の場所へ何が来るか」を語る相手**を 1 つ選ぶ。
//
// 使うのは 2 箇所 ——登録地点への主要動到達カウントダウン（`hooks/useSWaveCountdown.ts`）と、
// 地図の下端の自作地震計の波形へ引く P/S の到達線（`components/SeismoWaveChart`）。
// **選び方を 1 つにする**（2026-10-13 ユーザー指示「カウントダウンなどと同じ方法で絞って」）——
// 別々に持つと、複数の緊急地震速報が出ている間にカウントダウンと波形の線が別の地震を指しうる。

import type { PsWaveCircle } from '../services/kyoshin'
import type { EEWAlert } from '../types/earthquake'

/**
 * 予報円のうち、**S 波の波面がいちばん外側にあるもの**。1 つも無ければ `null`。
 *
 * 予報円は `usePsWaveCalc` の時点で、取消済み・位置不明・仮定震源要素・深さ不明・まだ発生していない
 * ものを外してある（`computeEewCircle`）。ここではそれ以上は絞らない。
 */
export function pickCountdownCircle(psWave: readonly PsWaveCircle[]): PsWaveCircle | null {
  if (psWave.length === 0) return null
  return psWave.reduce((best, c) => (c.sRadius > best.sRadius ? c : best), psWave[0])
}

/**
 * {@link pickCountdownCircle} の円を作った緊急地震速報。**引き当てられなければ `null`。**
 *
 * 円の `eventId` は `eew.issue?.eventId ?? eew.id`（`computeEewCircle`）なので、同じ式で引く。
 */
export function pickCountdownEew(psWave: readonly PsWaveCircle[], eews: readonly EEWAlert[]): EEWAlert | null {
  const circle = pickCountdownCircle(psWave)
  if (circle === null) return null
  return eews.find((e) => (e.issue?.eventId ?? e.id) === circle.eventId) ?? null
}
