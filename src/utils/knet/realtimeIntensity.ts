// リアルタイム震度（強震モニタと同じ方式）の実装。
//
// 出典は 2 本ある。
//   - フィルタ: 功刀ほか（2013）「震度のリアルタイム演算に用いられる近似フィルタの改良」
//     地震 2, 65, 223-230. doi:10.4294/zisin.65.223 —— Appendix A の 2 次 6 段＋ゲイン
//   - 震度への直し方: 功刀ほか（2008）「震度のリアルタイム演算法」地震 2, 60, 243-252.
//     doi:10.4294/zisin.60.243 —— サンプルが届くたびに直近 60 秒で 0.3 秒の判定を行う
//
// **気象庁の計測震度とは別の量。** あちらは周波数領域のフィルタ（非因果・零位相）を記録全体へ
// 当てる。こちらは時間領域で近似したフィルタを届いた順に当てるので、位相がずれる分だけ値が
// 違う（2013 年版の実測で、差の標準偏差 0.0272・99% 以上が 0.1 以内）。**最大値のほうが
// 計測震度に対応する** —— 時系列そのものを計測震度と呼ばないこと。気象庁の手順は
// `seismicIntensity.ts` の `calcSeismicIntensity` が持つ。
//
// **60 秒の窓の効き目は画面に出る。** 最大値に達してからおよそ 60 秒は値が下がらない
// （強震モニタの実データでも 60〜63 秒保たれてから落ちる。2026-10-04 に大地震 4 本で確認）。

import { DURATION_THRESHOLD_SEC, durationThresholdIndex, stepSamplesForSeconds } from './intensityCommon'

/** 0.3 秒の判定を行う窓（秒）。**論文の定義なので動かさない**（2008 年版 §2）。 */
export const REALTIME_JUDGE_WINDOW_SEC = 60

/**
 * 近似フィルタのパラメータ（2013 年版 A1 の末尾）。
 *
 * **書き換えない。** 論文はこの値の組で 453,357 波を検証している。どれか 1 つでも動かすと、
 * その検証の裏付けを失う。
 */
const PARAMS = {
  f0: 0.45,
  f1: 7.0,
  f2: 0.5,
  f3: 12.0,
  f4: 20.0,
  f5: 30.0,
  h2a: 1.0,
  h2b: 0.75,
  h3: 0.9,
  h4: 0.6,
  h5: 0.6,
  g: 1.262,
} as const

/**
 * 直流（重力）を推定する長さ（秒）。**1 秒。** 理由は {@link RealtimeIntensityCalculator} の説明。
 */
const OFFSET_ESTIMATE_SEC = 1

/** 震度へ直す式の定数（気象庁告示と同じ）。 */
const SINDO_LOG_COEFFICIENT = 2
const SINDO_OFFSET = 0.94

/** 2 次の差分方程式 1 段ぶんの係数。`a0` で割る前の値のまま持つ（論文 A15 の形）。 */
export interface BiquadCoefficients {
  readonly b0: number
  readonly b1: number
  readonly b2: number
  readonly a0: number
  readonly a1: number
  readonly a2: number
}

/**
 * 1 次フィルタ (a·ω·s⁻¹ + 1)/(ω·s⁻¹ + b) の z 変換（論文 A9）。
 * 返すのは [β0, β1, α0, α1]。
 */
function firstOrder(a: number, b: number, fa: number, dt: number): [number, number, number, number] {
  const w = 2 * Math.PI * fa
  return [w * a + 2 / dt, w * a - 2 / dt, w + (2 * b) / dt, w - (2 * b) / dt]
}

/**
 * 1 次 2 つの積を 2 次 1 段へまとめる（論文 A10）。
 *
 * **論文の展開済みの式（A11・A12）を写さず、ここで掛け合わせる。** A12 の β0・β2 は
 * `8.5ω_a2` と印刷されているが、A9 と A10 から導くと `8.5ω_a3` になる（A12 の他の項は
 * すべて ω_a3 で書かれている）。展開済みの式を写すと、その誤植ごと持ち込む。
 * 展開と一致することはテストが確かめる。
 */
function productOfFirstOrders(
  [b01, b11, a01, a11]: [number, number, number, number],
  [b02, b12, a02, a12]: [number, number, number, number],
): BiquadCoefficients {
  return {
    b0: b01 * b02,
    b1: b01 * b12 + b02 * b11,
    b2: b11 * b12,
    a0: a01 * a02,
    a1: a01 * a12 + a02 * a11,
    a2: a11 * a12,
  }
}

/** 補正フィルタ（論文 A5 → A13）。 */
function correction(h1: number, h2: number, fb: number, dt: number): BiquadCoefficients {
  const w = 2 * Math.PI * fb
  const t2 = 12 / (dt * dt)
  return {
    b0: t2 + (12 * h1 * w) / dt + w * w,
    b1: 10 * w * w - 24 / (dt * dt),
    b2: t2 - (12 * h1 * w) / dt + w * w,
    a0: t2 + (12 * h2 * w) / dt + w * w,
    a1: 10 * w * w - 24 / (dt * dt),
    a2: t2 - (12 * h2 * w) / dt + w * w,
  }
}

/** 2 次ローパス（論文 A6〜A8 → A14）。 */
function lowPass(h: number, fc: number, dt: number): BiquadCoefficients {
  const w = 2 * Math.PI * fc
  const t2 = 12 / (dt * dt)
  return {
    b0: w * w,
    b1: 10 * w * w,
    b2: w * w,
    a0: t2 + (12 * h * w) / dt + w * w,
    a1: 10 * w * w - 24 / (dt * dt),
    a2: t2 - (12 * h * w) / dt + w * w,
  }
}

/**
 * 6 段の係数を作る（論文 A3 の 1〜6）。7 段目のゲインは {@link PARAMS} の `g`。
 */
export function realtimeFilterStages(sampleRateHz: number): BiquadCoefficients[] {
  const dt = 1 / sampleRateHz
  const p = PARAMS
  return [
    // 1: (A1)(A2) —— f_a1 = f0, f_a2 = f1
    productOfFirstOrders(firstOrder(0, 1, p.f0, dt), firstOrder(1, 2, p.f1, dt)),
    // 2: (A3)(A4) —— f_a3 = f1
    productOfFirstOrders(firstOrder(4, 8, p.f1, dt), firstOrder(0.25, 0.5, p.f1, dt)),
    // 3: (A5) —— h_b1 = h2a, h_b2 = h2b, f_b = f2
    correction(p.h2a, p.h2b, p.f2, dt),
    // 4〜6: (A6)〜(A8)
    lowPass(p.h3, p.f3, dt),
    lowPass(p.h4, p.f4, dt),
    lowPass(p.h5, p.f5, dt),
  ]
}

/** 7 段目のゲイン（論文 A16 の g_d）。 */
export const REALTIME_FILTER_GAIN = PARAMS.g

/**
 * 1 段が安定か（極が単位円の内側か）。
 *
 * **作る時点で確かめる。** 双線形変換の歪みで、サンプリング周波数が低いと自己回帰の項が
 * 不安定になり、出力が発散する（この 2013 年版は約 77 Hz を下回ると発散すると報告されている）。
 * 発散した出力は有限のまま大きくなるので、震度だけ見ていても**揺れの大きな地震**と
 * 区別が付かない —— だから値を出す前に止める。
 */
export function isStableStage(c: BiquadCoefficients): boolean {
  const a1 = c.a1 / c.a0
  const a2 = c.a2 / c.a0
  return Math.abs(a2) < 1 && Math.abs(a1) < 1 + a2
}

/**
 * 1 成分ぶんの近似フィルタ（6 段＋ゲイン）。**状態を持つ**ので、成分ごとに 1 つ作る。
 */
class RealtimeFilter {
  private readonly stages: BiquadCoefficients[]
  /** 段ごとの [x(k-1), x(k-2), y(k-1), y(k-2)]。 */
  private readonly state: Float64Array

  constructor(stages: BiquadCoefficients[]) {
    this.stages = stages
    this.state = new Float64Array(stages.length * 4)
  }

  /** 1 サンプル通す（論文 A15 を 6 段直列に、最後に A16）。 */
  step(x: number): number {
    let v = x
    for (let i = 0; i < this.stages.length; i++) {
      const c = this.stages[i]
      const o = i * 4
      const x1 = this.state[o]
      const x2 = this.state[o + 1]
      const y1 = this.state[o + 2]
      const y2 = this.state[o + 3]
      const y = (-c.a1 * y1 - c.a2 * y2 + c.b0 * v + c.b1 * x1 + c.b2 * x2) / c.a0
      this.state[o + 1] = x1
      this.state[o] = v
      this.state[o + 3] = y1
      this.state[o + 2] = y
      v = y
    }
    return REALTIME_FILTER_GAIN * v
  }
}

/** 配列の中で `k` 番目に大きい値（0 起点）を返す。中身は並べ替える。 */
function kthLargestInPlace(values: Float64Array, length: number, k: number): number {
  let lo = 0
  let hi = length - 1
  while (lo < hi) {
    const pivot = values[(lo + hi) >>> 1]
    let i = lo
    let j = hi
    while (i <= j) {
      while (values[i] > pivot) i++
      while (values[j] < pivot) j--
      if (i <= j) {
        const t = values[i]
        values[i] = values[j]
        values[j] = t
        i++
        j--
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return values[k]
  }
  return values[k]
}

/**
 * 届いた順にサンプルを受け、いまのリアルタイム震度を返す計算器。
 *
 * **直流は最初の 1 秒の平均で引く。** 近似フィルタの 1 段目は直流を通さないけれど、重力
 * （机に置いた基板で約 1000 gal）を素で渡すと、立ち上がりの段差が強い揺れとして出て、
 * **60 秒の窓に入ったまま 1 分間居座る**。差し引けば段差は直流の推定誤差まで縮む
 * （残った直流はフィルタが落とす）。
 *
 * **1 サンプルで推定しない。** そのサンプルに乗っていたノイズがそのまま段差になる ——
 * 自作地震計の実記録で、区間の頭だけ 0.89（平常時は 0.36）が 60 秒居座った
 * （有感地震の前後の記録で確かめた）。1 秒（100 サンプル）の平均なら、
 * 誤差はノイズの 1/10 になる。
 *
 * **そのため最初の 1 秒はフィルタへ通さず溜めておき、平均が出た時点でまとめて通す。**
 * 答えが出るのは刻みの位置なので、この溜めで答えが遅れることは無い（刻みが 1 秒以上なら）。
 * K-NET の記録のように基線補正済みなら、引く量はほぼ 0 で害は無い。
 */
export class RealtimeIntensityCalculator {
  private readonly filters: [RealtimeFilter, RealtimeFilter, RealtimeFilter]
  private readonly amplitudes: Float64Array
  private readonly scratch: Float64Array
  private readonly thresholdIndex: number
  private next = 0
  private filled = 0
  /** 受け取ったサンプルの数（窓の外へ出たものも含む）。 */
  private total = 0
  /** 直流の推定（最初の 1 秒の平均）。出るまでは null。 */
  private offset: [number, number, number] | null = null
  /** 直流を推定するために溜めておくサンプル数（1 秒ぶん）。 */
  private readonly offsetSamples: number
  /** 直流が出るまで溜めているサンプル（成分ごと）。 */
  private pending: [number[], number[], number[]] = [[], [], []]

  constructor(sampleRateHz: number) {
    if (!(sampleRateHz > 0) || !Number.isFinite(sampleRateHz)) {
      throw new Error('sampleRateHz は正の数で指定すること')
    }
    const stages = realtimeFilterStages(sampleRateHz)
    const unstable = stages.findIndex((s) => !isStableStage(s))
    if (unstable >= 0) {
      throw new Error(
        `毎秒 ${sampleRateHz} 回では近似フィルタの ${unstable + 1} 段目が発散する（サンプリング周波数が低すぎる）`,
      )
    }
    this.filters = [new RealtimeFilter(stages), new RealtimeFilter(stages), new RealtimeFilter(stages)]
    const capacity = Math.max(1, Math.round(REALTIME_JUDGE_WINDOW_SEC * sampleRateHz))
    this.thresholdIndex = durationThresholdIndex(sampleRateHz)
    if (this.thresholdIndex < 0 || this.thresholdIndex >= capacity) {
      throw new Error(`${DURATION_THRESHOLD_SEC} 秒の判定ができない（毎秒 ${sampleRateHz} 回）`)
    }
    this.amplitudes = new Float64Array(capacity)
    this.scratch = new Float64Array(capacity)
    this.offsetSamples = Math.max(1, Math.round(OFFSET_ESTIMATE_SEC * sampleRateHz))
  }

  get sampleCount(): number {
    return this.total
  }

  /**
   * 3 成分のサンプルを 1 つ受ける（単位は gal。軸の並びは問わない）。
   *
   * **有限でない値は受け取らずに投げる。** 近似フィルタは前のサンプルの出力を持ち回るので、
   * 一度 NaN が入るとその計算器は以後ずっと NaN を出し続け、`intensity()` が黙って `null` を
   * 返し続ける（揺れていないのと見分けが付かない）。ホストの流し込みは手前で確かめているが、
   * K-NET 取り込みのバッチ経路もここを通るので、計算器自身が止める。
   */
  push(a: number, b: number, c: number): void {
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
      throw new Error(`有限でないサンプルが混じっている: 位置 ${this.total}`)
    }
    this.total++
    if (this.offset === null) {
      this.pending[0].push(a)
      this.pending[1].push(b)
      this.pending[2].push(c)
      if (this.pending[0].length < this.offsetSamples) return
      const mean = (v: number[]): number => v.reduce((p, q) => p + q, 0) / v.length
      this.offset = [mean(this.pending[0]), mean(this.pending[1]), mean(this.pending[2])]
      const [pa, pb, pc] = this.pending
      this.pending = [[], [], []]
      for (let i = 0; i < pa.length; i++) this.filterOne(pa[i], pb[i], pc[i])
      return
    }
    this.filterOne(a, b, c)
  }

  private filterOne(a: number, b: number, c: number): void {
    const offset = this.offset as [number, number, number]
    const fa = this.filters[0].step(a - offset[0])
    const fb = this.filters[1].step(b - offset[1])
    const fc = this.filters[2].step(c - offset[2])
    this.amplitudes[this.next] = Math.sqrt(fa * fa + fb * fb + fc * fc)
    this.next = this.next + 1 === this.amplitudes.length ? 0 : this.next + 1
    if (this.filled < this.amplitudes.length) this.filled++
  }

  /**
   * いまのリアルタイム震度。**判定に足りるだけ溜まっていなければ `null`**
   * （0.3 秒に満たない・代表値が 0 以下）。`null` は「揺れていない」ではない。
   */
  intensity(): number | null {
    if (this.filled <= this.thresholdIndex) return null
    this.scratch.set(this.filled === this.amplitudes.length ? this.amplitudes : this.amplitudes.subarray(0, this.filled))
    const a = kthLargestInPlace(this.scratch, this.filled, this.thresholdIndex)
    if (!(a > 0)) return null
    return SINDO_LOG_COEFFICIENT * Math.log10(a) + SINDO_OFFSET
  }
}

export interface RealtimeIntensityPoint {
  /** 記録の先頭からの経過秒（その時点までのサンプルで出した値）。 */
  readonly tSec: number
  /** リアルタイム震度。判定に足りなければ `null`。 */
  readonly intensity: number | null
}

/**
 * 3 成分の記録からリアルタイム震度の時系列を出す（`stepSec` ごと）。
 *
 * **届いた順に通すだけなので、各点はその時刻までのサンプルしか使っていない。** 記録を
 * 先読みしない —— 強震モニタと同じく、その時点で出せた値になる。
 */
export function computeRealtimeIntensityTimeSeries(
  ns: readonly number[],
  ew: readonly number[],
  ud: readonly number[],
  sampleRateHz: number,
  stepSec: number,
): RealtimeIntensityPoint[] {
  if (!(stepSec > 0)) throw new Error('stepSec は正の数で指定すること')
  const calc = new RealtimeIntensityCalculator(sampleRateHz)
  const len = Math.min(ns.length, ew.length, ud.length)
  // 刻みの丸め方はホストの流し込み（`seismo-host/src/intensity/intensityStream.ts`）と共有する。
  const stepSamples = stepSamplesForSeconds(stepSec, sampleRateHz)
  const points: RealtimeIntensityPoint[] = []
  for (let i = 0; i < len; i++) {
    calc.push(ns[i], ew[i], ud[i])
    if ((i + 1) % stepSamples === 0) {
      points.push({ tSec: (i + 1) / sampleRateHz, intensity: calc.intensity() })
    }
  }
  return points
}
