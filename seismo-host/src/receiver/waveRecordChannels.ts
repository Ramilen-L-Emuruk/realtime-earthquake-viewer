// 保存してあるチャンネルの一覧（管理コンソールの「波形の記録」で選ぶもの）。
//
// **一覧は要約の置き場所から作る**（設定からではない）。基板や観測点を設定から外しても、記録は残る ——
// 設定から作ると、外したものの記録が選べなくなる。設定は名前を添えるのにだけ使う。
//
// **時のファイルごとに名乗りを控える。** 1 分の段の部分（1 時間あたり約 40 KB）から名乗りだけを読み、
// 大きさと更新時刻が変わっていなければ 2 回目からは開かない。

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { hourStartOf } from './waveSummaryFiles'
import { mseed3SourceId } from './mseed3Record'
import { sensorOfSourceId } from './receptionSummary'
import type { StationConfig } from './stationConfigTypes'
import { stationFileToken } from './waveArchive'
import { parseChannelId } from './waveRecords'
import { listSummaryPartChannels, type SummaryUnit } from './waveSummary'

const RAW_COARSE_RE = /^raw-(\d{4}-\d{2}-\d{2}T\d{2})\.coarse\.wsum$/
const WAVE_COARSE_RE = /^wave-(.+)-(\d{4}-\d{2}-\d{2}T\d{2})\.coarse\.wsum$/
const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/
const STAT_PARALLEL = 32

/** 一覧の 1 行。 */
export interface RecordChannel {
  readonly id: string
  readonly kind: 'raw' | 'station'
  readonly unit: SummaryUnit
  /** 要約がある最初と最後の時の頭（unix ミリ秒）。 */
  readonly firstHourMs: number
  readonly lastHourMs: number
  /** 要約がある時の数（間に欠けがあれば、最初から最後までの時の数より少ない）。 */
  readonly hours: number
  /** 生データ: センサーの識別子（受信の記録の帯を引くのに使う）。合成波形は `null`。 */
  readonly sensor: string | null
  /**
   * 生データ: いまの設定でこのセンサーを持つ基板とセンサー。設定に無ければ `null`。
   * `stationName` は割り当て先の観測点の表示名（観測点が設定に無ければ `null`）。
   */
  readonly board: {
    readonly boardKey: string
    readonly sensorId: string
    readonly stationId: string
    readonly stationName: string | null
  } | null
  /** 合成波形: いまの設定でこの札になる観測点。設定に無ければ `null`（外した観測点）。 */
  readonly station: { readonly stationId: string; readonly displayName: string } | null
}

export interface RecordChannelList {
  readonly channels: RecordChannel[]
  /** 読めなかった要約・置き場所の数（一覧から漏れているかもしれない）。 */
  readonly unreadable: number
}

interface Cached {
  readonly size: number
  readonly mtimeMs: number
  readonly channels: readonly { readonly id: string; readonly unit: SummaryUnit }[] | null
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

/** 要約の置き場所を見て、チャンネルの一覧を作る。名乗りは時のファイルごとに控える。 */
export class RecordChannelIndex {
  private readonly cache = new Map<string, Cached>()

  constructor(private readonly summaryDir: string) {}

  /** 一覧を作る。投げない。 */
  async list(config: StationConfig): Promise<RecordChannelList> {
    const files: { path: string; hourMs: number }[] = []
    let unreadable = 0
    const rawRoot = join(this.summaryDir, 'raw')
    let days: string[] = []
    try {
      days = (await readdir(rawRoot)).filter((d) => DAY_DIR_RE.test(d))
    } catch (error) {
      if (!isMissing(error)) unreadable += 1
    }
    for (const day of days) {
      let names: string[]
      try {
        names = await readdir(join(rawRoot, day))
      } catch (error) {
        if (!isMissing(error)) unreadable += 1
        continue
      }
      for (const name of names) {
        const m = RAW_COARSE_RE.exec(name)
        const hourMs = m === null ? null : hourStartOf(m[1]!)
        if (hourMs !== null) files.push({ path: join(rawRoot, day, name), hourMs })
      }
    }
    const waveRoot = join(this.summaryDir, 'wave')
    let waves: string[] = []
    try {
      waves = await readdir(waveRoot)
    } catch (error) {
      if (!isMissing(error)) unreadable += 1
    }
    for (const name of waves) {
      const m = WAVE_COARSE_RE.exec(name)
      const hourMs = m === null ? null : hourStartOf(m[2]!)
      if (hourMs !== null) files.push({ path: join(waveRoot, name), hourMs })
    }

    const seen = new Set<string>()
    const byId = new Map<string, { unit: SummaryUnit; first: number; last: number; hours: Set<number> }>()
    for (let i = 0; i < files.length; i += STAT_PARALLEL) {
      const batch = await Promise.all(files.slice(i, i + STAT_PARALLEL).map((f) => this.channelsOf(f.path)))
      batch.forEach((channels, j) => {
        const f = files[i + j]!
        seen.add(f.path)
        if (channels === null) {
          unreadable += 1
          return
        }
        for (const c of channels) {
          const e = byId.get(c.id)
          if (e === undefined) {
            byId.set(c.id, { unit: c.unit, first: f.hourMs, last: f.hourMs, hours: new Set([f.hourMs]) })
          } else {
            e.first = Math.min(e.first, f.hourMs)
            e.last = Math.max(e.last, f.hourMs)
            e.hours.add(f.hourMs)
          }
        }
      })
    }
    // **消えたファイルの控えは捨てる**（溜め続けない）。
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path)

    const stationNames = new Map(config.stations.map((s) => [s.stationId, s.displayName]))
    const sensorOwners = new Map<string, NonNullable<RecordChannel['board']>>()
    for (const b of config.boards) {
      for (const s of b.sensors) {
        const sid = mseed3SourceId(b.boardKey, s.sensorId, 'HNZ')
        if (sid === null) continue
        sensorOwners.set(sensorOfSourceId(sid), {
          boardKey: b.boardKey,
          sensorId: s.sensorId,
          stationId: b.stationId,
          stationName: stationNames.get(b.stationId) ?? null,
        })
      }
    }
    const stationsByToken = new Map(config.stations.map((s) => [stationFileToken(s.stationId), { stationId: s.stationId, displayName: s.displayName }]))

    const channels: RecordChannel[] = []
    for (const [id, e] of byId) {
      const ref = parseChannelId(id)
      if (ref === null) continue
      const sensor = ref.kind === 'raw' ? sensorOfSourceId(id) : null
      channels.push({
        id,
        kind: ref.kind,
        unit: e.unit,
        firstHourMs: e.first,
        lastHourMs: e.last,
        hours: e.hours.size,
        sensor,
        board: sensor === null ? null : (sensorOwners.get(sensor) ?? null),
        station: ref.kind === 'station' ? (stationsByToken.get(ref.stationKey) ?? null) : null,
      })
    }
    channels.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return { channels, unreadable }
  }

  private async channelsOf(path: string): Promise<Cached['channels']> {
    let s: { size: number; mtimeMs: number }
    try {
      s = await stat(path)
    } catch {
      return null
    }
    const known = this.cache.get(path)
    if (known !== undefined && known.size === s.size && known.mtimeMs === s.mtimeMs) return known.channels
    let channels: Cached['channels'] = null
    try {
      const listed = listSummaryPartChannels(await readFile(path))
      channels = listed === null || listed.part !== 'coarse' ? null : listed.channels.map((c) => ({ id: c.id, unit: c.unit }))
    } catch {
      channels = null
    }
    this.cache.set(path, { size: s.size, mtimeMs: s.mtimeMs, channels })
    return channels
  }
}
