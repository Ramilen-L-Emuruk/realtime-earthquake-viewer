// 波形へ重ねる P 波・S 波の到達線の見た目と、横位置の出し方。
//
// **3 箇所が共有する** —— 地震カードの波形・詳細の窓・地図の下端の波形。見た目を 1 箇所で決めないと、
// 同じものを指す線が窓によって違う色・線種になる。

import { P_WAVE_COLOR, S_WAVE_COLOR } from '../Map/gl/psWaveStyle'
import type { WaveMark } from './paintWave'

/**
 * 到達の線の見た目。**地図の予報円と同じ配色・同じ線種を使う**（`gl/psWaveStyle.ts`）——
 * 同じ画面で同じものを指すのに色が違うと、別の量に見える。**P が破線・S が実線**なのも
 * あちらに揃えたもの。
 */
const P_MARK = { color: P_WAVE_COLOR, dashed: true } as const
const S_MARK = { color: S_WAVE_COLOR, dashed: false } as const

/**
 * 到達時刻を、絵の横位置（左端 0・右端 1）へ落とす。**絵の左端と右端の時刻で受ける。**
 *
 * **範囲の外に落ちた線は描く側（`paintMarks`）が捨てる。** 地図の下端の波形では、まだ来ていない時刻の線が
 * 右端の外に落ちるので描かれない —— 線を引けるのは過ぎた時刻だけ。
 */
export function buildArrivalMarksForRange(
  range: { readonly fromMs: number; readonly toMs: number },
  arrival: { pMs: number; sMs: number } | null,
): WaveMark[] {
  if (arrival === null) return []
  const spanMs = range.toMs - range.fromMs
  if (!(spanMs > 0)) return []
  const ratioOf = (atMs: number): number => (atMs - range.fromMs) / spanMs
  return [
    { ratio: ratioOf(arrival.pMs), label: 'P', ...P_MARK },
    { ratio: ratioOf(arrival.sMs), label: 'S', ...S_MARK },
  ]
}
