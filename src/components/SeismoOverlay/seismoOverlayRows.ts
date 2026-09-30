// 自作地震計の観測点の姿（`hooks/useSeismoStation.ts`）を、地図へ重ねる 1 行へ直す。
//
// **出どころを必ず添える。** 震度の出どころは 2 つあって
// （観測点の合成／センサー単独の最大）、値の性質が違う ——
// 2026-09-29 の実機の実測で、合成が届く前の 1 コマは単独の 1.26、届いた後は
// 合成の 0.19 と **6 倍** 開いた。無印で並べると、利用者にはどちらも同じ「震度」に見える。

import type { SeismoStationState } from '../../hooks/useSeismoStation'
import { intensityGradeColor, measuredIntensityToGrade } from '../../utils/measuredIntensity'

export interface SeismoOverlayRow {
  readonly stationId: string
  readonly displayName: string
  /** 震度階級のラベル（0〜7）。**震度を出せていなければ `null`。** */
  readonly gradeLabel: string | null
  /** 階級バッジの背景色。`gradeLabel` が `null` なら `null`。 */
  readonly gradeColor: string | null
  /**
   * 計測震度（小数 1 桁）。**出せていなければ `null`。**
   *
   * **桁は気象庁の公表に合わせる**（計測震度は小数第 1 位まで）。静穏時は負の値も出る。
   */
  readonly valueText: string | null
  /** その震度をどこから採ったか。 */
  readonly sourceText: string
}

/**
 * 計測震度を小数 1 桁の文字列にする。**マイナスゼロを出さない。**
 *
 * 静穏時のホストは `-0.04` のようなわずかな負の値をよく返すが、`toFixed` は符号を
 * 保つので `"-0.0"` になる。**あの見た目は表示が壊れたようにしか見えない** ——
 * この帯は「地震計が生きている」ことを示すのが主な役目なので、いちばん
 * 起こしたくない誤解になる。
 */
function formatMeasured(value: number): string {
  const rounded = Number(value.toFixed(1))
  return (rounded === 0 ? 0 : rounded).toFixed(1)
}

/**
 * 震度の出どころを 1 語で表す。
 *
 * @param hasValue その観測点の震度を出せているか。**出せていないときは「最大」と
 *   名乗らない** —— 選ぶ相手がいないのに最大と書くと、震度欄の `—` と食い違って
 *   見える（センサーは届いているが震度がまだ出せない起動直後に起きる）。
 */
function sourceText(source: SeismoStationState['source'], hasValue: boolean): string {
  if (source.kind === 'station') {
    // **本数は添えられない。** 合成の押し出し（`station-reading`）が名乗るのは
    // 観測点・時刻・震度の 3 つだけで、何本から作った値かをホストが持っていない
    // （`seismo-host/src/receiver/sensorFusion.ts` の `StationIntensityReading`）。
    return '合成'
  }
  // **1 本しか無いことは言い切る。** 「単独 1本の最大」は最大と呼べる相手がいない。
  if (source.sensorCount <= 1) return '単独（裏付けなし）'
  return hasValue ? `単独 ${source.sensorCount}本の最大` : `単独 ${source.sensorCount}本`
}

/**
 * 観測点の姿を、地図へ重ねる行へ直す。**並びは渡された順のまま**
 * （表示名の順に揃えるのは `useSeismoStation` の仕事）。
 */
export function seismoOverlayRows(
  stations: readonly SeismoStationState[],
): readonly SeismoOverlayRow[] {
  return stations.map((station) => {
    const grade = station.intensity === null ? null : measuredIntensityToGrade(station.intensity)
    return {
      stationId: station.stationId,
      displayName: station.displayName,
      gradeLabel: grade?.label ?? null,
      gradeColor: grade === null ? null : intensityGradeColor(grade),
      // **階級を引けなかった値は数字も出さない。** 非有限の値をそのまま
      // 「計測震度」として見せると、壊れていることが読み取れない
      // （`measuredIntensityToGrade` が `null` を返すのはその場合だけ）。
      valueText:
        grade === null || station.intensity === null ? null : formatMeasured(station.intensity),
      sourceText: sourceText(station.source, grade !== null),
    }
  })
}
