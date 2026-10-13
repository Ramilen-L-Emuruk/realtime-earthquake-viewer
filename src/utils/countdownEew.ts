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

/**
 * 地図の下端の波形へ P/S の到達線を引く相手。**自前の走時計算を使ってよい端末でなければ `null`**
 * （到達予想トークンが有効なとき。気象業務法の線引きの判断は `docs/forecast-computation-audit.md`）。
 *
 * 門をこの関数に置くのは、App の中の式のままだと**外れても型にもテストにも掛からない**から。
 */
export function pickSeismoArrivalEew(params: {
  allowOwnArrivalCalc: boolean
  psWave: readonly PsWaveCircle[]
  eews: readonly EEWAlert[]
}): EEWAlert | null {
  if (!params.allowOwnArrivalCalc) return null
  return pickCountdownEew(params.psWave, params.eews)
}
