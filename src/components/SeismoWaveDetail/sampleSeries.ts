// 詳細の窓で描くサンプルの並び。**描画を持たない純関数だけを置く。**
//
// - 取ったまとまりを時刻順に 1 本へ繋ぐ（重なりは捨て、途切れには欠測を挟んで線を切る）
// - 見えている範囲のサンプルを二分探索で切り出す
// - 寄せ具合に応じて「1 ピクセルごとの上下の端（包絡）」か「点そのもの」を返す
// - 強調（平常時のノイズの内側を潰す）を値へ当てる

import type { WaveSampleChunk } from '../../services/seismoWaveSamples'
import { NOISE_FLOOR_GAL, NOISE_MIN_SECONDS, NOISE_SPAN_MS, NOISE_WIDTH_RATIO, type NoiseBand } from '../../utils/seismoQuakeWindow'
import type { ViewRange } from './detailView'

/** 時刻順に繋いだサンプル。**欠測と途切れは `NaN`**（そこで線を切る）。 */
export interface SampleSeries {
  readonly t: Float64Array
  readonly v: readonly [Float32Array, Float32Array, Float32Array]
  readonly length: number
}

/**
 * 次のまとまりを「続き」と見なす時刻のずれの上限（サンプル間隔の何倍か）。**ホストの
 * `quakeIntensity.ts` と同じ 1.5 倍** —— 届かなかったパケットは 1 つでも十数サンプル以上の飛びになる。
 */
const CONTINUITY_TOLERANCE_SAMPLES = 1.5

/**
 * まとまりを時刻順に 1 本へ繋ぐ。
 *
 * - **重なりは後から来た側を捨てる**（2 分ずつ取った境目で同じまとまりが 2 度返ることがある）
 * - **途切れた所には欠測を 1 つ挟む** —— 前後の点を線で結ぶと、届かなかった時間が一直線に描かれる
 */
export function buildSampleSeries(chunks: readonly WaveSampleChunk[]): SampleSeries {
  const sorted = [...chunks].filter((c) => c.gal[0].length > 0).sort((a, b) => a.firstSampleMs - b.firstSampleMs)
  let capacity = 0
  for (const c of sorted) capacity += c.gal[0].length + 1
  const t = new Float64Array(capacity)
  const v: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(capacity),
    new Float32Array(capacity),
    new Float32Array(capacity),
  ]
  let n = 0
  let lastMs = Number.NEGATIVE_INFINITY
  let expectedMs = Number.NaN
  for (const c of sorted) {
    const step = c.msPerSample
    const continues = Number.isFinite(expectedMs) && Math.abs(c.firstSampleMs - expectedMs) <= step * CONTINUITY_TOLERANCE_SAMPLES
    let gapPending = n > 0 && !continues
    for (let i = 0; i < c.gal[0].length; i += 1) {
      const at = c.firstSampleMs + i * step
      // 重なり（既に持っている時刻以前）は捨てる
      if (at <= lastMs + step / 2) continue
      if (gapPending) {
        t[n] = (lastMs + at) / 2
        v[0][n] = Number.NaN
        v[1][n] = Number.NaN
        v[2][n] = Number.NaN
        n += 1
        gapPending = false
      }
      t[n] = at
      v[0][n] = c.gal[0][i]
      v[1][n] = c.gal[1][i]
      v[2][n] = c.gal[2][i]
      n += 1
      lastMs = at
    }
    expectedMs = c.firstSampleMs + c.gal[0].length * step
  }
  return { t: t.subarray(0, n), v: [v[0].subarray(0, n), v[1].subarray(0, n), v[2].subarray(0, n)], length: n }
}

/** 並びが覆う範囲（最初の点〜最後の点）。**点が無ければ `null`。** */
export function seriesRange(series: SampleSeries): ViewRange | null {
  if (series.length === 0) return null
  return { fromMs: series.t[0], toMs: series.t[series.length - 1] }
}

/** `t[i] >= x` となる最小の `i`（無ければ `length`）。 */
export function lowerBound(t: Float64Array, length: number, x: number): number {
  let lo = 0
  let hi = length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (t[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 見えている範囲に掛かる点の添字の範囲 `[start, end)`。**両端の外側の 1 点ずつも含める**
 * （線を範囲の端まで引くため）。
 */
export function visibleIndexRange(series: SampleSeries, range: ViewRange): { start: number; end: number } {
  const start = Math.max(0, lowerBound(series.t, series.length, range.fromMs) - 1)
  const end = Math.min(series.length, lowerBound(series.t, series.length, range.toMs) + 1)
  return { start, end }
}

/**
 * 値の変換（強調）。**平常時のノイズの内側を 0 にし、外側は幅だけ寄せる**（符号は保つ。
 * `emphasizeColumns.ts` の `shrink` と同じ）。非有限は非有限のまま返す。
 */
export function emphasizeValue(value: number, center: number, width: number): number {
  const d = value - center
  if (!Number.isFinite(d)) return d
  if (d > width) return d - width
  if (d < -width) return d + width
  return 0
}

/** 成分ごとの値の変換。強調しないなら素通し。 */
export function valueTransform(noise: NoiseBand | null): (axis: number, value: number) => number {
  if (noise === null) return (_axis, value) => value
  return (axis, value) => emphasizeValue(value, noise.center[axis], noise.width[axis])
}

/**
 * 範囲の中の、成分ごとの振れの最大（変換後の絶対値）。**値の無い成分は `-Infinity`。**
 * 縦の物差しを決めるのに使う。
 */
export function maxAbsInRange(
  series: SampleSeries,
  range: ViewRange,
  transform: (axis: number, value: number) => number,
): [number, number, number] {
  const out: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  const lo = lowerBound(series.t, series.length, range.fromMs)
  const hi = lowerBound(series.t, series.length, range.toMs + 1e-9)
  for (let i = lo; i < hi; i += 1) {
    for (let a = 0; a < 3; a += 1) {
      const x = Math.abs(transform(a, series.v[a][i]))
      if (Number.isFinite(x) && x > out[a]) out[a] = x
    }
  }
  return out
}

/** 1 ピクセルに入る点がこれを超えたら、点を結ばず上下の端（包絡）で描く。 */
export const ENVELOPE_POINTS_PER_PX = 2

/** 描き方。**点が多ければ包絡、少なければ点そのもの。** */
export type LaneGeometry =
  /** 1 列（1 デバイスピクセル）ごとの上下の端。値の無い列は `NaN`。 */
  | { readonly kind: 'envelope'; readonly min: Float32Array; readonly max: Float32Array }
  /** 点の横位置（0〜幅）と値。欠測は `NaN`（そこで線を切る）。 */
  | { readonly kind: 'points'; readonly x: Float32Array; readonly y: Float32Array }

/**
 * 1 本の値の並びの描き方を作る（成分 1 つ、または 合成）。
 *
 * @param values `series.t` と同じ添字で並んだ値（成分なら `series.v[a]`）
 * @param map 描く前に値へ当てる変換（強調など）。素のままなら恒等
 */
export function laneGeometry(params: {
  readonly series: SampleSeries
  readonly values: Float32Array
  readonly range: ViewRange
  readonly widthPx: number
  readonly map: (value: number) => number
}): LaneGeometry {
  const { series, values, range, widthPx, map } = params
  const span = range.toMs - range.fromMs
  const w = Math.max(1, Math.floor(widthPx))
  const { start, end } = visibleIndexRange(series, range)
  const count = end - start
  if (count > w * ENVELOPE_POINTS_PER_PX && span > 0) {
    const min = new Float32Array(w).fill(Number.NaN)
    const max = new Float32Array(w).fill(Number.NaN)
    for (let i = start; i < end; i += 1) {
      const c = Math.floor(((series.t[i] - range.fromMs) / span) * w)
      if (c < 0 || c >= w) continue
      const y = map(values[i])
      if (!Number.isFinite(y)) continue
      if (Number.isNaN(min[c]) || y < min[c]) min[c] = y
      if (Number.isNaN(max[c]) || y > max[c]) max[c] = y
    }
    return { kind: 'envelope', min, max }
  }
  const x = new Float32Array(Math.max(0, count))
  const y = new Float32Array(Math.max(0, count))
  for (let k = 0; k < count; k += 1) {
    const i = start + k
    x[k] = span > 0 ? ((series.t[i] - range.fromMs) / span) * w : 0
    y[k] = map(values[i])
  }
  return { kind: 'points', x, y }
}

/**
 * 合成の大きさ（各時刻の、選んだ成分の二乗和の平方根）。**選んだ成分のどれか 1 つでも欠けていれば `NaN`**
 * —— 欠けた成分を 0 と見なすと、その時刻だけ小さく描かれる。
 *
 * **向きの切り替えで消した成分は含めない**（2026-10-05 のユーザー判断。1 つだけ選べばその成分の振れの絶対値）。
 * ホストが返すサンプルは直流を引いた変動分なので、そのまま足せる。
 *
 * @param axes 成分ごとに含めるか（南北・東西・上下）
 */
export function vectorMagnitude(series: SampleSeries, axes: readonly boolean[]): Float32Array {
  const out = new Float32Array(series.length)
  const use = [0, 1, 2].filter((a) => axes[a] !== false)
  for (let i = 0; i < series.length; i += 1) {
    let sum = 0
    for (const a of use) {
      const v = series.v[a][i]
      sum += v * v
    }
    out[i] = use.length === 0 ? Number.NaN : Math.sqrt(sum)
  }
  return out
}

/**
 * 前後 `windowMs` の幅（各時刻を中心に）で値を平均した並び。**揺れの強さの輪郭**を見せるために使う。
 *
 * - 窓の中の値の無い点は数えない（平均は値のある点だけで取る）
 * - **元が `NaN` の点は `NaN` のまま** —— 途切れで線を切る扱いを均した線でも保つ
 *
 * 和と個数の累積から引くので、点の数に比例する手間で済む。
 */
export function movingAverage(series: SampleSeries, values: Float32Array, windowMs: number): Float32Array {
  const n = series.length
  const sum = new Float64Array(n + 1)
  const cnt = new Uint32Array(n + 1)
  for (let i = 0; i < n; i += 1) {
    const v = values[i]
    const ok = Number.isFinite(v)
    sum[i + 1] = sum[i] + (ok ? v : 0)
    cnt[i + 1] = cnt[i] + (ok ? 1 : 0)
  }
  const half = windowMs / 2
  const out = new Float32Array(n)
  let lo = 0
  let hi = 0
  for (let i = 0; i < n; i += 1) {
    const t = series.t[i]
    while (lo < n && series.t[lo] < t - half) lo += 1
    while (hi < n && series.t[hi] <= t + half) hi += 1
    const c = cnt[hi] - cnt[lo]
    out[i] = !Number.isFinite(values[i]) || c === 0 ? Number.NaN : (sum[hi] - sum[lo]) / c
  }
  return out
}

/**
 * 前後 `windowMs` の幅で、**正側に振れた値の平均と負側に振れた値の平均を別々に**出す（2026-10-05 のユーザー判断）。
 *
 * 成分は ＋ と − に行き来するので、値をそのまま平均すると 0 付近に潰れて揺れの大きさが消える。正側・負側に
 * 分けて平均すれば、ふつうの揺れでは 2 本がほぼ対称に並び、**片側に偏った動き（一方向のパルスや傾き）だけ
 * 2 本の高さが食い違う**。線は振れの頂点ではなく平均なので、山の頂点よりかなり内側を通る。
 *
 * - 0 ちょうどの値はどちらにも数えない。窓の中にその側の値が 1 つも無ければ 0
 * - **元が `NaN` の点は `NaN` のまま**（途切れで線を切る）
 *
 * @returns `pos` は 0 以上、`neg` は 0 以下
 */
export function signedMovingAverages(
  series: SampleSeries,
  values: Float32Array,
  windowMs: number,
): { readonly pos: Float32Array; readonly neg: Float32Array } {
  const n = series.length
  const posSum = new Float64Array(n + 1)
  const posCnt = new Uint32Array(n + 1)
  const negSum = new Float64Array(n + 1)
  const negCnt = new Uint32Array(n + 1)
  for (let i = 0; i < n; i += 1) {
    const v = values[i]
    const p = Number.isFinite(v) && v > 0
    const q = Number.isFinite(v) && v < 0
    posSum[i + 1] = posSum[i] + (p ? v : 0)
    posCnt[i + 1] = posCnt[i] + (p ? 1 : 0)
    negSum[i + 1] = negSum[i] + (q ? v : 0)
    negCnt[i + 1] = negCnt[i] + (q ? 1 : 0)
  }
  const half = windowMs / 2
  const pos = new Float32Array(n)
  const neg = new Float32Array(n)
  let lo = 0
  let hi = 0
  for (let i = 0; i < n; i += 1) {
    const t = series.t[i]
    while (lo < n && series.t[lo] < t - half) lo += 1
    while (hi < n && series.t[hi] <= t + half) hi += 1
    if (!Number.isFinite(values[i])) {
      pos[i] = Number.NaN
      neg[i] = Number.NaN
      continue
    }
    const pc = posCnt[hi] - posCnt[lo]
    const nc = negCnt[hi] - negCnt[lo]
    pos[i] = pc === 0 ? 0 : (posSum[hi] - posSum[lo]) / pc
    neg[i] = nc === 0 ? 0 : (negSum[hi] - negSum[lo]) / nc
  }
  return { pos, neg }
}

/**
 * 合成の大きさの平常時の底（gal）。**成分の強調と同じ測り方**（`measureNoiseBand`）—— 0 の手前 30 秒で 1 秒ごとの
 * 最大を取り、その中央値の 1.5 倍（下限 0.2 gal）。合成は大きさなので中心は取らず、0 から測る。
 *
 * **値のある 1 秒が 10 に満たなければ `null`**（推測で底を置かない。成分と同じ）。
 */
export function measureMagnitudeFloor(series: SampleSeries, magnitude: Float32Array, zeroMs: number): number | null {
  if (!Number.isFinite(zeroMs)) return null
  const fromMs = zeroMs - NOISE_SPAN_MS
  const peaks = new Map<number, number>()
  const lo = lowerBound(series.t, series.length, fromMs)
  const hi = lowerBound(series.t, series.length, zeroMs)
  for (let i = lo; i < hi; i += 1) {
    const v = magnitude[i]
    if (!Number.isFinite(v)) continue
    const sec = Math.floor((series.t[i] - zeroMs) / 1000)
    peaks.set(sec, Math.max(peaks.get(sec) ?? 0, v))
  }
  if (peaks.size < NOISE_MIN_SECONDS) return null
  const sorted = [...peaks.values()].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return Math.max(median * NOISE_WIDTH_RATIO, NOISE_FLOOR_GAL)
}

/** 範囲の中の値の最大と、その時刻（最初に達した点）。**値が 1 つも無ければ `null`。** */
export function peakInRange(
  series: SampleSeries,
  values: Float32Array,
  range: ViewRange,
): { readonly value: number; readonly atMs: number } | null {
  const lo = lowerBound(series.t, series.length, range.fromMs)
  const hi = lowerBound(series.t, series.length, range.toMs + 1e-9)
  let best: { value: number; atMs: number } | null = null
  for (let i = lo; i < hi; i += 1) {
    const v = values[i]
    if (Number.isFinite(v) && (best === null || v > best.value)) best = { value: v, atMs: series.t[i] }
  }
  return best
}
