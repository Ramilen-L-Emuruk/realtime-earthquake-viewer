/**
 * 公開観測点の表（`public/data/public-stations.json`）を EarthScope の観測点情報から作り直す。
 *
 * 気象庁が運用し IRIS（現 EarthScope）へ流している広帯域地震計の網（`JP`）を、
 * 下部の波形と地震カードに出すための表。観測点は移設・コードの付け替えで「エポック」
 * （運用期間）が分かれるので、エポックごとに 1 行を持つ（例: `ASAJ` は 2013-01-28 で終わり、
 * 同じ場所が `JKA` として続く）。どのエポックを使うかは使う側が時刻で選ぶ
 * （地震カードは地震の時刻・下部の波形はいま・リプレイ中は再生している時刻）。
 *
 * 取得元（FDSN station サービスのテキスト形式）:
 * - 観測点: `…/fdsnws/station/1/query?net=JP&format=text&nodata=404&level=station`
 * - 成分:   `…/fdsnws/station/1/query?net=JP&format=text&nodata=404&level=channel&cha=BH?`
 *
 * 取った応答は `.claude/public-stations-cache/` に残し、2 回目以降は読むだけにする。
 * 取り直すときは `--refresh`、投げる先だけ見たいときは `--dry-run`。
 *
 * **日本語の名前は上流に無いので、この中に手で持つ**（`NAMES_JA`）。名前は気象庁の観測点一覧
 * （地震・火山月報（カタログ編）の付録「地震観測点」。地方ごとの頁、例:
 * https://ds.data.jma.go.jp/eqev/data/bulletin/catalog/appendix/stkyushu.html ）の「観測点名」を
 * 表記のまま写したもの。一覧の「GS コード」の列が EarthScope の観測点コードに当たる。
 * 上流に名前の無い観測点が現れたら止まる —— 黙って英字のまま出さない。
 */
import type { PublicChannel, PublicStationEpoch, PublicStationsFile } from '../src/utils/publicStations'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

const BASE_URL = 'https://service.earthscope.org/fdsnws/station/1/query?net=JP&format=text&nodata=404'
export const SOURCE_URLS = {
  station: `${BASE_URL}&level=station`,
  channel: `${BASE_URL}&level=channel&cha=BH?`,
} as const
const CACHE_DIR = resolve(REPO_ROOT, '.claude/public-stations-cache')
const OUT_PATH = resolve(REPO_ROOT, 'public/data/public-stations.json')
const FETCH_TIMEOUT_MS = 30_000
/** 2 本を続けて投げるときの間隔。上限の明記は無いので、既存の生成スクリプトに倣って空ける。 */
const FETCH_INTERVAL_MS = 1_000

/**
 * 観測点コード → 気象庁の観測点名（一覧の表記のまま。県名が付く点と付かない点がある）。
 * 気象庁の一覧は `JKA`・`JCJ` を持たず、ほぼ同じ座標（数 m 以内）の `ASAJ`・`CBIJ` の行だけを持つ（コードの付け替え）。
 * その 2 つは付け替え前の行の名前を使う。`JMJ` と `JMJ2` は別の場所で、名前も違う。
 */
export const NAMES_JA: Readonly<Record<string, string>> = {
  ASAJ: '上川朝日',
  JKA: '上川朝日',
  JEM: 'えりも',
  JEW: '恵庭',
  JTM: '青森天間林',
  JMM: '宮城丸森',
  JYT: '茨城八郷',
  CBIJ: '父島三日月山',
  JCJ: '父島三日月山',
  JHJ2: '八丈島三根',
  JSD: '佐渡島銀山',
  JGF: '岐阜黒川',
  JSG: '静岡相良',
  JWT: '京都和知',
  JHS: '広島西城',
  JMN: '高知物部',
  JNU: '大分中津江',
  JTU: '対馬上県',
  JSU: '鹿児島錫山',
  JMJ: '宮古島西仲宗根',
  JMJ2: '宮古島３',
  JMZ: '南大東島池之沢',
  JOW: '沖縄国頭',
  YOJ: '与那国島',
}


/** 持つ成分と、その向き（方位角・傾斜）。`JP` 網は広帯域の 3 成分だけを流している。 */
const CHANNEL_ORIENTATION = {
  BHE: { azimuth: 90, dip: 0 },
  BHN: { azimuth: 0, dip: 0 },
  BHZ: { azimuth: 0, dip: -90 },
} as const
type ChannelCode = keyof typeof CHANNEL_ORIENTATION
const CHANNELS = Object.keys(CHANNEL_ORIENTATION) as ChannelCode[]
const NOMINAL_RATE_HZ = 20
/** 感度（カウント/(m/s)）。全成分が 1.0×10⁹ で、外れたら上流の形が変わったということ。 */
const NOMINAL_SENSITIVITY = 1e9
/** 感度を定めた周波数（Hz）。全成分が 8 Hz。 */
const NOMINAL_SENSITIVITY_FREQ_HZ = 8

/**
 * 上流の値が実データと食い違っていると確かめたもの。**ここに無い食い違いは止める。**
 * 鍵は「コード@エポックの始め.成分」で、エポックが分かれたら新しい側には効かない。
 * 受け取る側はレコードの見出しが名乗る採取率を正とするので、表の値は照合にだけ使う。
 */
const KNOWN_RATE_ANOMALIES: Readonly<Record<string, number>> = {
  // 上流は 30.113 Hz と名乗るが、2026-10-14 に受けた 519 レコードはすべて 20 Hz だった
  'YOJ@1996-10-14T00:00:00Z.BHN': 30.113,
}

/**
 * 波形の成分を持たないと確かめたエポック（「コード@始め」）。**ここに無いエポックが成分を
 * 持たなかったら止める** —— 上流の応答が欠けたときに、観測点が「外した」扱いで黙って消えないように。
 */
const KNOWN_NO_CHANNELS: ReadonlySet<string> = new Set([
  // 宮古島。2026-10-14 の応答で、どちらも BH? の成分を 1 本も持たなかった
  'JMJ@1996-09-24T00:00:00Z',
  'JMJ2@2013-03-28T00:00:00Z',
])

/** 生成物の検算に使う錨。上流が差し替わったことに気づくため、生成のたびに全部照合する。 */
const ANCHORS: { code: string; lat: number; lon: number; start: string; end: string | null }[] = [
  // 値は 2026-10-14 に取得した応答を、許容差（0.001 度）に見合う 3 桁へ丸めたもの。
  // 終わりは半開区間の値（上流の 2013-01-28T23:59:59.9999 を切り上げたもの）
  { code: 'JMN', lat: 33.731, lon: 133.876, start: '1996-09-26', end: null },
  { code: 'ASAJ', lat: 44.119, lon: 142.593, start: '1996-09-24', end: '2013-01-29T00:00:00Z' },
  { code: 'YOJ', lat: 24.467, lon: 123.011, start: '1996-10-14', end: null },
]
/** 錨の座標の許容差（度）。0.001 度 ≒ 100 m。 */
const ANCHOR_TOLERANCE_DEG = 0.001
/** 成分の座標と観測点の座標の許容差（度）。0.0001 度 ≒ 10 m。 */
const CHANNEL_COORD_TOLERANCE_DEG = 0.0001

// 表の型はアプリと共有する（`src/utils/publicStations.ts`）。ここで別に持つと、生成物と読む側の形が黙ってずれる。
export type { PublicChannel, PublicStationEpoch, PublicStationsFile } from '../src/utils/publicStations'

type Row = Record<string, string>

/** FDSN のテキスト形式（`#` で始まる見出し行＋`|` 区切り）を読む。 */
export function parseFdsnText(text: string): Row[] {
  const lines = text.split(/\r?\n/)
  const header = lines.find((l) => l.startsWith('#'))
  if (!header) throw new Error('見出し行（# で始まる行）がありません')
  const keys = header.slice(1).split('|').map((k) => k.trim())
  const rows: Row[] = []
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue
    const cells = line.split('|')
    if (cells.length !== keys.length) throw new Error(`列の数が見出しと合いません: ${line}`)
    rows.push(Object.fromEntries(keys.map((k, i) => [k, cells[i].trim()])))
  }
  return rows
}

function num(row: Row, key: string): number {
  const v = Number(row[key])
  if (row[key] === undefined || row[key] === '' || !Number.isFinite(v)) {
    throw new Error(`${row.Station ?? '?'} の ${key} が数値として読めません: ${row[key]}`)
  }
  return v
}

const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?$/

function toIso(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`
}

/** 上流の始めの時刻（小数秒つき・時間帯なし・UTC）を秒までの ISO 8601 へ切り捨てる。空なら null。 */
function startIso(value: string | undefined, label: string): string | null {
  if (!value) return null
  const m = TIME_RE.exec(value)
  if (!m) throw new Error(`${label} の時刻が読めません: ${value}`)
  return `${value.slice(0, 19)}Z`
}

/** 上流の終わりの時刻（含む側）を、秒へ切り上げた半開区間の終わりにする。空なら null。 */
export function endIso(value: string | undefined, label: string): string | null {
  if (!value) return null
  const m = TIME_RE.exec(value)
  if (!m) throw new Error(`${label} の時刻が読めません: ${value}`)
  const [, y, mo, d, h, mi, s, frac] = m
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
  return toIso(frac && Number(frac) > 0 ? ms + 1000 : ms)
}

/** ISO 8601（固定長・`Z` 付き）同士の比較。辞書順が時刻順と一致する。 */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function inEpoch(t: string, start: string, end: string | null): boolean {
  return t >= start && (end === null || t < end)
}

/** 2 つの応答から表を組み立てる。合わないところがあれば例外で止める。 */
export function buildPublicStations(stationText: string, channelText: string, fetchedOn: string): PublicStationsFile {
  const stationRows = parseFdsnText(stationText)
  const channelRows = parseFdsnText(channelText)
  const problems: string[] = []
  const stations: PublicStationEpoch[] = []
  const excluded: PublicStationsFile['excluded'] = []
  const seenNoChannels = new Set<string>()
  const usedRateAnomalies = new Set<string>()

  for (const s of stationRows) {
    const code = s.Station
    const start = startIso(s.StartTime, `${code} の始め`)
    const end = endIso(s.EndTime, `${code} の終わり`)
    if (!start) {
      problems.push(`${code}: 運用の始めがありません`)
      continue
    }
    const epochKey = `${code}@${start}`
    const nameJa = NAMES_JA[code]
    if (!nameJa) problems.push(`${code}（${s.SiteName}）: 日本語の名前が NAMES_JA にありません`)
    const lat = num(s, 'Latitude')
    const lon = num(s, 'Longitude')
    // このエポックの期間に入る成分だけを拾う（成分の期間は観測点の期間の中に収まるはず）
    const mine = channelRows.filter((c) => {
      if (c.Station !== code) return false
      const cs = startIso(c.StartTime, `${code}.${c.Channel} の始め`)
      return cs !== null && inEpoch(cs, start, end)
    })
    if (mine.length === 0) {
      if (KNOWN_NO_CHANNELS.has(epochKey)) {
        seenNoChannels.add(epochKey)
        excluded.push({ code, start, end, reason: '波形の成分（BH?）を持たない' })
      } else {
        problems.push(`${epochKey}: 波形の成分が 1 本も無い（応答の欠けでないか確かめ、外してよいなら KNOWN_NO_CHANNELS へ足す）`)
      }
      continue
    }
    const channels: PublicChannel[] = []
    for (const ch of CHANNELS) {
      const hits = mine.filter((c) => c.Channel === ch)
      if (hits.length !== 1) {
        problems.push(`${code}: ${ch} が ${hits.length} 件（1 件のはず）`)
        continue
      }
      const c = hits[0]
      const cEnd = endIso(c.EndTime, `${code}.${ch} の終わり`)
      if (cEnd !== end) problems.push(`${code}.${ch}: 成分の終わり（${cEnd}）が観測点の終わり（${end}）と違う`)
      // 成分と観測点で末尾の桁が違うことがある（JTU の BHN・BHZ は経度が 0.00003 度 ≒ 3 m 違う）。
      // 10 m を超えたら別の場所として止める
      if (Math.abs(num(c, 'Latitude') - lat) > CHANNEL_COORD_TOLERANCE_DEG || Math.abs(num(c, 'Longitude') - lon) > CHANNEL_COORD_TOLERANCE_DEG) {
        problems.push(`${code}.${ch}: 成分の座標が観測点の座標と違う`)
      }
      const sampleRate = num(c, 'SampleRate')
      const anomalyKey = `${epochKey}.${ch}`
      const known = KNOWN_RATE_ANOMALIES[anomalyKey]
      if (known !== undefined && sampleRate === known) usedRateAnomalies.add(anomalyKey)
      if (sampleRate !== NOMINAL_RATE_HZ && sampleRate !== known) {
        problems.push(`${code}.${ch}: 採取率 ${sampleRate} Hz（${NOMINAL_RATE_HZ} Hz のはず。実データを確かめて KNOWN_RATE_ANOMALIES へ足すか判断する）`)
      }
      const sensitivity = num(c, 'Scale')
      if (Math.abs(sensitivity / NOMINAL_SENSITIVITY - 1) > 0.01) {
        problems.push(`${code}.${ch}: 感度 ${sensitivity}（${NOMINAL_SENSITIVITY} の ±1% のはず）`)
      }
      const sensitivityFreq = num(c, 'ScaleFreq')
      if (sensitivityFreq !== NOMINAL_SENSITIVITY_FREQ_HZ) {
        problems.push(`${code}.${ch}: 感度を定めた周波数 ${sensitivityFreq} Hz（${NOMINAL_SENSITIVITY_FREQ_HZ} Hz のはず）`)
      }
      if (c.ScaleUnits !== 'M/S') problems.push(`${code}.${ch}: 感度の単位が ${c.ScaleUnits}（M/S のはず）`)
      // 向きは成分の名前と一致していなければならない（東西と南北の取り違え・上下の符号の反転を止める）
      const azimuth = num(c, 'Azimuth')
      const dip = num(c, 'Dip')
      const want = CHANNEL_ORIENTATION[ch]
      if (azimuth !== want.azimuth || dip !== want.dip) {
        problems.push(`${code}.${ch}: 向き 方位 ${azimuth}・傾斜 ${dip}（方位 ${want.azimuth}・傾斜 ${want.dip} のはず）`)
      }
      channels.push({ code: ch, sampleRate, sensitivity, sensitivityFreq, azimuth, dip })
    }
    const stray = mine.filter((c) => !(CHANNELS as readonly string[]).includes(c.Channel))
    for (const c of stray) problems.push(`${code}: 想定していない成分 ${c.Channel}`)
    stations.push({
      code,
      nameJa: nameJa ?? '',
      siteName: s.SiteName,
      lat,
      lon,
      elevation: num(s, 'Elevation'),
      start,
      end,
      channels,
    })
  }

  for (const key of KNOWN_NO_CHANNELS) {
    if (!seenNoChannels.has(key)) problems.push(`KNOWN_NO_CHANNELS の ${key} は、成分を持たないエポックとして現れなかった`)
  }

  for (const key of Object.keys(KNOWN_RATE_ANOMALIES)) {
    if (!usedRateAnomalies.has(key)) problems.push(`KNOWN_RATE_ANOMALIES の ${key} は使われなかった（上流が直したなら外す）`)
  }

  // 同じコードのエポックが重ならないか（重なると 1 本の成分が両方へ割り当てられる）
  const byCode = new Map<string, { start: string; end: string | null }[]>()
  for (const s of stationRows) {
    const start = startIso(s.StartTime, `${s.Station} の始め`)
    if (!start) continue
    byCode.set(s.Station, [...(byCode.get(s.Station) ?? []), { start, end: endIso(s.EndTime, `${s.Station} の終わり`) }])
  }
  for (const [code, list] of byCode) {
    list.sort((a, b) => cmp(a.start, b.start))
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]
      if (prev.end === null || prev.end > list[i].start) problems.push(`${code}: エポック ${prev.start}〜 と ${list[i].start}〜 が重なる`)
    }
  }

  // どのエポックにも入らなかった成分の行が残っていないか
  for (const c of channelRows) {
    const cs = startIso(c.StartTime, `${c.Station}.${c.Channel} の始め`)
    const owner = stations.some((s) => s.code === c.Station && cs !== null && inEpoch(cs, s.start, s.end))
    if (!owner) problems.push(`${c.Station}.${c.Channel}（${c.StartTime}〜）: 対応する観測点のエポックが無い`)
  }

  for (const a of ANCHORS) {
    const hit = stations.find((s) => s.code === a.code && s.start.startsWith(a.start))
    if (!hit) {
      problems.push(`錨 ${a.code}（${a.start}〜）が見つからない`)
      continue
    }
    if (Math.abs(hit.lat - a.lat) > ANCHOR_TOLERANCE_DEG || Math.abs(hit.lon - a.lon) > ANCHOR_TOLERANCE_DEG) {
      problems.push(`錨 ${a.code}: 座標 ${hit.lat}, ${hit.lon}（${a.lat}, ${a.lon} のはず）`)
    }
    if (hit.end !== a.end) problems.push(`錨 ${a.code}: 終わり ${hit.end}（${a.end} のはず）`)
  }

  // NAMES_JA に上流に無いコードが残っていないか（廃止の見落とし・綴りの誤り）
  const upstreamCodes = new Set(stationRows.map((s) => s.Station))
  for (const code of Object.keys(NAMES_JA)) {
    if (!upstreamCodes.has(code)) problems.push(`NAMES_JA の ${code} は上流に無い`)
  }

  if (problems.length > 0) throw new Error(`公開観測点の表を作れません:\n- ${problems.join('\n- ')}`)

  stations.sort((a, b) => cmp(a.code, b.code) || cmp(a.start, b.start))
  excluded.sort((a, b) => cmp(a.code, b.code) || cmp(a.start, b.start))
  return { source: { ...SOURCE_URLS }, fetchedOn, stations, excluded }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${url} が ${res.status} を返しました`)
  return res.text()
}

const KNOWN_ARGS = new Set(['--dry-run', '--refresh'])

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const unknown = args.filter((a) => !KNOWN_ARGS.has(a))
  if (unknown.length > 0) throw new Error(`知らない引数: ${unknown.join(' ')}（使えるのは ${[...KNOWN_ARGS].join(' ')}）`)
  const dryRun = args.includes('--dry-run')
  const keys = Object.keys(SOURCE_URLS) as (keyof typeof SOURCE_URLS)[]
  const paths = Object.fromEntries(keys.map((k) => [k, resolve(CACHE_DIR, `${k}.txt`)])) as Record<keyof typeof SOURCE_URLS, string>
  const stamp = resolve(CACHE_DIR, 'fetched-on.txt')
  // 2 本と取得日は揃って 1 組。どれか欠けていれば 2 本とも取り直す（取得日が片方とずれないように）
  const useCache = !args.includes('--refresh') && keys.every((k) => existsSync(paths[k])) && existsSync(stamp)
  const texts: Record<keyof typeof SOURCE_URLS, string> = { station: '', channel: '' }
  let fetchedOn: string
  if (useCache) {
    for (const k of keys) {
      texts[k] = readFileSync(paths[k], 'utf8')
      console.log(`[控え] ${k}: ${paths[k]}`)
    }
    fetchedOn = readFileSync(stamp, 'utf8').trim()
  } else {
    if (dryRun) {
      for (const k of keys) console.log(`[投げる予定] ${SOURCE_URLS[k]}`)
      console.log(`空振りで終えました（${keys.length} 件を投げる予定。何も書き出していません）`)
      return
    }
    for (const [i, k] of keys.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, FETCH_INTERVAL_MS))
      console.log(`[取得] ${SOURCE_URLS[k]}`)
      texts[k] = await fetchText(SOURCE_URLS[k])
    }
    fetchedOn = new Date().toISOString().slice(0, 10)
  }
  if (dryRun) {
    console.log('空振りで終えました（控えがあるので投げる予定は 0 件。何も書き出していません）')
    return
  }
  // 取った応答はすぐ控える。検査に落ちても、表（KNOWN_* や NAMES_JA）を直した次の実行は通信せずに同じ応答で試せる
  if (!useCache) {
    mkdirSync(CACHE_DIR, { recursive: true })
    for (const k of keys) writeFileSync(paths[k], texts[k])
    writeFileSync(stamp, fetchedOn)
  }
  let file: PublicStationsFile
  try {
    file = buildPublicStations(texts.station, texts.channel, fetchedOn)
  } catch (err) {
    const hint = useCache ? `
（控え ${CACHE_DIR} の応答で検査した。上流が直っているかもしれないなら --refresh で取り直す）` : ''
    throw new Error(`${err instanceof Error ? err.message : String(err)}${hint}`)
  }
  writeFileSync(OUT_PATH, `${JSON.stringify(file, null, 2)}\n`)
  const current = file.stations.filter((s) => s.end === null).length
  console.log(`書き出しました: ${OUT_PATH}（エポック ${file.stations.length} 件・運用中 ${current} 点・外した ${file.excluded.length} 件・取得 ${useCache ? 0 : keys.length} 件）`)
  for (const e of file.excluded) console.log(`  外した: ${e.code}（${e.start}〜${e.end ?? ''}）${e.reason}`)
}

/**
 * 直接実行のときだけ動かす。テストが `buildPublicStations` を読むだけで取得まで走らないように
 * （理由は `scripts/build-epicenter-accents.ts` の末尾）。
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
