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
// **収録年を広げるときは書式を数え直すこと。** 仕様には「震源を固定した場合は小数点以下が空白」
// という書き方があり、秒・緯度分・経度分の下 2 桁だけが空くと、いまの実装は 2 桁小さい値を返す
// （`35  ` を 0.35 と読む）。2009〜2023 年の全 J レコード（約 320 万行）では 0 件だが、
// 1982 年以前には震源を固定した決定が実在しうる。

/** 1 レコードの長さ（改行を含まない）。 */
export const RECORD_LENGTH = 96

/** カタログの時刻は日本時間。UTC へ直すのに引く量。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

export interface HypocenterRecord {
  /** 発生時刻（UTC epoch ミリ秒）。 */
  timeMs: number
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
  // 秒は 1/100 秒までの 4 桁。**ミリ秒として足し込む** —— 秒へ丸めてから組み立てると
  // 59.6 秒が 60 秒になって分が繰り上がらない。
  const sec100 = Number(line.slice(13, 17))
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(sec100)) return null

  // **`Date.UTC` で組み立ててから JST 分を引く。** ローカル時刻で組み立てると、実行環境の
  // タイムゾーンで結果が変わる（CI は UTC で回る）。
  const timeMs = Date.UTC(year, month - 1, day, hour, minute, 0) - JST_OFFSET_MS + sec100 * 10
  if (!Number.isFinite(timeMs)) return null

  const lat = parseDegMin(line.slice(21, 24), line.slice(24, 28))
  const lng = parseDegMin(line.slice(32, 36), line.slice(36, 40))
  if (lat == null || lng == null) return null

  const depth = parseDepth(line.slice(44, 49))
  if (depth == null) return null

  return {
    timeMs,
    lat,
    lng,
    depth,
    magnitude: parseMagnitude(line.slice(52, 54)),
    kind: line.slice(0, 1),
    quality: line.slice(95, 96),
  }
}

/**
 * 度分形式（度の整数 ＋ 1/100 分）を度へ直す。
 *
 * **分は度の符号に従う。** 南緯・西経では度が負で入るため、そのまま足すと符号が食い違う。
 */
function parseDegMin(degText: string, minText: string): number | null {
  // **符号と数字の間が空く書き方がある。** 海外の震源（`U` レコード）では南緯・西経が
  // `- 7` のように書かれ、そのまま `Number` に渡すと NaN になる。空白を落としてから読む。
  const deg = Number(degText.replace(/\s+/g, ''))
  const min100 = Number(minText)
  if (!Number.isFinite(deg) || degText.trim() === '') return null
  // 分は欠測しうる（震源を固定して決めた場合に空白になる）。その場合は度だけで表す。
  const min = minText.trim() === '' ? 0 : min100 / 100
  if (!Number.isFinite(min)) return null
  // **`-0` を負として扱う。** `Number('-0')` は `-0` になり `-0 < 0` は false なので、素朴に
  // 比較すると「南緯 0 度 30 分」が北緯へ反転する。現行の収録範囲（気象庁が決定した震源のみ・
  // 日本域）では起きないが、`J` 以外へ広げたときに踏む。
  const negative = deg < 0 || Object.is(deg, -0)
  return deg + (negative ? -min : min) / 60
}

/**
 * 深さを読む。**2 つの書き方がある。**
 *
 * 通常は 1/100 km 単位の 5 桁。震源決定で深さを固定した場合は整数 km の 3 桁（右詰め）になり、
 * 残り 2 桁が空白になる。後ろ 2 桁が空白かどうかで見分ける。
 */
function parseDepth(text: string): number | null {
  if (text.trim() === '') return null
  const fixed = text.slice(3).trim() === ''
  const value = fixed ? Number(text.slice(0, 3)) : Number(text) / 100
  return Number.isFinite(value) ? value : null
}

/** M は暗黙の小数点を持つ（`45` = 4.5）。数字で書かれていないものは読まない。 */
function parseMagnitude(text: string): number | null {
  if (!/^\s*-?\d+$/.test(text)) return null
  const value = Number(text) / 10
  return Number.isFinite(value) ? value : null
}
