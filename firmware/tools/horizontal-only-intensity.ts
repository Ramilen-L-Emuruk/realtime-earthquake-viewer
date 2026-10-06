// 上下動が無いと震度はどれだけ下がるかを、K-NET/KiK-net（地表）の実波形で測る。
//
// IIS2ICLX は 2 軸なので、水平に寝かせた基板だけでは上下動を測れない。そのまま震度を
// 出すと、3 成分の合成から上下の分が抜けて低めに出る。その下がり幅を、同じ記録から
// 「3 成分で計算した値」と「上下を 0 にして計算した値」を出して比べる。
//
// **震度は 2 つの方式で出す。** 計測震度（気象庁の方式・記録全体に 1 回）と、
// リアルタイム震度の最大（ホストと同じ計算器・毎秒評価）。
//
// **計測震度は、記録の平均を引いてから計算する。** `calcSeismicIntensity` は記録を
// そのまま 0 で詰めて FFT に掛けるので、K-NET の記録に残る直流のずれが詰め目で段差になり、
// フィルタを抜けて震度を押し上げる（遠い観測点では 1 以上）。上下動は直流のずれが
// 大きいので、引かずに比べると「上下を抜いたら大きく下がった」ように見えてしまう。
// リアルタイム震度は計算器が最初の 1 秒の平均を引くので、ここでは何もしない。
//
// **階級の境目はアプリと同じ表**（`src/utils/measuredIntensity.ts`）から引く。この道具が数えるのは
// 境目をまたいだかどうかなので、別の引き方をすると数えている当のものがずれる。
//
// 使い方（リポジトリのいちばん上で）:
//   DRY=1 npx tsx firmware/tools/horizontal-only-intensity.ts  … 投げる予定の URL と件数だけ出す（通信しない）
//   npx tsx firmware/tools/horizontal-only-intensity.ts         … 本番
//
// - **要 NIED の登録。** `NIED_KNET_USER` / `NIED_KNET_PASSWORD` を環境変数か、
//   リポジトリ直下の `.env.local` に置く（ワークツリーには引き継がれない）
// - **取得は地震 1 つにつき 2 件**（月ごとの一覧と ZIP）。上限 8 件・3 秒おき。ZIP は
//   `.claude/knet-cache/`（`KNET_CACHE` で変更可）へ控え、2 回目からは取得しない。
//   ワークツリーで走らせるなら `KNET_CACHE` でメインの checkout 側を指すと取り直さずに済む
// - 観測点ごとの値は `OUT_DIR`（既定はカレント）の `horizontal-only-rows.json` へ書く
//
// 結果と読み方は firmware/README.md「上下動が無いと、震度はどれだけ下がるか」。
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllStationFiles } from '../../src/utils/knet/parseAllStationFiles'
import { groupIntoStations } from '../../src/utils/knet/knetAscii'
import { calcSeismicIntensity } from '../../src/utils/knet/seismicIntensity'
import { computeRealtimeIntensityTimeSeries } from '../../src/utils/knet/realtimeIntensity'
import { measuredIntensityToGrade } from '../../src/utils/measuredIntensity'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CACHE_DIR = process.env.KNET_CACHE ?? join(REPO_ROOT, '.claude', 'knet-cache')
const OUT_DIR = process.env.OUT_DIR ?? '.'
const DRY = process.env.DRY === '1'

/** 1 回の実行で投げてよい取得の上限。地震 4 つ × 2 件。 */
const MAX_REQUESTS = 8
const INTERVAL_MS = 3000

/** 内陸の地殻内の地震 4 つ。発生時刻（JST）。 */
const EVENTS = [
  { id: '2016-kumamoto', origin: '20160416012505' },
  { id: '2016-tottori', origin: '20161021140722' },
  { id: '2018-osaka', origin: '20180618075834' },
  { id: '2018-iburi', origin: '20180906030759' },
]

/** K-NET のイベントのディレクトリ名は発生時刻と数秒ずれるので、この範囲で最も近いものを採る。 */
const EVENT_MATCH_TOLERANCE_MS = 60_000

let requests = 0
const planned: string[] = []

async function get(url: string, auth: string): Promise<Response> {
  if (requests >= MAX_REQUESTS) throw new Error(`取得の上限 ${MAX_REQUESTS} 件に達したので止める: ${url}`)
  requests++
  planned.push(url)
  if (DRY) throw new DryRun()
  if (requests > 1) await new Promise((r) => setTimeout(r, INTERVAL_MS))
  console.log(`  取得 ${requests}/${MAX_REQUESTS}: ${url}`)
  return fetch(url, { headers: { Authorization: auth } })
}

class DryRun extends Error {}

function jstMs(ts: string): number {
  return Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12), +ts.slice(12, 14))
}

async function loadZip(origin: string, auth: string): Promise<Uint8Array | null> {
  const cachePath = join(CACHE_DIR, `${origin}.zip`)
  if (existsSync(cachePath)) return new Uint8Array(await readFile(cachePath))

  const base = `https://www.kyoshin.bosai.go.jp/kyoshin/download/all/zip/${origin.slice(0, 4)}/${origin.slice(4, 6)}/`
  let list: Response
  try {
    list = await get(base, auth)
  } catch (e) {
    if (!(e instanceof DryRun)) throw e
    // ZIP の URL は一覧の中身で決まるので、空振りでは形だけ数えておく
    requests++
    planned.push(`${base}<14桁>/<14桁>_ascii.zip（一覧から決まる）`)
    return null
  }
  if (!list.ok) throw new Error(`一覧の取得に失敗 (status=${list.status}) ${base}`)
  const dirs = [...(await list.text()).matchAll(/href="(\d{14})\/"/g)].map((m) => m[1])
  let best: string | null = null
  for (const d of dirs) {
    if (best === null || Math.abs(jstMs(d) - jstMs(origin)) < Math.abs(jstMs(best) - jstMs(origin))) best = d
  }
  if (best === null || Math.abs(jstMs(best) - jstMs(origin)) > EVENT_MATCH_TOLERANCE_MS) {
    throw new Error(`${origin} に近いディレクトリが一覧に無い（最も近いもの: ${best ?? 'なし'}）`)
  }
  const zipRes = await get(`${base}${best}/${best}_ascii.zip`, auth)
  if (!zipRes.ok) throw new Error(`ZIP の取得に失敗 (status=${zipRes.status})`)
  const buf = new Uint8Array(await zipRes.arrayBuffer())
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(cachePath, buf)
  console.log(`  控えた: ${cachePath}（${buf.byteLength} バイト）`)
  return buf
}

function demean(a: readonly number[]): number[] {
  const m = a.reduce((p, x) => p + x, 0) / a.length
  return a.map((x) => x - m)
}

/** リアルタイム震度の最大（毎秒評価）。刻みの決め方はホストと共有の関数に任せる。 */
function realtimeMax(ns: readonly number[], ew: readonly number[], ud: readonly number[], hz: number): number | null {
  let max: number | null = null
  for (const p of computeRealtimeIntensityTimeSeries(ns, ew, ud, hz, 1)) {
    if (p.intensity !== null && (max === null || p.intensity > max)) max = p.intensity
  }
  return max
}

/** 震度階級の順序（0=震度0 … 9=震度7）。境目はアプリと同じ表（`measuredIntensityToGrade`）から引く。 */
function rankOf(intensity: number): number | null {
  return measuredIntensityToGrade(intensity)?.rank ?? null
}

const RANK_NAMES = ['0', '1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7']

interface Row {
  readonly event: string
  readonly station: string
  readonly jma3: number | null
  readonly jmaH: number | null
  readonly rt3: number | null
  readonly rtH: number | null
}

function quantile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]
}

function printTable(rows: readonly Row[], pick: (r: Row) => [number | null, number | null]): void {
  console.log('階級(3成分) | 点数 | ずれ 中央値 | 平均 | 上位1割 | 最大 | 階級が下がる割合')
  for (let c = 1; c < RANK_NAMES.length; c++) {
    const sel: { d: number; drop: boolean }[] = []
    for (const r of rows) {
      const [full, horizontal] = pick(r)
      if (full === null || horizontal === null || rankOf(full) !== c) continue
      const hr = rankOf(horizontal)
      if (hr === null) continue
      sel.push({ d: full - horizontal, drop: hr < c })
    }
    if (sel.length === 0) continue
    const d = sel.map((x) => x.d).sort((a, b) => a - b)
    const mean = d.reduce((p, x) => p + x, 0) / d.length
    const dropPct = (100 * sel.filter((x) => x.drop).length) / sel.length
    console.log(
      `${RANK_NAMES[c]} | ${sel.length} | ${quantile(d, 0.5).toFixed(3)} | ${mean.toFixed(3)}`
      + ` | ${quantile(d, 0.9).toFixed(3)} | ${d[d.length - 1].toFixed(3)} | ${dropPct.toFixed(1)}%`,
    )
  }
}

async function main(): Promise<void> {
  const envPath = join(REPO_ROOT, '.env.local')
  if (existsSync(envPath)) {
    if (typeof process.loadEnvFile !== 'function') {
      throw new Error('Node.js 20.12 以上が必要です（.env.local の読み込みに process.loadEnvFile を使用）')
    }
    process.loadEnvFile(envPath)
  }
  const user = process.env.NIED_KNET_USER
  const password = process.env.NIED_KNET_PASSWORD
  if (!user || !password) throw new Error('NIED_KNET_USER / NIED_KNET_PASSWORD が必要です（.env.local または環境変数）')
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

  // **1 つが落ちても残りは数える。** 落ちたものは名前を出し、表の外にあることが分かるようにする
  const rows: Row[] = []
  const failedEvents: string[] = []
  const failedStations: string[] = []
  for (const ev of EVENTS) {
    console.log(`=== ${ev.id}`)
    // 取得と ZIP の展開を同じ try に入れる（壊れた控えや、200 で返ったエラーページでも展開が投げる）
    let stations: ReturnType<typeof groupIntoStations>['stations']
    try {
      const zip = await loadZip(ev.origin, auth)
      if (zip === null) continue
      const { files, failures } = parseAllStationFiles(zip)
      const grouped = groupIntoStations(files)
      stations = grouped.stations
      console.log(`  観測点 ${stations.length}（3 成分が揃わず除外 ${grouped.skippedIncomplete}・読めないファイル ${failures.length}）`)
    } catch (err) {
      failedEvents.push(`${ev.id}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    for (const s of stations) {
      // 3 成分の長さが揃っている保証は無い（groupIntoStations は長さを見ない）ので短いほうへ揃える
      const len = Math.min(s.components.NS.length, s.components.EW.length, s.components.UD.length)
      const [NS, EW, UD] = [s.components.NS, s.components.EW, s.components.UD].map((a) => a.slice(0, len))
      const hz = s.samplingHz
      const zero = new Array<number>(len).fill(0)
      const [ns, ew, ud] = [demean(NS), demean(EW), demean(UD)]
      try {
        rows.push({
          event: ev.id,
          station: s.stationCode,
          jma3: calcSeismicIntensity(ns, ew, ud, hz),
          jmaH: calcSeismicIntensity(ns, ew, zero, hz),
          rt3: realtimeMax(NS, EW, UD, hz),
          rtH: realtimeMax(NS, EW, zero, hz),
        })
      } catch (err) {
        failedStations.push(`${ev.id}/${s.stationCode}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  if (failedEvents.length > 0) console.log(`取れなかった地震 ${failedEvents.length}:\n  ${failedEvents.join('\n  ')}`)
  if (failedStations.length > 0) console.log(`計算できなかった観測点 ${failedStations.length}:\n  ${failedStations.join('\n  ')}`)

  if (DRY) {
    console.log(`空振り: 投げる予定の取得 ${requests} 件`)
    for (const u of planned) console.log(`  ${u}`)
    return
  }
  console.log(`実際の取得 ${requests} 件・観測点 ${rows.length}`)
  await writeFile(join(OUT_DIR, 'horizontal-only-rows.json'), JSON.stringify(rows))

  console.log('\n## 計測震度（気象庁の方式）')
  printTable(rows, (r) => [r.jma3, r.jmaH])
  console.log('\n## リアルタイム震度の最大（ホストの方式）')
  printTable(rows, (r) => [r.rt3, r.rtH])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
