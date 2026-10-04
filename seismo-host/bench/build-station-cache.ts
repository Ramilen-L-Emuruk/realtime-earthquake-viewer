// 観測点の合成波形の控えを、日本時間の 1 日ぶん作る（`stationWaveCache.ts`）。
//
//   npx tsx seismo-host/bench/build-station-cache.ts --day 2026-10-03 [--station station-1]
//     [--raw <生データの置き場所>] [--out <控えの置き場所>] [--force]
//
// 生データは `raw-<日>.ndjson(.gz)` と `stations-history.ndjson` を、実機の
// `seismo-host/data/raw/` から写したもの。その日の前後の日のファイルも、あれば読む
// （日付の境目で届いたパケットが隣のファイルに入るため）。

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { readStationHistory } from './rawReplay'
import { buildStationWaveCache, cacheIsFresh } from './stationWaveCache'

const JST_OFFSET_MS = 9 * 3_600_000
const DAY_MS = 24 * 3_600_000
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

function jstDay(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10)
}

function rawFile(dir: string, day: string): string | null {
  for (const name of [`raw-${day}.ndjson.gz`, `raw-${day}.ndjson`]) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return null
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

  const paths = [jstDay(fromMs - DAY_MS), day, jstDay(toMs)]
    .map((d) => rawFile(rawDir, d))
    .filter((p): p is string => p !== null)
  if (rawFile(rawDir, day) === null) {
    console.error(`その日の生データが無い: ${rawDir}/raw-${day}.ndjson(.gz)`)
    process.exit(2)
  }
  mkdirSync(outDir, { recursive: true })
  const cachePath = join(outDir, `${stationId}-${day}.bin`)
  if (process.argv.includes('--force') === false && cacheIsFresh(cachePath, paths, stationId, fromMs, toMs)) {
    console.log(`控えは新しい: ${cachePath}`)
    return
  }
  const { entries, unreadable } = readStationHistory(join(rawDir, 'stations-history.ndjson'))
  if (entries.length === 0) {
    console.error('設定の履歴が読めない（stations-history.ndjson）')
    process.exit(2)
  }
  if (fromMs < entries[0].atMs) {
    console.warn(`[注意] ${day} は設定の履歴が始まる前。最初の履歴の校正値で流す（実機とは感度・回転が違いうる）`)
  }
  const t = Date.now()
  const counts = await buildStationWaveCache({ cachePath, paths, stationId, fromMs, toMs, history: entries, leadMs: LEAD_MS })
  console.log(`${cachePath} ${((Date.now() - t) / 1000).toFixed(0)} 秒 ${JSON.stringify({ ...counts, historyUnreadable: unreadable })}`)
}

void main()
