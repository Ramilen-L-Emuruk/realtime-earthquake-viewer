/**
 * 強震モニタ検知エンジン（`src/utils/kyoshinDetector.ts`）の実データ回帰検証。
 *
 * Yahoo 強震モニタの過去フレームを取得してローカルにキャッシュし、検知エンジンへ 1 フレームずつ流して
 * 「初めて likely になった時刻」「初めて confirmed になった時刻」を測る。ユニットテストは合成フレームで
 * 判定ロジックを固定するが、実地震の立ち上がり方（震源最近傍の単点が先行する等）の変化は捕まえられない
 * ため、検知エンジンを変更したらこちらも回す（CLAUDE.md「特殊ケース: 強震モニタ検知エンジンを変更したとき」）。
 *
 * ## 使い方
 *
 * ```bash
 * # 既定の窓（能登半島地震 本震）を測る
 * npm run probe-kyoshin
 *
 * # 窓を指定する（label:開始時刻(JST・yyyyMMddHHmmss):秒数 をカンマ区切り）
 * npm run probe-kyoshin -- "noto:20240101160930:180,calm:20260820030000:600"
 *
 * # キャッシュ済みの窓を測り直す（秒数 0 でネットワークに行かない）
 * npm run probe-kyoshin -- "noto:x:0"
 * ```
 *
 * ## 変更前との比較
 *
 * 同一ワークツリー内で `git stash push src/utils/kyoshinDetector.ts` を挟み、同じ窓を測り直して
 * 突き合わせるのが最も確実（別チェックアウトを跨がないので、どちらのコードを測ったのか取り違えない）。
 * 測り終えたら `git stash pop` を忘れないこと。
 *
 * ## 注意
 *
 * - 取得したフレームは `.probe-cache/`（Git 管理外）に置く。1 窓 180 秒で数 MB になる
 * - 観測点リストの版（`siteConfigId`）は年で変わる。窓ごとに先頭フレームの版を採り、対応する
 *   `sitelist_{版}.json` を引く。窓が版の切替を跨ぐと警告を出す（その窓は結果が信用できない）
 * - Yahoo が保持しているのは 2020 年以降
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { initState, buildStationMeta, step, indexToValue } from '../src/utils/kyoshinDetector'

/** 取得済みフレームの置き場（Git 管理外）。 */
const CACHE_DIR = process.env.PROBE_CACHE ?? '.probe-cache'
/** 既定の測定窓。引数が無いときはこれを測る。 */
const DEFAULT_SPECS = 'noto:20240101160930:180'
/** 同時に投げる取得リクエスト数。 */
const FETCH_CONCURRENCY = 16

const REALTIME_BASE = (edge: 'west' | 'east') =>
  `https://weather-kyoshin.${edge}.edge.storage-yahoo.jp/RealTimeData`
const SITELIST_BASE = 'https://weather-kyoshin.west.edge.storage-yahoo.jp/SiteList'

/** 1 フレーム分の観測データ（キャッシュに載る形）。 */
interface Frame {
  /** データ時刻(ms)。検知エンジンへ `dataTimeMs` として渡す */
  ms: number
  /** yyyyMMddHHmmss（表示用） */
  ts: string
  /** 観測点ごとの震度インデックス。負の値は欠測 */
  indices: number[]
  /** 観測点リストの版 */
  cfg: string
}

/** JST の壁時計として `base` から `offsetSec` 秒進めた時刻の、取得用パス部品を作る。 */
function pathAt(base: string, offsetSec: number): { dateStr: string; ts: string; ms: number } {
  const y = +base.slice(0, 4)
  const mo = +base.slice(4, 6)
  const d = +base.slice(6, 8)
  const h = +base.slice(8, 10)
  const mi = +base.slice(10, 12)
  const s = +base.slice(12, 14)
  // Yahoo のパスは JST 表記。UTC の暦計算をそのまま JST の壁時計として扱う（時差を足さない）
  const t = Date.UTC(y, mo - 1, d, h, mi, s) + offsetSec * 1000
  const dt = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  const dateStr = `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}`
  const ts = `${dateStr}${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}${p(dt.getUTCSeconds())}`
  return { dateStr, ts, ms: t }
}

/** 1 フレームを取得する。west→east の順に試し、どちらも駄目なら null（その秒は欠落として扱う）。 */
async function fetchFrame(dateStr: string, ts: string, ms: number): Promise<Frame | null> {
  for (const edge of ['west', 'east'] as const) {
    try {
      const res = await fetch(`${REALTIME_BASE(edge)}/${dateStr}/${ts}.json`)
      if (!res.ok) continue
      const json = (await res.json()) as {
        realTimeData?: { siteConfigId?: string; intensity?: string }
      }
      const rt = json.realTimeData
      if (!rt || typeof rt.intensity !== 'string' || rt.intensity.length === 0) continue
      // 震度は 1 文字 1 観測点。services/kyoshin.ts と同じ変換（charCode - 100）
      return {
        ms,
        ts,
        indices: Array.from(rt.intensity, (c) => c.charCodeAt(0) - 100),
        cfg: rt.siteConfigId ?? '',
      }
    } catch {
      // このエッジは諦めて次へ。両方失敗したら null を返す
    }
  }
  return null
}

/** 窓のフレーム列を得る。キャッシュがあればそれを使い、無ければ取得して保存する。 */
async function loadFrames(label: string, start: string, seconds: number): Promise<Frame[]> {
  const path = `${CACHE_DIR}/${label}.json`
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as Frame[]
  if (seconds <= 0) {
    console.log(`[${label}] キャッシュが無い。秒数を指定して取得すること`)
    return []
  }
  const targets = Array.from({ length: seconds }, (_, i) => pathAt(start, i))
  const fetched: (Frame | null)[] = []
  for (let i = 0; i < targets.length; i += FETCH_CONCURRENCY) {
    const chunk = targets.slice(i, i + FETCH_CONCURRENCY)
    fetched.push(...(await Promise.all(chunk.map((t) => fetchFrame(t.dateStr, t.ts, t.ms)))))
  }
  const frames = fetched.filter((f): f is Frame => f != null)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(frames))
  console.log(`[${label}] 取得 ${frames.length}/${seconds} フレーム`)
  return frames
}

const sitesCache = new Map<string, [number, number][]>()

/** 観測点リスト（版指定）を得る。キャッシュを挟む。 */
async function loadSites(cfg: string): Promise<[number, number][]> {
  const hit = sitesCache.get(cfg)
  if (hit) return hit
  const path = `${CACHE_DIR}/sites_${cfg}.json`
  let sites: [number, number][]
  if (existsSync(path)) {
    sites = JSON.parse(readFileSync(path, 'utf8')) as [number, number][]
  } else {
    const res = await fetch(`${SITELIST_BASE}/sitelist_${cfg}.json`)
    const raw = (await res.json()) as { items?: [number, number][] } | [number, number][]
    sites = (Array.isArray(raw) ? raw : (raw.items ?? [])) as [number, number][]
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(sites))
  }
  sitesCache.set(cfg, sites)
  return sites
}

/** 1 窓を測った結果。 */
interface Measured {
  /** 初めて likely 以上になったフレームの時刻（HHmmss）。一度も無ければ null */
  firstLikely: string | null
  /** 初めて confirmed になったフレームの時刻（HHmmss）。一度も無ければ null */
  firstConfirmed: string | null
  /** confirmed が立っていたフレーム数 */
  confirmedFrames: number
  /** confirmed イベントの `lastSize` の最大 */
  maxSize: number
  /** 窓の中で観測された最大 value */
  peakValue: number
}

function measure(frames: Frame[], sites: [number, number][]): Measured {
  const meta = buildStationMeta(sites)
  let state = initState(frames[0].ms - 1000)
  const out: Measured = {
    firstLikely: null,
    firstConfirmed: null,
    confirmedFrames: 0,
    maxSize: 0,
    peakValue: -Infinity,
  }
  for (const f of frames) {
    const missing = f.indices.map((v) => v < 0)
    for (let i = 0; i < f.indices.length; i++) {
      if (missing[i]) continue
      const v = indexToValue(f.indices[i])
      if (v > out.peakValue) out.peakValue = v
    }
    const r = step(
      state,
      { dataTimeMs: f.ms, sites, values: f.indices, missing, eewActive: false },
      meta,
    )
    state = r.state
    const hhmmss = f.ts.slice(8)
    if (!out.firstLikely && r.detections.some((d) => d.confidence !== 'weak' && d.confidence !== 'faint')) {
      out.firstLikely = hhmmss
    }
    const confirmed = r.detections.filter((d) => d.confidence === 'confirmed')
    if (confirmed.length > 0) {
      if (!out.firstConfirmed) out.firstConfirmed = hhmmss
      out.confirmedFrames++
      for (const d of confirmed) out.maxSize = Math.max(out.maxSize, d.lastSize)
    }
  }
  return out
}

async function main(): Promise<void> {
  const specs = (process.argv[2] ?? DEFAULT_SPECS).split(',')
  for (const spec of specs) {
    const [label, start, seconds] = spec.split(':')
    if (!label) continue
    const frames = await loadFrames(label, start ?? '', Number(seconds ?? 0))
    if (frames.length === 0) continue
    const cfgs = new Set(frames.map((f) => f.cfg))
    const sites = await loadSites(frames[0].cfg)
    console.log('')
    console.log(`=== ${label}: ${frames.length}フレーム / ${sites.length}点 / 版 ${frames[0].cfg} ===`)
    if (cfgs.size > 1) {
      console.log(`!! 窓の中で観測点リストの版が変わっている（${[...cfgs].join(', ')}）。結果は信用できない`)
    }
    if (sites.length !== frames[0].indices.length) {
      console.log(`!! 観測点リスト(${sites.length})と震度列(${frames[0].indices.length})の長さが違う`)
      continue
    }
    const m = measure(frames, sites)
    console.log(`窓の最大震度(value)  : ${m.peakValue}`)
    console.log(`初 likely            : ${m.firstLikely ?? 'なし'}`)
    console.log(`初 confirmed         : ${m.firstConfirmed ?? 'なし'}`)
    console.log(`confirmed 継続フレーム: ${m.confirmedFrames}`)
    console.log(`confirmed 最大 size  : ${m.maxSize}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
