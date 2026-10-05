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
}

/** リアルタイム震度の 1 刻み。 */
export interface RealtimePoint {
  /** その刻みの最後のサンプルの時刻。 */
  readonly atMs: number
  readonly value: number | null
}

/** 途切れずに続いている波形 1 本。 */
interface Run {
  readonly msPerSample: number
  readonly t: number[]
  readonly v: [number[], number[], number[]]
}

function allFinite(c: ArchivedWaveChunk): boolean {
  for (const axis of c.gal) {
    for (let i = 0; i < axis.length; i++) if (!Number.isFinite(axis[i])) return false
  }
  return Number.isFinite(c.firstSampleMs) && c.msPerSample > 0
}

/**
 * まとまりを、途切れずに続いている波形ごとに分ける。
 *
 * **有限でない値を含むまとまりは捨て、そこで区切る。** 近似フィルタは 1 度 NaN を通すと
 * 以後ずっと NaN を出す（`RealtimeIntensityCalculator.push` は投げて止める）。
 */
function splitRuns(chunks: readonly ArchivedWaveChunk[]): { runs: Run[]; invalid: number } {
  const runs: Run[] = []
  let invalid = 0
  let cur: Run | null = null
  let expectedMs = Number.NaN
  for (const c of [...chunks].sort((a, b) => a.firstSampleMs - b.firstSampleMs)) {
    if (!allFinite(c)) {
      invalid += 1
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
  return { runs: runs.filter((r) => r.t.length > 0), invalid }
}

/** 区間 `[fromMs, toMs]` の震度を出す。`chunks` は `fromMs - QUAKE_INTENSITY_LEAD_MS` から読んだもの。 */
export function computeQuakeIntensity(params: {
  readonly chunks: readonly ArchivedWaveChunk[]
  readonly fromMs: number
  readonly toMs: number
}): QuakeIntensityResult {
  const { fromMs, toMs } = params
  const { runs, invalid: invalidChunkCount } = splitRuns(params.chunks)

  // 最大リアルタイム震度: 途切れごとに計算器を作り直し、区間の中の刻みだけを見る。
  let maxRealtime: number | null = null
  let maxRealtimeAtMs: number | null = null
  const realtimeSeries: RealtimePoint[] = []
  for (const run of runs) {
    const rateHz = 1000 / run.msPerSample
    const calc = new RealtimeIntensityCalculator(rateHz)
    const step = stepSamplesForSeconds(STEP_SEC_DEFAULT, rateHz)
    for (let i = 0; i < run.t.length; i++) {
      calc.push(run.v[0][i], run.v[1][i], run.v[2][i])
      if ((i + 1) % step !== 0) continue
      const at = run.t[i]
      if (at < fromMs || at > toMs) continue
      const value = calc.intensity()
      realtimeSeries.push({ atMs: at, value })
      if (value !== null && (maxRealtime === null || value > maxRealtime)) {
        maxRealtime = value
        maxRealtimeAtMs = at
      }
    }
  }

  // 区間に重なる波形
  const inside = runs.filter((r) => r.t[r.t.length - 1] >= fromMs && r.t[0] <= toMs)
  const gapCount = Math.max(0, inside.length - 1)
  const base = { maxRealtime, maxRealtimeAtMs, realtimeSeries, gapCount, invalidChunkCount }
  if (inside.length === 0) return { ...base, measured: null, measuredUnavailable: 'no-data' }
  if (inside.length > 1) return { ...base, measured: null, measuredUnavailable: 'gap' }

  const run = inside[0]
  if (run.t[0] > fromMs + COVER_TOLERANCE_MS || run.t[run.t.length - 1] < toMs - COVER_TOLERANCE_MS) {
    return { ...base, measured: null, measuredUnavailable: 'not-covered' }
  }
  const cut: [number[], number[], number[]] = [[], [], []]
  for (let i = 0; i < run.t.length; i++) {
    if (run.t[i] < fromMs || run.t[i] > toMs) continue
    cut[0].push(run.v[0][i])
    cut[1].push(run.v[1][i])
    cut[2].push(run.v[2][i])
  }
  const measured = calcSeismicIntensity(cut[0], cut[1], cut[2], 1000 / run.msPerSample)
  return measured === null
    ? { ...base, measured: null, measuredUnavailable: 'no-value' }
    : { ...base, measured, measuredUnavailable: null }
}
