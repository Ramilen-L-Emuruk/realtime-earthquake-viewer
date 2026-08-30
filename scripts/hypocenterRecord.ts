// 気象庁「地震月報（カタログ編）」の震源レコードを読む。
//
// 生成スクリプト（`build-hypocenter-catalog.ts`）から使う純関数。ここに切り出しているのは
// **カラム位置を 1 バイト間違えるだけで全件が静かに壊れる**ため。テストで固定できる形にしておく。
//
// フォーマット: https://www.data.jma.go.jp/eqev/data/bulletin/data/format/hypfmt_j.html
//
// **仕様書は「96 Byte 固定長」と書いているが、実ファイルは各レコードが改行で終わる。**
// 96 バイトずつ切り出すと 1 バイトずつずれていくので、必ず改行で分割してから渡すこと
// （分割後は全行きっちり 96 文字になる）。
//
// **数値欄は「整数部＋小数部」で、小数部が空白のぶんだけ桁が減る。**
// 桁が 1 つ少ない年は緯度分を `474 `（= 47.4 分）と書く。空白を無視して `474 / 100` と読むと
// 4.74 分になり、**緯度が 78km ずれる**。
// **どの年がそうかは年の範囲で区切れない**（年の途中で切り替わる年もある）ため、年で判定せず
// 必ず `parseTrailingBlankDecimal` を通すこと。書式の詳細は
// `docs/spec/data-sources-spec.md` §6「長期震源カタログ」。

/** 1 レコードの長さ（改行を含まない）。 */
export const RECORD_LENGTH = 96

/** カタログの時刻は日本時間。UTC へ直すのに引く量。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

export interface HypocenterRecord {
  /** 発生時刻（UTC epoch ミリ秒）。 */
  timeMs: number
  /**
   * 秒欄が空白だったか。この場合 `timeMs` は分までしか意味を持たない（秒は 0 で埋める）。
   *
   * 1919〜1950 年に 18 件ある。件数が少ないので捨てずに採るが、**黙って 0 秒にはしない**
   * ——呼び出し側が件数を数えて出せるようにする。
   */
  secondUnknown: boolean
  /** 緯度（度）。南緯は負。 */
  lat: number
  /** 経度（度）。西経は負。 */
  lng: number
  /** 深さ (km)。 */
  depth: number
  /**
   * マグニチュード。読めないときは `null`。
   *
   * 負の M（-0.1〜-3.0）は `A0`〜`C0` のような符号化で表されるが、ここでは読まずに `null` に
   * 倒す。この生成が採るのは M2.0 以上で、符号化されるのはそれよりはるかに小さい地震だけのため。
   */
  magnitude: number | null
  /** レコード種別（`J` = 気象庁が決定した震源）。 */
  kind: string
  /**
   * 最大震度の生コード。無感（空白）は `null`。
   *
   * **震度の値と、震度ではない分類が同じ欄に混在する。** 気象庁の
   * [フォーマット仕様](https://www.data.jma.go.jp/eqev/data/bulletin/data/format/hypfmt_j.html)より、
   * 括弧内は 1919〜2023 年の実測件数。
   *
   * | コード | 意味 | 年代 | 件数 |
   * |---|---|---|---|
   * | `1`〜`4`・`7` | 震度 1〜4・7 | 通期 | 102,518 |
   * | `5`・`6` | 震度 5・6（弱強の区分が無い時代） | 1996 年 9 月まで | 199 |
   * | `A`〜`D` | 震度 5 弱・5 強・6 弱・6 強 | 1996 年 10 月以降 | 366 |
   * | `F` | **有感地震**（震度の値ではない） | 1984 年まで | 4,639 |
   * | `X` | **付近有感**（同上） | 1996 年 9 月まで | 1,963 |
   * | `L`・`S`・`M`・`R` | **最大有感距離による顕著度**（局発 / 小局発 / やや顕著 / 顕著。震度ではない） | 1977 年まで | 588 |
   *
   * **数値へ寄せず生のまま持つ。** `L`〜`R` は震度スケール上の値ですらないので、数値相当に
   * 潰すと「震度別集計」が壊れる。**将来この列で震度別の集計を作るなら、数値へ写せるのは
   * `1`〜`7`・`A`〜`D` だけ**であることを必ず確かめること。
   * 「有感かどうか」だけが必要なら `null` でないことを見ればよい（どのコードも有感を意味する）。
   */
  intensity: string | null
  /**
   * 震源決定フラグ。`K` が手動検測、`A` が自動処理。
   *
   * M2.0 以上に絞ると `K` が約 8 割を占める（2023 年の実測で 20,194/25,823）。全体では自動処理が
   * 過半数だが、大きい地震は人が検測するため、絞った後の品質は高い。
   *
   * **生成物にはまだ含めていない。** 「手動検測だけで b 値を出す」といった選別が要るように
   * なったら、`build-hypocenter-catalog.ts` の `YearCatalog` に列を足すこと（ここで読めている
   * ので、足すのは出力側だけで済む）。
   */
  quality: string
}

/**
 * 1 行を読む。読めない行（長さ不足・必須項目の欠測）は `null` を返す。
 *
 * 必須は時刻・緯度・経度・深さ。M は欠測しうるので `null` を許す（呼び出し側が閾値で弾く）。
 */
export function parseHypocenterRecord(line: string): HypocenterRecord | null {
  if (line.length < RECORD_LENGTH) return null

  const year = Number(line.slice(1, 5))
  const month = Number(line.slice(5, 7))
  const day = Number(line.slice(7, 9))
  const hour = Number(line.slice(9, 11))
  const minute = Number(line.slice(11, 13))
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null

  // 秒は「整数 2 桁 ＋ 小数部」。桁が 1 つ少ない年は小数 1 桁（`031 ` = 3.1 秒）。
  const secText = line.slice(13, 17)
  const secondUnknown = secText.trim() === ''
  const sec = secondUnknown ? 0 : parseTrailingBlankDecimal(secText, 2)
  if (sec == null) return null

  // **`Date.UTC` で組み立ててから JST 分を引く。** ローカル時刻で組み立てると、実行環境の
  // タイムゾーンで結果が変わる（CI は UTC で回る）。
  // 秒はミリ秒として足し込む —— 秒へ丸めてから組み立てると 59.6 秒が 60 秒になって分が繰り上がらない。
  const timeMs = Date.UTC(year, month - 1, day, hour, minute, 0) - JST_OFFSET_MS + Math.round(sec * 1000)
  if (!Number.isFinite(timeMs)) return null

  const lat = parseDegMin(line.slice(21, 24), line.slice(24, 28))
  const lng = parseDegMin(line.slice(32, 36), line.slice(36, 40))
  if (lat == null || lng == null) return null

  // 深さは「整数 3 桁 ＋ 小数部」。固定深さは小数部が空白になる（` 50  ` = 50km）。
  const depth = parseTrailingBlankDecimal(line.slice(44, 49), 3)
  if (depth == null) return null

  const intensityText = line.slice(61, 62)

  return {
    timeMs,
    secondUnknown,
    lat,
    lng,
    depth,
    magnitude: parseMagnitude(line.slice(52, 54)),
    kind: line.slice(0, 1),
    intensity: intensityText.trim() === '' ? null : intensityText,
    quality: line.slice(95, 96),
  }
}

/**
 * 「整数部（右詰め）＋ 小数部（左詰め・空白埋め）」の数値欄を読む。
 *
 * **深さ欄には仕様外の形が実在し、読めずに `null` を返す。** 整数部が空白なのに小数部に
 * 数字がある形（`   0 ` `   7 ` 等・1958〜1987 年に 72 件。最多は 1967 年の 29 件で大半が
 * 松代群発地震）と、小数部の途中に空白が挟まる形（`  0 4`・2016 年の熊本の余震に 18 件）。
 * **値を推測しない** —— 前者は 0〜9 のすべてが現れるため「0km の別表記」ではなく桁の解釈が
 * 変わっており、0.7km と 7km のどちらなのかがデータからは決まらない。標準誤差も 39・50 と
 * 異常で、M 欄が空の記録が多い。生成側はこれを理由ごとに数えて閾値で監視する
 * （`build-hypocenter-catalog.ts` の `UNREADABLE_DEPTH_WARN_RATIO`）。
 *
 * 秒・緯度分・経度分・深さがこの形。**小数部の桁数が年代で変わる**ため、桁数を決め打つと
 * 片方の年代で 10 倍ずれた値を黙って返す。空白を落としてから、残った桁数で割ること。
 *
 * ```
 * ('1251', 2) → 12.51    ('474 ', 2) → 47.4    ('47  ', 2) → 47
 * (' 2374', 3) → 23.74   (' 227 ', 3) → 22.7   (' 50  ', 3) → 50
 * ```
 *
 * @param text 欄の全体（整数部＋小数部）
 * @param intDigits 整数部の桁数。秒・緯度分・経度分は 2、深さは 3
 * @returns 値。整数部が空白なら `null`。数字の間に空白が挟まる等の異常も `null`
 */
export function parseTrailingBlankDecimal(text: string, intDigits: number): number | null {
  const intText = text.slice(0, intDigits)
  if (intText.trim() === '') return null
  // 整数部は右詰め（`  0` ` 22` `123`）。前後の空白を落として読む。
  if (!/^ *\d+ *$/.test(intText)) return null
  const int = Number(intText.trim())
  // **小数部は末尾の空白を落としてから桁数で割る。** `7 ` は 0.7 であって 0.07 ではない。
  const frac = text.slice(intDigits).replace(/ +$/, '')
  if (frac === '') return int
  if (!/^\d+$/.test(frac)) return null
  return int + Number(frac) / 10 ** frac.length
}

/**
 * 度分形式（度の整数 ＋ 分）を度へ直す。
 *
 * **分は度の符号に従う。** 南緯・西経では度が負で入るため、そのまま足すと符号が食い違う。
 */
function parseDegMin(degText: string, minText: string): number | null {
  // **符号と数字の間が空く書き方がある。** 海外の震源（`U` レコード）では南緯・西経が
  // `- 7` のように書かれ、そのまま `Number` に渡すと NaN になる。空白を落としてから読む。
  const deg = Number(degText.replace(/\s+/g, ''))
  if (!Number.isFinite(deg) || degText.trim() === '') return null
  // **`-0` を負として扱う。** `Number('-0')` は `-0` になり `-0 < 0` は false なので、素朴に
  // 比較すると「南緯 0 度 30 分」が北緯へ反転する。現行の収録範囲（気象庁が決定した震源のみ・
  // 日本域）では起きないが、`J` 以外へ広げたときに踏む。
  const negative = deg < 0 || Object.is(deg, -0)
  // 分は全欠しうる（震源を固定して決めた場合）。その場合は度だけで表す。
  if (minText.trim() === '') return deg
  const min = parseTrailingBlankDecimal(minText, 2)
  if (min == null) return null
  return deg + (negative ? -min : min) / 60
}

/** M は暗黙の小数点を持つ（`45` = 4.5）。数字で書かれていないものは読まない。 */
function parseMagnitude(text: string): number | null {
  if (!/^\s*-?\d+$/.test(text)) return null
  const value = Number(text) / 10
  return Number.isFinite(value) ? value : null
}
