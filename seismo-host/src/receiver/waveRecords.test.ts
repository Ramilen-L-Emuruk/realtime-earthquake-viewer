import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildMseed3Record, buildMseed3TextRecord, mseed3LogSourceId, mseed3SourceId } from './mseed3Record'
import type { FusedWaveChunk } from './sensorFusion'
import { encodeSteim2 } from './steim2'
import { encodeWaveChunk } from './waveArchive'
import {
  FINE_RANGE_MAX_MS,
  GAL_PER_UG,
  chooseEnvelopeSource,
  columnMsFor,
  hoursToOpen,
  levelsToColumns,
  parseChannelId,
  readReception,
  readSamples,
  readSamplesEnvelope,
  readSpectrogram,
  readSpectrum,
  readSummaryEnvelope,
  samplesToColumns,
  type RecordDirs,
} from './waveRecords'
import type { SummaryLevel } from './waveSummary'
import { buildSummaryFile, rawSummaryPath, waveSummaryPath } from './waveSummaryFiles'

const H0 = Date.parse('2026-10-07T12:00:00+09:00')
const HOUR = 3_600_000
const KEY = 'home-0123456789ab'
const BOARD = 'mac:02000000a1b2'

let root: string
let dirs: RecordDirs

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wave-records-'))
  dirs = { summaryDir: join(root, 'summary'), rawDir: join(root, 'raw'), waveDir: join(root, 'wave') }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function hourKeyOf(ms: number): string {
  return new Date(ms + 9 * HOUR).toISOString().slice(0, 13)
}

/** 合成波形の時のファイルを書いて要約を作る。`chunks` は [先頭の時刻, 値の列（3 軸とも同じ）, 作り直した分か]。 */
async function writeWaveHour(hourStartMs: number, chunks: Array<[number, number[], boolean?]>, summarize = true): Promise<string> {
  mkdirSync(dirs.waveDir, { recursive: true })
  const hourKey = hourKeyOf(hourStartMs)
  const sourcePath = join(dirs.waveDir, `wave-${KEY}-${hourKey}.bin`)
  const bufs = chunks.map(([firstSampleMs, values, revised]) =>
    encodeWaveChunk(
      {
        stationId: 'home',
        firstSampleIndex: 0,
        firstSampleMs,
        msPerSample: 10,
        gal: [values, values, values],
        dcGal: [values.map(() => 0), values.map(() => 0), values.map(() => 980)],
        memberCount: values.map(() => 3),
      } as unknown as FusedWaveChunk,
      revised === true,
    )!,
  )
  writeFileSync(sourcePath, Buffer.concat(bufs))
  if (summarize) {
    const result = await buildSummaryFile({
      kind: 'wave',
      sourcePath,
      summaryPath: waveSummaryPath(dirs.summaryDir, KEY, hourKey),
      hourKey,
      hourStartMs,
      stationKey: KEY,
    })
    expect(result.ok).toBe(true)
  }
  return sourcePath
}

function level(bucketMs: number, firstBucket: number, rows: Array<[number, number, number, number, number] | null>, noise?: number[]): SummaryLevel {
  const len = rows.length
  const n = bucketMs === 1000 ? new Uint16Array(len) : new Uint32Array(len)
  const mk = () => new Float32Array(len).fill(Number.NaN)
  const lv = { bucketMs, firstBucket, n, min: mk(), max: mk(), mean: mk(), variance: mk(), noiseVariance: noise === undefined ? null : mk() }
  rows.forEach((r, i) => {
    if (r === null) return
    ;[lv.n[i], lv.min[i], lv.max[i], lv.mean[i], lv.variance[i]] = r
    if (lv.noiseVariance !== null) lv.noiseVariance[i] = noise![i]!
  })
  return lv
}

describe('parseChannelId', () => {
  it('合成波形と生データの名乗りを解く', () => {
    expect(parseChannelId(`station/${KEY}/EW`)).toEqual({ kind: 'station', id: `station/${KEY}/EW`, stationKey: KEY, axis: 1 })
    expect(parseChannelId('FDSN:XX_0000A1B2_S1_H_N_Z')).toEqual({ kind: 'raw', id: 'FDSN:XX_0000A1B2_S1_H_N_Z' })
  })

  it('置き場所の外へ出る名乗り・受信の記録・知らない向きは通さない', () => {
    expect(parseChannelId('station/../x/NS')).toBeNull()
    expect(parseChannelId('station/a/b/NS')).toBeNull()
    expect(parseChannelId(`station/${KEY}/Z`)).toBeNull()
    expect(parseChannelId('FDSN:XX_0000A1B2_S1_L_O_G')).toBeNull()
    expect(parseChannelId('FDSN:../../etc')).toBeNull()
    expect(parseChannelId('')).toBeNull()
  })
})

describe('hoursToOpen', () => {
  it('前の時を含めて開く（境目を跨いだまとまりは前の時のファイルにある）', () => {
    expect(hoursToOpen(H0 + 5 * 60_000, H0 + 10 * 60_000)).toEqual([H0 - HOUR, H0])
    expect(hoursToOpen(H0, H0 + 2 * HOUR)).toEqual([H0 - HOUR, H0, H0 + HOUR])
  })

  it('終わりはその時刻を含まない（ちょうど時の頭で終わる範囲は、次の時を開かない）', () => {
    expect(hoursToOpen(H0, H0 + HOUR)).toEqual([H0 - HOUR, H0])
  })
})

describe('chooseEnvelopeSource', () => {
  const tenMin = 10 * 60_000
  it('列の幅が 1 分ちょうどなら 1 分の段、それより細ければ 1 秒の段', () => {
    expect(chooseEnvelopeSource(0, 60_000 * 100, 100, tenMin)).toBe('coarse')
    expect(chooseEnvelopeSource(0, 60_000 * 100 - 1, 100, tenMin)).toBe('fine')
  })

  it('列が 1 秒より細く、範囲が生のサンプルの上限以内なら生のサンプル', () => {
    expect(chooseEnvelopeSource(0, tenMin, 1000, tenMin)).toBe('samples')
    // 上限を超えたら 1 秒の段（列の数は頼まれたより減る）
    expect(chooseEnvelopeSource(0, tenMin + 1, 1000, tenMin)).toBe('fine')
  })

  it('1 秒の段を使える広さを超えたら、列が 1 分より細くても 1 分の段', () => {
    expect(chooseEnvelopeSource(0, FINE_RANGE_MAX_MS, 4000, tenMin)).toBe('fine')
    expect(chooseEnvelopeSource(0, FINE_RANGE_MAX_MS + 1000, 4000, tenMin)).toBe('coarse')
  })
})

describe('columnMsFor', () => {
  it('段のまとまりの整数倍にし、頼まれた数より列を増やさない', () => {
    expect(columnMsFor(0, 3_600_000, 100, 1000)).toBe(36_000)
    expect(columnMsFor(0, 3_600_000, 7, 60_000)).toBe(540_000) // 8.57 分 → 9 分
    expect(columnMsFor(0, 30_000, 100, 1000)).toBe(1000) // まとまりより細くはしない
  })
})

describe('levelsToColumns', () => {
  it('まとまりを Chan の式で束ね、係数は値に 1 乗・ばらつきに 2 乗で効く', () => {
    // 1 秒のまとまり 2 つ: {1, 3}（平均 2・分散 1）と {5, 7}（平均 6・分散 1）→ 4 個の平均 4・分散 5
    const lv = level(1000, 10, [
      [2, 1, 3, 2, 1],
      [2, 5, 7, 6, 1],
    ])
    const cols = levelsToColumns([{ level: lv, scale: 2 }], 10_000, 12_000, 2000)
    expect(cols.firstColumnMs).toBe(10_000)
    expect(cols.n).toEqual([4])
    expect(cols.mean[0]).toBe(8)
    expect(cols.min[0]).toBe(2)
    expect(cols.max[0]).toBe(14)
    expect(cols.std[0]).toBeCloseTo(2 * Math.sqrt(5), 4)
    // 1 秒ごとのばらつき（どちらも 1）を束ねたものなので、平均の動きは入らない
    expect(cols.noiseStd[0]).toBeCloseTo(2, 5)
  })

  it('1 分の段はノイズの分散の欄を束ねる', () => {
    const lv = level(60_000, 1, [[100, -1, 1, 0, 9]], [4])
    const cols = levelsToColumns([{ level: lv, scale: 1 }], 60_000, 120_000, 60_000)
    expect(cols.std[0]).toBeCloseTo(3, 5)
    expect(cols.noiseStd[0]).toBeCloseTo(2, 5)
  })

  it('届いていない列は本数 0 で、他の欄は null（0 と区別する）', () => {
    const lv = level(1000, 0, [[1, 0, 0, 0, 0], null, null])
    const cols = levelsToColumns([{ level: lv, scale: 1 }], 0, 3000, 1000)
    expect(cols.n).toEqual([1, 0, 0])
    expect(cols.mean).toEqual([0, null, null])
    expect(cols.noiseStd).toEqual([0, null, null])
  })

  it('範囲の外のまとまりは捨て、2 つの時の要約が同じ列に入っても合わせる', () => {
    const before = level(1000, 99, [[1, 5, 5, 5, 0]])
    const a = level(1000, 100, [[1, 1, 1, 1, 0]])
    const b = level(1000, 101, [[1, 3, 3, 3, 0]])
    const cols = levelsToColumns(
      [
        { level: before, scale: 1 },
        { level: a, scale: 1 },
        { level: b, scale: 1 },
      ],
      100_000,
      102_000,
      2000,
    )
    expect(cols.n).toEqual([2])
    expect(cols.mean[0]).toBe(2)
  })
})

describe('samplesToColumns', () => {
  it('サンプルを列へ束ね、範囲の外と有限でない値は外す', () => {
    const cols = samplesToColumns(
      [{ firstSampleMs: 990, msPerSample: 10, values: [100, 1, 2, Number.NaN, 3] }],
      1,
      1000,
      1040,
      20,
    )
    expect(cols.n).toEqual([2, 1])
    expect(cols.mean).toEqual([1.5, 3])
    expect(cols.std[0]).toBeCloseTo(0.5, 6)
    expect(cols.noiseStd[0]).toBeCloseTo(0.5, 6)
  })
})

const HNZ = mseed3SourceId(BOARD, 'S1', 'HNZ')!

/** 生データの時のファイルを書く。`records` は [先頭の時刻, 値, 届き方の印]。`ug` が null なら受信の記録を書かない。 */
function writeRawHour(hourStartMs: number, records: Array<[number, number[], 'live' | 'backlog']>, ug: number | null = 61.0352): string {
  const hourKey = hourKeyOf(hourStartMs)
  mkdirSync(join(dirs.rawDir, hourKey.slice(0, 10)), { recursive: true })
  const path = join(dirs.rawDir, hourKey.slice(0, 10), `raw-${hourKey}.mseed3`)
  const parts: Uint8Array[] = []
  if (ug !== null) {
    parts.push(
      buildMseed3TextRecord({
        sourceId: mseed3LogSourceId(BOARD, 'S1')!,
        startMs: hourStartMs,
        text: JSON.stringify({ board: BOARD, sensor: 'S1', channels: ['HNZ'], ugPerLsb: ug }),
      }),
    )
  }
  records.forEach(([startMs, values, lane], i) => {
    parts.push(
      buildMseed3Record({
        sourceId: HNZ,
        startMs,
        sampleRateHz: 100,
        block: encodeSteim2(Int32Array.from(values), 7),
        extraHeaders: JSON.stringify({ Seismo: { b: 'boot', q: i * 1000, ...(lane === 'backlog' ? { r: 1 } : {}) } }),
      }),
    )
  })
  writeFileSync(path, Buffer.concat(parts))
  return path
}

describe('readSamples', () => {
  it('生データを範囲で切って換算し、届き方の印を付けて時刻順に返す', async () => {
    writeRawHour(H0, [
      [H0 + 1000, [10, 20, 30, 40], 'backlog'],
      [H0, [1, 2, 3], 'live'],
    ])
    const ref = parseChannelId(HNZ)!
    const got = await readSamples({ dirs, ref, fromMs: H0 + 10, toMs: H0 + 1030, unit: 'gal' })
    expect(got.unit).toBe('gal')
    expect(got.runs.map((r) => [r.firstSampleMs, r.origin, r.values.length])).toEqual([
      [H0 + 10, 'live', 2],
      [H0 + 1000, 'backlog', 3],
    ])
    expect(got.runs[0]!.values[0]).toBeCloseTo(2 * 61.0352 * GAL_PER_UG, 9)
    // 前の時のファイルは無い（記録していない）
    expect(got.files).toEqual({ read: 1, missing: 1, failed: 0 })
  })

  it('換算の係数がどこにも無い時は外して数え、native ならカウントのまま返す', async () => {
    writeRawHour(H0, [[H0, [5, 6], 'live']], null)
    const ref = parseChannelId(HNZ)!
    const gal = await readSamples({ dirs, ref, fromMs: H0, toMs: H0 + 1000, unit: 'gal' })
    expect(gal.runs).toHaveLength(0)
    expect(gal.problems.unscaledHours).toBe(1)
    const native = await readSamples({ dirs, ref, fromMs: H0, toMs: H0 + 1000, unit: 'native' })
    expect(native.unit).toBe('count')
    expect(Array.from(native.runs[0]!.values)).toEqual([5, 6])
  })

  it('合成波形は札で読み、作り直した分は印を付ける', async () => {
    // 2 つ目のサンプル（H0 + 10）だけを作り直した
    await writeWaveHour(H0, [[H0, [1, 2, 3]], [H0 + 10, [20], true]], false)
    const ref = parseChannelId(`station/${KEY}/EW`)!
    const got = await readSamples({ dirs, ref, fromMs: H0 + 10, toMs: H0 + 30, unit: 'gal' })
    expect(got.runs.map((r) => [r.firstSampleMs, r.origin, Array.from(r.values)])).toEqual([
      [H0 + 10, 'revised', [20]],
      [H0 + 20, 'live', [3]],
    ])
  })
})

describe('readReception', () => {
  it('取り戻した区間を範囲で切って返し、要約がまだ無い時は pending と数える', async () => {
    const path = writeRawHour(H0, [
      [H0, [1, 2, 3], 'live'],
      [H0 + 5000, Array.from({ length: 200 }, () => 1), 'backlog'],
    ])
    await buildSummaryFile({
      kind: 'raw',
      sourcePath: path,
      summaryPath: rawSummaryPath(dirs.summaryDir, hourKeyOf(H0)),
      hourKey: hourKeyOf(H0),
      hourStartMs: H0,
      stationKey: null,
    })
    // 次の時は元のファイルだけある（要約を作る係が追いついていない）
    writeRawHour(H0 + HOUR, [[H0 + HOUR, [1], 'live']])
    const got = await readReception({ dirs, fromMs: H0 + 6000, toMs: H0 + HOUR + 1000, sensor: null })
    expect(got.sensors).toHaveLength(1)
    expect(got.sensors[0]!.backlog).toEqual([{ fromMs: H0 + 6000, toMs: H0 + 7000 }])
    expect(got.hours).toEqual({ ok: 1, stale: 0, pending: 1, failed: 0, absent: 1 })
    // センサーで絞ると、別のセンサーは出ない
    const other = await readReception({ dirs, fromMs: H0, toMs: H0 + HOUR, sensor: 'FDSN:XX_FFFFFFFF_S9' })
    expect(other.sensors).toEqual([])
  })
})

describe('readSamplesEnvelope', () => {
  it('生のサンプルを列へ束ねる（列の幅は整数のミリ秒）', async () => {
    writeRawHour(H0, [[H0, [1, 3, 5, 7], 'live']])
    const ref = parseChannelId(HNZ)!
    const got = await readSamplesEnvelope({ dirs, ref, fromMs: H0, toMs: H0 + 40, columns: 2, unit: 'native' })
    expect(got.columns.columnMs).toBe(20)
    expect(got.columns.n).toEqual([2, 2])
    expect(got.columns.mean).toEqual([2, 6])
  })
})

describe('readSpectrum', () => {
  it('10 分以内は生のサンプルから、それより広ければ 1 分ごとの PSD の平均から出す', async () => {
    const values = Array.from({ length: 6000 }, (_, i) => Math.sin((2 * Math.PI * 5 * i) / 100))
    await writeWaveHour(H0, [[H0, values]])
    const ref = parseChannelId(`station/${KEY}/NS`)!
    const short = await readSpectrum({ dirs, ref, fromMs: H0, toMs: H0 + 60_000, unit: 'gal' })
    expect(short.source).toBe('samples')
    expect(short.segments).toBe(Math.floor((6000 - 1024) / 512) + 1)
    const long = await readSpectrum({ dirs, ref, fromMs: H0, toMs: H0 + 20 * 60_000, unit: 'gal' })
    expect(long.source).toBe('minutes')
    expect(long.segments).toBe(short.segments)
    // 同じ区間から出したので、5 Hz を含む区画の値はほぼ同じ
    const b5 = long.binEdgesHz.findIndex((e, i) => e <= 5 && long.binEdgesHz[i + 1]! > 5)
    expect(long.power[b5]! / short.power[b5]!).toBeCloseTo(1, 3)
  })
})

describe('readSpectrogram', () => {
  it('1 分ごとの PSD を列へ束ね、区間が無い列は 0', async () => {
    const values = Array.from({ length: 6000 }, (_, i) => Math.sin(i / 3))
    await writeWaveHour(H0, [[H0 + 2 * 60_000, values]])
    const ref = parseChannelId(`station/${KEY}/UD`)!
    const got = await readSpectrogram({ dirs, ref, fromMs: H0, toMs: H0 + 6 * 60_000, columns: 3, unit: 'gal' })
    expect(got.columnMs).toBe(120_000)
    expect(got.segments[0]).toBe(0)
    expect(got.segments[1]! + got.segments[2]!).toBe(Math.floor((6000 - 1024) / 512) + 1)
    expect(Array.from(got.power[0]!).every((v) => Number.isNaN(v))).toBe(true)
  })
})

describe('readSummaryEnvelope', () => {
  it('時の境目を跨いだまとまりは前の時の要約から拾う（次の時の元のファイルが無くても）', async () => {
    // 12:59:59.5 から 1 秒ぶん → 13:00:00〜00.5 の 50 サンプルは 12 時の要約に入っている
    await writeWaveHour(H0, [[H0 + HOUR - 500, Array.from({ length: 100 }, () => 2)]])
    const ref = parseChannelId(`station/${KEY}/NS`)!
    const result = await readSummaryEnvelope({ dirs, ref, source: 'fine', fromMs: H0 + HOUR, toMs: H0 + HOUR + 2000, columns: 2, unit: 'gal' })
    expect(result.unit).toBe('gal')
    expect(result.columns.n).toEqual([50, 0])
    expect(result.columns.mean[0]).toBe(2)
    expect(result.hours).toEqual({ ok: 1, stale: 0, pending: 0, failed: 0, absent: 1 })
  })

  it('元のファイルはあるのに要約が無い時は pending、作ったあとで伸びた時は stale と数える', async () => {
    await writeWaveHour(H0 - HOUR, [[H0 - HOUR, [1, 1]]], false)
    const grown = await writeWaveHour(H0, [[H0, [1, 1]]])
    appendFileSync(grown, Buffer.from([0, 0, 0]))
    const ref = parseChannelId(`station/${KEY}/UD`)!
    const result = await readSummaryEnvelope({ dirs, ref, source: 'coarse', fromMs: H0, toMs: H0 + HOUR, columns: 60, unit: 'gal' })
    expect(result.hours).toEqual({ ok: 0, stale: 1, pending: 1, failed: 0, absent: 0 })
    // 古くても出す
    expect(result.columns.n[0]).toBe(2)
  })

  it('生データのカウントを gal へ換算し、native ならカウントのまま返す', async () => {
    mkdirSync(join(dirs.rawDir, hourKeyOf(H0).slice(0, 10)), { recursive: true })
    const sourcePath = join(dirs.rawDir, hourKeyOf(H0).slice(0, 10), `raw-${hourKeyOf(H0)}.mseed3`)
    const log = buildMseed3TextRecord({
      sourceId: mseed3LogSourceId(BOARD, 'S1')!,
      startMs: H0,
      text: JSON.stringify({ board: BOARD, sensor: 'S1', channels: ['HNZ'], ugPerLsb: 61.0352 }),
    })
    const wave = buildMseed3Record({
      sourceId: mseed3SourceId(BOARD, 'S1', 'HNZ')!,
      startMs: H0,
      sampleRateHz: 100,
      block: encodeSteim2(Int32Array.from({ length: 50 }, () => 16384), 7),
    })
    writeFileSync(sourcePath, Buffer.concat([log, wave]))
    await buildSummaryFile({
      kind: 'raw',
      sourcePath,
      summaryPath: rawSummaryPath(dirs.summaryDir, hourKeyOf(H0)),
      hourKey: hourKeyOf(H0),
      hourStartMs: H0,
      stationKey: null,
    })
    const ref = parseChannelId(mseed3SourceId(BOARD, 'S1', 'HNZ')!)!
    const gal = await readSummaryEnvelope({ dirs, ref, source: 'fine', fromMs: H0, toMs: H0 + 1000, columns: 1, unit: 'gal' })
    expect(gal.unit).toBe('gal')
    expect(gal.columns.mean[0]).toBeCloseTo(16384 * 61.0352 * GAL_PER_UG, 2)
    const native = await readSummaryEnvelope({ dirs, ref, source: 'fine', fromMs: H0, toMs: H0 + 1000, columns: 1, unit: 'native' })
    expect(native.unit).toBe('count')
    expect(native.columns.mean[0]).toBe(16384)
    expect(native.problems).toEqual({ skippedBytes: 0, badRecords: 0, unscaledHours: 0 })
  })
})
