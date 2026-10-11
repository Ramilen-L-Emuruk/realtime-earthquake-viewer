// 地震 1 件ぶんの区間について、合成波形の控え（`waveArchive.ts`）から震度を 2 つ出す。
//
// - **最大リアルタイム震度** —— 押し出し（`station-reading`）と同じ方式（功刀ほか 2008・2013）を
//   区間の手前から通し直し、区間の中で出た値の最大を取る
// - **計測震度** —— 気象庁の手順（周波数領域のフィルタ）を区間の波形全体へ 1 回当てる
//
// **計算はアプリ側の `src/utils/knet/` を呼ぶ。** 写し取ると、片方だけ直した日から
// 静かに離れていく（`../intensity/intensityStream.ts` と同じ判断）。
//
// **当時の押し出しと同じ値になるとは限らない。** 押し出しの計算器はその区間（`segmentId`）の
// 頭から通し続けたもので、直流の推定（最初の 1 秒の平均）も刻みの位置もそこで決まっている。
// ここでは `QUAKE_INTENSITY_LEAD_MS` の手前から通し直すので、判定の窓（60 秒）は埋まるが、
// 刻みの位置と直流の推定はずれる。合成波形は直流を引いた変動分なので、推定のずれは小さい。
//
// **途切れた波形を繋がない。** 時刻が飛んだところで計算器を作り直す（届いた順に繋ぐと、
// 失われた時間が段差になって強い揺れとして出る。`../timebase/segmenter.ts` と同じ理由）。
// 計測震度は区間全体の波形を要するので、区間の中で 1 か所でも途切れていれば出さない ——
// 欠けた波形から出した値は小さく出るだけで、見た目では気づけない。

import { REALTIME_JUDGE_WINDOW_SEC, RealtimeIntensityCalculator } from '../../../src/utils/knet/realtimeIntensity'
import { calcSeismicIntensity } from '../../../src/utils/knet/seismicIntensity'
import { STEP_SEC_DEFAULT, stepSamplesForSeconds } from '../../../src/utils/knet/intensityCommon'
import type { ArchivedWaveChunk } from './waveArchive'

/**
 * 区間の手前から読む長さ（ms）。**判定の窓（60 秒）と同じ。**
 *
 * リアルタイム震度は直近 60 秒のうち 0.3 秒の判定で決まるので、60 秒前から通せば
 * 区間の頭の値も窓が埋まった状態で出る。
 */
export const QUAKE_INTENSITY_LEAD_MS = REALTIME_JUDGE_WINDOW_SEC * 1000

/**
 * 次のまとまりを「続き」と見なす時刻のずれの上限（サンプル間隔の何倍か）。
 *
 * まとまりの頭の時刻は区間の当てはめから出ているので、続いていれば 1 サンプル以内で揃う。
 * 届かなかったパケットは 1 つでも十数サンプル以上の飛びになるので、1.5 倍で分けられる。
 */
const CONTINUITY_TOLERANCE_SAMPLES = 1.5

/**
 * 区間の両端で、記録が届いていなくても「覆えた」と見なす幅（ms）。
 *
 * 受け手（アプリ）が渡す区間の端は、波形を列に畳んだときの列の境目なので、
 * 最後のサンプルとは列 1 つ分ほどずれる。
 */
const COVER_TOLERANCE_MS = 1000

/** 計測震度を出せなかった理由。 */
export type MeasuredUnavailable =
  /** 区間に記録が 1 つも無い。 */
  | 'no-data'
  /** 区間の中で波形が途切れている。 */
  | 'gap'
  /** 区間の頭か終わりまで記録が届いていない（ホストが止まっていた・まだ書かれていない）。 */
  | 'not-covered'
  /** 波形はあるが値にならなかった（0.3 秒に満たない・振幅が 0）。 */
  | 'no-value'

export interface QuakeIntensityResult {
  /** 区間の中で出た最大のリアルタイム震度。区間に 1 つも値が出なければ null。 */
  readonly maxRealtime: number | null
  /** その値を出したときの最後のサンプルの時刻。 */
  readonly maxRealtimeAtMs: number | null
  /**
   * 区間の中の刻み（1 秒ごと）ごとのリアルタイム震度。**最大もここから取っている。**
   *
   * 途切れた所は刻みが無い（時刻が飛ぶ）。計算器が値を出せなかった刻みは `value: null`。
   * 描く側（詳細ポップアップの震度の推移）が途切れを線の切れ目として描けるよう、補わない。
   */
  readonly realtimeSeries: readonly RealtimePoint[]
  readonly measured: number | null
  /** `measured` が null のときの理由。出せたときは null。 */
  readonly measuredUnavailable: MeasuredUnavailable | null
  /** 区間の中にある途切れの数。 */
  readonly gapCount: number
  /**
   * **有限でない値を含んでいたので捨てたまとまりの数**（読み込んだ範囲全体）。
   *
   * 捨てた所は途切れ（`gap`）として扱うので、数を別に持たないと「届かなかった」と
   * 「届いたが壊れていた」の見分けが付かない。
   */
  readonly invalidChunkCount: number
  /**
   * **観測点の合成が解けなかった成分（`NaN`）を含んでいたので捨てたまとまりの数**（読み込んだ範囲全体）。
   *
   * 有効なセンサーの測る向きが 3 方向へ散っていない間、合成は解けない成分だけを `NaN` にして出す
   * （`sensorFusion.ts` の `solveNormal`）。震度は 3 成分が要るのでここでも捨てて区切るが、壊れた値では
   * ないので {@link invalidChunkCount} と分けて数える —— 混ぜると、上が解けないだけの観測点で
   * 「値の壊れたまとまり」が記録に出続ける。
   */
  readonly unsolvedChunkCount: number
}

/** リアルタイム震度の 1 刻み。 */
export interface RealtimePoint {
  /** その刻みの最後のサンプルの時刻。 */
  readonly atMs: number
  readonly value: number | null
}

/** 途切れずに続いている波形 1 本。 */
export interface Run {
  readonly msPerSample: number
  readonly t: number[]
  readonly v: [number[], number[], number[]]
}

/**
 * まとまりの値を見分ける。`'unsolved'` は解けなかった成分の `NaN` だけを含むもの、`'invalid'` は
 * それ以外の有限でない値（±Infinity）や読めない時刻を持つもの。
 *
 * **`NaN` と ±Infinity で分けられるのは、控えが Float32 の 2 進で両者をそのまま残すから**
 * （`waveArchive.ts` の `encodeWaveChunk`）。合成が `NaN` を出すのは解けない成分だけで、
 * 桁あふれのような壊れ方は ±Infinity になる。
 */
function classifyChunk(c: ArchivedWaveChunk): 'ok' | 'unsolved' | 'invalid' {
  if (!(Number.isFinite(c.firstSampleMs) && c.msPerSample > 0)) return 'invalid'
  let unsolved = false
  for (const axis of c.gal) {
    for (let i = 0; i < axis.length; i++) {
      const v = axis[i]
      if (Number.isFinite(v)) continue
      if (!Number.isNaN(v)) return 'invalid'
      unsolved = true
    }
  }
  return unsolved ? 'unsolved' : 'ok'
}

/**
 * まとまりを、途切れずに続いている波形ごとに分ける。
 *
 * **有限でない値を含むまとまりは捨て、そこで区切る。** 近似フィルタは 1 度 NaN を通すと
 * 以後ずっと NaN を出す（`RealtimeIntensityCalculator.push` は投げて止める）。捨てた数は
 * 壊れた値（`invalid`）と解けなかった成分（`unsolved`）で分けて返す（{@link classifyChunk}）。
 */
export function splitRuns(chunks: readonly ArchivedWaveChunk[]): { runs: Run[]; invalid: number; unsolved: number } {
  const runs: Run[] = []
  let invalid = 0
  let unsolved = 0
  let cur: Run | null = null
  let expectedMs = Number.NaN
  for (const c of [...chunks].sort((a, b) => a.firstSampleMs - b.firstSampleMs)) {
    const kind = classifyChunk(c)
    if (kind !== 'ok') {
      if (kind === 'invalid') invalid += 1
      else unsolved += 1
      cur = null
      continue
    }
    const continues =
      cur !== null && Math.abs(c.firstSampleMs - expectedMs) <= c.msPerSample * CONTINUITY_TOLERANCE_SAMPLES
    if (!continues) {
      cur = { msPerSample: c.msPerSample, t: [], v: [[], [], []] }
      runs.push(cur)
    }
    const run = cur as Run
    const n = c.gal[0].length
    for (let i = 0; i < n; i++) {
      run.t.push(c.firstSampleMs + i * c.msPerSample)
      run.v[0].push(c.gal[0][i])
      run.v[1].push(c.gal[1][i])
      run.v[2].push(c.gal[2][i])
    }
    expectedMs = c.firstSampleMs + n * c.msPerSample
  }
  return { runs: runs.filter((r) => r.t.length > 0), invalid, unsolved }
}

/**
 * 途切れずに続いた波形ごとに計算器を作り直して通し、刻み（1 秒）ごとのリアルタイム震度を返す。
 * **返すのは刻みの最後のサンプルの時刻が `[fromMs, toMs]` に入るものだけ**（手前は窓を埋めるための助走）。
 *
 * 要約（`waveSummaryDerived.ts`）も同じ関数で作る —— 画面の 10 分以内（この口）と広い幅（要約）で
 * 計算の作りを分けると、同じ揺れの推移が幅によって違って見える。
 */
export function realtimeSeriesOfRuns(runs: readonly Run[], fromMs: number, toMs: number): RealtimePoint[] {
  const out: RealtimePoint[] = []
  for (const run of runs) {
    const rateHz = 1000 / run.msPerSample
    const calc = new RealtimeIntensityCalculator(rateHz)
    const step = stepSamplesForSeconds(STEP_SEC_DEFAULT, rateHz)
    for (let i = 0; i < run.t.length; i++) {
      calc.push(run.v[0][i], run.v[1][i], run.v[2][i])
      if ((i + 1) % step !== 0) continue
      const at = run.t[i]
      if (at < fromMs || at > toMs) continue
      out.push({ atMs: at, value: calc.intensity() })
    }
  }
  return out
}

/** 区間 `[fromMs, toMs]` の震度を出す。`chunks` は `fromMs - QUAKE_INTENSITY_LEAD_MS` から読んだもの。 */
export function computeQuakeIntensity(params: {
  readonly chunks: readonly ArchivedWaveChunk[]
  readonly fromMs: number
  readonly toMs: number
}): QuakeIntensityResult {
  const { fromMs, toMs } = params
  const { runs, invalid: invalidChunkCount, unsolved: unsolvedChunkCount } = splitRuns(params.chunks)

  // 最大リアルタイム震度: 途切れごとに計算器を作り直し、区間の中の刻みだけを見る。
  const realtimeSeries = realtimeSeriesOfRuns(runs, fromMs, toMs)
  let maxRealtime: number | null = null
  let maxRealtimeAtMs: number | null = null
  for (const p of realtimeSeries) {
    if (p.value !== null && (maxRealtime === null || p.value > maxRealtime)) {
      maxRealtime = p.value
      maxRealtimeAtMs = p.atMs
    }
  }

  // 区間に重なる波形
  const inside = runs.filter((r) => r.t[r.t.length - 1] >= fromMs && r.t[0] <= toMs)
  const gapCount = Math.max(0, inside.length - 1)
  const base = { maxRealtime, maxRealtimeAtMs, realtimeSeries, gapCount, invalidChunkCount, unsolvedChunkCount }
  return { ...base, ...measuredForRange(runs, fromMs, toMs) }
}

/** 区間 `[fromMs, toMs]` の計測震度。**区間の中で途切れていれば出さない**（{@link computeQuakeIntensity} の説明）。 */
function measuredForRange(
  runs: readonly Run[],
  fromMs: number,
  toMs: number,
): { readonly measured: number | null; readonly measuredUnavailable: MeasuredUnavailable | null } {
  const inside = runs.filter((r) => r.t[r.t.length - 1] >= fromMs && r.t[0] <= toMs)
  if (inside.length === 0) return { measured: null, measuredUnavailable: 'no-data' }
  if (inside.length > 1) return { measured: null, measuredUnavailable: 'gap' }

  const run = inside[0]
  if (run.t[0] > fromMs + COVER_TOLERANCE_MS || run.t[run.t.length - 1] < toMs - COVER_TOLERANCE_MS) {
    return { measured: null, measuredUnavailable: 'not-covered' }
  }
  const cut: [number[], number[], number[]] = [[], [], []]
  for (let i = 0; i < run.t.length; i++) {
    if (run.t[i] < fromMs || run.t[i] > toMs) continue
    cut[0].push(run.v[0][i])
    cut[1].push(run.v[1][i])
    cut[2].push(run.v[2][i])
  }
  const measured = calcSeismicIntensity(cut[0], cut[1], cut[2], 1000 / run.msPerSample)
  return measured === null ? { measured: null, measuredUnavailable: 'no-value' } : { measured, measuredUnavailable: null }
}

/**
 * 「普段」を測る範囲（ms）。**地震の区間の手前 1 時間。**
 *
 * 地震カードの「計測」だけを見ても、その値がいつもより上がっているのかが分からない
 * （静かなときでも計測震度は 0 にならず、観測点ごとに決まった値に落ち着く）。比べる相手として、
 * 直前 1 時間の同じ長さの区間の計測震度を出す（2026-10-11 ユーザー承認）。
 */
export const USUAL_SPAN_MS = 60 * 60_000

/**
 * 「普段」を測る区間の数。**6 つ。**
 *
 * 計測震度は区間の長さで値が変わる（長いほど強い一瞬を拾いやすい）ので、地震の区間と**同じ長さ**の
 * 区間で測る。1 つだけだと、そこに別の揺れや人の作業（6 面法で基板を動かす等）が入ったとき
 * 外れるので、手前 1 時間へ散らして測り、**中央値**を取る。区間が 10 分（上限）ならちょうど
 * 1 時間を敷き詰める。
 */
export const USUAL_WINDOW_COUNT = 6

/**
 * 中央値を出すのに要る区間の数。**半分（3 つ）。** 測れた区間がそれより少なければ「普段」は出さない
 * —— 1〜2 区間の値を「普段」と名乗ると、たまたま静かだった・揺れていた区間がそのまま出る。
 */
export const USUAL_MIN_WINDOWS = 3

/**
 * 「普段」を待つ上限（ms）。**5 秒。** 計算は 10 分の区間で 1 秒ほど（{@link computeUsualMeasured}）なので
 * ふだんは間に合う。アプリは 15 秒で問い合わせを諦めるので、そこへ「最大」「計測」を道連れにしない余白を取る。
 */
export const USUAL_WAIT_MS = 5_000

/**
 * 「普段」を測る区間の並び（古い順）。**最後の区間は地震の区間の頭で終わる。**
 *
 * 区間の長さは地震の区間と同じ。手前 1 時間（{@link USUAL_SPAN_MS}）の中へ等間隔に置く。
 */
export function usualWindows(fromMs: number, toMs: number): readonly { readonly fromMs: number; readonly toMs: number }[] {
  const lengthMs = toMs - fromMs
  if (!(lengthMs > 0) || !Number.isFinite(fromMs)) return []
  const firstFrom = fromMs - USUAL_SPAN_MS
  const step = Math.max(0, (USUAL_SPAN_MS - lengthMs) / (USUAL_WINDOW_COUNT - 1))
  const out: { fromMs: number; toMs: number }[] = []
  for (let k = 0; k < USUAL_WINDOW_COUNT; k += 1) {
    const start = Math.round(firstFrom + k * step)
    out.push({ fromMs: start, toMs: start + lengthMs })
  }
  return out
}

/** 「普段」の計測震度。 */
export interface UsualMeasuredResult {
  /** 測れた区間の計測震度の中央値。**測れた区間が {@link USUAL_MIN_WINDOWS} に満たなければ `null`。** */
  readonly usualMeasured: number | null
  /** 測ろうとした区間の数。 */
  readonly usualWindowCount: number
  /** そのうち計測震度を出せた区間の数（途切れた・記録の無い区間は数えない）。 */
  readonly usualUsedCount: number
}

/**
 * 「普段」の計測震度を出す。`chunks` は {@link usualWindows} の最初の区間の頭から地震の区間の頭までを読んだもの。
 *
 * **1 区間ずつ `onWindow` で順番を譲る**（呼び出し側が受信のイベントループを止めないため）。区間 1 つの
 * 計算は地震の区間の「計測」1 本と同じ重さ（作業 PC の実測で 3 分ぶん 0.07 秒・10 分ぶん 0.19 秒）なので、
 * 1 回に止める長さは「計測」を出すときより延びない。6 区間を続けて回すと 10 分ぶんで 1 秒ほど止まる。
 *
 * **値が有限でない区間は数えない。** 中央値に `NaN` が混ざると結果も `NaN` になり、JSON では `null` に
 * 化けるのに控えには「測れた値」として残る。
 */
export async function computeUsualMeasured(params: {
  readonly chunks: readonly ArchivedWaveChunk[]
  readonly fromMs: number
  readonly toMs: number
  readonly onWindow: () => Promise<void>
}): Promise<UsualMeasuredResult> {
  const windows = usualWindows(params.fromMs, params.toMs)
  const { runs } = splitRuns(params.chunks)
  const values: number[] = []
  for (const w of windows) {
    await params.onWindow()
    const r = measuredForRange(runs, w.fromMs, w.toMs)
    if (r.measured !== null && Number.isFinite(r.measured)) values.push(r.measured)
  }
  return {
    usualMeasured: values.length >= USUAL_MIN_WINDOWS ? median(values) : null,
    usualWindowCount: windows.length,
    usualUsedCount: values.length,
  }
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
