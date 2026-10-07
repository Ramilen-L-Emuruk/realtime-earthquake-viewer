import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildMseed3Record, mseed3SourceId } from './mseed3Record'
import { RECORD_QUAKES_RANGE_MAX_MS, RecordQuakes } from './recordQuakes'
import type { FusedWaveChunk } from './sensorFusion'
import { encodeSteim2 } from './steim2'
import type { StationConfig } from './stationConfigTypes'
import { encodeWaveChunk, stationFileToken } from './waveArchive'
import { RecordChannelIndex } from './waveRecordChannels'
import { RECORDS_COLUMNS_MAX, RECORDS_RANGE_MAX_MS, handleRecordsRequest, type RecordsApiDeps } from './waveRecordsApi'
import { SAMPLES_RANGE_MAX_MS, type RecordDirs } from './waveRecords'
import { buildSummaryFile, rawSummaryPath, waveSummaryPath } from './waveSummaryFiles'

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
  deps = { dirs, channels: new RecordChannelIndex(dirs.summaryDir), config: () => config, quakes: null }
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
  const channel = `station/${KEY}/X`

  it.each([
    ['範囲が無い', { channel, columns: 10 }, 'bad-range'],
    ['終わりが始まり以前', { channel, from: H0, to: H0, columns: 10 }, 'bad-range'],
    ['10 進でない時刻', { channel, from: '0x10', to: H0, columns: 10 }, 'bad-range'],
    ['チャンネルが無い', { from: H0, to: H0 + 1000, columns: 10 }, 'bad-channel'],
    ['置き場所の外を指すチャンネル', { channel: 'station/../X', from: H0, to: H0 + 1000, columns: 10 }, 'bad-channel'],
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
    const channel = `station/${KEY}/X`
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
    const got = await handleRecordsRequest('samples', q({ channel: `station/${KEY}/Z`, from: H0, to: H0 + 30 }), deps)
    const body = JSON.parse(JSON.stringify(got.body)) as { runs: { values: (number | null)[] }[] }
    expect(body.runs[0]!.values).toEqual([1, null, 3])
  })

  it('スペクトログラムは作り方・正常でない時・読んだファイルを添えて返す', async () => {
    await writeWaveHour(KEY, H0, Array.from({ length: 6000 }, (_, i) => Math.sin(i / 3)))
    const channel = `station/${KEY}/X`
    const fine = await handleRecordsRequest('spectrogram', q({ channel, from: H0, to: H0 + 60_000, columns: 100 }), deps)
    expect(fine.status).toBe(200)
    const fb = JSON.parse(JSON.stringify(fine.body)) as { source: string; columnMs: number; irregularHours: unknown[]; hours: unknown; files: unknown }
    expect(fb.source).toBe('samples')
    expect(fb.columnMs).toBe(6000)
    expect(fb.irregularHours).toEqual([])
    expect(fb.hours).toBeNull()
    expect(fb.files).not.toBeNull()
    const wide = await handleRecordsRequest('spectrogram', q({ channel, from: H0, to: H0 + 2 * HOUR, columns: 120 }), deps)
    const wb = JSON.parse(JSON.stringify(wide.body)) as { source: string; irregularHours: unknown[]; files: unknown }
    expect(wb.source).toBe('minutes')
    expect(wb.files).toBeNull()
    expect(Array.isArray(wb.irregularHours)).toBe(true)
  })
})

describe('intensity', () => {
  it('札で引いた合成波形から、刻みごとのリアルタイム震度と計測震度を返す', async () => {
    // 2 分ぶん（100 Hz）。前の 60 秒は判定の窓を埋めるために読む
    const values = Array.from({ length: 12_000 }, (_, i) => 20 * Math.sin(i / 4))
    await writeWaveHour(KEY, H0, values)
    const got = await handleRecordsRequest('intensity', q({ station: KEY, from: H0 + 60_000, to: H0 + 90_000 }), deps)
    expect(got.status).toBe(200)
    const body = got.body as { station: string; realtimeSeries: { atMs: number; value: number | null }[]; maxRealtime: number | null; measured: number | null }
    expect(body.station).toBe(KEY)
    expect(body.realtimeSeries.length).toBeGreaterThan(20)
    expect(body.maxRealtime).not.toBeNull()
    expect(body.measured).not.toBeNull()
  })

  it('札の形でないもの・10 分を超える範囲は弾く', async () => {
    expect(await handleRecordsRequest('intensity', q({ station: '../x', from: H0, to: H0 + 1000 }), deps)).toEqual({
      status: 400,
      body: { error: 'bad-station' },
    })
    expect(await handleRecordsRequest('intensity', q({ station: KEY, from: H0, to: H0 + SAMPLES_RANGE_MAX_MS + 1 }), deps)).toEqual({
      status: 400,
      body: { error: 'range-too-wide' },
    })
  })

  it('記録が無ければ値は null で、読んだファイルの数を添える', async () => {
    const got = await handleRecordsRequest('intensity', q({ station: KEY, from: H0, to: H0 + 1000 }), deps)
    expect(got.status).toBe(200)
    const body = got.body as { maxRealtime: number | null; measuredUnavailable: string | null; filesMissing: number }
    expect(body.maxRealtime).toBeNull()
    expect(body.measuredUnavailable).toBe('no-data')
    expect(body.filesMissing).toBeGreaterThan(0)
  })
})

describe('envelope の正常でない時', () => {
  it('要約がまだ無い時を頭の時刻つきで返す', async () => {
    // 元のファイルだけ置き、要約は作らない
    mkdirSync(dirs.waveDir, { recursive: true })
    const chunk = {
      stationId: STATION,
      firstSampleIndex: 0,
      firstSampleMs: H0,
      msPerSample: 10,
      gal: [[1], [1], [1]],
      dcGal: [[0], [0], [980]],
      memberCount: [3],
    } as unknown as FusedWaveChunk
    writeFileSync(join(dirs.waveDir, `wave-${KEY}-${hourKeyOf(H0)}.bin`), encodeWaveChunk(chunk, false)!)
    const got = await handleRecordsRequest('envelope', q({ channel: `station/${KEY}/X`, from: H0, to: H0 + HOUR, columns: 60 }), deps)
    expect((got.body as { irregularHours: unknown }).irregularHours).toEqual([{ hourStartMs: H0, state: 'pending' }])
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
    const ns = body.channels.find((c) => c.id === `station/${KEY}/X`)!
    expect(ns.station).toEqual({ stationId: STATION, displayName: '自宅' })
    expect([ns.hours, ns.firstHourMs, ns.lastHourMs]).toEqual([2, H0, H0 + HOUR])
    const old = body.channels.find((c) => c.id === `station/${gone}/X`)!
    expect(old.station).toBeNull()
    expect(body.channels).toHaveLength(6)
  })

  it('生データの行には、いまの設定でそのセンサーを持つ基板と観測点の名前を添える', async () => {
    const board = 'mac:02000000a1b2'
    const hourKey = hourKeyOf(H0)
    mkdirSync(join(dirs.rawDir, hourKey.slice(0, 10)), { recursive: true })
    const sourcePath = join(dirs.rawDir, hourKey.slice(0, 10), `raw-${hourKey}.mseed3`)
    const wave = buildMseed3Record({
      sourceId: mseed3SourceId(board, 'S1', 'HN1')!,
      startMs: H0,
      sampleRateHz: 100,
      block: encodeSteim2(Int32Array.from({ length: 50 }, () => 100), 7),
    })
    writeFileSync(sourcePath, wave)
    await buildSummaryFile({ kind: 'raw', sourcePath, summaryPath: rawSummaryPath(dirs.summaryDir, hourKey), hourKey, hourStartMs: H0, stationKey: null })
    const unit = { enabled: true, rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], offset: [0, 0, 0], sensitivity: [1, 1, 1], noiseDensity: null } as const
    config = { ...config, boards: [{ boardKey: board, stationId: STATION, sensors: [{ sensorId: 'S1', ...unit }] }] }
    const got = await handleRecordsRequest('channels', q({}), deps)
    const body = got.body as { channels: Array<{ id: string; board: unknown }> }
    const raw = body.channels.find((c) => c.id === mseed3SourceId(board, 'S1', 'HN1'))!
    expect(raw.board).toEqual({ boardKey: board, sensorId: 'S1', stationId: STATION, stationName: '自宅' })
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

describe('quakes', () => {
  /** 10/07 12:30 JST の地震 1 件を返す P2PQuake（それ以外は 404）。 */
  function fakeQuakes(): RecordQuakes {
    const item = {
      code: 551,
      earthquake: { time: '2026/10/07 12:30:00', maxScale: 20, hypocenter: { name: '茨城県南部', latitude: 36.1, longitude: 140.0, depth: 50, magnitude: 4.0 } },
    }
    return new RecordQuakes({
      dir: join(root, 'quakes'),
      get: async (url) => (url.startsWith('https://api.p2pquake.net/') ? { status: 200, body: JSON.stringify([item]) } : { status: 404, body: '' }),
      sleep: async () => {},
      now: () => H0 + 2 * HOUR,
      dmdataApiKey: null,
    })
  }

  it('観測点を渡せば、その観測点へ P・S が届く時刻の幅を添える（分の幅のまま）', async () => {
    const got = await handleRecordsRequest('quakes', q({ from: H0, to: H0 + HOUR, station: STATION }), { ...deps, quakes: fakeQuakes() })
    expect(got.status).toBe(200)
    const body = got.body as { off: boolean; located: boolean; quakes: Array<{ name: string; originSource: string; p: { fromMs: number; toMs: number } | null; s: { fromMs: number; toMs: number } | null }> }
    expect(body).toMatchObject({ off: false, located: true })
    expect(body.quakes).toHaveLength(1)
    const quake = body.quakes[0]!
    expect(quake).toMatchObject({ name: '茨城県南部', originSource: 'quake-info' })
    expect(quake.s!.toMs - quake.s!.fromMs).toBe(60_000)
    expect(quake.p!.fromMs).toBeLessThan(quake.s!.fromMs)
  })

  it('観測点が設定に無ければ P・S は無し（地震そのものは出す）', async () => {
    const got = await handleRecordsRequest('quakes', q({ from: H0, to: H0 + HOUR, station: 'gone' }), { ...deps, quakes: fakeQuakes() })
    const body = got.body as { located: boolean; quakes: Array<{ p: unknown; s: unknown }> }
    expect(body.located).toBe(false)
    expect(body.quakes).toEqual([expect.objectContaining({ p: null, s: null })])
  })

  it('地震情報を受け取らない設定なら外へ取りに行かず、そう答える', async () => {
    const got = await handleRecordsRequest('quakes', q({ from: H0, to: H0 + HOUR }), deps)
    expect(got).toEqual({ status: 200, body: { off: true, located: false, quakes: [], failedDays: [], unreadable: 0, problem: null } })
  })

  it('7 日を超える範囲は断る', async () => {
    const got = await handleRecordsRequest('quakes', q({ from: H0, to: H0 + RECORD_QUAKES_RANGE_MAX_MS + 1 }), { ...deps, quakes: fakeQuakes() })
    expect(got).toEqual({ status: 400, body: { error: 'range-too-wide' } })
  })
})
