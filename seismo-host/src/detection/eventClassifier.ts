// 切り出した揺れの区間が「地震らしいか」を、揺れ方の特徴から決める（REQUIREMENTS.md §6）。
//
// **これは最終判定ではない。** 地震だと確定させるのは気象庁の地震情報との照合（`quakeMatch.ts`）
// で、ここが決めるのは照合できなかった揺れの扱いだけ ——「地震かもしれない揺れ」と
// 「生活振動らしい揺れ」のどちらとして残すか。外れても、照合で確定する地震には響かない。
//
// **枠は実機の記録から置いた**（2026-09-28〜10-03・自宅の観測点）。気象庁の地震と一致した
// 6 件（M2.8〜3.5）の揺れ方を囲み、少し余裕を持たせた。この枠で一致しなかった
// 90 件のうち 72 件が外へ出る（お掃除ロボット・基板を手で動かした揺れ・上下動や細かい揺れの
// 多いもの）。**近い地震・大きな地震の揺れ方はまだ確かめていない** —— 低い周波数が増えて
// 枠の外へ出うる。そういう地震は気象庁の地震情報が必ず出るので、照合の側で拾える。
//
// **比はすべて「基準の帯（5〜10 Hz）の水平動」に対する比。** 基準の帯は枠が自分で持つ
// （`referenceBandHz`）—— 枠はこの帯を基準に実機の記録から置いたので、引き金の帯を変えても
// 枠の意味は変わらない。振幅そのものは見ない ——
// 地震の大きさや距離で桁が変わるうえ、強い地震ほど大きいので、大きさで生活振動を弾くと
// いちばん大事な揺れを落とす。
//
// 機械学習の分類器へ替えるときは、この関数と同じ形（区間 → 分類）で差し替える（§6）。

import { featureBandIndex } from './quakeTrigger'
import type { TriggerEvent } from './quakeTrigger'

/** 揺れ方の分類。 */
export type ShakeClass =
  /** 揺れ方が地震の枠に収まる（照合できていなければ「地震かもしれない揺れ」）。 */
  | 'quake-like'
  /** 枠の外（生活振動らしい揺れ）。 */
  | 'local-like'

/** 基準の帯の水平動に対する比の枠。 */
export interface ShakeEnvelope {
  /** 比の基準にする帯（Hz）。`FEATURE_BANDS` のどれかでなければならない。 */
  readonly referenceBandHz: readonly [number, number]
  /** 上下動（基準の帯）÷ 水平動（基準の帯）の下限・上限。 */
  readonly verticalRatio: readonly [number, number]
  /** 水平動の各帯域 ÷ 水平動（基準の帯）の上限。`FEATURE_BANDS` の並びで、基準の帯は null。 */
  readonly bandRatioMax: readonly (number | null)[]
}

export const SHAKE_ENVELOPE_DEFAULT: ShakeEnvelope = {
  referenceBandHz: [5, 10],
  verticalRatio: [0.3, 0.65],
  // 0.5–2 / 2–5 / 5–10（基準の帯）/ 10–20 / 20–45 Hz
  bandRatioMax: [0.4, 0.6, null, 0.8, 0.7],
}

/** 区間の揺れ方の比（記録に残す特徴量）。 */
export interface ShakeRatios {
  readonly verticalRatio: number
  /** 水平動の各帯域 ÷ 基準の帯。`FEATURE_BANDS` の並び。 */
  readonly bandRatios: readonly number[]
}

/**
 * 基準の帯 `referenceBandHz` に対する比。基準の帯が 0・非有限、または特徴量の帯に無ければ null。
 */
export function shakeRatios(
  event: Pick<TriggerEvent, 'bandRmsH' | 'bandRmsZ'>,
  referenceBandHz: readonly [number, number] = SHAKE_ENVELOPE_DEFAULT.referenceBandHz,
): ShakeRatios | null {
  const at = featureBandIndex(referenceBandHz)
  if (at < 0) return null
  const ref = event.bandRmsH[at]
  if (!(ref > 0) || !Number.isFinite(ref)) return null
  return {
    verticalRatio: event.bandRmsZ[at] / ref,
    bandRatios: event.bandRmsH.map((v) => v / ref),
  }
}

/**
 * 揺れ方を枠に当てる。比を出せない（基準の帯が 0・非有限）なら `local-like` に倒す ——
 * 基準の帯で揺れていない区間は、地震の S 波が集まる帯で揺れていないので地震らしいとは言えない。
 */
export function classifyShake(
  event: Pick<TriggerEvent, 'bandRmsH' | 'bandRmsZ'>,
  envelope: ShakeEnvelope = SHAKE_ENVELOPE_DEFAULT,
): ShakeClass {
  const r = shakeRatios(event, envelope.referenceBandHz)
  if (r === null) return 'local-like'
  const [vLo, vHi] = envelope.verticalRatio
  if (!(r.verticalRatio >= vLo && r.verticalRatio <= vHi)) return 'local-like'
  for (let i = 0; i < r.bandRatios.length; i++) {
    const max = envelope.bandRatioMax[i]
    if (max === null || max === undefined) continue
    if (!(r.bandRatios[i] <= max)) return 'local-like'
  }
  return 'quake-like'
}
