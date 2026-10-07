import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildMseed3Record, buildMseed3TextRecord, mseed3LogSourceId, mseed3SourceId } from './mseed3Record'
import type { FusedWaveChunk } from './sensorFusion'
import { decodeReceptionSummary } from './receptionSummary'
import { encodeSteim2 } from './steim2'
import { encodeWaveChunk } from './waveArchive'
import { decodeSummaryPart } from './waveSummary'
import {
  buildSummaryFile,
  hourStartOf,
  listSummaryJobs,
  rawSummaryPath,
  receptionSummaryPath,
  summarizedSourceBytes,
  summaryPartPath,
  waveSummaryPath,
} from './waveSummaryFiles'

const BOARD = 'mac:02000000a1b2'
const HOUR_KEY = '2026-10-07T12'
const HOUR_START = Date.parse('2026-10-07T12:00:00+09:00')

let root: string
let rawDir: string
let waveDir: string
let summaryDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wave-summary-files-'))
  rawDir = join(root, 'raw')
  waveDir = join(root, 'wave')
  summaryDir = join(root, 'summary')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function rawHourBytes(): Uint8Array {
  const log = buildMseed3TextRecord({
    sourceId: mseed3LogSourceId(BOARD, 'S1')!,
    startMs: HOUR_START,
    text: JSON.stringify({ board: BOARD, sensor: 'S1', channels: ['HNZ'], ugPerLsb: 61.0352 }),
  })
  const wave = buildMseed3Record({
    sourceId: mseed3SourceId(BOARD, 'S1', 'HNZ')!,
    startMs: HOUR_START,
    sampleRateHz: 100,
    block: encodeSteim2(Int32Array.from({ length: 50 }, (_, i) => 16384 + (i % 3)), 7),
  })
  const out = new Uint8Array(log.length + wave.length)
  out.set(log, 0)
  out.set(wave, log.length)
  return out
}

function waveHourBytes(): Buffer {
  const chunk = {
    stationId: 'home',
    firstSampleIndex: 0,
    firstSampleMs: HOUR_START,
    msPerSample: 10,
    gal: [[1, 2], [3, 4], [5, 6]],
    dcGal: [[0, 0], [0, 0], [980, 980]],
    memberCount: [3, 3],
  } as unknown as FusedWaveChunk
  return encodeWaveChunk(chunk, false)!
}

describe('hourStartOf', () => {
  it('日本時間の時の頭を返し、読めなければ null', () => {
    expect(hourStartOf(HOUR_KEY)).toBe(HOUR_START)
    expect(hourStartOf('2026-13-99T99')).toBeNull()
  })
})

describe('listSummaryJobs', () => {
  it('生データと合成波形の時のファイルを数え上げ、要約の置き場所を決める', async () => {
    mkdirSync(join(rawDir, '2026-10-07'), { recursive: true })
    writeFileSync(join(rawDir, '2026-10-07', `raw-${HOUR_KEY}.mseed3`), '')
    writeFileSync(join(rawDir, '2026-10-07', 'notes.txt'), '')
    mkdirSync(join(rawDir, 'misc'), { recursive: true })
    mkdirSync(waveDir, { recursive: true })
    writeFileSync(join(waveDir, `wave-home-0123456789ab-${HOUR_KEY}.bin`), '')
    writeFileSync(join(waveDir, `wave-home-0123456789ab-${HOUR_KEY}.bin.tmp`), '')

    const listed = await listSummaryJobs({ rawDir, waveDir, summaryDir })
    expect(listed.errors).toEqual([])
    expect(listed.jobs).toHaveLength(2)
    const raw = listed.jobs.find((j) => j.kind === 'raw')!
    expect(raw).toMatchObject({ hourKey: HOUR_KEY, hourStartMs: HOUR_START, stationKey: null })
    expect(raw.summaryPath).toBe(rawSummaryPath(summaryDir, HOUR_KEY))
    const wave = listed.jobs.find((j) => j.kind === 'wave')!
    expect(wave).toMatchObject({ hourKey: HOUR_KEY, stationKey: 'home-0123456789ab' })
    expect(wave.summaryPath).toBe(waveSummaryPath(summaryDir, 'home-0123456789ab', HOUR_KEY))
  })

  it('置き場所がまだ無いのは異常ではない（0 件・誤りなし）', async () => {
    const listed = await listSummaryJobs({ rawDir, waveDir, summaryDir })
    expect(listed).toEqual({ jobs: [], errors: [] })
  })
})

describe('buildSummaryFile', () => {
  it('生データの時のファイルから要約を作り、一時ファイルを残さずに置く', async () => {
    mkdirSync(join(rawDir, '2026-10-07'), { recursive: true })
    const sourcePath = join(rawDir, '2026-10-07', `raw-${HOUR_KEY}.mseed3`)
    const bytes = rawHourBytes()
    writeFileSync(sourcePath, bytes)
    const summaryPath = rawSummaryPath(summaryDir, HOUR_KEY)

    const result = await buildSummaryFile({ kind: 'raw', sourcePath, summaryPath, hourKey: HOUR_KEY, hourStartMs: HOUR_START, stationKey: null })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sourceBytes).toBe(bytes.length)
    expect(result.channels).toBe(1)

    const decoded = decodeSummaryPart(readFileSync(summaryPartPath(summaryPath, 'coarse')))
    expect(decoded).not.toBeNull()
    expect(decoded!.part).toBe('coarse')
    expect(decoded!.channels[0]!.ugPerLsb).toBe(61.0352)
    // 3 部分と受信の記録の要約が並び、一時ファイルは残らない
    expect(readdirSync(join(summaryDir, 'raw', '2026-10-07')).sort()).toEqual([
      `raw-${HOUR_KEY}.coarse.wsum`,
      `raw-${HOUR_KEY}.fine.wsum`,
      `raw-${HOUR_KEY}.psd.wsum`,
      `raw-${HOUR_KEY}.reception.json`,
    ])
    const reception = decodeReceptionSummary(readFileSync(receptionSummaryPath(summaryPath), 'utf8'))
    expect(reception?.sourceBytes).toBe(bytes.length)
    expect(await summarizedSourceBytes(summaryPath)).toBe(bytes.length)
  })

  it('合成波形の時のファイルから要約を作る（チャンネルは観測点の札で名乗る）', async () => {
    mkdirSync(waveDir, { recursive: true })
    const sourcePath = join(waveDir, `wave-home-0123456789ab-${HOUR_KEY}.bin`)
    writeFileSync(sourcePath, waveHourBytes())
    const summaryPath = waveSummaryPath(summaryDir, 'home-0123456789ab', HOUR_KEY)
    const result = await buildSummaryFile({
      kind: 'wave',
      sourcePath,
      summaryPath,
      hourKey: HOUR_KEY,
      hourStartMs: HOUR_START,
      stationKey: 'home-0123456789ab',
    })
    expect(result.ok).toBe(true)
    const decoded = decodeSummaryPart(readFileSync(summaryPartPath(summaryPath, 'fine')))!
    expect(decoded.channels.map((c) => c.id).sort()).toEqual([
      'station/home-0123456789ab/EW',
      'station/home-0123456789ab/NS',
      'station/home-0123456789ab/UD',
    ])
  })

  it('元のファイルが無ければ ok: false で返し、投げない・何も残さない', async () => {
    const summaryPath = rawSummaryPath(summaryDir, HOUR_KEY)
    const result = await buildSummaryFile({
      kind: 'raw',
      sourcePath: join(rawDir, 'nope.mseed3'),
      summaryPath,
      hourKey: HOUR_KEY,
      hourStartMs: HOUR_START,
      stationKey: null,
    })
    expect(result.ok).toBe(false)
    expect(await summarizedSourceBytes(summaryPath)).toBeNull()
  })
})

describe('summarizedSourceBytes', () => {
  it('要約でないファイル・短いファイルは null（作り直せばよい）', async () => {
    mkdirSync(summaryDir, { recursive: true })
    const base = join(summaryDir, 'x')
    writeFileSync(summaryPartPath(base, 'psd'), 'not a summary at all')
    expect(await summarizedSourceBytes(base)).toBeNull()
    writeFileSync(summaryPartPath(base, 'psd'), Buffer.alloc(3))
    expect(await summarizedSourceBytes(base)).toBeNull()
  })

  it('最後に書く部分（PSD）が無ければ、他の部分があっても作り直しになる', async () => {
    mkdirSync(join(rawDir, '2026-10-07'), { recursive: true })
    const sourcePath = join(rawDir, '2026-10-07', `raw-${HOUR_KEY}.mseed3`)
    writeFileSync(sourcePath, rawHourBytes())
    const summaryPath = rawSummaryPath(summaryDir, HOUR_KEY)
    await buildSummaryFile({ kind: 'raw', sourcePath, summaryPath, hourKey: HOUR_KEY, hourStartMs: HOUR_START, stationKey: null })
    // 途中で落ちて PSD を書けなかった跡（1 秒・1 分の部分は新しい）
    rmSync(summaryPartPath(summaryPath, 'psd'))
    expect(await summarizedSourceBytes(summaryPath)).toBeNull()
  })
})
