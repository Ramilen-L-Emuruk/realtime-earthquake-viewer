// 太陽高度から夜の濃さを引く。
//
// 夜の側は「日の入りから天文薄明の下限まで、だんだん濃くなる」ものとして描く。その濃さを
// **高度から直接引く**のがこのファイルの役目で、段に刻んだり面を作ったりはしない
// （太陽の位置は utils/solarPosition.ts、描く側は components/Map/gl/dayNightLayer.ts）。
//
// **同じ式を JS と GLSL の両方で使う。** 濃さは画面のフラグメントごとに GPU が計算するが、
// 検証（実際の画素と理論値の突き合わせ）とテストには JS 側が要る。二重に書くと片方だけ古く
// なるため、**GLSL の断片はここの定数から組み立てる**（{@link shadingDepthGlsl}）。

/**
 * 日の入り・日の出の太陽高度（度）。
 *
 * 太陽の中心が地平線と同じ高さになる 0° ではなく、大気差（約 0.57°）と太陽の視半径（約 0.27°）の
 * ぶん沈んだところが、実際に太陽が見えなくなる高さ。暦の日の入り時刻もこの定義で決まる。
 */
export const SUNSET_ALTITUDE = -0.833

/**
 * 夜が深まりきる太陽高度（度）。天文薄明の下限で、これより下では太陽光が空の明るさに寄与しない。
 * これより深いところは一様な濃さになる。
 */
export const NIGHT_ALTITUDE = -18

/**
 * 薄明の明るさ。太陽高度（度）と、そのときの屋外の明るさ（常用対数を取った照度・lux）の対応。
 *
 * 空は日の入りから一様に暗くなるのではなく、**最初の数度で大半が暗くなる**。日の入りから
 * 天文薄明の終わりまでで照度は 100 万分の 1 ほどまで落ち、その落ち方は高度に対して直線ではない。
 * 濃さをこの曲線に沿って引くことで、変わり方が実際の暗くなり方に近づく。
 *
 * 値は薄明の各段階で一般に挙げられる概数（日の入り 約 400 lux／市民薄明の終わり 約 3.4 lux／
 * 航海薄明の終わり 約 0.008 lux／天文薄明の終わり 約 0.0006 lux）。
 *
 * **高度の降順（明るい順）に並べること。** 下の補間と GLSL の生成がこの順序を前提にしている。
 */
const TWILIGHT_LUMINANCE: ReadonlyArray<{ altitude: number; logLux: number }> = [
  { altitude: SUNSET_ALTITUDE, logLux: Math.log10(400) },
  { altitude: -6, logLux: Math.log10(3.4) },
  { altitude: -12, logLux: Math.log10(0.008) },
  { altitude: NIGHT_ALTITUDE, logLux: Math.log10(0.0006) },
]

const BRIGHTEST_LOG_LUX = TWILIGHT_LUMINANCE[0].logLux
const DARKEST_LOG_LUX = TWILIGHT_LUMINANCE[TWILIGHT_LUMINANCE.length - 1].logLux

/**
 * 太陽高度（度）での夜の深さ。0 が日の入り（濃さ 0）、1 が天文薄明の下限（濃さが最大）。
 *
 * 明るさ（照度の常用対数）を {@link TWILIGHT_LUMINANCE} の折れ線で引き、日の入りから
 * 天文薄明の下限までの範囲で正規化した値。日の入りより上は 0、天文薄明より下は 1 で頭打ち。
 *
 * **段に刻んでいた頃との関係**: 以前は 32 段の帯に分け、帯ごとに「内側の端の濃さ」を塗って
 * いた。この関数はその段数を無限にした極限にあたる（帯の内側では一致し、帯の中では最大で
 * 1 段のさらに半分ぶん薄くなる。8bit へ丸めると差は現れない）。
 */
export function shadingDepth(altitudeDeg: number): number {
  if (!Number.isFinite(altitudeDeg)) return 0
  let logLux = DARKEST_LOG_LUX
  if (altitudeDeg >= TWILIGHT_LUMINANCE[0].altitude) {
    logLux = BRIGHTEST_LOG_LUX
  } else {
    for (let i = 1; i < TWILIGHT_LUMINANCE.length; i++) {
      const upper = TWILIGHT_LUMINANCE[i - 1]
      const lower = TWILIGHT_LUMINANCE[i]
      if (altitudeDeg >= lower.altitude) {
        const ratio = (upper.altitude - altitudeDeg) / (upper.altitude - lower.altitude)
        logLux = upper.logLux + (lower.logLux - upper.logLux) * ratio
        break
      }
    }
  }
  const depth = (BRIGHTEST_LOG_LUX - logLux) / (BRIGHTEST_LOG_LUX - DARKEST_LOG_LUX)
  return Math.min(1, Math.max(0, depth))
}

/**
 * 太陽高度（度）での夜の濃さ（不透明度）。
 *
 * @param nightOpacity 夜が深まりきったところの濃さ（設定「夜側の濃さ」）。
 *
 * 深さに対して指数で効かせる。段を重ねて濃くしていた頃と同じ濃さの付き方にするためで、
 * **最深部がちょうど `nightOpacity` になる**。
 */
export function nightOpacityAt(altitudeDeg: number, nightOpacity: number): number {
  return 1 - Math.pow(1 - nightOpacity, shadingDepth(altitudeDeg))
}

/** GLSL へ埋め込む数値。桁を落とすと JS 側とずれるため、有効桁を残して書き出す。 */
function glslFloat(value: number): string {
  const text = value.toPrecision(9)
  return text.includes('.') || text.includes('e') ? text : `${text}.0`
}

/**
 * {@link shadingDepth} と同じ式の GLSL 断片。`float shadingDepth(float altitudeDeg)` を定義する。
 *
 * **定数は {@link TWILIGHT_LUMINANCE} から組み立てる。** 表を書き換えたら GLSL 側も自動で
 * 追従するため、値が二重管理にならない。式の構造（折れ線を降順に辿る）だけが両実装に重複する
 * ので、境界と単調性は solarShading.test.ts が JS 側で固定している。
 */
export function shadingDepthGlsl(): string {
  const lines: string[] = []
  lines.push('float shadingDepth(float altitudeDeg) {')
  lines.push(`  float logLux = ${glslFloat(DARKEST_LOG_LUX)};`)
  lines.push(`  if (altitudeDeg >= ${glslFloat(TWILIGHT_LUMINANCE[0].altitude)}) {`)
  lines.push(`    logLux = ${glslFloat(BRIGHTEST_LOG_LUX)};`)
  for (let i = 1; i < TWILIGHT_LUMINANCE.length; i++) {
    const upper = TWILIGHT_LUMINANCE[i - 1]
    const lower = TWILIGHT_LUMINANCE[i]
    lines.push(`  } else if (altitudeDeg >= ${glslFloat(lower.altitude)}) {`)
    lines.push(
      `    logLux = mix(${glslFloat(upper.logLux)}, ${glslFloat(lower.logLux)}, ` +
        `(${glslFloat(upper.altitude)} - altitudeDeg) / ${glslFloat(upper.altitude - lower.altitude)});`,
    )
  }
  lines.push('  }')
  lines.push(
    `  return clamp((${glslFloat(BRIGHTEST_LOG_LUX)} - logLux) / ` +
      `${glslFloat(BRIGHTEST_LOG_LUX - DARKEST_LOG_LUX)}, 0.0, 1.0);`,
  )
  lines.push('}')
  return lines.join('\n')
}
