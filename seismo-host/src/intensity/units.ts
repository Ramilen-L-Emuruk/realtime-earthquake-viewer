// センサーが名乗る生のカウント値を、計測震度の計算が使う単位へ直す。
//
// **桁を 1 つ間違えても、出てくる数字はそれらしい形をしている。** 1000 倍すれば震度が
// 6 上がるだけで、例外も警告も出ない。実際、桁の狂った値を計算核へ通すと
// 「計測震度 304」のような、形だけは正しい答えが返る（`intensityStream.test.ts`）。
// だからここだけを関数にして名前を付け、既知の値で固定する。

import type { SensorPacket } from '../protocol/types'

/** 標準重力加速度。1 g = 980.665 gal（cm/s²）。 */
export const GAL_PER_G = 980.665

/**
 * 換算に要る、**センサー自身が名乗る値**。`SensorPacket` がどちらも持っている。
 *
 * 型番から引かない —— 換算の根拠は送り手が持っている事実で、レンジを変えた基板を
 * 後から読むときに食い違う。
 */
export type SampleScale = Pick<SensorPacket, 'ugPerLsb' | 'fullScaleG'>

/**
 * フルスケールをどれだけ超えるまで許すか。
 *
 * **名乗る分解能は丸めた値。** MPU6050 の ±2g は 2/32768 g = 61.03515625 µg/LSB だけれど、
 * 送り手は 61.0352 と名乗る。目盛りの端はそのぶんフルスケールをわずかに超える。
 * 捕まえたいのは**桁の取り違え**なので、余裕を持たせても効き目は落ちない
 * （10 倍の誤りでもこの倍率には遠く及ばない）。
 */
const FULL_SCALE_TOLERANCE = 1.05

/**
 * カウント値を gal へ直す。**範囲の外なら `null`。**
 *
 * `ugPerLsb` は 1 カウントあたりの µg。センサーの中の値はフルスケールで頭打ちになるので、
 * **換算した結果がそこを超えるなら、桁のどこかが狂っている**（名乗る分解能が違う・
 * ヘッダが壊れている）。通せば、静止している基板が強い揺れとして出る。
 *
 * **`null` が 1 件でも出たら、そのパケットごと捨てること。** 疑わしいのは 1 つの値では
 * なくヘッダが名乗る倍率なので、残りの軸も同じだけ狂っている。軸ごとに間引くと
 * 3 成分の長さが食い違い、時刻の合わない値どうしを合成することになる。
 *
 * **落とした件数を数えるのは呼び出し側の仕事。** ここは 1 件ごとに答えを返すだけで、
 * 集計は持たない（`../protocol/parsePacket.ts` と同じ分担）。
 */
export function galFromCounts(counts: number, scale: SampleScale): number | null {
  if (!Number.isFinite(counts)) return null
  if (!(scale.ugPerLsb > 0) || !Number.isFinite(scale.ugPerLsb)) return null
  if (!(scale.fullScaleG > 0) || !Number.isFinite(scale.fullScaleG)) return null
  const gal = counts * scale.ugPerLsb * 1e-6 * GAL_PER_G
  if (Math.abs(gal) > scale.fullScaleG * GAL_PER_G * FULL_SCALE_TOLERANCE) return null
  return gal
}
