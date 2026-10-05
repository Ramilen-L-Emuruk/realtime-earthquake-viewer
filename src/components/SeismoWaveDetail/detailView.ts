// 詳細の窓（`SeismoWaveDetail`）の、見えている範囲の扱い。**描画を持たない純関数だけを置く。**
//
// - 範囲の拡大・縮小・送り（持っている記録の外へは出さない）
// - 見えている範囲の列を切り出す（サンプルが届く前の代わりの絵）
// - 成分ごとの最大加速度
// - 震度の推移を、線の切れ目ごとに分ける

import type { RealtimeIntensityPoint } from '../../services/seismoQuakeIntensity'
import type { TimedColumns } from '../../utils/seismoWaveColumns'

/** 見えている範囲（エポックミリ秒）。 */
export interface ViewRange {
  readonly fromMs: number
  readonly toMs: number
}

/**
 * 寄せられる最も狭い範囲（ms）。**2 秒。**
 *
 * 基板は 100 Hz なので 2 秒で 200 サンプル。これより寄せても 1 サンプルが数ピクセルに伸びるだけで、
 * 読み取れることは増えない。
 */
export const MIN_VIEW_MS = 2_000

/**
 * 範囲を、持っている記録（`bounds`）の中へ収める。
 *
 * - 幅は {@link MIN_VIEW_MS} 以上・`bounds` の幅以下
 * - 端がはみ出したら、幅を保ったまま内側へずらす
 *
 * **`bounds` が {@link MIN_VIEW_MS} より狭ければ `bounds` そのもの**（それ以上は寄せられない）。
 */
export function clampView(view: ViewRange, bounds: ViewRange): ViewRange {
  const boundsSpan = bounds.toMs - bounds.fromMs
  if (!(boundsSpan > MIN_VIEW_MS)) return bounds
  let span = view.toMs - view.fromMs
  if (!Number.isFinite(span)) return bounds
  span = Math.min(boundsSpan, Math.max(MIN_VIEW_MS, span))
  // 幅を変えたときは中心を保つ
  const center = (view.fromMs + view.toMs) / 2
  let fromMs = Number.isFinite(center) ? center - span / 2 : bounds.fromMs
  if (fromMs < bounds.fromMs) fromMs = bounds.fromMs
  if (fromMs + span > bounds.toMs) fromMs = bounds.toMs - span
  return { fromMs, toMs: fromMs + span }
}

/**
 * 拡大・縮小する。**押さえた位置（`anchorRatio`。左端 0・右端 1）の時刻を動かさない。**
 *
 * @param factor 新しい幅 ÷ いまの幅。1 より小さければ寄る
 */
export function zoomView(view: ViewRange, bounds: ViewRange, factor: number, anchorRatio: number): ViewRange {
  if (!(factor > 0)) return clampView(view, bounds)
  const ratio = Math.min(1, Math.max(0, Number.isFinite(anchorRatio) ? anchorRatio : 0.5))
  const span = view.toMs - view.fromMs
  const anchorMs = view.fromMs + span * ratio
  const boundsSpan = bounds.toMs - bounds.fromMs
  const nextSpan = Math.min(boundsSpan, Math.max(MIN_VIEW_MS, span * factor))
  const fromMs = anchorMs - nextSpan * ratio
  // **幅が決まってから収める。** clampView に任せると中心を保ってしまい、押さえた位置がずれる。
  let from = fromMs
  if (from < bounds.fromMs) from = bounds.fromMs
  if (from + nextSpan > bounds.toMs) from = bounds.toMs - nextSpan
  return clampView({ fromMs: from, toMs: from + nextSpan }, bounds)
}

/** 送る。`deltaRatio` は見えている幅に対する割合（正で右＝後の時刻へ）。 */
export function panView(view: ViewRange, bounds: ViewRange, deltaRatio: number): ViewRange {
  if (!Number.isFinite(deltaRatio)) return clampView(view, bounds)
  const span = view.toMs - view.fromMs
  const shift = span * deltaRatio
  return clampView({ fromMs: view.fromMs + shift, toMs: view.toMs + shift }, bounds)
}

/** 列の束が覆う範囲（先頭の列の始まり〜最後の列の終わり）。 */
export function columnsRange(src: TimedColumns): ViewRange {
  return { fromMs: src.fromMs, toMs: src.fromMs + src.columns.length * src.columnSpanMs }
}

/**
 * 見えている範囲に掛かる列を切り出す。**端の列は一部しか掛からなくても入れる**
 * （落とすと端のピークが消える）。
 *
 * **返した束の範囲（{@link columnsRange}）を、絵の横位置の物差しにすること。** 描画は列を
 * 幅いっぱいに並べるので、要求した `view` ではなく実際に切り出した範囲で比を取らないと、
 * 到達の線や震度の推移が列 1 つ分ずれる。
 */
export function sliceColumns(src: TimedColumns, view: ViewRange): TimedColumns {
  const span = src.columnSpanMs
  if (!(span > 0) || src.columns.length === 0) return { ...src, columns: [] }
  const first = Math.max(0, Math.floor((view.fromMs - src.fromMs) / span))
  const last = Math.min(src.columns.length, Math.ceil((view.toMs - src.fromMs) / span))
  if (last <= first) return { fromMs: src.fromMs + first * span, columnSpanMs: span, columns: [] }
  return { fromMs: src.fromMs + first * span, columnSpanMs: span, columns: src.columns.slice(first, last) }
}

/** 成分 1 つぶんの最大加速度。 */
export interface AxisPeak {
  /** 絶対値（gal）。 */
  readonly gal: number
  /** 記録した時刻。**その列の中ほど**（列の長さぶんの幅を持つ）。 */
  readonly atMs: number
}

/**
 * 範囲の中の、成分ごとの最大加速度とその時刻。**値の無い成分は `null`。**
 *
 * 列は上下の端を持つので、端の絶対値の大きいほうを取れば間引く前の最大と一致する。
 *
 * **時刻は「いちばん強く振れた瞬間」。** 波形の上の「最大」の線はこれを指す —— リアルタイム震度が
 * 最大に達した時刻は、0.3 秒ぶん積み上がってから値が出る量なので揺れの山より 2〜3 秒後ろに付き
 * （有感地震の 1 件の実測）、波形に重ねると山を指しているように読めてしまう（2026-10-05 のユーザー判断）。
 */
export function peakPerAxis(src: TimedColumns, range: ViewRange): [AxisPeak | null, AxisPeak | null, AxisPeak | null] {
  const out: [AxisPeak | null, AxisPeak | null, AxisPeak | null] = [null, null, null]
  const span = src.columnSpanMs
  for (let i = 0; i < src.columns.length; i += 1) {
    const col = src.columns[i]
    if (col === null) continue
    const start = src.fromMs + i * span
    if (start + span <= range.fromMs || start >= range.toMs) continue
    for (let a = 0; a < 3; a += 1) {
      const v = Math.max(Math.abs(col.min[a]), Math.abs(col.max[a]))
      if (!Number.isFinite(v)) continue
      const prev = out[a]
      if (prev === null || v > prev.gal) out[a] = { gal: v, atMs: start + span / 2 }
    }
  }
  return out
}

/**
 * 震度の推移を、線を切るところで分ける。**途切れ（刻みの時刻が `maxGapMs` を超えて飛ぶ）と、
 * 値の出なかった刻み（`null`）で切る。** 範囲の外の点は落とす（範囲の端をまたぐ線のために、
 * 外側の隣の 1 点ずつは残す）。
 */
export function seriesSegments(
  series: readonly RealtimeIntensityPoint[],
  range: ViewRange,
  maxGapMs: number,
): { atMs: number; value: number }[][] {
  const out: { atMs: number; value: number }[][] = []
  let cur: { atMs: number; value: number }[] = []
  let prevMs = Number.NaN
  for (let i = 0; i < series.length; i += 1) {
    const p = series[i]
    const nextMs = series[i + 1]?.atMs ?? Infinity
    const prevAt = series[i - 1]?.atMs ?? -Infinity
    // 範囲の外。ただし範囲の端をまたぐ隣の点は残す
    if (p.atMs < range.fromMs && nextMs < range.fromMs) continue
    if (p.atMs > range.toMs && prevAt > range.toMs) continue
    const broken = p.value === null || (Number.isFinite(prevMs) && p.atMs - prevMs > maxGapMs)
    if (broken && cur.length > 0) {
      out.push(cur)
      cur = []
    }
    if (p.value !== null) cur.push({ atMs: p.atMs, value: p.value })
    prevMs = p.atMs
  }
  if (cur.length > 0) out.push(cur)
  return out
}
