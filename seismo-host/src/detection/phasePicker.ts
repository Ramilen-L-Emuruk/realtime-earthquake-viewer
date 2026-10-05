// P 波・S 波の到達時刻を拾う（REQUIREMENTS.md §6・§9）。
//
// **AIC（赤池情報量規準）で「静かな前半」と「揺れている後半」の切れ目を探す**（Maeda 1985 の
// 波形から直接求める形）。窓の中のどこで分けると、前後それぞれの分散で最もよく説明できるかを
// 1 点ずつ調べ、AIC が最小になる位置を到達とする。STA/LTA の引き金は比が閾値を越えた時刻で、
// 到達そのものより遅れる —— その遅れを詰めるのがこの段の役目。
//
// **拾えたかどうかを必ず添える。** AIC は雑音しか無い窓でも「どこか」を最小にする。拾った点の
// 前後の振幅の比（SNR）が小さければ、その点は到達ではない。§9 の「P 波 SNR」はこの値。
//
// 機械学習の P/S ピッカーへ替えるときは、`pickPhases` と同じ形（窓の波形 → 時刻と確からしさ）で
// 差し替える（§6）。

/** AIC が最小になる位置（`from` 以上 `to` 未満）。窓が短すぎれば null。 */
export function aicPick(x: ArrayLike<number>, from = 0, to = x.length): number | null {
  const n = to - from
  if (n < 10) return null
  // 前から・後ろからの累積和で、各分け目の前後の分散を O(n) で出す。
  const prefix = new Float64Array(n + 1)
  const prefixSq = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    const v = x[from + i]
    prefix[i + 1] = prefix[i] + v
    prefixSq[i + 1] = prefixSq[i] + v * v
  }
  const variance = (a: number, b: number): number => {
    const m = b - a
    const mean = (prefix[b] - prefix[a]) / m
    return Math.max((prefixSq[b] - prefixSq[a]) / m - mean * mean, 1e-12)
  }
  let best = Number.POSITIVE_INFINITY
  let bestK: number | null = null
  // 両端の数点は分散が定まらないので外す。
  for (let k = 5; k < n - 5; k++) {
    const aic = k * Math.log(variance(0, k)) + (n - k - 1) * Math.log(variance(k, n))
    if (aic < best) {
      best = aic
      bestK = from + k
    }
  }
  return bestK
}

/** 位置 `at` の前 `beforeN` 点と後 `afterN` 点の RMS の比（後 ÷ 前）。 */
export function onsetSnr(x: ArrayLike<number>, at: number, beforeN: number, afterN: number): number | null {
  const a0 = Math.max(0, at - beforeN)
  const b1 = Math.min(x.length, at + afterN)
  if (at - a0 < beforeN / 2 || b1 - at < afterN / 2) return null
  let pre = 0
  for (let i = a0; i < at; i++) pre += x[i] * x[i]
  let post = 0
  for (let i = at; i < b1; i++) post += x[i] * x[i]
  const preRms = Math.sqrt(pre / (at - a0))
  const postRms = Math.sqrt(post / (b1 - at))
  return preRms > 0 ? postRms / preRms : null
}

/** 2 本の波形を 1 本にまとめる（水平 2 成分の AIC 用）。各点の二乗和の平方根に符号を付けない。 */
export function horizontalEnvelope(x: ArrayLike<number>, y: ArrayLike<number>): Float64Array {
  const out = new Float64Array(Math.min(x.length, y.length))
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(x[i], y[i])
  return out
}

export interface PhasePickConfig {
  /** S の探索窓: 引き金の時刻から前へ（秒）。 */
  readonly sSearchBeforeSec: number
  /** S の探索窓: 引き金の時刻から後ろへ（秒）。 */
  readonly sSearchAfterSec: number
  /** P の探索窓: S の何秒前から（秒）。 */
  readonly pSearchMaxLeadSec: number
  /** P の探索窓: S の何秒前まで（秒）。 */
  readonly pSearchMinLeadSec: number
  /** SNR を測る長さ: 前（秒）。 */
  readonly snrBeforeSec: number
  /** SNR を測る長さ: 後（秒）。 */
  readonly snrAfterSec: number
  /** これ以上の SNR がなければ、P は拾えなかったことにする。 */
  readonly pMinSnr: number
  /** これ以上の SNR がなければ、S は拾えなかったことにする。 */
  readonly sMinSnr: number
}

export const PHASE_PICK_CONFIG_DEFAULT: PhasePickConfig = {
  sSearchBeforeSec: 6,
  sSearchAfterSec: 3,
  pSearchMaxLeadSec: 30,
  pSearchMinLeadSec: 1,
  snrBeforeSec: 4,
  snrAfterSec: 2,
  // **P は 2.0 倍を求める。** 2026-09-28〜10-03 の実機で気象庁の地震と一致した 6 件（
  // M2.8〜3.5）では、P の立ち上がりは平常時の 0.5〜1.9 倍しか無く、1.5 倍で採った 3 件は S−P が
  // 走時表と合わなかった。MPU6050 の雑音では、
  // この距離の M3 級の P は拾えない —— 拾えたことにして偽の S−P を残すより、空のまま残す。
  pMinSnr: 2,
  sMinSnr: 2,
}

/** 拾い出しに渡す窓の波形（帯域で絞った後のもの）。 */
export interface PhaseWindow {
  /** 先頭のサンプルの時刻（unix ミリ秒）。 */
  readonly startMs: number
  readonly msPerSample: number
  /** S 用（水平動）。 */
  readonly horizontal: ArrayLike<number>
  /** P 用（上下動）。 */
  readonly vertical: ArrayLike<number>
}

export interface PhasePick {
  readonly atMs: number
  readonly snr: number
}

export interface PhasePicks {
  /** 拾えなければ null（SNR が足りない・窓が足りない）。 */
  readonly s: PhasePick | null
  readonly p: PhasePick | null
  /** 拾った点の SNR（拾えなかったときも、試した点の値があれば残す。§9 の P 波 SNR）。 */
  readonly pSnrTried: number | null
}

/**
 * 引き金の時刻 `triggerMs` を手掛かりに S を、その前に P を拾う。
 *
 * **引き金は S で引かれる前提で探す。** 実機の記録では、近い M3 級でも P は平常時の 1.5 倍
 * 程度しか出ず、引き金（2.5 倍）を引くのは S だった。P が強くて引き金を引いた場合は、S の
 * 窓に P が入り、P の窓はその前の雑音になる —— P は SNR で弾かれ、S の位置に P の時刻が入る。
 * これを見分けるには、S の後ろに 2 つ目の立ち上がりがあるかを見る必要がある（未対応。
 * 近くの大きな地震の記録がまだ無い）。
 */
export function pickPhases(
  w: PhaseWindow,
  triggerMs: number,
  cfg: PhasePickConfig = PHASE_PICK_CONFIG_DEFAULT,
): PhasePicks {
  const fs = 1000 / w.msPerSample
  const idx = (ms: number): number => Math.round((ms - w.startMs) / w.msPerSample)
  const n = Math.min(w.horizontal.length, w.vertical.length)
  const clamp = (i: number): number => Math.max(0, Math.min(n, i))

  const sFrom = clamp(idx(triggerMs - cfg.sSearchBeforeSec * 1000))
  const sTo = clamp(idx(triggerMs + cfg.sSearchAfterSec * 1000))
  const sAt = aicPick(w.horizontal, sFrom, sTo)
  if (sAt === null) return { s: null, p: null, pSnrTried: null }
  const sSnr = onsetSnr(w.horizontal, sAt, Math.round(cfg.snrBeforeSec * fs), Math.round(cfg.snrAfterSec * fs))
  const s = sSnr !== null && sSnr >= cfg.sMinSnr ? { atMs: w.startMs + sAt * w.msPerSample, snr: sSnr } : null
  if (s === null) return { s: null, p: null, pSnrTried: null }

  const pFrom = clamp(sAt - Math.round(cfg.pSearchMaxLeadSec * fs))
  const pTo = clamp(sAt - Math.round(cfg.pSearchMinLeadSec * fs))
  const pAt = aicPick(w.vertical, pFrom, pTo)
  if (pAt === null) return { s, p: null, pSnrTried: null }
  const pSnr = onsetSnr(w.vertical, pAt, Math.round(cfg.snrBeforeSec * fs), Math.round(cfg.snrAfterSec * fs))
  const p = pSnr !== null && pSnr >= cfg.pMinSnr ? { atMs: w.startMs + pAt * w.msPerSample, snr: pSnr } : null
  return { s, p, pSnrTried: pSnr }
}
