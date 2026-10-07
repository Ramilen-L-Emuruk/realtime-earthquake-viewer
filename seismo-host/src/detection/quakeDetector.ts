// 観測点 1 つぶんの地震検出（REQUIREMENTS.md §6）。引き金・P/S の拾い出し・揺れ方の分類を
// 1 本の流れにまとめる。
//
//   合成波形 → TriggerDetector（区間を切る）→ 閉じた区間ごとに
//     pickPhases（手元に残した波形から P/S を拾う）＋ classifyShake（揺れ方の分類）→ DetectedShake
//
// **評価台（`seismo-host/bench/`）と同じ部品を通す。** 窓の切り出し（`phaseWindowFrom`）を
// ここに置き、評価台もこれを呼ぶ —— 別々に書くと、評価した値と実機の値が黙ってずれる。
//
// **気象庁の地震情報との照合はここでは行わない**（地震情報は揺れの数分後に届くので、区間が
// 閉じた時点では判定できない）。照合は記録の段（`shakeEventBook.ts`）が後から書き足す。

import { BandPass } from './bandPass'
import { SHAKE_ENVELOPE_DEFAULT, classifyShake, shakeRatios } from './eventClassifier'
import type { ShakeClass, ShakeEnvelope, ShakeRatios } from './eventClassifier'
import { PHASE_PICK_CONFIG_DEFAULT, horizontalEnvelope, pickPhases } from './phasePicker'
import type { PhasePicks } from './phasePicker'
import { TRIGGER_CONFIG_DEFAULT, TriggerDetector, featureBandIndex } from './quakeTrigger'
import type { TriggerConfig, TriggerEvent, TriggerHealth, TriggerInput, TriggerPeak } from './quakeTrigger'

/** 検出器の版。記録に残し、後から「どの判定で出した区間か」を辿れるようにする。 */
export const DETECTOR_VERSION = 1

/** P/S を拾う窓: 引き金の何ミリ秒前から。 */
const PHASE_WINDOW_BEFORE_MS = 45_000
/** P/S を拾う窓: 引き金の何ミリ秒後まで。 */
const PHASE_WINDOW_AFTER_MS = 10_000
/** フィルタを落ち着かせるため、窓の手前から回し始める長さ。 */
const PHASE_FILTER_SETTLE_MS = 20_000
/**
 * 手元の波形が窓より短い（起動直後）ときに、フィルタを回してから窓を始めるまでの最短の長さ。
 * 2 段の帯域通過は 1 秒ほどで落ち着くので、余裕を見て 5 秒。
 */
const PHASE_FILTER_MIN_SETTLE_MS = 5_000
/** まとまりの継ぎ目のずれをどこまで許すか（サンプル数）。これを超えたら途切れとみなす。 */
const PHASE_GAP_TOLERANCE_SAMPLES = 2
/** P を拾う上下動の帯域（Hz）。S は引き金と同じ水平動 5〜10 Hz。 */
export const P_BAND_HZ: readonly [number, number] = [2, 8]

/**
 * P/S の窓を作った結果。
 *
 * - `picked` — 窓を作って拾った（拾えたかどうかは `phases` の中身）
 * - `no-data` — 窓へ置ける波形が 1 つも無い。**異常ではない**。起動直後で引き金より前が短いだけなら、
 *   置けた分で拾う（`picked`。S を探す範囲が足りなければ中身が null になる）
 * - `broken` — S を探す範囲（とその手前の SNR の窓）に、波形の途切れ・非有限値が掛かっていた。
 *   **拾わない** —— 途切れの前後を詰めて繋ぐと時刻がずれ、非有限値はフィルタの状態を以後ずっと壊す。
 *   どちらも S の時刻を誤らせ、照合の「どちらの地震が近いか」まで狂わせる
 */
export type PhaseWindowResult =
  | { readonly kind: 'picked'; readonly phases: PhasePicks }
  | { readonly kind: 'no-data' }
  | { readonly kind: 'broken'; readonly problem: 'gap' | 'non-finite' }

/** S を探す範囲の頭（引き金から何ミリ秒前か）。ここより後ろに途切れが掛かったら拾わない。 */
const S_REGION_LEAD_MS = (PHASE_PICK_CONFIG_DEFAULT.sSearchBeforeSec + PHASE_PICK_CONFIG_DEFAULT.snrBeforeSec) * 1000

function usableStep(c: TriggerInput): boolean {
  return c.msPerSample > 0 && Number.isFinite(c.msPerSample) && Number.isFinite(c.firstSampleMs)
}

/** 窓の材料のサンプル 1 つ。 */
interface WindowSample {
  readonly t: number
  readonly dt: number
  readonly x: number
  readonly y: number
  readonly z: number
  /** 直前のサンプルとの間に途切れ（継ぎ目のずれが許容を超えた・刻みが変わった）がある。 */
  readonly gapBefore: boolean
}

/**
 * `[headMs, toMs)` に入るサンプルを時刻順に**一度だけ**並べる。
 *
 * **途切れ・非有限値を探すのも、窓へ置くのも、この並びだけを見る。** 境界（窓の頭と終わり）を
 * 探す側と置く側で別々に書くと、片方だけ境界が緩くなる —— 実際、探す側だけがまとまりの末尾まで
 * 見ていて、拾い出しに使わない窓の外の非有限値 1 つで拾うのをやめる形が出た。
 */
function windowSamples(chunks: readonly TriggerInput[], headMs: number, toMs: number): WindowSample[] {
  const out: WindowSample[] = []
  let prev: TriggerInput | null = null
  let gapPending = false
  for (const c of chunks) {
    if (!usableStep(c)) continue
    const len = c.gal[0].length
    if (c.firstSampleMs + len * c.msPerSample <= headMs || c.firstSampleMs >= toMs) continue
    if (prev !== null) {
      const expectedMs = prev.firstSampleMs + prev.gal[0].length * prev.msPerSample
      const rateChanged = !(Math.abs(c.msPerSample - prev.msPerSample) / prev.msPerSample <= 0.05)
      if (rateChanged || Math.abs(c.firstSampleMs - expectedMs) > PHASE_GAP_TOLERANCE_SAMPLES * prev.msPerSample) {
        gapPending = true
      }
    }
    prev = c
    for (let i = 0; i < len; i++) {
      const t = c.firstSampleMs + i * c.msPerSample
      if (t < headMs || t >= toMs) continue
      out.push({ t, dt: c.msPerSample, x: c.gal[0][i], y: c.gal[1][i], z: c.gal[2][i], gapBefore: gapPending })
      gapPending = false
    }
    // 窓へ 1 つも置かなかったまとまり（助走の頭をかすめただけ）の手前の途切れは、窓の外の話。
    // 次のまとまりへ持ち越すと、要らない始め直しを起こす。
    gapPending = false
  }
  return out
}

/**
 * 手元に残した波形から、引き金 `onMs` の前後を帯域で絞って取り出し、P/S を拾う。
 *
 * **サンプルは時刻から割り出した位置へ置く**（届いた順に詰めない）。継ぎ目の小さなずれ
 * （`PHASE_GAP_TOLERANCE_SAMPLES` 以下）は位置で吸収する。
 *
 * **それより大きな途切れ・非有限値があれば、その後ろから窓を始め直す**（起動直後で波形が
 * 短いときと同じ扱い）。P を探す範囲は短くなるが、S を探す範囲が丸ごと残っていれば拾える ——
 * 引き金は 1 秒までの途切れを 1 つの区間として扱うので、窓のどこかに途切れが 1 つあるだけで
 * 拾うのをやめると、普通に起きるパケットの欠けで S/P を失う。始め直した窓が S を探す範囲
 * （`S_REGION_LEAD_MS`）に届かないときだけ `broken` にする。
 */
export function phaseWindowFrom(
  chunks: readonly TriggerInput[],
  onMs: number,
  triggerBandHz: readonly [number, number],
): PhaseWindowResult {
  const fromMs = onMs - PHASE_WINDOW_BEFORE_MS
  const toMs = onMs + PHASE_WINDOW_AFTER_MS
  const samples = windowSamples(chunks, fromMs - PHASE_FILTER_SETTLE_MS, toMs)
  // 最後の途切れ・非有限値を探し、その後ろを窓の材料にする。
  let begin = 0
  let problem: 'gap' | 'non-finite' | null = null
  for (let j = 0; j < samples.length; j++) {
    const s = samples[j]
    if (s.gapBefore) {
      begin = j
      problem = 'gap'
    }
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) {
      begin = j + 1
      problem = 'non-finite'
    }
  }
  if (begin >= samples.length) return problem === null ? { kind: 'no-data' } : { kind: 'broken', problem }

  const dt = samples[begin].dt
  const dataStartMs = samples[begin].t
  // 窓の起点はデータの刻みに乗せる。手元の波形が短ければ、フィルタが落ち着くぶん後ろへずらす。
  const wantMs = Math.max(fromMs, dataStartMs + PHASE_FILTER_MIN_SETTLE_MS)
  const startMs = dataStartMs + Math.ceil((wantMs - dataStartMs) / dt) * dt
  // 判定は刻みへ乗せた後の起点で行う（丸めで 1 サンプルぶん S の範囲へ食い込まないように）。
  if (problem !== null && startMs > onMs - S_REGION_LEAD_MS) return { kind: 'broken', problem }
  const n = Math.round((toMs - startMs) / dt)
  if (n <= 0) return { kind: 'no-data' }

  // 始め直した位置からフィルタを回し、時刻の位置へ置く（この先に途切れ・非有限値は無い）。
  const fs = 1000 / dt
  const fx = new BandPass(triggerBandHz[0], triggerBandHz[1], fs)
  const fy = new BandPass(triggerBandHz[0], triggerBandHz[1], fs)
  const fz = new BandPass(P_BAND_HZ[0], P_BAND_HZ[1], fs)
  const xs = new Float64Array(n).fill(Number.NaN)
  const ys = new Float64Array(n).fill(Number.NaN)
  const zs = new Float64Array(n).fill(Number.NaN)
  let lastK = -1
  for (let j = begin; j < samples.length; j++) {
    const s = samples[j]
    const hx = fx.step(s.x)
    const hy = fy.step(s.y)
    const vz = fz.step(s.z)
    const k = Math.round((s.t - startMs) / dt)
    if (k < 0 || k >= n) continue
    xs[k] = hx
    ys[k] = hy
    zs[k] = vz
    if (k > lastK) lastK = k
  }
  if (lastK < 0) return { kind: 'no-data' }
  // 継ぎ目のずれで空いた 1〜2 サンプルは直前の値で埋める（先頭が空いていれば最初の値で）。
  const used = lastK + 1
  for (const a of [xs, ys, zs]) {
    let first = 0
    while (first < used && Number.isNaN(a[first])) first++
    for (let k = 0; k < used; k++) if (Number.isNaN(a[k])) a[k] = k < first ? a[first] : a[k - 1]
  }
  const phases = pickPhases(
    { startMs, msPerSample: dt, horizontal: horizontalEnvelope(xs.subarray(0, used), ys.subarray(0, used)), vertical: zs.subarray(0, used) },
    onMs,
  )
  return { kind: 'picked', phases }
}

/** 検出した 1 つの揺れ。 */
export interface DetectedShake {
  readonly trigger: TriggerEvent
  readonly shakeClass: ShakeClass
  /** 揺れ方の比（引き金の帯が 0 なら null）。 */
  readonly ratios: ShakeRatios | null
  /** P/S（窓を作れなければ null。理由は `phaseWindow`）。 */
  readonly phases: PhasePicks | null
  readonly phaseWindow: PhaseWindowState
}

/**
 * P/S の窓をどう扱ったか。`picked` 以外なら P/S は null —— 「拾ったが SNR が足りなかった」
 * （`picked` で中身が null）と「拾わなかった」を記録の上で分けるために持つ。
 *
 * - `picked` — 窓を作って拾った
 * - `no-data` — 窓へ置ける波形が 1 つも無かった
 * - `gap` / `non-finite` — 窓の中で波形が途切れた・非有限値が混じったので拾わなかった
 * - `failed` — 拾い出しの途中で例外が出た
 */
export type PhaseWindowState = 'picked' | 'no-data' | 'gap' | 'non-finite' | 'failed'

export interface QuakeDetectorOptions {
  readonly trigger?: TriggerConfig
  readonly envelope?: ShakeEnvelope
}

/**
 * 観測点 1 つの検出器。合成波形のまとまりを時刻順に `push` し、閉じた揺れを受け取る。
 *
 * **投げない**（ホストの受信を止めないため）。中で例外が出たら、その区間の P/S を空にして返す。
 * ただし**作るときは投げる**（設定の誤り。揺れ方の枠の基準の帯が特徴量の帯に無い等）。
 */
export class QuakeDetector {
  private readonly cfg: TriggerConfig
  private readonly envelope: ShakeEnvelope
  private readonly trigger: TriggerDetector
  /** P/S を拾うために残しておく直近の波形。 */
  private kept: TriggerInput[] = []
  /** 拾い出しで例外が出た回数。 */
  phaseFailures = 0
  /** P/S の窓の中で波形が途切れていた・非有限値が混じっていて、拾わなかった回数。 */
  phaseWindowsBroken = 0

  constructor(options: QuakeDetectorOptions = {}) {
    this.cfg = options.trigger ?? TRIGGER_CONFIG_DEFAULT
    this.envelope = options.envelope ?? SHAKE_ENVELOPE_DEFAULT
    if (featureBandIndex(this.envelope.referenceBandHz) < 0) {
      throw new Error(`揺れ方の枠の基準の帯 ${this.envelope.referenceBandHz.join('〜')} Hz が特徴量の帯に無い`)
    }
    this.trigger = new TriggerDetector(this.cfg)
  }

  /** 引き金の内部で数えている値（状態の口へ出す）。 */
  get droppedChunks(): number {
    return this.trigger.droppedChunks
  }

  get resets(): number {
    return this.trigger.resets
  }

  /** 引き金が最後にサンプルを使えた時刻（データの時刻。`TriggerDetector.lastSampleAtMs`）。 */
  get lastSampleAtMs(): number | null {
    return this.trigger.lastSampleAtMs
  }

  /** 引き金のいまの状態（`TriggerDetector.health`）。 */
  health(): TriggerHealth {
    return this.trigger.health()
  }

  /** 範囲（データの時刻・1 分単位）で比がいちばん大きかったサンプル（`TriggerDetector.peakBetween`）。 */
  peakBetween(fromMs: number, toMs: number): TriggerPeak | null {
    return this.trigger.peakBetween(fromMs, toMs)
  }

  push(chunk: TriggerInput): DetectedShake[] {
    // 刻みの読めないまとまりは残さない（引き金も捨てて数える。窓の位置の計算を壊さないため）。
    if (usableStep(chunk)) this.kept.push(chunk)
    const closed = this.trigger.push(chunk)
    const out = closed.map((e) => this.finish(e))
    this.trim(chunk.firstSampleMs + chunk.gal[0].length * chunk.msPerSample)
    return out
  }

  flush(): DetectedShake[] {
    return this.trigger.flush().map((e) => this.finish(e))
  }

  private finish(trigger: TriggerEvent): DetectedShake {
    let phases: PhasePicks | null = null
    let phaseWindow: DetectedShake['phaseWindow']
    try {
      const w = phaseWindowFrom(this.kept, trigger.onMs, this.cfg.triggerBandHz)
      if (w.kind === 'picked') phases = w.phases
      if (w.kind === 'broken') this.phaseWindowsBroken++
      phaseWindow = w.kind === 'broken' ? w.problem : w.kind
    } catch {
      this.phaseFailures++
      phaseWindow = 'failed'
    }
    return {
      trigger,
      shakeClass: classifyShake(trigger, this.envelope),
      ratios: shakeRatios(trigger, this.envelope.referenceBandHz),
      phases,
      phaseWindow,
    }
  }

  /**
   * 残す波形を刈り込む。開いている区間の始まりより前の窓（P/S の窓 ＋ フィルタの助走）は
   * 残す必要があるので、区間の最長（`maxEventSec`）ぶんを見込んで残す。
   */
  private trim(nowMs: number): void {
    const keepMs = PHASE_WINDOW_BEFORE_MS + PHASE_FILTER_SETTLE_MS + this.cfg.maxEventSec * 1000 + this.cfg.holdSec * 1000
    const cutoff = nowMs - keepMs
    let drop = 0
    while (drop < this.kept.length) {
      const c = this.kept[drop]
      if (c.firstSampleMs + c.gal[0].length * c.msPerSample >= cutoff) break
      drop++
    }
    if (drop > 0) this.kept = this.kept.slice(drop)
  }
}
