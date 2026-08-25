// 長期震源カタログの生成。
//
// 気象庁「地震月報（カタログ編）」の年別 ZIP を読み、M の下限で絞って年ごとの JSON にする。
// 統計解析（b 値・静穏化・余震域・同一地点履歴・深さ断面）の土台。
//
//   npm run build-hypocenter-catalog                      # 既定（2009〜2023・M2.0 以上）
//   npm run build-hypocenter-catalog -- --from 2020 --to 2023
//   npm run build-hypocenter-catalog -- --min-magnitude 3
//
// 【なぜ年別に分けるか】1 ファイルにまとめると M2.0 以上・15 年で 15MB 前後になり、既存の
// 生成データの最大（`subregions.json` 2.6MB）を大きく超える。年別なら平年 1MB 弱に収まり、
// 用途に応じて必要な年だけ読める。2024 年が公開されたら 1 ファイル足すだけで済むのも利点。
//
// 【カタログは 2023 年まで】確定値は精査を経てから収録されるため構造的に遅れる。`h2024.zip` は
// 未公開（404）。直近は既存のヒートマップ（DMDATA / P2PQuake の 30 日）が別途カバーしている。
//
// 出典: 気象庁ホームページ（https://www.data.jma.go.jp/eqev/data/bulletin/hypo.html）
// 気象庁の公共データ利用規約（第 1.0 版）に基づき、加工して作成。

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { parseHypocenterRecord } from './hypocenterRecord'

const SOURCE_BASE = 'https://www.data.jma.go.jp/eqev/data/bulletin/data/hypo'
const SOURCE_PAGE = 'https://www.data.jma.go.jp/eqev/data/bulletin/hypo.html'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'data', 'hypocenter')

/** カタログの時刻は日本時間。年の頭を UTC epoch へ直すのに使う。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** 座標の格納単位。1/10000 度 ≒ 11m で、震源の決定精度（0.01 分 ≒ 18m）より細かい。 */
const COORD_SCALE = 10000
/** 深さの格納単位。0.1km。震源の決定誤差はこれより大きいので十分。 */
const DEPTH_SCALE = 10
/** M の格納単位。カタログ自体が 0.1 刻み。 */
const MAG_SCALE = 10

/**
 * 読めない行がこの割合を超えたら警告する。**分母は M で絞る前の `J` レコード全件。**
 *
 * 実測の最大は 2016 年の 18 件 / 313,356 件 ＝ 0.0057%（他の年は 0 件）。その約 3.5 倍を
 * 目安に置いた。上流の形式が変わったときに、件数の増加が埋もれずに目に入るようにするための線。
 *
 * **分母を「採用した件数」にしない。** 読めるかどうかは M を見る前に決まるので、絞った後の
 * 件数で割ると M の下限を変えただけで比率が動く。
 */
const UNREADABLE_WARN_RATIO = 0.0002

/** 生成のたびに照合する既知の地震。**カラム位置を 1 バイト間違えると全件が静かに壊れる。** */
const KNOWN = {
  year: 2011,
  label: '東北地方太平洋沖地震の本震',
  timeIso: '2011-03-11T05:46:18.120Z',
  lat: 38.1035,
  lng: 142.861,
  depth: 23.74,
  magnitude: 9.0,
}

interface YearCatalog {
  year: number
  /**
   * その年の 1 月 1 日 00:00 JST を UTC epoch ミリ秒で表したもの。`t` の起点。
   *
   * **これを持たせるのは、読む側に日本時間の知識を要求しないため。** 起点を年から計算させると、
   * 生成側と読み込み側でタイムゾーンの解釈がずれる余地が残る。
   */
  startMs: number
  minMagnitude: number
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
}

function argValue(name: string, fallback: number): number {
  const i = process.argv.indexOf(name)
  if (i < 0) return fallback
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) ? v : fallback
}

async function fetchYear(year: number): Promise<string> {
  const url = `${SOURCE_BASE}/h${year}.zip`
  const res = await fetch(url)
  if (!res.ok) {
    // 未公開の年（確定値がまだ出ていない）はここへ来る。呼び出し側が年を飛ばせるよう
    // ステータスを添えて投げる。
    throw new Error(`${url}: ${res.status}`)
  }
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
  const names = Object.keys(files)
  if (names.length === 0) throw new Error(`${url}: ZIP が空です`)
  // **latin1 で読む。** 震央地名の欄が Shift-JIS で入りうるため、UTF-8 で読むと不正な
  // シーケンスが置換文字に潰れて 1 バイト 1 文字が崩れ、後ろのカラム（震源決定フラグ）が
  // ずれる。今回はその欄を使わないが、位置を守るために 1 バイト 1 文字を保つ。
  return new TextDecoder('latin1').decode(files[names[0]])
}

function buildYear(year: number, text: string, minMagnitude: number): YearCatalog {
  // 仕様書は「96 Byte 固定長」と書いているが実ファイルは改行区切り。バイト数で切ると
  // 1 バイトずつずれる（詳細は hypocenterRecord.ts）。
  const lines = text.split('\n')
  const yearStartMs = Date.UTC(year, 0, 1) - JST_OFFSET_MS

  let kindJ = 0
  const out: YearCatalog = {
    year,
    startMs: yearStartMs,
    minMagnitude,
    coordScale: COORD_SCALE,
    depthScale: DEPTH_SCALE,
    magScale: MAG_SCALE,
    count: 0,
    t: [],
    lat: [],
    lng: [],
    dep: [],
    mag: [],
  }
  let skippedUnreadable = 0
  let skippedKind = 0

  for (const line of lines) {
    if (!line.trim()) continue
    // 気象庁が決定した震源（`J`）だけを採る。ほかの種別は年 100 件に満たず、決定の
    // 経緯が違うため統計に混ぜない。**パースより先に弾く** —— 海外の震源（`U`）は
    // 緯度経度の書き方が違い、読めない行として数えられて「壊れた行がある」ように見える。
    if (line[0] !== 'J') {
      skippedKind++
      continue
    }
    kindJ++
    const r = parseHypocenterRecord(line)
    if (!r) {
      skippedUnreadable++
      continue
    }
    if (r.magnitude == null || r.magnitude < minMagnitude) continue

    out.t.push(Math.round((r.timeMs - yearStartMs) / 1000))
    out.lat.push(Math.round(r.lat * COORD_SCALE))
    out.lng.push(Math.round(r.lng * COORD_SCALE))
    out.dep.push(Math.round(r.depth * DEPTH_SCALE))
    out.mag.push(Math.round(r.magnitude * MAG_SCALE))
  }
  out.count = out.t.length

  if (skippedUnreadable > 0) {
    // 深さ欄に仕様外の書き方が稀に現れる（実例: 2016 年に「  0 4」——整数 3 桁でも 1/100km の
    // 5 桁でもない形が 18 件）。値を推測して混ぜるより捨てる方が安全なので落としている。
    // **ただし増えたら上流の形式が変わった疑いがある。** 件数だけでは気づけないので割合で見る。
    const ratio = kindJ > 0 ? skippedUnreadable / kindJ : 0
    const line = `  読めなかった行: ${skippedUnreadable} (${(ratio * 100).toFixed(3)}%)`
    if (ratio > UNREADABLE_WARN_RATIO) {
      console.warn(`${line} ← 想定より多い。フォーマットが変わっていないか確認すること`)
    } else {
      console.log(line)
    }
  }
  if (skippedKind > 0) {
    console.log(`  気象庁以外の震源として除外: ${skippedKind}`)
  }
  return out
}

/**
 * 既知の地震が正しい値で入っているかを照合する。
 *
 * パーサのユニットテストとは別に**生成物そのもの**を確かめる。ZIP の中身が変わった・
 * 列の詰め方を間違えた・単位の掛け方を取り違えた、といった生成側の事故はテストでは捕まらない。
 */
function verifyKnown(cat: YearCatalog): void {
  const yearStartMs = Date.UTC(cat.year, 0, 1) - JST_OFFSET_MS
  const wantSec = Math.round((Date.parse(KNOWN.timeIso) - yearStartMs) / 1000)
  const i = cat.t.indexOf(wantSec)
  if (i < 0) {
    throw new Error(`${KNOWN.label}が見つかりません（発生時刻が一致する項目なし）。カラム位置がずれた可能性があります`)
  }
  const got = {
    lat: cat.lat[i] / COORD_SCALE,
    lng: cat.lng[i] / COORD_SCALE,
    depth: cat.dep[i] / DEPTH_SCALE,
    magnitude: cat.mag[i] / MAG_SCALE,
  }
  const diffs: string[] = []
  if (Math.abs(got.lat - KNOWN.lat) > 0.001) diffs.push(`緯度 ${got.lat} (期待 ${KNOWN.lat})`)
  if (Math.abs(got.lng - KNOWN.lng) > 0.001) diffs.push(`経度 ${got.lng} (期待 ${KNOWN.lng})`)
  if (Math.abs(got.depth - KNOWN.depth) > 0.1) diffs.push(`深さ ${got.depth} (期待 ${KNOWN.depth})`)
  if (got.magnitude !== KNOWN.magnitude) diffs.push(`M ${got.magnitude} (期待 ${KNOWN.magnitude})`)
  if (diffs.length > 0) {
    throw new Error(`${KNOWN.label}の値が合いません: ${diffs.join(' / ')}`)
  }
  console.log(`  照合 OK: ${KNOWN.label}（M${got.magnitude}・深さ ${got.depth}km）`)
}

/**
 * 既存の索引から年ごとの件数を読む。無ければ空。
 *
 * **M の下限が食い違っていたら警告する。** 下限を変えて一部の年だけ作り直すと、索引が持つ
 * 下限と実際のファイルがずれる（年ファイル自身も下限を持つので読む側は判別できるが、
 * 索引だけを見た人は取り違える）。
 */
async function readExistingCounts(): Promise<Record<string, number>> {
  try {
    const raw = await readFile(join(OUT_DIR, 'index.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { counts?: Record<string, number>; minMagnitude?: number }
    return parsed.counts ?? {}
  } catch {
    // 初回は索引が無い。エラーではない。
    return {}
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
  const from = argValue('--from', 2009)
  const to = argValue('--to', 2023)
  const minMagnitude = argValue('--min-magnitude', 2.0)

  console.log(`震源カタログを生成します: ${from}〜${to} 年 / M${minMagnitude.toFixed(1)} 以上`)
  await mkdir(OUT_DIR, { recursive: true })

  const previousMin = await readExistingMinMagnitude()
  if (previousMin != null && previousMin !== minMagnitude) {
    console.warn(
      `※ 既にある年ファイルは M${previousMin.toFixed(1)} 以上で作られています。` +
        `下限を変えるなら全期間を作り直してください（混在したまま索引が上書きされます）`,
    )
  }

  const counts: Record<string, number> = {}
  const missing: number[] = []
  let verified = false

  for (let year = from; year <= to; year++) {
    process.stdout.write(`${year} ... `)
    let text: string
    try {
      text = await fetchYear(year)
    } catch (e) {
      // 未公開の年は飛ばして続ける。範囲の指定ミスで全部落ちるより、取れた年で作って
      // 何が欠けたかを最後に見せる方が扱いやすい。
      console.log(`取得できません（${(e as Error).message}）`)
      missing.push(year)
      continue
    }
    const cat = buildYear(year, text, minMagnitude)
    console.log(`${cat.count} 件`)
    if (year === KNOWN.year) {
      verifyKnown(cat)
      verified = true
    }
    await writeFile(join(OUT_DIR, `${year}.json`), JSON.stringify(cat), 'utf-8')
    counts[String(year)] = cat.count
  }

  // **索引は出力ディレクトリの実態から作る。** 今回生成した年だけで書くと、範囲を絞って
  // 1 年を作り直した瞬間に**他の年が索引から消える**（ファイルは残るのに読めなくなる）。
  const merged = { ...(await readExistingCounts()), ...counts }
  const present = new Set(
    (await readdir(OUT_DIR)).filter((f) => /^\d{4}\.json$/.test(f)).map((f) => f.slice(0, 4)),
  )
  const finalCounts: Record<string, number> = {}
  for (const [year, count] of Object.entries(merged)) {
    // 手で消した年ファイルは索引からも落とす。
    if (present.has(year)) finalCounts[year] = count
  }
  // 索引にも今回の生成にも無いが、ファイルは在る年を拾う。**索引が壊れた状態から回復できる**
  // ようにするため（範囲を絞った再生成で索引を上書きしてしまった場合など）。件数はファイルから
  // 読む。通常は起きないので、その都度パースする手間は許容する。
  for (const year of present) {
    if (finalCounts[year] != null) continue
    const raw = await readFile(join(OUT_DIR, `${year}.json`), 'utf-8')
    const parsed = JSON.parse(raw) as { count?: number }
    if (typeof parsed.count === 'number') {
      finalCounts[year] = parsed.count
      console.log(`  索引に無かった ${year} 年をファイルから拾いました（${parsed.count} 件）`)
    }
  }

  const years = Object.keys(finalCounts).map(Number).sort((a, b) => a - b)
  if (years.length === 0) throw new Error('1 年も生成できませんでした')

  await writeFile(
    join(OUT_DIR, 'index.json'),
    JSON.stringify({
      source: '気象庁 地震月報（カタログ編）震源データ',
      sourceUrl: SOURCE_PAGE,
      license: '気象庁の公共データ利用規約（第1.0版）に基づき、加工して作成',
      minMagnitude,
      coordScale: COORD_SCALE,
      depthScale: DEPTH_SCALE,
      magScale: MAG_SCALE,
      years,
      counts: finalCounts,
    }),
    'utf-8',
  )

  const total = years.reduce((sum, y) => sum + finalCounts[String(y)], 0)
  console.log(`\n合計 ${total} 件 / ${years.length} 年ぶんを ${OUT_DIR} へ出力しました`)
  if (!verified) {
    // 2011 年を含めずに生成した場合。照合を通していないことを黙って済ませない。
    console.log(`※ ${KNOWN.year} 年を含めなかったため、既知の地震との照合は行っていません`)
  }
  if (missing.length > 0) {
    console.log(`※ 取得できなかった年: ${missing.join(', ')}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
