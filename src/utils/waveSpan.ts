// 地図の下端の波形の横の幅（設定）。**自作地震計と公開観測点で揃える**（物差しを合わせる。
// `docs/public-waveform-design.md` §0。2026-10-14 ユーザー承認）。
//
// 定義を utils に置くのは、設定（`hooks/useSettings.ts`）と抱える側（`hooks/useSeismoStation.ts`）の両方が
// 読むため —— 設定から生やすと、抱える側が設定へ依存する向きになる。

/** 選べる幅（秒）。 */
export const WAVE_SPAN_CHOICES = [60, 120, 180] as const

export type WaveSpanSec = (typeof WAVE_SPAN_CHOICES)[number]

/** 既定の幅（秒）。 */
export const DEFAULT_WAVE_SPAN_SEC: WaveSpanSec = 120

/**
 * 選べるいちばん長い幅（秒）。**波形を抱える長さはこれに合わせる** —— 設定で幅を広げた瞬間に、
 * 抱えていない区間が絵の左に空いて「届かなかった」ように見えないようにする。
 */
export const MAX_WAVE_SPAN_SEC: WaveSpanSec = WAVE_SPAN_CHOICES[WAVE_SPAN_CHOICES.length - 1]

/** 保存された値を読む。選べる幅のどれでもなければ `fallback`。 */
export function ensureWaveSpanSec(value: unknown, fallback: WaveSpanSec): WaveSpanSec {
  return (WAVE_SPAN_CHOICES as readonly unknown[]).includes(value) ? (value as WaveSpanSec) : fallback
}
