// 気象庁「震源リスト」（日別 HTML）の 1 行を読む。
//
// 地震月報（カタログ編）の確定値は公表が遅れるため、直近は日別の「震源リスト」で埋める。
// 収録は 2024-01-01 から 2 日前まで（それより過去は月報カタログ編の担当）。
//
//   https://www.data.jma.go.jp/eqev/data/daily_map/YYYYMMDD.html
//
// **年 ZIP とは読み方が正反対。取り違えると静かに壊れる。**
//
// | | 年 ZIP（`hypocenterRecord.ts`） | 日別 HTML（この file） |
// |---|---|---|
// | 文字コード | latin1 で読む（震央地名が Shift-JIS） | UTF-8 |
// | 切り方 | **バイト**位置の固定幅 | **正規表現**（`°` `'` が多バイト） |
//
// **空白区切りに見えるが、空白では割れない。** 分が 1 桁の座標は `137° 8.0'E` のように
// 中に空白が入るため、`split(/\s+/)` すると列がずれて深さと M を取り違える。
//
// 位置を決め打たず正規表現にしているのは、気象庁が列幅を変えたときに**黙って誤読するより
// 落ちてほしい**ため。スクレイピングした表なので、上流の変更を検知できる形にしておく。
//
// 出典: 気象庁ホームページ（https://www.data.jma.go.jp/eqev/data/daily_map/）
// 気象庁の公共データ利用規約（第 1.0 版）に基づき、加工して作成。

/** カタログの時刻は日本時間。UTC へ直すのに引く量。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/**
 * 1 行の形。実測（2024-01-01 から 2026-08-23 までの 966 日・716,455 行）で
 * 全行が 82 文字・この形に一致し、読めない行は 0 件だった。
 *
 * ```
 * 2024  1  1 16:10 22.5  37°29.7'N 137°16.2'E   16     7.6  石川県能登地方
 * 2026  8 23 00:06 15.2  37°24.0'N 137° 8.0'E    9     0.4  石川県能登地方
 *                                        ↑ 分が 1 桁だと空白が入る
 * ```
 *
 * M 欄の `-` は未決定（966 日の実測で 1 日あたり 5〜165 件）。
 */
const ROW =
  /^(\d{4})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s+(\d+(?:\.\d+)?)\s+(\d+)°\s*(\d+(?:\.\d+)?)'([NS])\s+(\d+)°\s*(\d+(?:\.\d+)?)'([EW])\s+(\d+(?:\.\d+)?)\s+(-|-?\d+(?:\.\d+)?)\s+(.*?)\s*$/

export interface DailyHypocenterRecord {
  /** 発生時刻（UTC epoch ミリ秒）。 */
  timeMs: number
  /** 緯度（度）。南緯は負。 */
  lat: number
  /** 経度（度）。西経は負。 */
  lng: number
  /** 深さ (km)。 */
  depth: number
  /** マグニチュード。欄が `-`（未決定）なら `null`。 */
  magnitude: number | null
  /** 震央地名。生成物には含めないが、抜き出したレコードを目で確かめるときに使う。 */
  region: string
}

/**
 * 日別ページの HTML から震源リストの行だけを取り出す。
 *
 * データ本体はページ内にただ 1 つある `<pre>` の中にある。**`<pre>` が見つからなければ
 * 空ではなく例外にする** —— ページ構成が変わったのに「その日は地震が 0 件だった」として
 * 通ってしまうと、静かに穴が空く。
 */
export function extractDailyHypocenterRows(html: string): string[] {
  const start = html.indexOf('<pre>')
  const end = html.indexOf('</pre>', start)
  if (start < 0 || end < 0) {
    throw new Error('震源リストの <pre> が見つかりません（ページ構成が変わった可能性があります）')
  }
  return html
    .slice(start + '<pre>'.length, end)
    .split('\n')
    .filter((line) => ROW.test(line))
}

/** 1 行を読む。読めない行は `null`。 */
export function parseDailyHypocenterLine(line: string): DailyHypocenterRecord | null {
  const m = ROW.exec(line)
  if (!m) return null
  const [, year, month, day, hour, minute, sec, latDeg, latMin, ns, lngDeg, lngMin, ew, depth, mag, region] = m

  // **`Date.UTC` で組み立ててから JST 分を引く。** ローカル時刻で組み立てると実行環境の
  // タイムゾーンで結果が変わる（CI は UTC で回る）。
  const timeMs =
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0) -
    JST_OFFSET_MS +
    Math.round(Number(sec) * 1000)
  if (!Number.isFinite(timeMs)) return null

  const latSign = ns === 'S' ? -1 : 1
  const lngSign = ew === 'W' ? -1 : 1
  return {
    timeMs,
    lat: latSign * (Number(latDeg) + Number(latMin) / 60),
    lng: lngSign * (Number(lngDeg) + Number(lngMin) / 60),
    depth: Number(depth),
    magnitude: mag === '-' ? null : Number(mag),
    region,
  }
}
