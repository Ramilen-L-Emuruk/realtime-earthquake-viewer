// 詳細の窓で描くサンプルの並び。**描画を持たない純関数だけを置く。**
//
// - 取ったまとまりを時刻順に 1 本へ繋ぐ（重なりは捨て、途切れには欠測を挟んで線を切る）
// - 見えている範囲のサンプルを二分探索で切り出す
// - 寄せ具合に応じて「1 ピクセルごとの上下の端（包絡）」か「点そのもの」を返す

import type { WaveSampleChunk } from '../../services/seismoWaveSamples'
import type { ViewRange } from './detailView'

/** 時刻順に繋いだサンプル。**欠測と途切れは `NaN`**（そこで線を切る）。 */
export interface SampleSeries {
  readonly t: Float64Array
  readonly v: readonly [Float32Array, Float32Array, Float32Array]
  /**
   * そのサンプルへ効いたセンサーの本数（ホストの `memberCount`）。**途切れに挟んだ欠測は `NaN`。**
   * 裏付けが 1 本しか無い区間を薄く敷くのに使う（{@link singleMemberColumns}）。
   */
  readonly members: Float32Array
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
  const members = new Float32Array(capacity)
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
        members[n] = Number.NaN
        n += 1
        gapPending = false
      }
      t[n] = at
      v[0][n] = c.gal[0][i]
      v[1][n] = c.gal[1][i]
      v[2][n] = c.gal[2][i]
      members[n] = c.memberCount[i]
      n += 1
      lastMs = at
    }
    expectedMs = c.firstSampleMs + c.gal[0].length * step
  }
  return {
    t: t.subarray(0, n),
    v: [v[0].subarray(0, n), v[1].subarray(0, n), v[2].subarray(0, n)],
    members: members.subarray(0, n),
    length: n,
  }
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

/**
 * 裏付けが 1 本しか無いサンプルに掛かるピクセル（1 なら掛かる）。**カードの列の「その列でいちばん少ない
 * 本数が 1 以下」と同じ意味**（`SeismoWaveChart/waveColumns.ts`）—— 値のあるサンプルのうち 1 つでも
 * 1 本以下なら、そのピクセルは敷く。
 *
 * **点ごとに「前の点との中点〜次の点との中点」を覆う。** 点の位置の 1 ピクセルだけを塗ると、寄せて
 * 点がまばらになったとき帯が櫛の歯になる。途切れに挟んだ欠測（本数 `NaN`）は値が無いので敷かず、
 * その隣の点も欠測の側へは張り出さない。
 */
export function singleMemberColumns(series: SampleSeries, range: ViewRange, widthPx: number): Uint8Array {
  const w = Math.max(1, Math.floor(widthPx))
  const out = new Uint8Array(w)
  const span = range.toMs - range.fromMs
  if (!(span > 0)) return out
  const { start, end } = visibleIndexRange(series, range)
  const xOf = (ms: number): number => ((ms - range.fromMs) / span) * w
  for (let i = start; i < end; i += 1) {
    if (!(series.members[i] <= 1)) continue
    if (!Number.isFinite(series.v[0][i]) && !Number.isFinite(series.v[1][i]) && !Number.isFinite(series.v[2][i])) continue
    const t = series.t[i]
    // 隣が無い（端）・隣が途切れに挟んだ欠測なら、その側は反対側と同じ幅だけ取る（点が 1 つなら
    // 1 ピクセル）。**欠測までの半分を取ると、値の無い時間へ帯が張り出す。**
    const prevOk = i > 0 && !Number.isNaN(series.members[i - 1])
    const nextOk = i + 1 < series.length && !Number.isNaN(series.members[i + 1])
    const rawPrev = prevOk ? (t - series.t[i - 1]) / 2 : null
    const rawNext = nextOk ? (series.t[i + 1] - t) / 2 : null
    const prevHalf = rawPrev ?? rawNext ?? 0
    const nextHalf = rawNext ?? rawPrev ?? 0
    // **端は四捨五入する。** 切り捨て・切り上げにすると、隣の点との境目が数ミリ秒はみ出しただけで
    // 隣のピクセルまで丸ごと敷く（引いた絵で帯が 1 ピクセル太る）。点の入るピクセルだけは必ず敷く。
    const own = Math.floor(xOf(t))
    const from = Math.max(0, Math.min(own, Math.round(xOf(t - prevHalf))))
    const to = Math.min(w, Math.max(own + 1, Math.round(xOf(t + nextHalf))))
    for (let c = from; c < to; c += 1) out[c] = 1
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
 * @param map 描く前に値へ当てる変換。素のままなら恒等
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
 * **並び全体で 1 点も値の無い成分も含めない**（2026-10-13 ユーザー承認）。上下が解けない観測点ではホストが上下だけ
 * `null` を送るので、含めると上下を選んでいる限り全点が `NaN` になり段が空になる。**外すかは並び全体で 1 度だけ
 * 決める** —— 点ごとに決めると、上下が途中で解けた・欠けた境目で何成分の合成かが変わり、振れが急に小さく
 * 見える。一部でも値のある成分は含めたまま、欠けた点を `NaN` にする。
 *
 * @param axes 成分ごとに含めるか（東西・南北・上下）
 */
export function vectorMagnitude(series: SampleSeries, axes: readonly boolean[]): Float32Array {
  const out = new Float32Array(series.length)
  const use = [0, 1, 2].filter((a) => axes[a] !== false && hasAnyValue(series.v[a], series.length))
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

function hasAnyValue(values: Float32Array, length: number): boolean {
  for (let i = 0; i < length; i += 1) if (Number.isFinite(values[i])) return true
  return false
}

/**
 * 平均の線（合成の均した線・成分の正側／負側の平均の線）。**計算はホストの管理コンソールと共有する**
 * （`utils/waveMeanLines.ts`）。`SampleSeries` はそのまま渡せる。
 */
export { movingAverage, signedMovingAverages } from '../../utils/waveMeanLines'

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
