// 長期震源カタログの格納単位と、その単位で元データを表せるかの検査。
//
// 生成（build-hypocenter-catalog.ts）と、その回帰テストの両方から使う。**単位はここが単一情報源。**
//
// 【なぜ検査が要るか】格納は `Math.round(値 × 単位)` で行う。単位が元データの刻みと噛み合って
// いなければ、例外も NaN も出さずに丸めた値を書き続ける。**「読めない行」としては現れない**ので、
// 突き合わせて数えるしかない。実際に、緯度経度を 1/10000 度・深さを 0.1km・時刻を 1 秒で
// 格納していた期間があり（元データはそれぞれ 0.01 分・0.01km・0.01 秒）、誰も気づいていなかった。

// 【単位は「最も細かい箇所」に合わせる】数値欄の小数部の桁数は取得元と年代で変わる。確定値は
// 年代によって秒・緯度経度の分・深さの桁数が異なり（年の途中で変わることもある）、日別ページ
// 由来の年は深さが整数 km になる。粗い側に合わせると細かい箇所の値が丸められるので、
// **最も細かい刻みを表せる単位**を採る（粗い箇所の値も同じ格子に乗るため、どの年も丸めずに
// 格納できる）。

/**
 * 座標の格納単位。1/6000 度 ＝ 0.01 分。
 *
 * **元データの刻みにそのまま乗る値を選ぶ。** 緯度経度は「度 ＋ 分」で書かれており
 * （`hypocenterRecord.ts` の `parseDegMin`）、分は細かい箇所で小数 2 桁 ＝ 0.01 分まで持つ。
 * 度へ直すと 1/6000 度の整数倍になる。10 進で切ると（1/10000 度など）格子が噛み合わず、
 * **3 件に 2 件で丸め誤差が乗る**（1/6000 度の値が 1/10000 度に乗るのは 3 の倍数のときだけ。
 * データによらず決まる比率で、ずれは最大 1/30000 度 ≒ 3.7m）。
 * 基準は「決定精度より細かいこと」ではなく「元データの値を復元できること」。
 */
export const COORD_SCALE = 6000

/** 深さの格納単位。0.01km。深さ欄は細かい年で小数 2 桁まで持つ。 */
export const DEPTH_SCALE = 100

/** M の格納単位。M 欄はどの年も 0.1 刻み。 */
export const MAG_SCALE = 10

/** 時刻の格納単位。1/100 秒。秒欄は細かい年で小数 2 桁まで持つ。 */
export const TIME_SCALE = 100

/**
 * 格納単位の格子から外れたと判断するずれ（`値 × 単位` を整数と比べたときの差）。
 *
 * **2 進小数の誤差ぶんだけを許す。** 元データの分は `度 + 分 / 60` の割り算を経るため、
 * 格子に乗る値でも下位桁に 1e-10 程度の誤差が残る（実測の最大）。一方で丸めが起きるときの
 * ずれは 0.1 以上あるので、この幅で両者は明確に分かれる。
 */
const SCALE_FIT_EPSILON = 1e-6

/** 値が格納単位の格子に乗るか（＝丸めずに整数へ写せるか）。 */
export function fitsScale(value: number, scale: number): boolean {
  const scaled = value * scale
  return Math.abs(scaled - Math.round(scaled)) < SCALE_FIT_EPSILON
}

/** 検査に必要な項目だけ。取得経路ごとのレコード型はこれを満たす。 */
export interface ScaleCheckTarget {
  /** 発生時刻（UTC epoch ミリ秒）。 */
  timeMs: number
  lat: number
  lng: number
  /** 深さ (km)。 */
  depth: number
  /** M。読めなかった行は null で、その場合 M は検査しない。 */
  magnitude: number | null
}

/**
 * 取得元の値が格納単位で表せるかを数える。**件数 0 を保つのが正常。**
 *
 * **M で絞る前の全件を渡すこと。** 採用しなかった行の形式変更も、閾値を下げたときに効いてくる。
 */
export function countUnrepresentable(
  records: readonly ScaleCheckTarget[],
): { count: number; example: string | null } {
  let count = 0
  let example: string | null = null
  for (const r of records) {
    const reasons: string[] = []
    // 時刻はミリ秒の整数なので、割り切れるかを整数のまま見る。年の起点（1 月 1 日 00:00 JST）は
    // ミリ秒が 0 なので、起点を引く前の値で判定しても結果は変わらない。
    if ((r.timeMs * TIME_SCALE) % 1000 !== 0) reasons.push(`時刻 ${new Date(r.timeMs).toISOString()}`)
    if (!fitsScale(r.lat, COORD_SCALE)) reasons.push(`緯度 ${r.lat}`)
    if (!fitsScale(r.lng, COORD_SCALE)) reasons.push(`経度 ${r.lng}`)
    if (!fitsScale(r.depth, DEPTH_SCALE)) reasons.push(`深さ ${r.depth}`)
    if (r.magnitude != null && !fitsScale(r.magnitude, MAG_SCALE)) reasons.push(`M ${r.magnitude}`)
    if (reasons.length === 0) continue
    count++
    example ??= reasons.join(' / ')
  }
  return { count, example }
}

/** 年ファイルが持つ格納単位。読み戻して検査するときの形（値の型は信用しない）。 */
export interface StoredScales {
  coordScale?: unknown
  depthScale?: unknown
  magScale?: unknown
  timeScale?: unknown
}

/**
 * 年ファイルの格納単位が今の定数と食い違っていないかを見る。食い違う項目の説明を返し、
 * 揃っていれば `null`。
 *
 * **欠落だけでなく値の一致まで見る。** 欠落を弾くだけでは、次に単位を 1 つだけ変えたとき
 * （座標だけ細かくする等）に同じ穴がまた開く。
 *
 * 用途は生成スクリプトの索引復元。**読み取り側（ブラウザ）はこの検査を使わない** ——
 * 年ファイル自身が持つ単位をそのまま信じて読む設計なので、年ごとに単位が違っても読めてしまう。
 * 「作り直し忘れた年」を捕まえられるのは生成のときだけ。
 */
export function findScaleMismatch(stored: StoredScales): string | null {
  const checks: readonly [keyof StoredScales, number][] = [
    ['coordScale', COORD_SCALE],
    ['depthScale', DEPTH_SCALE],
    ['magScale', MAG_SCALE],
    ['timeScale', TIME_SCALE],
  ]
  for (const [key, want] of checks) {
    const got = stored[key]
    if (got !== want) return `${key} は ${String(got)}（今の単位は ${want}）`
  }
  return null
}
