// 観測点の合成波形の控えを、日本時間の 1 日ぶん作る（`stationWaveCache.ts`）。
//
//   npx tsx seismo-host/bench/build-station-cache.ts --day 2026-10-03 [--station station-1]
//     [--raw <生データの置き場所>] [--stations <観測点の設定>] [--out <控えの置き場所>] [--force]
//
// 生データは `<日>/raw-<日>T<時>.mseed3` を実機の `seismo-host/data/raw/` から、観測点の設定
// （`stations.xml`。履歴も入っている）を実機の `seismo-host/config/` から写したもの。設定の既定の
// 置き場所は生データの置き場所の直下。窓の前後 1 時間の本も、あれば読む（本は名乗った時刻で分けてあり、
// 受け取った時刻で窓を切るので、境目で届いたパケットが隣の本に入る）。

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { mseedFilePath } from '../src/receiver/mseedStore'
import { loadStationHistory, STATION_CONFIG_FILE } from '../src/receiver/stationStore'
import { historyEntries } from './rawReplay'
import type { HourFile } from './rawReplay'
import { buildStationWaveCache, cacheIsFresh } from './stationWaveCache'

const JST_OFFSET_MS = 9 * 3_600_000
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** 検出の助走（長い窓の平均が落ち着くまで）。日の始まりより前から鎖へ通す。 */
const LEAD_MS = 5 * 60_000

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function dayStartMs(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (m === null) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - JST_OFFSET_MS
}

/** `[fromMs, toMs)` に前後 1 時間を足した範囲の、在る本（時の順）。日本時間の正時は UTC の正時と同じ刻み。 */
function hourFiles(dir: string, fromMs: number, toMs: number): HourFile[] {
  const out: HourFile[] = []
  const first = Math.floor(fromMs / HOUR_MS) * HOUR_MS - HOUR_MS
  for (let hourStartMs = first; hourStartMs < toMs + HOUR_MS; hourStartMs += HOUR_MS) {
    const path = mseedFilePath(dir, hourStartMs)
    if (path !== null && existsSync(path)) out.push({ path, hourStartMs })
  }
  return out
}

async function main(): Promise<void> {
  const day = arg('day')
  const fromMs = day === undefined ? null : dayStartMs(day)
  if (day === undefined || fromMs === null) {
    console.error('--day YYYY-MM-DD が要る')
    process.exit(2)
  }
  const stationId = arg('station') ?? 'station-1'
  const rawDir = arg('raw') ?? '.claude/seismo-bench-cache/raw'
  const outDir = arg('out') ?? '.claude/seismo-bench-cache/station'
  const toMs = fromMs + DAY_MS

  const files = hourFiles(rawDir, fromMs - LEAD_MS, toMs)
  if (!files.some((f) => f.hourStartMs >= fromMs && f.hourStartMs < toMs)) {
    console.error(`その日の生データが無い: ${rawDir}/${day}/raw-*.mseed3`)
    process.exit(2)
  }
  mkdirSync(outDir, { recursive: true })
  const cachePath = join(outDir, `${stationId}-${day}.bin`)
  const paths = files.map((f) => f.path)
  if (process.argv.includes('--force') === false && cacheIsFresh(cachePath, paths, stationId, fromMs, toMs)) {
    console.log(`控えは新しい: ${cachePath}`)
    return
  }
  const stationsPath = arg('stations') ?? join(rawDir, STATION_CONFIG_FILE)
  const history = historyEntries(loadStationHistory(stationsPath))
  if (history.length === 0) {
    console.error(`観測点の設定（履歴）が無い: ${stationsPath}`)
    process.exit(2)
  }
  // **知らない観測点なら止める。** 合成波形は観測点の ID で選ぶので、打ち間違えたまま流すと
  // 1 件も選ばれず、空の控えが黙ってできる（評価では「揺れが 1 件も無い日」に化ける）。
  const known = [...new Set(history.flatMap((e) => e.config.stations.map((s) => s.stationId)))]
  if (!known.includes(stationId)) {
    console.error(`観測点 ${stationId} が設定の履歴に無い（ある観測点: ${known.join(', ') || 'なし'}）。--station で指すこと`)
    process.exit(2)
  }
  if (fromMs < history[0].atMs) {
    console.warn(`[注意] ${day} は設定の履歴が始まる前。最初の記録の校正値で流す（実機とは感度・回転が違いうる）`)
  }
  const t = Date.now()
  const counts = await buildStationWaveCache({ cachePath, files, stationId, fromMs, toMs, history, leadMs: LEAD_MS })
  console.log(`${cachePath} ${((Date.now() - t) / 1000).toFixed(0)} 秒 ${JSON.stringify(counts)}`)
}

void main()
