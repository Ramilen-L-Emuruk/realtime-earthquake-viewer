// 検出した揺れ 1 件の記録（REQUIREMENTS.md §9「イベント情報」）。
//
// §9 の項目との対応:
//   開始時刻 → startMs / 終了時刻 → endMs / P 波推定時刻 → pMs / S 波推定時刻 → sMs /
//   S-P → sMinusPSec / 最大加速度 → peakAccelGal / 最大計測震度相当 → maxIntensity /
//   P 波 SNR → pSnr / 観測したセンサー → sensors / 観測した観測点 → stationId /
//   判定信頼度 → verdict（下記）
//
// **判定信頼度を数値にしない。** 決まりごとの組み合わせで出す判定に「0.73」のような値を
// 付けると、実装が持っていない精度を装うことになる（強震モニタの検知でも同じ判断をした。
// docs/spec/kyoshin-detection-spec.md §8）。代わりに、何を根拠にどこまで言えるかを段で持つ。
//
// **記録は版を重ねる。** 揺れが閉じた時点では気象庁の地震情報はまだ届いていない
// （数分遅れる）。照合の結果が出たら、同じ `id` で `rev` を 1 つ進めた版を作り、
// 保存側（`shakeEventStore.ts`）がその揺れの記録を新しい版へ置き換える。

import type { DetectedShake, PhaseWindowState } from './quakeDetector'
import type { ArrivalWindow } from './quakeMatch'
import type { P2pReferenceQuake } from './p2pQuake'

/**
 * 判定。**上から順に強い。**
 *
 * - `quake` — 気象庁の地震情報と時刻が合った（地震だと言える）
 * - `pending` — 照合を待っている（揺れが閉じてから `MATCH_DEADLINE_MS` まで）
 * - `quake-like` — 照合できなかったが、揺れ方は地震の枠に収まる（地震かもしれない揺れ）
 * - `local-like` — 照合できず、揺れ方も枠の外（生活振動らしい揺れ）
 * - `unchecked` — 照合の期限までの間に地震情報の受信が途切れていて、合わなかったとは言えない
 */
export type ShakeVerdict = 'quake' | 'pending' | 'quake-like' | 'local-like' | 'unchecked'

/** 照合が合った気象庁の地震。 */
export interface MatchedQuake {
  readonly name: string
  readonly originMs: number
  readonly originPrecisionMs: number
  /** 震央（度）。 */
  readonly lat: number
  readonly lon: number
  readonly magnitude: number | null
  readonly depthKm: number | null
  readonly maxScale: number | null
  /** 観測点からの震央距離（km）。 */
  readonly distanceKm: number
}

/** 観測したセンサー 1 本。 */
export interface ShakeSensorRef {
  readonly boardKey: string
  readonly sensorId: string
}

export interface ShakeEventRecord {
  /** `<stationId>-<startMs>`。同じ揺れの版はこの値で束ねる。 */
  readonly id: string
  /** 版。最初の記録が 1、照合の結果を書き足すたびに 1 つ進む。 */
  readonly rev: number
  /** この版を書いた時刻（unix ミリ秒・ホストの時計）。 */
  readonly writtenAtMs: number
  readonly stationId: string
  readonly detectorVersion: number

  readonly startMs: number
  readonly endMs: number
  /** 区間の終わり方（`TriggerEnd`）。`quiet` 以外は長さが切り詰められている。 */
  readonly endReason: string
  /** 拾えなければ null。 */
  readonly sMs: number | null
  readonly sSnr: number | null
  /** 拾えなければ null（MPU6050 では M3 級の P はほぼ拾えない。phasePicker.ts）。 */
  readonly pMs: number | null
  /** P を拾おうとした点の SNR。拾えなかったときも試した値があれば残す。 */
  readonly pSnr: number | null
  readonly sMinusPSec: number | null
  /**
   * P/S を拾う窓をどう扱ったか（`PhaseWindowState`）。`picked` 以外は拾っていない ——
   * S・P が null でも「拾ったが弱かった」のか「窓が途切れていて拾わなかった」のかをここで分ける。
   */
  readonly phaseWindow: PhaseWindowState

  /** 最大加速度（3 成分の合成・gal。直流は合成の段で落としてある）。 */
  readonly peakAccelGal: number
  readonly peakHorizontalGal: number
  /** 区間の中の最大の計測震度相当（観測点の合成から）。届いていなければ null。 */
  readonly maxIntensity: number | null
  /** 引き金の比（平常時の何倍か）の最大と、そのときの平常時の強さ（gal）。 */
  readonly peakRatio: number
  readonly baselineGal: number
  /** 揺れ方の比（`eventClassifier.ts`）。 */
  readonly verticalRatio: number | null
  readonly bandRatios: readonly number[] | null
  readonly shakeClass: 'quake-like' | 'local-like'

  /** 観測点の設定でこの観測点に割り当てられていたセンサー（有効なもの）。 */
  readonly sensors: readonly ShakeSensorRef[]
  /**
   * 基板どうしで揺れ方が揃っているか（空間的な一致。§7・§8）。**いまは見ていない。**
   * 基板が 1 か所にまとまっていると、足音も家じゅうの基板に同じように乗るので
   * 見分けの役に立たない（#311 で基板を散らしてから使う）。見ていないことを値で残す。
   */
  readonly spatialConsistency: 'not-evaluated'

  readonly verdict: ShakeVerdict
  readonly matchedQuake: MatchedQuake | null
}

/** 揺れが閉じた時点の記録（版 1・照合待ち）を作る。 */
export function initialRecord(params: {
  readonly shake: DetectedShake
  readonly stationId: string
  readonly detectorVersion: number
  readonly maxIntensity: number | null
  readonly sensors: readonly ShakeSensorRef[]
  readonly nowMs: number
}): ShakeEventRecord {
  const { shake } = params
  const t = shake.trigger
  const s = shake.phases?.s ?? null
  const p = shake.phases?.p ?? null
  return {
    id: `${params.stationId}-${t.onMs.toFixed(0)}`,
    rev: 1,
    writtenAtMs: params.nowMs,
    stationId: params.stationId,
    detectorVersion: params.detectorVersion,
    startMs: t.onMs,
    endMs: t.offMs,
    endReason: t.end,
    sMs: s?.atMs ?? null,
    sSnr: s?.snr ?? null,
    pMs: p?.atMs ?? null,
    pSnr: p?.snr ?? shake.phases?.pSnrTried ?? null,
    sMinusPSec: s !== null && p !== null ? (s.atMs - p.atMs) / 1000 : null,
    phaseWindow: shake.phaseWindow,
    peakAccelGal: t.peakVectorGal,
    peakHorizontalGal: t.peakHorizontalGal,
    maxIntensity: params.maxIntensity,
    peakRatio: t.peakRatio,
    baselineGal: t.baselineGal,
    verticalRatio: shake.ratios?.verticalRatio ?? null,
    bandRatios: shake.ratios?.bandRatios ?? null,
    shakeClass: shake.shakeClass,
    sensors: params.sensors,
    spatialConsistency: 'not-evaluated',
    verdict: 'pending',
    matchedQuake: null,
  }
}

/** 照合が合った版を作る。 */
export function withMatch(rec: ShakeEventRecord, quake: P2pReferenceQuake, window: ArrivalWindow, nowMs: number): ShakeEventRecord {
  return {
    ...rec,
    rev: rec.rev + 1,
    writtenAtMs: nowMs,
    verdict: 'quake',
    matchedQuake: {
      name: quake.name,
      originMs: quake.originMs,
      originPrecisionMs: quake.originPrecisionMs,
      lat: quake.lat,
      lon: quake.lon,
      magnitude: quake.magnitude,
      depthKm: quake.depthKm,
      maxScale: quake.maxScale,
      distanceKm: window.distanceKm,
    },
  }
}

/**
 * 照合の期限が来た版を作る。地震情報の受信が期限までずっと繋がっていたなら揺れ方で決め、
 * 途切れていたなら `unchecked`（合わなかったとは言えない）。
 */
export function withDeadline(rec: ShakeEventRecord, feedCovered: boolean, nowMs: number): ShakeEventRecord {
  return {
    ...rec,
    rev: rec.rev + 1,
    writtenAtMs: nowMs,
    verdict: feedCovered ? rec.shakeClass : 'unchecked',
  }
}
