import { WAVE_HISTORY_LEAD_MS, WAVE_HISTORY_TAIL_MS } from '../services/seismoWaveHistory'

/**
 * 地震カードの公開観測点の波形を、保存庫からどの範囲で取るか（`docs/public-waveform-design.md` §6.1・§6.2）。
 *
 * - 範囲は自作地震計と同じカードの分の頭の 60 秒前〜4 分後（`WAVE_HISTORY_LEAD_MS`・`WAVE_HISTORY_TAIL_MS`）。次の地震の発生で切る
 * - **S 波が 4 分の内に届かない遠い観測点は、範囲の終わりを S 波の到達に合わせて伸ばす**（§0）
 * - 保存庫には 8〜19 秒遅れで入る（§3.5 の実測）。範囲の終わりが「いま」より十分前のものだけを取り終えたものとして扱う
 */

/** S 波の到達から、揺れを見せるために足す余白（ms）。**仮の値**（設計書 §12）。 */
export const PUBLIC_S_ARRIVAL_PAD_MS = 60_000
/** 範囲の長さの上限（ms）。伸ばしても超えない。**仮の値**（設計書 §12）。 */
export const PUBLIC_WAVE_RANGE_MAX_MS = 15 * 60_000
/**
 * 範囲の終わりから、取り終えたと見なすまでの余裕（ms）。**仮の値**（設計書 §12）。保存庫へ入る遅れの実測（8〜19 秒）に
 * 余裕を持たせた値。
 */
export const PUBLIC_WAVE_SETTLE_MARGIN_MS = 120_000

export interface PublicWaveRange {
  readonly fromMs: number
  readonly toMs: number
}

/**
 * 取る範囲。`cutoffMs` は 1 つ新しい地震の発生（無ければ `null`）。`sArrivalMs` はその観測点への S 波の到達
 * （解けなければ `null`。範囲は通常の幅のまま）。範囲が空になるなら `null`。
 */
export function publicWaveRange(params: {
  readonly originMs: number
  readonly cutoffMs: number | null
  readonly sArrivalMs: number | null
}): PublicWaveRange | null {
  const { originMs, cutoffMs, sArrivalMs } = params
  if (!Number.isFinite(originMs)) return null
  const fromMs = originMs - WAVE_HISTORY_LEAD_MS
  let toMs = originMs + WAVE_HISTORY_TAIL_MS
  if (sArrivalMs !== null && Number.isFinite(sArrivalMs)) toMs = Math.max(toMs, sArrivalMs + PUBLIC_S_ARRIVAL_PAD_MS)
  toMs = Math.min(toMs, fromMs + PUBLIC_WAVE_RANGE_MAX_MS)
  if (cutoffMs !== null && Number.isFinite(cutoffMs)) toMs = Math.min(toMs, cutoffMs)
  return toMs > fromMs ? { fromMs, toMs } : null
}

/**
 * 範囲が保存庫に入りきっているとみてよいか。**`nowMs` は本当のいまの時刻を渡すこと** —— 再生中の時刻を渡すと、
 * 最近の地震を「まだ入っていない」と取り違える。成功した応答に含まれない観測点を確かな不在として扱えるのもこれが真のときだけ。問い合わせ全体の204・404は失敗として取り直す。
 */
export function isPublicWaveRangeSettled(range: PublicWaveRange, nowMs: number): boolean {
  return range.toMs <= nowMs - PUBLIC_WAVE_SETTLE_MARGIN_MS
}
