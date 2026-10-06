// 観測点の合成波形を、日本時間の 1 日ごとに手元へ控える（評価台の下ごしらえ）。
//
// **生データから合成波形を作り直すのは重い**（1 日ぶんの miniSEED を解いてパケットへ組み立て直し、
// 補正・区間・合成の鎖を通す）。検出の閾値を試すたびにそれを待たずに済むよう、鎖の出口（合成波形）を
// 一度だけ作って控え、2 回目からはそれを読む。
//
// **控えの中身は鎖の出力そのもの**（`FusedWaveChunk` の時刻・刻み・3 成分）。手を加えた値を
// 控えると、検出の前処理を変えたときに作り直しが要る。
//
// 形（すべてリトルエンディアン）: まとまりごとに
//   firstSampleMs: float64 / msPerSample: float64 / n: uint32 / gal: float32 × 3 × n（成分ごとに n 個）
// 控えの隣に `<名前>.meta.json` を置き、作ったときの元ファイルの大きさを残す。元が変われば作り直す。

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'

import { emptyReplayCounts, replayMseed } from './rawReplay'
import type { HourFile, ReplayCounts, StationHistoryEntry } from './rawReplay'

/** 控えから読み戻した 1 まとまり。 */
export interface CachedChunk {
  readonly firstSampleMs: number
  readonly msPerSample: number
  readonly gal: readonly [Float32Array, Float32Array, Float32Array]
}

interface CacheMeta {
  readonly stationId: string
  readonly fromMs: number
  readonly toMs: number
  readonly sources: readonly { path: string; size: number }[]
  readonly counts: ReplayCounts
  readonly chunks: number
}

function metaPath(cachePath: string): string {
  return `${cachePath}.meta.json`
}

function sourcesOf(paths: readonly string[]): { path: string; size: number }[] {
  return paths.map((path) => ({ path, size: statSync(path).size }))
}

/** 控えが今の元ファイルから作ったものか。 */
export function cacheIsFresh(cachePath: string, paths: readonly string[], stationId: string, fromMs: number, toMs: number): boolean {
  if (!existsSync(cachePath) || !existsSync(metaPath(cachePath))) return false
  const meta = JSON.parse(readFileSync(metaPath(cachePath), 'utf8')) as CacheMeta
  if (meta.stationId !== stationId || meta.fromMs !== fromMs || meta.toMs !== toMs) return false
  const now = sourcesOf(paths)
  return (
    now.length === meta.sources.length &&
    now.every((s, i) => s.path === meta.sources[i].path && s.size === meta.sources[i].size)
  )
}

/**
 * 生データを流し直して、観測点 `stationId` の合成波形のうち時刻が `[fromMs, toMs)` に掛かる
 * まとまりを控える。返すのは数えた件数（`counts`）。
 */
export async function buildStationWaveCache(params: {
  readonly cachePath: string
  readonly files: readonly HourFile[]
  readonly stationId: string
  readonly fromMs: number
  readonly toMs: number
  readonly history: readonly StationHistoryEntry[]
  /** 検出の助走ぶん、窓より前から鎖へ通す（ミリ秒）。 */
  readonly leadMs: number
}): Promise<ReplayCounts> {
  const counts: ReplayCounts = emptyReplayCounts()
  const parts: Buffer[] = []
  let chunks = 0
  for await (const item of replayMseed({
    files: params.files,
    fromMs: params.fromMs - params.leadMs,
    toMs: params.toMs,
    history: params.history,
    counts,
  })) {
    if (item.kind !== 'station' || item.wave.stationId !== params.stationId) continue
    const w = item.wave
    const n = w.gal[0].length
    const endMs = w.firstSampleMs + n * w.msPerSample
    if (endMs <= params.fromMs - params.leadMs || w.firstSampleMs >= params.toMs) continue
    const buf = Buffer.alloc(8 + 8 + 4 + 3 * 4 * n)
    let o = 0
    o = buf.writeDoubleLE(w.firstSampleMs, o)
    o = buf.writeDoubleLE(w.msPerSample, o)
    o = buf.writeUInt32LE(n, o)
    for (let axis = 0; axis < 3; axis++) {
      for (let i = 0; i < n; i++) o = buf.writeFloatLE(w.gal[axis][i], o)
    }
    parts.push(buf)
    chunks++
  }
  writeFileSync(params.cachePath, Buffer.concat(parts))
  const meta: CacheMeta = {
    stationId: params.stationId,
    fromMs: params.fromMs,
    toMs: params.toMs,
    sources: sourcesOf(params.files.map((f) => f.path)),
    counts,
    chunks,
  }
  writeFileSync(metaPath(params.cachePath), JSON.stringify(meta, null, 2))
  return counts
}

/** 控えを読み戻す。壊れていれば（途中で切れていれば）投げる。 */
export function readStationWaveCache(cachePath: string): CachedChunk[] {
  const buf = readFileSync(cachePath)
  const out: CachedChunk[] = []
  let o = 0
  while (o < buf.length) {
    if (o + 20 > buf.length) throw new Error(`控えが途中で切れている: ${cachePath} @${o}`)
    const firstSampleMs = buf.readDoubleLE(o)
    const msPerSample = buf.readDoubleLE(o + 8)
    const n = buf.readUInt32LE(o + 16)
    o += 20
    if (o + 12 * n > buf.length) throw new Error(`控えが途中で切れている: ${cachePath} @${o}`)
    const gal: [Float32Array, Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
    for (let axis = 0; axis < 3; axis++) {
      for (let i = 0; i < n; i++) {
        gal[axis][i] = buf.readFloatLE(o)
        o += 4
      }
    }
    out.push({ firstSampleMs, msPerSample, gal })
  }
  return out
}
