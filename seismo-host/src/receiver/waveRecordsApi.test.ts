import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { FusedWaveChunk } from './sensorFusion'
import type { StationConfig } from './stationConfigTypes'
import { encodeWaveChunk, stationFileToken } from './waveArchive'
import { RecordChannelIndex } from './waveRecordChannels'
import { RECORDS_COLUMNS_MAX, RECORDS_RANGE_MAX_MS, handleRecordsRequest, type RecordsApiDeps } from './waveRecordsApi'
import { SAMPLES_RANGE_MAX_MS, type RecordDirs } from './waveRecords'
import { buildSummaryFile, waveSummaryPath } from './waveSummaryFiles'

const H0 = Date.parse('2026-10-07T12:00:00+09:00')
const HOUR = 3_600_000
const STATION = 'home'
const KEY = stationFileToken(STATION)

let root: string
let dirs: RecordDirs
let deps: RecordsApiDeps
let config: StationConfig

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wave-records-api-'))
  dirs = { summaryDir: join(root, 'summary'), rawDir: join(root, 'raw'), waveDir: join(root, 'wave') }
  config = { stations: [{ stationId: STATION, displayName: '自宅', lat: 35, lon: 139 }], boards: [] }
  deps = { dirs, channels: new RecordChannelIndex(dirs.summaryDir), config: () => config }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function hourKeyOf(ms: number): string {
  return new Date(ms + 9 * HOUR).toISOString().slice(0, 13)
}

async function writeWaveHour(key: string, hourStartMs: number, values: number[]): Promise<void> {
  mkdirSync(dirs.waveDir, { recursive: true })
  const hourKey = hourKeyOf(hourStartMs)
  const sourcePath = join(dirs.waveDir, `wave-${key}-${hourKey}.bin`)
  const chunk = {
    stationId: STATION,
    firstSampleIndex: 0,
    firstSampleMs: hourStartMs,
    msPerSample: 10,
    gal: [values, values, values],
    dcGal: [values.map(() => 0), values.map(() => 0), values.map(() => 980)],
    memberCount: values.map(() => 3),
  } as unknown as FusedWaveChunk
  writeFileSync(sourcePath, encodeWaveChunk(chunk, false)!)
  const result = await buildSummaryFile({
    kind: 'wave',
    sourcePath,
    summaryPath: waveSummaryPath(dirs.summaryDir, key, hourKey),
    hourKey,
    hourStartMs,
    stationKey: key,
  })
  expect(result.ok).toBe(true)
}

function q(params: Record<string, string | number>): URLSearchParams {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
}

describe('handleRecordsRequest の入口', () => {
  const channel = `station/${KEY}/NS`

  it.each([
    ['範囲が無い', { channel, columns: 10 }, 'bad-range'],
    ['終わりが始まり以前', { channel, from: H0, to: H0, columns: 10 }, 'bad-range'],
    ['10 進でない時刻', { channel, from: '0x10', to: H0, columns: 10 }, 'bad-range'],
    ['チャンネルが無い', { from: H0, to: H0 + 1000, columns: 10 }, 'bad-channel'],
    ['置き場所の外を指すチャンネル', { channel: 'station/../NS', from: H0, to: H0 + 1000, columns: 10 }, 'bad-channel'],
    ['列が 0', { channel, from: H0, to: H0 + 1000, columns: 0 }, 'bad-columns'],
    ['列が多すぎる', { channel, from: H0, to: H0 + 1000, columns: RECORDS_COLUMNS_MAX + 1 }, 'bad-columns'],
    ['知らない単位', { channel, from: H0, to: H0 + 1000, columns: 10, unit: 'm/s2' }, 'bad-unit'],
    ['範囲が広すぎる', { channel, from: H0, to: H0 + RECORDS_RANGE_MAX_MS + 1, columns: 10 }, 'range-too-wide'],
  ])('%s は 400', async (_name, params, error) => {
    const got = await handleRecordsRequest('envelope', q(params), deps)
    expect(got).toEqual({ status: 400, body: { error } })
  })

  it('生のサンプルは 10 分を超える範囲を弾く（境目ちょうどは通す）', async () => {
    const over = await handleRecordsRequest('samples', q({ channel, from: H0, to: H0 + SAMPLES_RANGE_MAX_MS + 1 }), deps)
    expect(over).toEqual({ status: 400, body: { error: 'range-too-wide' } })
    const edge = await handleRecordsRequest('samples', q({ channel, from: H0, to: H0 + SAMPLES_RANGE_MAX_MS }), deps)
    expect(edge.status).toBe(200)
  })

  it('受信の記録のセンサーは名乗りの形でなければ弾く', async () => {
    const got = await handleRecordsRequest('reception', q({ from: H0, to: H0 + 1000, sensor: '../x' }), deps)
    expect(got).toEqual({ status: 400, body: { error: 'bad-sensor' } })
  })

  it('知らない経路は 404', async () => {
    expect((await handleRecordsRequest('nope', q({}), deps)).status).toBe(404)
  })
})

describe('handleRecordsRequest の中身', () => {
  it('列の幅で段を選び、届いていない列は null で返す', async () => {
    await writeWaveHour(KEY, H0, [1, 2, 3])
    const channel = `station/${KEY}/NS`
    const coarse = await handleRecordsRequest('envelope', q({ channel, from: H0, to: H0 + HOUR, columns: 60 }), deps)
    expect(coarse.status).toBe(200)
    const cb = coarse.body as { source: string; n: number[]; mean: (number | null)[]; columnMs: number }
    expect(cb.source).toBe('coarse')
    expect(cb.columnMs).toBe(60_000)
    expect(cb.n[0]).toBe(3)
    expect(cb.mean[1]).toBeNull()
    // 列が 1 秒より細い（30 秒を 3000 列）ので、生のサンプルから束ねる
    const samples = await handleRecordsRequest('envelope', q({ channel, from: H0, to: H0 + 30_000, columns: 3000 }), deps)
    expect(samples.status).toBe(200)
    expect((samples.body as { source: string }).source).toBe('samples')
  })

  it('有限でない値は JSON で null になる（欠けを 0 に化けさせない）', async () => {
    await writeWaveHour(KEY, H0, [1, Number.NaN, 3])
    const got = await handleRecordsRequest('samples', q({ channel: `station/${KEY}/UD`, from: H0, to: H0 + 30 }), deps)
    const body = JSON.parse(JSON.stringify(got.body)) as { runs: { values: (number | null)[] }[] }
    expect(body.runs[0]!.values).toEqual([1, null, 3])
  })
})

describe('channels', () => {
  it('要約の置き場所から一覧を作り、いまの設定の観測点名を添える（外した観測点の記録も残す）', async () => {
    await writeWaveHour(KEY, H0, [1, 2])
    await writeWaveHour(KEY, H0 + HOUR, [1, 2])
    const gone = stationFileToken('old')
    await writeWaveHour(gone, H0, [1])
    const got = await handleRecordsRequest('channels', q({}), deps)
    const body = got.body as { channels: Array<{ id: string; station: unknown; hours: number; firstHourMs: number; lastHourMs: number }>; unreadable: number }
    expect(body.unreadable).toBe(0)
    const ns = body.channels.find((c) => c.id === `station/${KEY}/NS`)!
    expect(ns.station).toEqual({ stationId: STATION, displayName: '自宅' })
    expect([ns.hours, ns.firstHourMs, ns.lastHourMs]).toEqual([2, H0, H0 + HOUR])
    const old = body.channels.find((c) => c.id === `station/${gone}/NS`)!
    expect(old.station).toBeNull()
    expect(body.channels).toHaveLength(6)
  })

  it('読めない要約は数えて一覧から外す', async () => {
    await writeWaveHour(KEY, H0, [1])
    writeFileSync(join(dirs.summaryDir, 'wave', `wave-${KEY}-${hourKeyOf(H0 + HOUR)}.coarse.wsum`), 'broken')
    const got = await handleRecordsRequest('channels', q({}), deps)
    const body = got.body as { channels: Array<{ hours: number }>; unreadable: number }
    expect(body.unreadable).toBe(1)
    expect(body.channels.every((c) => c.hours === 1)).toBe(true)
  })
})
