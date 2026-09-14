/**
 * 強震モニタ検知エンジンの「助走」の効きを実データで測る。
 *
 * ## 何を測るか
 *
 * 助走は「供給が始まる前のフレームを検知エンジンだけへ先に食わせる」仕組み
 * （→ `src/utils/kyoshinWarmup.ts`・`docs/spec/kyoshin-detection-spec.md` §7）。
 * ここで測るのは **「その時刻から再生を始めた場合」が「ずっと再生し続けた場合」と
 * どれだけ一致するか**。一致の基準は検知の段階（confirmed / likely / なし）と最大震度で、
 * イベントの件数は見ない（本震で生まれた古いイベントは助走の範囲外になるため、
 * 遡りの長さに素直に比例してしまう）。
 *
 * 検知エンジンのユニットテストは合成フレームなので、実地震の立ち上がり方は捕まえられない。
 * `npm run bench-kyoshin` は窓の**先頭から**流すので、「途中から入る」形は測れない。
 * この 2 つの隙間を埋めるのがこのスクリプト。
 *
 * ## 使い方
 *
 * ```bash
 * # 窓を取得する（初回のみ。7 本 × 15 分 ≒ 6300 フレーム・数分）
 * npx tsx scripts/measure-kyoshin-warmup.ts --fetch
 *
 * # 助走の長さを変えて一致率を見る
 * npx tsx scripts/measure-kyoshin-warmup.ts --warmups=0,180,300,600
 *
 * # 実装と同じ「60 秒ブロックで遡り、静穏で打ち切る」方式で測る
 * npx tsx scripts/measure-kyoshin-warmup.ts --adaptive
 * ```
 *
 * キャッシュの置き場は `npm run bench-kyoshin` と同じ（環境変数 `KYOSHIN_BENCH_CACHE`・
 * 既定 `.probe-cache`）。観測点リストもそちらと共有する。
 *
 * ## 測定に使う窓
 *
 * 大地震 7 本。**地震発生の 1 分後から 12.5 分後まで**を 30 秒刻みで走査する（164 点）。
 * 揺れが完全に収まった後は「ずっと再生」でも検知が消えるので、そこは測っても差が出ない。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { initState, buildStationMeta, step, indexToValue } from '../src/utils/kyoshinDetector'
import type { DetectionEvent, DetectorState, StationMeta } from '../src/utils/kyoshinDetector'
import {
  WARMUP_BLOCK_SEC, WARMUP_MAX_BLOCKS, isQuietFrame,
} from '../src/utils/kyoshinWarmup'

const CACHE_DIR = process.env.KYOSHIN_BENCH_CACHE ?? '.probe-cache'
const REALTIME_BASE = (edge: 'west' | 'east'): string =>
  `https://weather-kyoshin.${edge}.edge.storage-yahoo.jp/RealTimeData`
const SITELIST_BASE = 'https://weather-kyoshin.west.edge.storage-yahoo.jp/SiteList'
/** 取得の同時実行数（`bench-kyoshin` と同じ）。 */
const FETCH_CONCURRENCY = 24

interface Frame { ms: number; ts: string; indices: number[]; cfg: string }

/**
 * 測定に使う窓。`start` は JST の壁時計（`bench-kyoshin` の窓カタログと同じ表記）。
 *
 * `quakeAt` は窓の先頭から地震発生までの秒数。走査はここから 1 分後に始める。
 */
const WINDOWS: { label: string; start: string; seconds: number; quakeAt: number; name: string }[] = [
  { label: 'warmup-noto2024', start: '20240101160800', seconds: 780, quakeAt: 120, name: '2024/01/01 能登半島地震 M7.6' },
  { label: 'warmup-noto2023', start: '20230505144000', seconds: 900, quakeAt: 120, name: '2023/05/05 石川県能登地方 M6.3' },
  { label: 'warmup-fukushima2022', start: '20220316233400', seconds: 900, quakeAt: 120, name: '2022/03/16 福島県沖 M7.3' },
  { label: 'warmup-fukushima2021', start: '20210213230600', seconds: 900, quakeAt: 120, name: '2021/02/13 福島県沖 M7.1' },
  { label: 'warmup-hyuganada2024', start: '20240808164100', seconds: 900, quakeAt: 120, name: '2024/08/08 日向灘 M6.9' },
  { label: 'warmup-bungo2024', start: '20240417231200', seconds: 900, quakeAt: 120, name: '2024/04/17 豊後水道 M6.4' },
  { label: 'warmup-chiba2021', start: '20211007223900', seconds: 900, quakeAt: 120, name: '2021/10/07 千葉県北西部 M6.1' },
]

/** 走査の刻み（秒）。 */
const SWEEP_STEP_SEC = 30
/** 走査を始める「地震発生からの経過」（秒）。 */
const SWEEP_FROM_SEC = 60

// ============================================================
// 取得
// ============================================================

/** JST の壁時計として `base` から `offsetSec` 秒進めた時刻の、取得用パス部品を作る。 */
function pathAt(base: string, offsetSec: number): { dateStr: string; ts: string; ms: number } {
  // Yahoo のパスは JST 表記。UTC の暦計算をそのまま JST の壁時計として扱う（時差を足さない）
  const t = Date.UTC(
    +base.slice(0, 4), +base.slice(4, 6) - 1, +base.slice(6, 8),
    +base.slice(8, 10), +base.slice(10, 12), +base.slice(12, 14),
  ) + offsetSec * 1000
  const dt = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  const dateStr = `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}`
  return { dateStr, ts: `${dateStr}${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}${p(dt.getUTCSeconds())}`, ms: t }
}

async function fetchFrame(dateStr: string, ts: string, ms: number): Promise<Frame | null> {
  for (const edge of ['west', 'east'] as const) {
    try {
      const res = await fetch(`${REALTIME_BASE(edge)}/${dateStr}/${ts}.json`)
      if (!res.ok) continue
      const json = await res.json() as { realTimeData?: { siteConfigId?: string; intensity?: string } }
      const rt = json.realTimeData
      if (!rt || typeof rt.intensity !== 'string' || rt.intensity.length === 0) continue
      // 震度は 1 文字 1 観測点。services/kyoshin.ts と同じ変換（charCode - 100）
      return { ms, ts, indices: Array.from(rt.intensity, (c) => c.charCodeAt(0) - 100), cfg: rt.siteConfigId ?? '' }
    } catch {
      // このエッジは諦めて次へ
    }
  }
  return null
}

async function fetchWindow(w: typeof WINDOWS[number]): Promise<void> {
  const path = `${CACHE_DIR}/${w.label}.json`
  if (existsSync(path)) { console.log(`  ${w.label}: 既にある`); return }
  const targets = Array.from({ length: w.seconds }, (_, i) => pathAt(w.start, i))
  const out: Frame[] = []
  for (let i = 0; i < targets.length; i += FETCH_CONCURRENCY) {
    const chunk = targets.slice(i, i + FETCH_CONCURRENCY)
    const got = await Promise.all(chunk.map(t => fetchFrame(t.dateStr, t.ts, t.ms)))
    for (const f of got) if (f) out.push(f)
  }
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(path, JSON.stringify(out))
  console.log(`  ${w.label}: ${out.length}/${w.seconds} 取得 cfg=${out[0]?.cfg}`)
  const cfg = out[0]?.cfg
  if (cfg && !existsSync(`${CACHE_DIR}/sites_${cfg}.json`)) {
    const res = await fetch(`${SITELIST_BASE}/sitelist_${cfg}.json`)
    const raw = await res.json() as { items?: [number, number][] } | [number, number][]
    writeFileSync(`${CACHE_DIR}/sites_${cfg}.json`, JSON.stringify(Array.isArray(raw) ? raw : (raw.items ?? [])))
    console.log(`  sites_${cfg}: 取得`)
  }
}

// ============================================================
// 測定
// ============================================================

interface Snap { tier: string; maxInt: number }

function snap(dets: DetectionEvent[]): Snap {
  const shown = dets.filter(d => d.confidence === 'confirmed' || d.confidence === 'likely')
  const conf = shown.filter(d => d.confidence === 'confirmed')
  return {
    tier: conf.length > 0 ? 'confirmed' : shown.length > 0 ? 'likely' : 'なし',
    maxInt: shown.length > 0 ? Math.max(...shown.map(d => d.maxIntensity)) : NaN,
  }
}

function same(a: Snap, b: Snap): boolean {
  if (a.tier !== b.tier) return false
  if (Number.isNaN(a.maxInt) && Number.isNaN(b.maxInt)) return true
  return Math.abs(a.maxInt - b.maxInt) < 0.1
}

/** 実装と同じ規則で、どこまで遡るかを決める（`kyoshinWarmup.ts` の判定を共有する）。 */
function adaptiveStart(frames: Frame[], at: number): number {
  for (let b = 1; b <= WARMUP_MAX_BLOCKS; b++) {
    const head = Math.max(0, at - b * WARMUP_BLOCK_SEC)
    if (head === 0) return 0
    if (isQuietFrame(frames[head].indices)) return head
  }
  return Math.max(0, at - WARMUP_MAX_BLOCKS * WARMUP_BLOCK_SEC)
}

function main(): void {
  const args = process.argv.slice(2)
  const adaptive = args.includes('--adaptive')
  const warmupArg = args.find(a => a.startsWith('--warmups='))
  const warmups = warmupArg ? warmupArg.slice('--warmups='.length).split(',').map(Number) : [0, 180, 300, 600]

  const columns = adaptive ? ['遡って打ち切る'] : warmups.map(w => `${w}s`)
  const agree = new Map<string, number>(columns.map(c => [c, 0]))
  const fetched = new Map<string, number[]>(columns.map(c => [c, []]))
  let total = 0

  for (const w of WINDOWS) {
    const path = `${CACHE_DIR}/${w.label}.json`
    if (!existsSync(path)) { console.log(`${w.name}: 窓が無い（--fetch で取得する）`); continue }
    const frames = JSON.parse(readFileSync(path, 'utf8')) as Frame[]
    const sitesPath = `${CACHE_DIR}/sites_${frames[0].cfg}.json`
    if (!existsSync(sitesPath)) { console.log(`${w.name}: 観測点リスト（${frames[0].cfg}）が無い`); continue }
    const sites = JSON.parse(readFileSync(sitesPath, 'utf8')) as [number, number][]
    const meta: StationMeta = buildStationMeta(sites)
    const advance = (state: DetectorState, f: Frame): { state: DetectorState; dets: DetectionEvent[] } => {
      const r = step(state, { dataTimeMs: f.ms, sites, values: f.indices, missing: f.indices.map(v => v < 0), eewActive: false }, meta)
      return { state: r.state, dets: r.detections as DetectionEvent[] }
    }

    // ずっと再生し続けた場合（窓の先頭から流す）
    const base: Snap[] = []
    { let s = initState(frames[0].ms - 1000); for (const f of frames) { const r = advance(s, f); s = r.state; base.push(snap(r.dets)) } }

    const local = new Map<string, number>(columns.map(c => [c, 0]))
    let localTotal = 0
    for (let i = w.quakeAt + SWEEP_FROM_SEC; i < frames.length; i += SWEEP_STEP_SEC) {
      localTotal++
      for (const col of columns) {
        const from = adaptive
          ? adaptiveStart(frames, i)
          : Math.max(0, i - Number(col.replace('s', '')))
        let s = initState(frames[from].ms - 1000)
        let got: Snap = { tier: 'なし', maxInt: NaN }
        for (let k = from; k <= i; k++) { const r = advance(s, frames[k]); s = r.state; got = snap(r.dets) }
        if (same(got, base[i])) local.set(col, local.get(col)! + 1)
        fetched.get(col)!.push(i - from)
      }
    }
    total += localTotal
    for (const col of columns) agree.set(col, agree.get(col)! + local.get(col)!)
    console.log(`${w.name}: ${columns.map(c => `${c} ${local.get(c)}/${localTotal}`).join(' ／ ')}`)
  }

  console.log(`\n===== 合計（${total} 点）=====`)
  for (const col of columns) {
    const lens = fetched.get(col)!
    const avg = lens.length > 0 ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0
    console.log(`  ${col}: 段階＋最大震度が一致 ${agree.get(col)}/${total}（助走の長さ 平均 ${avg}s・最大 ${lens.length > 0 ? Math.max(...lens) : 0}s）`)
  }
}

// 直接実行のときだけ走らせる（定数を読むためだけの import で測定まで始めないため）。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')) {
  if (process.argv.includes('--fetch')) {
    console.log(`窓を取得する（キャッシュ ${CACHE_DIR}）`)
    void (async () => { for (const w of WINDOWS) await fetchWindow(w) })()
  } else {
    main()
  }
}
