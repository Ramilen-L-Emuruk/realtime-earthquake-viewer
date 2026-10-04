// 生データ（NDJSON）を、実機の受信と同じ処理の鎖へ流し直す（評価台の入口）。
//
// **鎖は `main.ts` の受信と同じ部品を、同じ順に通す** —— `parseSensorPacket` →
// `IntensityPipeline.handlePacket`（補正・区間・センサーごとの波形）→ `SensorFusion.ingest`
// （観測点の合成波形）。別に書き起こすと、実機と違う波形で検出を評価することになる。
//
// **流すのはライブで届いたパケットだけ。** 取り戻した分（`via: 'backlog'`）は実機でも
// 保存にしか回らない（`main.ts` の取り戻しの経路）ので、ここでも鎖へ入れない。
//
// **観測点の設定は、その時刻に効いていたものを使う**（`stations-history.ndjson`）。
// 履歴が始まる前の時刻には最初の履歴を当てる —— 実機ではそれより前の校正値が効いていたので、
// **履歴より前の日は感度・回転が実機と違う**（`firstHistoryAtMs` で呼び出し側が見分けられる）。

import { createReadStream, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'

import { parseSensorPacket } from '../src/protocol/parsePacket'
import { IntensityPipeline } from '../src/receiver/intensityPipeline'
import type { WaveChunk } from '../src/receiver/intensityPipeline'
import { SensorFusion } from '../src/receiver/sensorFusion'
import type { FusedWaveChunk } from '../src/receiver/sensorFusion'
import { StationDirectory, parseStationConfig } from '../src/receiver/stationConfig'
import type { StationConfig } from '../src/receiver/stationConfig'

/** 設定の履歴 1 行ぶん（`stationConfigHistory.ts`）。 */
export interface StationHistoryEntry {
  readonly atMs: number
  readonly config: StationConfig
}

/** 履歴のファイルを読む。読めない行は数えて飛ばす（黙って捨てない）。 */
export function readStationHistory(path: string): { entries: StationHistoryEntry[]; unreadable: number } {
  const entries: StationHistoryEntry[] = []
  let unreadable = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const o = JSON.parse(line) as { at?: unknown; config?: unknown }
      const parsed = parseStationConfig(o.config)
      if (typeof o.at !== 'number' || !parsed.ok) {
        unreadable++
        continue
      }
      entries.push({ atMs: o.at, config: parsed.config })
    } catch {
      unreadable++
    }
  }
  entries.sort((a, b) => a.atMs - b.atMs)
  return { entries, unreadable }
}

/** その時刻に効いていた設定。履歴より前なら最初の履歴。履歴が空なら null。 */
export function configAt(history: readonly StationHistoryEntry[], atMs: number): StationHistoryEntry | null {
  if (history.length === 0) return null
  let found = history[0]
  for (const e of history) {
    if (e.atMs > atMs) break
    found = e
  }
  return found
}

export type ReplayItem =
  | { readonly kind: 'sensor'; readonly wave: WaveChunk }
  | { readonly kind: 'station'; readonly wave: FusedWaveChunk }

export interface ReplayCounts {
  lines: number
  unreadableLines: number
  backlogSkipped: number
  parseFailed: number
  outOfWindow: number
  configSwitches: number
}

function lines(path: string): AsyncIterable<string> {
  const source: Readable = path.endsWith('.gz') ? createReadStream(path).pipe(createGunzip()) : createReadStream(path)
  return createInterface({ input: source, crlfDelay: Infinity })
}

/**
 * NDJSON のファイル（日付順に並べて渡す）を流し、受け取った時刻が `[fromMs, toMs)` の
 * パケットだけを鎖へ通す。センサーごとの波形と観測点の合成波形を、出てきた順に返す。
 *
 * `counts` は呼び出し側が渡した入れ物へ書き足す（終わってから読む）。
 */
export async function* replayRaw(params: {
  readonly paths: readonly string[]
  readonly fromMs: number
  readonly toMs: number
  readonly history: readonly StationHistoryEntry[]
  readonly counts: ReplayCounts
}): AsyncGenerator<ReplayItem> {
  const { counts } = params
  let current: StationHistoryEntry | null = null
  let pipeline: IntensityPipeline | null = null
  let fusion: SensorFusion | null = null

  for (const path of params.paths) {
    for await (const line of lines(path)) {
      counts.lines++
      let env: { rx?: unknown; raw?: unknown; via?: unknown }
      try {
        env = JSON.parse(line) as typeof env
      } catch {
        counts.unreadableLines++
        continue
      }
      if (typeof env.rx !== 'number' || typeof env.raw !== 'string') {
        counts.unreadableLines++
        continue
      }
      if (env.via !== undefined) {
        counts.backlogSkipped++
        continue
      }
      if (env.rx < params.fromMs || env.rx >= params.toMs) {
        counts.outOfWindow++
        continue
      }

      const wanted = configAt(params.history, env.rx)
      if (wanted !== null && wanted !== current) {
        // 実機の設定変更と同じ順: 観測点の表を差し替え、合成は締めてから作り直す。
        if (pipeline === null) {
          pipeline = new IntensityPipeline({ stations: new StationDirectory(wanted.config) })
        } else {
          pipeline.updateStations(new StationDirectory(wanted.config))
          counts.configSwitches++
        }
        if (fusion !== null) {
          const closing = fusion.closeAll()
          for (const w of closing.drained) if (w.fusedWave !== null) yield { kind: 'station', wave: w.fusedWave }
        }
        fusion = new SensorFusion(wanted.config)
        current = wanted
      }
      if (pipeline === null || fusion === null) continue

      const read = parseSensorPacket(env.raw)
      if (!read.ok) {
        counts.parseFailed++
        continue
      }
      const outcome = pipeline.handlePacket(read.packet)
      if (outcome.wave === null) continue
      yield { kind: 'sensor', wave: outcome.wave }
      const fused = fusion.ingest(outcome.wave)
      if (fused.fusedWave !== null) yield { kind: 'station', wave: fused.fusedWave }
    }
  }
}
