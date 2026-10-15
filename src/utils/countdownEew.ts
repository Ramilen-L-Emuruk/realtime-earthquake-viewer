// 発表中の緊急地震速報のうち、**「この端末の場所へ何が来るか」を語る相手**を 1 つ選ぶ。
//
// 使うのは 2 箇所 ——登録地点への主要動到達カウントダウン（`hooks/useSWaveCountdown.ts`）と、
// 地図の下端の自作地震計の波形へ引く P/S の到達線（`components/SeismoWaveChart`）。
// **選び方を 1 つにする**（2026-10-13 ユーザー指示「カウントダウンなどと同じ方法で絞って」）——
// 別々に持つと、複数の緊急地震速報が出ている間にカウントダウンと波形の線が別の地震を指しうる。

import type { PsWaveCircle } from '../services/kyoshin'
import type { EEWAlert } from '../types/earthquake'
import { eewSortTimeMs } from './eew'

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
 * 下部の波形に出す公開観測点を選ぶ材料にする緊急地震速報（`hooks/usePublicWaves.ts`）。
 *
 * **予報円が引けるならそれと同じ速報を使う**（P/S 線・カウントダウンと別の地震を指さない）。予報円を描かない速報
 * ——仮定震源要素・深さ不明——だけが出ているときは、**発表中のうち地震の発生（無ければ発現）がいちばん新しいものを使う**。
 * そうした報でも観測点を選ぶと決めてあるため（`docs/public-waveform-design.md` §0「震源の要素が欠けるとき」）。
 * `eews` は取消を外したもの（`App.tsx` の `eewsForMap`）。
 */
export function pickPublicWaveEew(countdownEew: EEWAlert | null, eews: readonly EEWAlert[]): EEWAlert | null {
  if (countdownEew !== null) return countdownEew
  let best: EEWAlert | null = null
  let bestMs = -Infinity
  for (const e of eews) {
    const key = eewSortTimeMs(e)
    if (best === null || key > bestMs) {
      best = e
      bestMs = key
    }
  }
  return best
}
