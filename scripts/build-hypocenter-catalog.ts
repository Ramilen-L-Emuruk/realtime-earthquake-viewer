// 長期震源カタログの生成。
//
// 気象庁の震源データを読み、M の下限で絞って年ごとの JSON にする。統計解析（b 値・静穏化・
// 余震域・同一地点履歴・深さ断面）の土台。
//
//   npm run build-hypocenter-catalog                 # 既定（1919 年〜今年・M2.0 以上）
//   npm run build-hypocenter-catalog -- --from 2024  # 直近だけ作り直す（週次更新はこれ）
//   npm run build-hypocenter-catalog -- --min-magnitude 3
//
// 【取得元が 2 つある】確定値（地震月報カタログ編）は精査を経てから収録されるため構造的に
// 遅れる。2023 年までがそれで、2024 年以降は日別の「震源リスト」で埋める。
// **年 ZIP を先に試し、404 なら日別へ落ちる。** 確定値が公開されたら、回すだけで入れ替わる。
//
// 【年別に分ける】1 ファイルにまとめると 30MB 前後になる。年別なら平年 1MB 弱で、用途に応じて
// 必要な年だけ読める（時計盤なら 1 年、b 値なら 10 年）。
// **月別には分けない。** 週次更新で書き換わるのは当年ファイルだけだが、内容は末尾への追記なので
// git の差分圧縮がよく効く（788KB の年ファイルを 52 回更新して .git の増分は 438KB）。
//
// 【完全性は年代で違う】M2.0 の取りこぼしが無いのは 1997 年以降だけ。それ以前は観測網が疎で、
// 1919〜1950 年は M2.0 以上を年 505 件しか記録していない（現代は 2 万件超）。**同じ濃淡で
// 描くと「昔は地震が少なかった」という嘘になる。** 索引の completeness がその境界を持つ。
//
// 出典: 気象庁ホームページ
//   確定値 https://www.data.jma.go.jp/eqev/data/bulletin/hypo.html
//   直近   https://www.data.jma.go.jp/eqev/data/daily_map/
// 気象庁の公共データ利用規約（第 1.0 版）に基づき、加工して作成。

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { parseHypocenterRecord, parseTrailingBlankDecimal } from './hypocenterRecord'
import { extractDailyHypocenterRows, parseDailyHypocenterLine } from './hypocenterDailyRecord'

const ZIP_BASE = 'https://www.data.jma.go.jp/eqev/data/bulletin/data/hypo'
const DAILY_BASE = 'https://www.data.jma.go.jp/eqev/data/daily_map'
const SOURCE_PAGE = 'https://www.data.jma.go.jp/eqev/data/bulletin/hypo.html'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'data', 'hypocenter')
/** 日別ページの置き場。Git 管理外（.claude/* は .gitignore 済み）。 */
const CACHE_DIR = join(__dirname, '..', '.claude', 'hypocenter-cache')

/** カタログの時刻は日本時間。年・日の頭を UTC epoch へ直すのに使う。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** 座標の格納単位。1/10000 度 ≒ 11m で、震源の決定精度（0.01 分 ≒ 18m）より細かい。 */
const COORD_SCALE = 10000
/** 深さの格納単位。0.1km。震源の決定誤差はこれより大きいので十分。 */
const DEPTH_SCALE = 10
/** M の格納単位。カタログ自体が 0.1 刻み。 */
const MAG_SCALE = 10

/** 収録の最初の年。気象庁が配布する最古。 */
const FIRST_YEAR = 1919

/**
 * 「震源リスト」の収録開始年。これより前は月報カタログ編の担当。
 * 年 ZIP が未公開の年をここから埋める。
 */
const DAILY_FROM_YEAR = 2024

/** 「震源リスト」は 2 日前までしか載らない。それより新しい日は取りに行かない。 */
const DAILY_LAG_DAYS = 2

/** 日別ページの取得間隔 (ms)。966 日を一気に叩かないための間。 */
const DAILY_FETCH_INTERVAL_MS = 120

/** 日別ページの取得を諦めるまでの試行回数。 */
const DAILY_FETCH_ATTEMPTS = 3

/**
 * 読めない行がこの割合を超えたら警告する。**分母は M で絞る前の J レコード全件。**
 *
 * 実測の最大は 2016 年の 18 件 / 313,356 件 ＝ 0.0057%（他の年は 0 件）。その約 3.5 倍を
 * 目安に置いた。上流の形式が変わったときに、件数の増加が埋もれずに目に入るようにするための線。
 *
 * **分母を「採用した件数」にしない。** 読めるかどうかは M を見る前に決まるので、絞った後の
 * 件数で割ると M の下限を変えただけで比率が動く。
 *
 * **年ごとではなく全期間で見る。** 古い年は J レコードが年 300 件しかなく（1951〜1960 年）、
 * 年単位の比率では 2 件の異常で 0.25% に跳ねる。実例: 1923 年に深さ欄が `"   0 "` と
 * 書かれた行が 2 件あり（0km を通常と違う詰め方で書いたもの・1919〜1950 年で 2 件だけ）、
 * 年で割ると警告するが 1919〜1950 年の全体では 0.007% でしかない。**形式が変わったかを
 * 知りたいのだから、見るべき分母は取得元の全体。**
 */
const UNREADABLE_WARN_RATIO = 0.0002

/**
 * 深さ欄の既知の変則で落ちる行の、1 年あたりの許容割合。**超えたら生成を失敗させる。**
 *
 * 実測の最大は **1967 年の 29/1666 件 ＝ 1.741%**（大半が松代群発地震）。次が 1961 年の 0.23%。
 * 3% は「観測された最大の 1.7 倍」で、桁がずれる形式変更（ほぼ全件が落ちる）とは大きく離れている。
 *
 * **理由で分けて数えるのが要点。** 以前は理由を問わず 1 つの比率で見ていたため、
 * 1923 年の 0.25%（同じ深さ欄の変則・2 件）を誤発火として抑えようと全期間の比率へ緩めた結果、
 * **1967 年の 1.741% という本物の信号まで黙らせていた**（全期間の分母 577 万件では 0.001%）。
 * 既知の理由には実測に見合った閾値を当て、それ以外は 1 件でも失敗させる。
 */
const UNREADABLE_DEPTH_WARN_RATIO = 0.03

/**
 * まとめて 1 ファイルに入っている年代。気象庁の配布単位そのまま。
 * 1983 年以降は年 1 ファイル、1997 年だけ 10 月の処理方法改訂を境に 2 ファイルに割れている。
 */
const GROUPED_ZIPS: readonly { file: string; from: number; to: number }[] = [
  { file: '1919', from: 1919, to: 1950 },
  { file: '1951', from: 1951, to: 1960 },
  { file: '1961', from: 1961, to: 1966 },
  { file: '1967', from: 1967, to: 1982 },
]

/** 1997 年は 1〜9 月と 10〜12 月で別ファイル。両方読んで 1 年にまとめる。 */
const SPLIT_YEAR_ZIPS: Record<number, readonly string[]> = { 1997: ['199701', '199710'] }

/**
 * 「その期間で M いくつ以上なら取りこぼしが無いか」。
 *
 * 年間件数のマグニチュード別推移を実測して決めた。M5 以上・M6 以上は 1919 年から横ばい
 * （M5+ は年 88〜204 件）だが、M2 以上は 505 件（1919〜1950）から 23,224 件（2010）へ
 * 46 倍に増えている —— **増えたのは地震ではなく観測網。**
 *
 * | 期間 | M2+/年 | M3+/年 | M4+/年 | M5+/年 |
 * |---|---|---|---|---|
 * | 1919〜1950 | 505 | 482 | 322 | 111 |
 * | 1961〜1966 | 1,062 | 1,031 | 522 | 119 |
 * | 1983 | 4,823 | 3,061 | 1,014 | 204 |
 * | 2010 | 23,224 | 6,305 | 1,441 | 187 |
 *
 * **統計に使う機能（日別回数・b 値・静穏化）は、描く期間に応じてここまで閾値を上げること。**
 * 大きい地震を見せるだけの機能（同一地点の履歴など）は見なくてよい。
 */
const COMPLETENESS: readonly { from: number; minMagnitude: number }[] = [
  { from: 1919, minMagnitude: 5.0 },
  { from: 1961, minMagnitude: 4.5 },
  { from: 1983, minMagnitude: 3.5 },
  { from: 1997, minMagnitude: 2.0 },
]

/**
 * 生成のたびに照合する既知の地震。**カラム位置を 1 つ間違えると全件が静かに壊れる。**
 *
 * **取得経路ごとに 1 つ置く。** 経路によって文字コードも切り方も違うため、1 つでは
 * 他の経路の壊れを捕まえられない。
 */
const KNOWN: readonly {
  year: number
  label: string
  /** 期待する取得元。**照合していない経路を最後に名指しするための札。** */
  path: string
  timeIso: string
  lat: number
  lng: number
  depth: number
  magnitude: number
}[] = [
  {
    year: 1923,
    label: '関東大震災の本震',
    path: 'まとめ ZIP 1919-1950',
    timeIso: '1923-09-01T02:58:31.680Z',
    lat: 35 + 19.87 / 60,
    lng: 139 + 8.14 / 60,
    depth: 23,
    magnitude: 7.9,
  },
  {
    year: 1952,
    label: '十勝沖地震（1952 年）の本震',
    path: 'まとめ ZIP 1951-1960',
    timeIso: '1952-03-04T01:22:44.000Z',
    lat: 41.7057,
    lng: 144.1512,
    depth: 54,
    magnitude: 8.2,
  },
  {
    year: 1964,
    label: '新潟地震の本震',
    path: 'まとめ ZIP 1961-1966',
    timeIso: '1964-06-16T04:01:41.000Z',
    lat: 38.37,
    lng: 139.2117,
    depth: 34.1,
    magnitude: 7.5,
  },
  {
    year: 1968,
    label: '十勝沖地震（1968 年）の本震',
    path: 'まとめ ZIP 1967-1982',
    timeIso: '1968-05-16T00:48:55.000Z',
    lat: 40.6992,
    lng: 143.5957,
    depth: 0,
    magnitude: 7.9,
  },
  {
    year: 1997,
    label: '鹿児島県北西部地震（3 月）の本震',
    path: '年 ZIP（1997 の分割ファイル）',
    timeIso: '1997-03-26T08:31:48.000Z',
    lat: 31.9728,
    lng: 130.359,
    depth: 11.9,
    magnitude: 6.6,
  },
  {
    year: 2011,
    label: '東北地方太平洋沖地震の本震',
    path: '年 ZIP',
    timeIso: '2011-03-11T05:46:18.120Z',
    lat: 38.1035,
    lng: 142.861,
    depth: 23.74,
    magnitude: 9.0,
  },
  {
    year: 2024,
    label: '能登半島地震の本震',
    path: '日別 震源リスト',
    timeIso: '2024-01-01T07:10:22.500Z',
    lat: 37 + 29.7 / 60,
    lng: 137 + 16.2 / 60,
    depth: 16,
    magnitude: 7.6,
  },
]

/** データの確からしさ。確定値（月報カタログ編）と速報値（震源リスト）を言い分ける。 */
type Quality = 'final' | 'preliminary'

/** 取得元から読み出した 1 件。経路の違いをここで吸収する。 */
interface SourceRecord {
  timeMs: number
  lat: number
  lng: number
  depth: number
  magnitude: number | null
  /** 最大震度の生コード。日別経路には震度欄が無いので常に null。 */
  intensity: string | null
}

interface Collected {
  records: SourceRecord[]
  quality: Quality
  /** 実際に読んだ取得元。**照合ログに出す** —— 期待した経路と食い違ったことに気づけるように。 */
  source: string
  /** 震度欄を持つ経路から作ったか。日別経路は持たない。 */
  hasIntensity: boolean
  /** この年のデータが「いつまで」を覆っているか（UTC epoch ミリ秒）。 */
  coveredThroughMs: number
  /** 読めた J レコード数（読めない行の割合の分母）。 */
  kindJ: number
  /**
   * 深さ欄の既知の変則で落ちた行。**理由を分けて数える** ——
   * 実測に見合う閾値（`UNREADABLE_DEPTH_WARN_RATIO`）で監視する。
   */
  unreadableDepth: number
  /**
   * 深さ以外の理由で落ちた行。**1 件でも生成を失敗させる。**
   * 現状の実測は 0 件なので、出たら上流の形式が変わったということ。
   */
  unreadableOther: number
  skippedKind: number
  secondUnknown: number
  /**
   * まとめ ZIP で、どの年にも振り分けられなかった J レコード。
   * 年欄が壊れると、どの年の集計にも入らず黙って消えるため別に数える（実測は 0 件）。
   */
  unassigned: number
}

interface YearCatalog {
  year: number
  /**
   * その年の 1 月 1 日 00:00 JST を UTC epoch ミリ秒で表したもの。t の起点。
   *
   * **これを持たせるのは、読む側に日本時間の知識を要求しないため。** 起点を年から計算させると、
   * 生成側と読み込み側でタイムゾーンの解釈がずれる余地が残る。
   */
  startMs: number
  /**
   * この年のデータが覆っている終端（UTC epoch ミリ秒）。通年なら翌年の頭。
   *
   * **これが無いと「まだ取っていない」と「地震が無かった」を描き分けられない。** 格子の空白は
   * 両者を区別しないので、終端を持たない限り必ず嘘になる。
   */
  coveredThroughMs: number
  minMagnitude: number
  quality: Quality
  hasIntensity: boolean
  /**
   * 格納単位。**索引（index.json）にも同じ値があるが、年ファイル側にも持たせる。**
   * 片方だけを見て解釈できないと、索引を読み損ねたときに桁が 1 万倍ずれた座標を黙って使うことになる。
   */
  coordScale: number
  depthScale: number
  magScale: number
  count: number
  /** その年の 1 月 1 日 00:00 JST からの経過秒。 */
  t: number[]
  /** 緯度 × 10000。 */
  lat: number[]
  /** 経度 × 10000。 */
  lng: number[]
  /** 深さ (km) × 10。 */
  dep: number[]
  /** M × 10。 */
  mag: number[]
  /**
   * 最大震度を持つ地震の添字。**疎に持つ** —— 有感は M2.0 以上の 11.9% しかないので、
   * 全件ぶんの列にすると 9 割が無駄になる。hasIntensity が false の年は空。
   */
  intIdx: number[]
  /**
   * intIdx と同じ長さ。最大震度の生コード。**震度でないコードも入る**
   * （`F` 有感地震・`X` 付近有感・`L`〜`R` 最大有感距離による顕著度）。
   * 欄が空でなければそのまま積むので、コード表の全種が現れうる（一覧は `hypocenterRecord.ts`）。
   */
  intCode: string[]
}

function argValue(name: string, fallback: number): number {
  const i = process.argv.indexOf(name)
  if (i < 0) return fallback
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) ? v : fallback
}

/** その年の 1 月 1 日 00:00 JST（UTC epoch ミリ秒）。 */
function yearStart(year: number): number {
  return Date.UTC(year, 0, 1) - JST_OFFSET_MS
}

/** 「震源リスト」が載っている最後の日（JST の年月日）。 */
function latestDailyDate(): { year: number; month: number; day: number } {
  const nowJst = new Date(Date.now() + JST_OFFSET_MS)
  const d = new Date(
    Date.UTC(nowJst.getUTCFullYear(), nowJst.getUTCMonth(), nowJst.getUTCDate() - DAILY_LAG_DAYS),
  )
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// 取得元 1: 確定値（ZIP）
// ---------------------------------------------------------------------------

/**
 * 確定値がまだ公開されていない（404）。**これだけが日別経路へ落ちる条件。**
 *
 * ネットワークの一時障害や ZIP の破損まで同じ扱いにすると、確定値が公開済みの年が
 * 速報値で作られる（`quality` に記録は残るが、それを見張る仕組みが無い）。
 */
class NotPublishedError extends Error {}

/** ZIP の中身をファイル名で覚える。まとめ ZIP は 1 ファイルで 32 年ぶんあるため、年ごとに取り直さない。 */
const zipTextCache = new Map<string, string>()

async function fetchZipText(file: string): Promise<string> {
  const cached = zipTextCache.get(file)
  if (cached != null) return cached
  const url = `${ZIP_BASE}/h${file}.zip`
  const res = await fetch(url)
  if (!res.ok) {
    // 404 だけが「まだ公開されていない」。それ以外は一時障害・URL 変更の疑いとして、
    // 日別経路へ落とさず失敗させる。
    if (res.status === 404) throw new NotPublishedError(`${url}: 404（確定値は未公開）`)
    throw new Error(`${url}: ${res.status}`)
  }
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
  const names = Object.keys(files)
  if (names.length === 0) throw new Error(`${url}: ZIP が空です`)
  // **latin1 で読む。** 震央地名の欄が Shift-JIS で入りうるため、UTF-8 で読むと不正な
  // シーケンスが置換文字に潰れて 1 バイト 1 文字が崩れ、後ろのカラム（震源決定フラグ）が
  // ずれる。今回はその欄を使わないが、位置を守るために 1 バイト 1 文字を保つ。
  const text = new TextDecoder('latin1').decode(files[names[0]])
  zipTextCache.set(file, text)
  return text
}

/** その年を含む ZIP のファイル名。年 1 ファイルが基本で、まとめ・分割は表で持つ。 */
function zipFilesFor(year: number): readonly string[] {
  const split = SPLIT_YEAR_ZIPS[year]
  if (split) return split
  const grouped = GROUPED_ZIPS.find((g) => year >= g.from && year <= g.to)
  return grouped ? [grouped.file] : [String(year)]
}

async function collectFromZip(year: number): Promise<Collected> {
  const files = zipFilesFor(year)
  const out: Collected = {
    records: [],
    quality: 'final',
    source: files.map((f) => `h${f}.zip`).join(' + '),
    hasIntensity: true,
    // 確定値は通年ぶんある。終端は翌年の頭。
    coveredThroughMs: yearStart(year + 1),
    kindJ: 0,
    unreadableDepth: 0,
    unreadableOther: 0,
    skippedKind: 0,
    secondUnknown: 0,
    unassigned: 0,
  }
  const yearText = String(year)
  for (const file of files) {
    const text = await fetchZipText(file)
    // 仕様書は「96 Byte 固定長」と書いているが実ファイルは改行区切り。バイト数で切ると
    // 1 バイトずつずれる（詳細は hypocenterRecord.ts）。
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      // まとめ ZIP は複数年を含む。年で絞ってから種別を見る（除外件数を年ごとに出すため）。
      if (line.slice(1, 5) !== yearText) {
        // **年欄が数字で無い行は別に数える。** どの年にも振り分けられず黙って消えるため。
        // まとめ ZIP を跨いだ通算はできないので、その年の集計として最後に突き合わせる
        // （実測は 4 ファイルすべてで 0 件）。
        if (line[0] === 'J' && !/^\d{4}$/.test(line.slice(1, 5))) out.unassigned++
        continue
      }
      // 気象庁が決定した震源（J）だけを採る。ほかの種別は年 100 件に満たず、決定の
      // 経緯が違うため統計に混ぜない。**パースより先に弾く** —— 海外の震源（U）は
      // 緯度経度の書き方が違い、読めない行として数えられて「壊れた行がある」ように見える。
      if (line[0] !== 'J') {
        out.skippedKind++
        continue
      }
      out.kindJ++
      const r = parseHypocenterRecord(line)
      if (!r) {
        // **理由を分ける。** 深さ欄が読めないなら既知の変則（実測 90 件）。深さは読めるのに
        // 落ちたなら、時刻か座標の形が変わったということ —— そちらは 1 件でも失敗させる。
        if (parseTrailingBlankDecimal(line.slice(44, 49), 3) == null) out.unreadableDepth++
        else out.unreadableOther++
        continue
      }
      if (r.secondUnknown) out.secondUnknown++
      out.records.push({
        timeMs: r.timeMs,
        lat: r.lat,
        lng: r.lng,
        depth: r.depth,
        magnitude: r.magnitude,
        intensity: r.intensity,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 取得元 2: 速報値（日別「震源リスト」）
// ---------------------------------------------------------------------------

function dailyKey(year: number, month: number, day: number): string {
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`
}

async function readDailyCache(key: string): Promise<string | null> {
  try {
    return await readFile(join(CACHE_DIR, `${key}.html`), 'utf-8')
  } catch {
    return null
  }
}

/**
 * 日別ページを取る。**一度取った日はディスクに残して二度取らない。**
 *
 * 過去の日のページは書き換わらないため、キャッシュは無期限でよい。週次更新で新しい数日だけを
 * 取りに行けるようにするのが目的（966 日を毎回取り直すと約 70MB になる）。
 */
async function fetchDailyHtml(key: string): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= DAILY_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${DAILY_BASE}/${key}.html`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const html = await res.text()
      // 検分してから保存する。**中身を確かめずに残すと、エラーページを「その日は 0 件」として
      // 恒久的にキャッシュしてしまう。**
      const rows = extractDailyHypocenterRows(html)
      // **0 件は障害として扱う。** 日本で 1 日の地震が 0 件になることは無い（966 日の実測で
      // 最小 391 件／平均 742 件）。HTTP 200 で `<pre>` はあるが中身が空、という応答を恒久キャッシュすると、
      // その日は二度と取り直されないまま「地震が無かった」ことになる。
      if (rows.length === 0) throw new Error('震源リストが 0 件（障害の疑い）')
      await writeFile(join(CACHE_DIR, `${key}.html`), html, 'utf-8')
      return html
    } catch (e) {
      lastError = e
      if (attempt < DAILY_FETCH_ATTEMPTS) await sleep(DAILY_FETCH_INTERVAL_MS * attempt * 5)
    }
  }
  // **穴を許さない。** 期間の途中が欠けたまま通すと、その空白が「地震が無かった」として
  // 統計に混ざる。取れなかった日は必ず落とす（キャッシュがあるので再実行は安い）。
  throw new Error(`${key} の震源リストを取得できません: ${(lastError as Error)?.message ?? lastError}`)
}

async function collectFromDaily(year: number): Promise<Collected> {
  const latest = latestDailyDate()
  if (year > latest.year) throw new Error(`${year} 年は震源リストの収録範囲より新しい`)
  const out: Collected = {
    records: [],
    quality: 'preliminary',
    source: '震源リスト（日別）',
    hasIntensity: false, // 震源リストに震度欄は無い
    coveredThroughMs: yearStart(year),
    kindJ: 0,
    unreadableDepth: 0,
    // 日別経路に深さ欄の変則は無い（実測 11,537 行すべてが読めた）ので、
    // 読めない行が出たら上流の列幅が変わったということ。すべて other へ数える。
    unreadableOther: 0,
    skippedKind: 0,
    secondUnknown: 0,
    unassigned: 0,
  }

  let fetched = 0
  for (let month = 1; month <= 12; month++) {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
    for (let day = 1; day <= daysInMonth; day++) {
      // 「2 日前まで」を越えた日はまだ載っていない。ここで打ち切り、終端はそれまでの値を残す。
      if (year === latest.year && (month > latest.month || (month === latest.month && day > latest.day))) {
        return out
      }
      const key = dailyKey(year, month, day)
      let html = await readDailyCache(key)
      if (html == null) {
        html = await fetchDailyHtml(key)
        fetched++
        await sleep(DAILY_FETCH_INTERVAL_MS)
        if (fetched % 50 === 0) process.stdout.write(`(${fetched}日) `)
      }
      for (const line of extractDailyHypocenterRows(html)) {
        out.kindJ++
        const r = parseDailyHypocenterLine(line)
        if (!r) {
          out.unreadableOther++
          continue
        }
        out.records.push({
          timeMs: r.timeMs,
          lat: r.lat,
          lng: r.lng,
          depth: r.depth,
          magnitude: r.magnitude,
          intensity: null,
        })
      }
      // その日の終わり（＝翌日の 00:00 JST）まで覆えた。
      out.coveredThroughMs = Date.UTC(year, month - 1, day + 1) - JST_OFFSET_MS
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

/**
 * その年の取得元を決めて読む。**確定値を先に試し、無ければ速報値へ落ちる。**
 * 手で切り替える箇所を作らないのが狙い —— 2024 年の確定値が公開された日に、回すだけで入れ替わる。
 */
async function collectYear(year: number): Promise<Collected> {
  try {
    return await collectFromZip(year)
  } catch (e) {
    // **404 以外は落とさない。** 一時障害で速報値へ格下げしないため。
    if (!(e instanceof NotPublishedError) || year < DAILY_FROM_YEAR) throw e
    process.stdout.write('（確定値は未公開。震源リストから）')
    return await collectFromDaily(year)
  }
}

function buildYear(year: number, collected: Collected, minMagnitude: number): YearCatalog {
  const startMs = yearStart(year)
  const out: YearCatalog = {
    year,
    startMs,
    coveredThroughMs: collected.coveredThroughMs,
    minMagnitude,
    quality: collected.quality,
    hasIntensity: collected.hasIntensity,
    coordScale: COORD_SCALE,
    depthScale: DEPTH_SCALE,
    magScale: MAG_SCALE,
    count: 0,
    t: [],
    lat: [],
    lng: [],
    dep: [],
    mag: [],
    intIdx: [],
    intCode: [],
  }

  // **時刻順に並べる。** ZIP はおおむね時刻順だが日別経路は日ごとの連結なので、
  // 揃えておかないと読む側が二分探索できない。
  const sorted = [...collected.records].sort((a, b) => a.timeMs - b.timeMs)
  for (const r of sorted) {
    if (r.magnitude == null || r.magnitude < minMagnitude) continue
    const i = out.t.length
    out.t.push(Math.round((r.timeMs - startMs) / 1000))
    out.lat.push(Math.round(r.lat * COORD_SCALE))
    out.lng.push(Math.round(r.lng * COORD_SCALE))
    out.dep.push(Math.round(r.depth * DEPTH_SCALE))
    out.mag.push(Math.round(r.magnitude * MAG_SCALE))
    if (r.intensity != null) {
      out.intIdx.push(i)
      out.intCode.push(r.intensity)
    }
  }
  out.count = out.t.length

  // 深さ欄の変則で落ちた行。値を推測して混ぜるより捨てる方が安全なので落としている
  // （書式の詳細は hypocenterRecord.ts の parseTrailingBlankDecimal）。
  if (collected.unreadableDepth > 0) {
    const ratio = collected.kindJ > 0 ? collected.unreadableDepth / collected.kindJ : 0
    const text = `  深さ欄が読めず捨てた行: ${collected.unreadableDepth} (${(ratio * 100).toFixed(3)}%)`
    if (ratio > UNREADABLE_DEPTH_WARN_RATIO) {
      console.error(`${text} ← 実測の最大（1967 年の 1.741%）を大きく超えています。書式を確認すること`)
    } else {
      console.log(text)
    }
  }
  // **こちらは 1 件でも異常。** 深さは読めているのに落ちたということは、時刻か座標の形が変わった。
  if (collected.unreadableOther > 0) {
    console.error(
      `  深さ以外の理由で読めなかった行: ${collected.unreadableOther}` +
        ' ← 想定 0 件。上流の形式が変わった疑いがあります',
    )
  }
  if (collected.unassigned > 0) {
    console.error(`  年欄が数字でない J レコード: ${collected.unassigned} ← 想定 0 件`)
  }
  if (collected.skippedKind > 0) console.log(`  気象庁以外の震源として除外: ${collected.skippedKind}`)
  if (collected.secondUnknown > 0) {
    console.log(`  秒が判らない記録: ${collected.secondUnknown}（分までで採用）`)
  }
  return out
}

/**
 * 既知の地震が正しい値で入っているかを照合する。
 *
 * パーサのユニットテストとは別に**生成物そのもの**を確かめる。ZIP の中身が変わった・
 * 列の詰め方を間違えた・単位の掛け方を取り違えた、といった生成側の事故はテストでは捕まらない。
 */
function verifyKnown(cat: YearCatalog, source: string): void {
  const known = KNOWN.find((k) => k.year === cat.year)
  if (!known) return
  const wantMs = Date.parse(known.timeIso)
  // **時刻の完全一致で引かない。** 速報値と確定値では発生時刻が 0.1 秒単位で動きうるため、
  // 一致検索にすると確定値へ入れ替わった日に「見つからない」で落ちる。最も近いものを採る。
  let best = -1
  let bestDiff = Infinity
  for (let i = 0; i < cat.count; i++) {
    const diff = Math.abs(cat.startMs + cat.t[i] * 1000 - wantMs)
    if (diff < bestDiff) {
      bestDiff = diff
      best = i
    }
  }
  if (best < 0 || bestDiff > 5000) {
    throw new Error(`${known.label}が見つかりません（${source}）。カラム位置がずれた可能性があります`)
  }
  const got = {
    lat: cat.lat[best] / COORD_SCALE,
    lng: cat.lng[best] / COORD_SCALE,
    depth: cat.dep[best] / DEPTH_SCALE,
    magnitude: cat.mag[best] / MAG_SCALE,
  }
  // 許容差は「カラムがずれたら必ず超える」幅に取る。位置が 1 列ずれれば桁ごと変わるので、
  // 速報値と確定値の差（M で 0.1 程度）を通しても検知力は落ちない。
  const diffs: string[] = []
  if (Math.abs(got.lat - known.lat) > 0.01) diffs.push(`緯度 ${got.lat} (期待 ${known.lat.toFixed(4)})`)
  if (Math.abs(got.lng - known.lng) > 0.01) diffs.push(`経度 ${got.lng} (期待 ${known.lng.toFixed(4)})`)
  if (Math.abs(got.depth - known.depth) > 1) diffs.push(`深さ ${got.depth} (期待 ${known.depth})`)
  if (Math.abs(got.magnitude - known.magnitude) > 0.2) {
    diffs.push(`M ${got.magnitude} (期待 ${known.magnitude})`)
  }
  if (diffs.length > 0) {
    throw new Error(`${known.label}の値が合いません（${source}）: ${diffs.join(' / ')}`)
  }
  // **札ではなく実際に読んだ取得元を出す。** 期待と食い違ったことに気づけるように
  // （2024 年の確定値が公開されれば、日別経路から年 ZIP へ静かに入れ替わる）。
  console.log(`  照合 OK: ${known.label}（M${got.magnitude}・深さ ${got.depth}km / ${source}）`)
}

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

/** 年ファイルから索引に載せる項目だけを読む。索引が壊れた状態から作り直せるようにするため。 */
interface YearSummary {
  count: number
  quality: Quality
  hasIntensity: boolean
  coveredThroughMs: number
}

async function readYearSummary(year: number): Promise<YearSummary | null> {
  try {
    const raw = await readFile(join(OUT_DIR, `${year}.json`), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<YearCatalog>
    if (typeof parsed.count !== 'number') return null
    return {
      count: parsed.count,
      quality: parsed.quality === 'preliminary' ? 'preliminary' : 'final',
      hasIntensity: parsed.hasIntensity === true,
      coveredThroughMs:
        typeof parsed.coveredThroughMs === 'number' ? parsed.coveredThroughMs : yearStart(year + 1),
    }
  } catch {
    return null
  }
}

async function readExistingMinMagnitude(): Promise<number | null> {
  try {
    const raw = await readFile(join(OUT_DIR, 'index.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { minMagnitude?: number }
    return typeof parsed.minMagnitude === 'number' ? parsed.minMagnitude : null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const latest = latestDailyDate()
  const from = argValue('--from', FIRST_YEAR)
  const to = argValue('--to', latest.year)
  const minMagnitude = argValue('--min-magnitude', 2.0)

  console.log(`震源カタログを生成します: ${from}〜${to} 年 / M${minMagnitude.toFixed(1)} 以上`)
  console.log(`震源リストの収録は ${latest.year}-${latest.month}-${latest.day} まで（2 日前）`)
  await mkdir(OUT_DIR, { recursive: true })
  await mkdir(CACHE_DIR, { recursive: true })

  const previousMin = await readExistingMinMagnitude()
  if (previousMin != null && previousMin !== minMagnitude) {
    console.warn(
      `※ 既にある年ファイルは M${previousMin.toFixed(1)} 以上で作られています。` +
        `下限を変えるなら全期間を作り直してください（混在したまま索引が上書きされます）`,
    )
  }

  const built = new Map<number, YearSummary>()
  const missing: number[] = []
  const verifiedPaths: string[] = []
  // 深さ欄の変則は全期間でも見る（傾向の把握用。失敗の判定は年ごとに行う）。
  let totalUnreadableDepth = 0
  let totalKindJ = 0
  // **生成を失敗させる理由。** 1 つでも溜まったら最後に exit 1 する。
  // 途中で throw しないのは、何がいくつ起きたかをまとめて見せたいため。
  const failures: string[] = []

  for (let year = from; year <= to; year++) {
    process.stdout.write(`${year} ... `)
    let collected: Collected
    try {
      collected = await collectYear(year)
    } catch (e) {
      // 取得できない年は飛ばして続ける。範囲の指定ミスで全部落ちるより、取れた年で作って
      // 何が欠けたかを最後に見せる方が扱いやすい。
      console.log(`取得できません（${(e as Error).message}）`)
      missing.push(year)
      continue
    }
    totalUnreadableDepth += collected.unreadableDepth
    totalKindJ += collected.kindJ
    const cat = buildYear(year, collected, minMagnitude)
    console.log(`${cat.count} 件`)
    // 検知した異常はここで失敗理由へ積む（buildYear が既に画面へ出している）。
    const depthRatio = collected.kindJ > 0 ? collected.unreadableDepth / collected.kindJ : 0
    if (depthRatio > UNREADABLE_DEPTH_WARN_RATIO) {
      failures.push(`${year} 年: 深さ欄が読めない行が ${(depthRatio * 100).toFixed(3)}%`)
    }
    if (collected.unreadableOther > 0) {
      failures.push(`${year} 年: 深さ以外の理由で読めない行が ${collected.unreadableOther} 件`)
    }
    if (collected.unassigned > 0) {
      failures.push(`${year} 年: 年欄が数字でない J レコードが ${collected.unassigned} 件`)
    }
    // **1 件も採れなかった年は異常。** M 欄だけが壊れると震源 3 要素は読めるため
    // 「読めない行」は増えず、件数 0 という形でしか現れない。
    if (cat.count === 0 && collected.kindJ > 0) {
      failures.push(`${year} 年: J レコードは ${collected.kindJ} 件あるのに 1 件も採れませんでした`)
    }
    const known = KNOWN.find((k) => k.year === year)
    if (known) {
      verifyKnown(cat, collected.source)
      verifiedPaths.push(known.path)
    }
    await writeFile(join(OUT_DIR, `${year}.json`), JSON.stringify(cat), 'utf-8')
    built.set(year, {
      count: cat.count,
      quality: cat.quality,
      hasIntensity: cat.hasIntensity,
      coveredThroughMs: cat.coveredThroughMs,
    })
  }

  // **索引は出力ディレクトリの実態から作る。** 今回生成した年だけで書くと、範囲を絞って
  // 1 年を作り直した瞬間に**他の年が索引から消える**（ファイルは残るのに読めなくなる）。
  const present = (await readdir(OUT_DIR))
    .filter((f) => /^\d{4}\.json$/.test(f))
    .map((f) => Number(f.slice(0, 4)))
    .sort((a, b) => a - b)

  const counts: Record<string, number> = {}
  const quality: Record<string, Quality> = {}
  const intensityYears: number[] = []
  let coveredThroughMs = 0
  for (const year of present) {
    const summary = built.get(year) ?? (await readYearSummary(year))
    if (!summary) {
      // **黙って索引から外さない。** ファイルは残るのに読めなくなる（歴史の途中の年が
      // 丸ごと消える）経路で、`coveredThroughMs` は直近の尾しか見ていないので気づけない。
      console.error(`  ${year}.json を読めませんでした`)
      failures.push(`${year}.json が読めません（壊れているか形式が違う）`)
      continue
    }
    if (!built.has(year)) {
      console.log(`  索引を ${year} 年のファイルから復元しました（${summary.count} 件）`)
    }
    counts[String(year)] = summary.count
    quality[String(year)] = summary.quality
    if (summary.hasIntensity) intensityYears.push(year)
    coveredThroughMs = Math.max(coveredThroughMs, summary.coveredThroughMs)
  }

  const years = Object.keys(counts).map(Number).sort((a, b) => a - b)
  if (years.length === 0) throw new Error('1 年も生成できませんでした')

  await writeFile(
    join(OUT_DIR, 'index.json'),
    JSON.stringify({
      source: '気象庁 地震月報（カタログ編）震源データ / 震源リスト',
      sourceUrl: SOURCE_PAGE,
      license: '気象庁の公共データ利用規約（第1.0版）に基づき、加工して作成',
      minMagnitude,
      coordScale: COORD_SCALE,
      depthScale: DEPTH_SCALE,
      magScale: MAG_SCALE,
      coveredThroughMs,
      completeness: COMPLETENESS,
      years,
      counts,
      quality,
      intensityYears,
    }),
    'utf-8',
  )

  const total = years.reduce((sum, y) => sum + counts[String(y)], 0)
  console.log(`\n合計 ${total} 件 / ${years.length} 年ぶんを ${OUT_DIR} へ出力しました`)
  console.log(`データの終端: ${new Date(coveredThroughMs).toISOString()}`)
  // 照合を通していないことを黙って済ませない。範囲を絞って生成したものを「照合済み」と
  // 思い込むのを防ぐため、経路ごとに言う。
  for (const k of KNOWN) {
    if (!verifiedPaths.includes(k.path)) {
      console.log(`※ ${k.year} 年を含めなかったため、${k.path} の照合は行っていません`)
    }
  }
  if (totalUnreadableDepth > 0) {
    const ratio = totalKindJ > 0 ? totalUnreadableDepth / totalKindJ : 0
    console.log(
      `深さ欄が読めず捨てた行（全期間）: ${totalUnreadableDepth} / ${totalKindJ}` +
        ` (${(ratio * 100).toFixed(4)}%)`,
    )
    if (ratio > UNREADABLE_WARN_RATIO) {
      // 年ごとの判定を通り抜けても、全期間で薄く広く増えていれば形式の変化を疑う。
      console.warn('※ 全期間の比率が想定より高い。フォーマットが変わっていないか確認すること')
    }
  }
  if (missing.length > 0) {
    // **取得できなかった年を警告で済ませない。** CI は exit code しか見ておらず、
    // 「毎週緑なのに数ヶ月データが古いまま」という状態を作る。
    console.error(`※ 取得できなかった年: ${missing.join(', ')}`)
    failures.push(`取得できなかった年: ${missing.join(', ')}`)
  }
  if (failures.length > 0) {
    console.error(`
生成に失敗しました（${failures.length} 件）:`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
