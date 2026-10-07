// 保存した波形を範囲で読み返す（管理コンソールの「波形の記録」の材料・`/api/records/*`）。
//
// **重い読みは前もって作った要約（`waveSummary.ts`）で済ませる。** 何日・何週を俯瞰するとき、
// 生データを解くと 1 時間あたり 0.6 秒かかる。要約なら画面の列数と開く時の数だけで決まる。
//
// **チャンネルの名乗り**は要約と同じ（`waveSummarySources.ts`）。
// - 生データ: miniSEED の識別子（`FDSN:XX_<局>_<センサー>_H_N_<向き>`）
// - 合成波形: `station/<観測点の札>/<X|Y|Z>`（共通座標 ENU の軸。札は `waveArchive.ts` の `stationFileToken`）
//
// **前の時の要約も重ねる。** まとまりは先頭の時刻で時のファイルへ入るので、時の境目の直後
// （合成波形なら最大 10 分）は前の時の要約にある（`waveSummary.ts` の `OVERHANG_MS`）。
// 同じサンプルが 2 つの要約に入ることは無いので、重ねても数え直しにはならない。
//
// **「無い」と「読めない」を分けて返す。** 要約がまだ無い時（いまの時・作る係が追いついていない）と、
// 元のファイルそのものが無い時（記録していない）を区別しないと、俯瞰の欠けが「揺れていない」にも
// 「壊れている」にも見える。

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { jstHour, jstHourStartMs } from './jstTime'
import { mseed3SourceId } from './mseed3Record'
import { readMseed3RecordsMatching } from './mseed3Reader'
import { RECORD_SPAN_MAX_MS, laneOfRecord } from './mseedPacketReader'
import { readWaveRangeByToken, waveFileNameOfToken } from './waveArchive'
import { PSD_BIN_COUNT, PSD_BIN_EDGES_HZ, columnPsd, intervalPsd } from './wavePsd'
import {
  SUMMARY_COARSE_MS,
  SUMMARY_FINE_MS,
  decodeSummaryPartWhere,
  type SourceProblems,
  type SummaryLevel,
  type SummaryPart,
  type SummaryPartChannel,
} from './waveSummary'
import {
  decodeReceptionSummary,
  mergeSpans,
  type ReceptionSpan,
  type ReceptionSummary,
  type SensorReception,
  type UnreadableEntry,
} from './receptionSummary'
import { rawSummaryPath, receptionSummaryPath, summaryPartPath, waveSummaryPath } from './waveSummaryFiles'
import { scaleOfLog } from './waveSummarySources'

const HOUR_MS = 3_600_000

/** 1 カウントを gal へ直す係数のうち、µg → gal の分（1 µg = 9.80665 × 10⁻⁴ gal）。 */
export const GAL_PER_UG = 9.80665e-4

/** 1 秒の段を使ってよい範囲の広さ。**これより広いと、1 秒の段の読みが 1 時間あたり約 1.9 MB ずつ嵩む。** */
export const FINE_RANGE_MAX_MS = 12 * HOUR_MS

/** 同時に開く要約の数。 */
const READ_PARALLEL = 16

/** 読み返す場所。 */
export interface RecordDirs {
  readonly summaryDir: string
  readonly rawDir: string
  readonly waveDir: string
}

/** チャンネルの名乗りを解いたもの。 */
export type ChannelRef =
  | { readonly kind: 'raw'; readonly id: string }
  | { readonly kind: 'station'; readonly id: string; readonly stationKey: string; readonly axis: 0 | 1 | 2 }

const RAW_ID_RE = /^FDSN:[A-Za-z0-9_-]{1,64}$/
const STATION_ID_RE = /^station\/([A-Za-z0-9_-]{1,64})\/(X|Y|Z)$/
/** 共通座標（ENU）の軸。並びは `waveSummarySources.ts` の `stationWaveChannelId` と同じ。 */
const AXES = ['X', 'Y', 'Z'] as const

/**
 * チャンネルの名乗りを解く。**名乗りの形に合わなければ `null`**（読み手は名乗りからファイルの場所を
 * 作るので、区切り文字や `..` を通すと置き場所の外を読みに行く）。受信の記録（`L_O_G`）は波形ではないので通さない。
 */
export function parseChannelId(id: string): ChannelRef | null {
  const station = STATION_ID_RE.exec(id)
  if (station !== null) {
    return { kind: 'station', id, stationKey: station[1]!, axis: AXES.indexOf(station[2] as (typeof AXES)[number]) as 0 | 1 | 2 }
  }
  if (RAW_ID_RE.test(id) && !id.endsWith('_L_O_G')) return { kind: 'raw', id }
  return null
}

/** 範囲 `[fromMs, toMs)` に触れる時の頭を、**前の時を含めて**古い順に並べる。 */
export function hoursToOpen(fromMs: number, toMs: number): number[] {
  const first = jstHourStartMs(fromMs)
  const last = jstHourStartMs(toMs - 1)
  if (first === null || last === null || last < first) return []
  const hours: number[] = []
  for (let at = first - HOUR_MS; at <= last; at += HOUR_MS) hours.push(at)
  return hours
}

function summaryBaseOf(dirs: RecordDirs, ref: ChannelRef, hourKey: string): string {
  return ref.kind === 'raw' ? rawSummaryPath(dirs.summaryDir, hourKey) : waveSummaryPath(dirs.summaryDir, ref.stationKey, hourKey)
}

/** 要約の元になったファイルの場所（大きさを比べて、要約が古いかを見る）。 */
export function sourcePathOf(dirs: RecordDirs, ref: ChannelRef, hourKey: string): string {
  return ref.kind === 'raw' ? rawSourcePathOf(dirs, hourKey) : join(dirs.waveDir, waveFileNameOfToken(ref.stationKey, hourKey))
}

/** 生データの時のファイルの場所（`mseedStore.ts` の置き方）。 */
function rawSourcePathOf(dirs: RecordDirs, hourKey: string): string {
  return join(dirs.rawDir, hourKey.slice(0, 10), `raw-${hourKey}.mseed3`)
}

/**
 * 開いた時の数え。**`pending` は「元のファイルはあるのに要約がまだ無い」**（その時は俯瞰に出ない）、
 * **`stale` は「要約はあるが、作ったあとで元のファイルが伸びた」**（出すが、末尾が欠けているかもしれない）。
 * `absent` は元のファイルも無い（記録していない時で、異常ではない）。
 */
export interface HourTally {
  ok: number
  stale: number
  pending: number
  failed: number
  absent: number
}

function emptyTally(): HourTally {
  return { ok: 0, stale: 0, pending: 0, failed: 0, absent: 0 }
}

/** 1 時ぶんの要約の 1 チャンネル。 */
export interface HourChannel {
  readonly hourStartMs: number
  readonly channel: SummaryPartChannel
  readonly sourceProblems: SourceProblems
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

async function sizeOrNull(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

type HourOutcome =
  | { readonly state: 'ok' | 'stale'; readonly found: HourChannel | null }
  | { readonly state: 'pending' | 'failed' | 'absent' }

async function readOneHour(dirs: RecordDirs, ref: ChannelRef, part: SummaryPart, hourStartMs: number): Promise<HourOutcome> {
  const hourKey = jstHour(hourStartMs)
  if (hourKey === null) return { state: 'failed' }
  let sourceBytes: number | null
  try {
    sourceBytes = await sizeOrNull(sourcePathOf(dirs, ref, hourKey))
  } catch {
    return { state: 'failed' }
  }
  let buf: Buffer
  try {
    buf = await readFile(summaryPartPath(summaryBaseOf(dirs, ref, hourKey), part))
  } catch (error) {
    if (!isMissing(error)) return { state: 'failed' }
    return { state: sourceBytes === null ? 'absent' : 'pending' }
  }
  const decoded = decodeSummaryPartWhere(buf, (id) => id === ref.id)
  // **読めない要約は「作り直し待ち」として数える**（作る係が頭の形の違いで作り直す）。元のファイルが
  // 無いのに読めない要約だけが残っているなら、それは読めないものとして数える。
  if (decoded === null || decoded.part !== part) return { state: sourceBytes === null ? 'failed' : 'pending' }
  const channel = decoded.channels.find((c) => c.id === ref.id) ?? null
  return {
    state: sourceBytes === null || sourceBytes === decoded.sourceBytes ? 'ok' : 'stale',
    found: channel === null ? null : { hourStartMs, channel, sourceProblems: decoded.sourceProblems },
  }
}

/**
 * 正常でない時 1 つ（{@link HourTally} の `stale`・`pending`・`failed`）。**数だけでは場所が判らない**ので、
 * 画面が「記録が無い」と「要約がまだ無い」を時刻の上で塗り分けられるよう、頭の時刻を添えて返す。
 */
export interface IrregularHour {
  readonly hourStartMs: number
  readonly state: 'stale' | 'pending' | 'failed'
}

/** 範囲に触れる時の要約から、そのチャンネルの 1 部分を集める。投げない。 */
export async function readHourChannels(
  dirs: RecordDirs,
  ref: ChannelRef,
  part: SummaryPart,
  fromMs: number,
  toMs: number,
): Promise<{ readonly hours: readonly HourChannel[]; readonly tally: HourTally; readonly irregular: readonly IrregularHour[] }> {
  const starts = hoursToOpen(fromMs, toMs)
  const tally = emptyTally()
  const hours: HourChannel[] = []
  const irregular: IrregularHour[] = []
  for (let i = 0; i < starts.length; i += READ_PARALLEL) {
    const slice = starts.slice(i, i + READ_PARALLEL)
    const batch = await Promise.all(slice.map((h) => readOneHour(dirs, ref, part, h)))
    batch.forEach((outcome, k) => {
      tally[outcome.state] += 1
      if (outcome.state === 'stale' || outcome.state === 'pending' || outcome.state === 'failed') {
        irregular.push({ hourStartMs: slice[k]!, state: outcome.state })
      }
      if ((outcome.state === 'ok' || outcome.state === 'stale') && outcome.found !== null) hours.push(outcome.found)
    })
  }
  return { hours, tally, irregular }
}

// ---- 列へ束ねる ---------------------------------------------------------------------------

/** 要約のどの段を使うか。`samples` は要約より細かいので生のサンプルを読む。 */
export type EnvelopeSource = 'coarse' | 'fine' | 'samples'

/**
 * 列 1 本の幅から段を選ぶ。`samplesRangeMaxMs` は生のサンプルを読んでよい範囲の広さ。
 *
 * - 列の幅が 1 分以上 → 1 分の段
 * - 1 秒以上、かつ範囲が {@link FINE_RANGE_MAX_MS} 以内 → 1 秒の段
 * - 1 秒未満、かつ範囲が `samplesRangeMaxMs` 以内 → 生のサンプル
 * - それ以外は、使える中でいちばん細かい段（列の数は頼まれたより増える）
 */
export function chooseEnvelopeSource(fromMs: number, toMs: number, columns: number, samplesRangeMaxMs: number): EnvelopeSource {
  const range = toMs - fromMs
  const width = range / columns
  if (width >= SUMMARY_COARSE_MS) return 'coarse'
  if (width < SUMMARY_FINE_MS && range <= samplesRangeMaxMs) return 'samples'
  return range <= FINE_RANGE_MAX_MS ? 'fine' : 'coarse'
}

/**
 * 列の幅。**段のまとまりの整数倍に揃える**（まとまりが列をまたがないので、半端な割り付けで偽の欠けや
 * 偽の山が出ない）。頼まれた数より列を増やさない向きに丸める。
 */
export function columnMsFor(fromMs: number, toMs: number, columns: number, bucketMs: number): number {
  return bucketMs * Math.max(1, Math.ceil((toMs - fromMs) / columns / bucketMs))
}

/** 列ごとの値。**本数が 0 の列は他の欄が `null`**（届いていない）。 */
export interface EnvelopeColumns {
  readonly columnMs: number
  /** 1 本目の列の頭（unix ミリ秒）。i 本目は `firstColumnMs + i × columnMs`。 */
  readonly firstColumnMs: number
  readonly n: number[]
  readonly min: (number | null)[]
  readonly max: (number | null)[]
  readonly mean: (number | null)[]
  /** 列の中の標準偏差（平均のゆっくりした動きも含む）。 */
  readonly std: (number | null)[]
  /**
   * 1 秒より速い揺れの強さ（1 秒ごとのばらつきを本数で重みを付けて束ねた標準偏差）。
   * **ノイズ水準の推移はこちらを見る**（`std` は傾きや温度でゆっくり動く直流まで含む）。
   */
  readonly noiseStd: (number | null)[]
}

/** 束ねている途中の 1 列。 */
interface ColumnAcc {
  n: Float64Array
  mean: Float64Array
  m2: Float64Array
  noiseM2: Float64Array
  min: Float64Array
  max: Float64Array
}

function newAcc(count: number): ColumnAcc {
  return {
    n: new Float64Array(count),
    mean: new Float64Array(count),
    m2: new Float64Array(count),
    noiseM2: new Float64Array(count),
    min: new Float64Array(count).fill(Number.POSITIVE_INFINITY),
    max: new Float64Array(count).fill(Number.NEGATIVE_INFINITY),
  }
}

/** 2 つの群の平均とばらつきを合わせる（Chan らの式）。 */
function mergeInto(acc: ColumnAcc, j: number, nb: number, mb: number, m2b: number): void {
  const na = acc.n[j]!
  const total = na + nb
  const d = mb - acc.mean[j]!
  acc.mean[j] = acc.mean[j]! + (d * nb) / total
  acc.m2[j] = acc.m2[j]! + m2b + (d * d * na * nb) / total
  acc.n[j] = total
}

/** 有効数字 6 桁へ丸める（f32 の要約に 17 桁を書いても意味が無く、応答が 3 倍に膨らむ）。 */
export function round6(v: number): number {
  if (v === 0 || !Number.isFinite(v)) return v
  return Number(v.toPrecision(6))
}

function finishColumns(acc: ColumnAcc, columnMs: number, firstColumn: number): EnvelopeColumns {
  const count = acc.n.length
  const out: EnvelopeColumns = {
    columnMs,
    firstColumnMs: firstColumn * columnMs,
    n: new Array<number>(count),
    min: new Array<number | null>(count),
    max: new Array<number | null>(count),
    mean: new Array<number | null>(count),
    std: new Array<number | null>(count),
    noiseStd: new Array<number | null>(count),
  }
  for (let j = 0; j < count; j += 1) {
    const n = acc.n[j]!
    out.n[j] = n
    if (n === 0) {
      out.min[j] = null
      out.max[j] = null
      out.mean[j] = null
      out.std[j] = null
      out.noiseStd[j] = null
      continue
    }
    out.min[j] = round6(acc.min[j]!)
    out.max[j] = round6(acc.max[j]!)
    out.mean[j] = round6(acc.mean[j]!)
    out.std[j] = round6(Math.sqrt(Math.max(0, acc.m2[j]! / n)))
    out.noiseStd[j] = round6(Math.sqrt(Math.max(0, acc.noiseM2[j]! / n)))
  }
  return out
}

/** 束ねる 1 段と、その値へ掛ける係数（カウント → gal。換算しないなら 1）。 */
export interface ScaledLevel {
  readonly level: SummaryLevel
  readonly scale: number
}

/**
 * 段のまとまりを列へ束ねる。`columnMs` は段のまとまりの整数倍であること（{@link columnMsFor}）。
 * 列は `[fromMs, toMs)` を覆う分だけ作り、範囲の外のまとまりは捨てる。
 *
 * **ノイズの分散**は、1 分の段ならその欄を、1 秒の段ならまとまりのばらつきそのものを束ねる
 * （どちらも「1 秒ごとのばらつきを本数で重みを付けて平均したもの」になる）。
 */
export function levelsToColumns(levels: readonly ScaledLevel[], fromMs: number, toMs: number, columnMs: number): EnvelopeColumns {
  const firstColumn = Math.floor(fromMs / columnMs)
  const lastColumn = Math.floor((toMs - 1) / columnMs)
  const count = Math.max(0, lastColumn - firstColumn + 1)
  const acc = newAcc(count)
  for (const { level, scale } of levels) {
    const s2 = scale * scale
    for (let i = 0; i < level.n.length; i += 1) {
      const nb = level.n[i]!
      if (nb === 0) continue
      const t = (level.firstBucket + i) * level.bucketMs
      const j = Math.floor(t / columnMs) - firstColumn
      if (j < 0 || j >= count) continue
      const m2b = level.variance[i]! * nb * s2
      mergeInto(acc, j, nb, level.mean[i]! * scale, m2b)
      const noiseVar = level.noiseVariance === null ? level.variance[i]! : level.noiseVariance[i]!
      acc.noiseM2[j] = acc.noiseM2[j]! + noiseVar * nb * s2
      // 係数は正なので、最小・最大の向きは変わらない。
      const lo = level.min[i]! * scale
      const hi = level.max[i]! * scale
      if (lo < acc.min[j]!) acc.min[j] = lo
      if (hi > acc.max[j]!) acc.max[j] = hi
    }
  }
  return finishColumns(acc, columnMs, firstColumn)
}

/**
 * 生のサンプルを列へ束ねる（要約より細かく見るとき）。列の幅は好きに取ってよい（段に揃える必要が無い）。
 * **ノイズの欄は 1 秒ごとのばらつきを束ねる**ので、列が 1 秒より短いと `std` と同じになる。
 */
export function samplesToColumns(
  runs: readonly { readonly firstSampleMs: number; readonly msPerSample: number; readonly values: ArrayLike<number> }[],
  scale: number,
  fromMs: number,
  toMs: number,
  columnMs: number,
): EnvelopeColumns {
  const firstColumn = Math.floor(fromMs / columnMs)
  const lastColumn = Math.floor((toMs - 1) / columnMs)
  const count = Math.max(0, lastColumn - firstColumn + 1)
  const acc = newAcc(count)
  for (const r of runs) {
    for (let i = 0; i < r.values.length; i += 1) {
      const t = r.firstSampleMs + i * r.msPerSample
      if (t < fromMs || t >= toMs) continue
      const x = r.values[i]! * scale
      if (!Number.isFinite(x)) continue
      const j = Math.floor(t / columnMs) - firstColumn
      if (j < 0 || j >= count) continue
      mergeInto(acc, j, 1, x, 0)
      if (x < acc.min[j]!) acc.min[j] = x
      if (x > acc.max[j]!) acc.max[j] = x
    }
  }
  // サンプルを 1 つずつ足すと、列の中のばらつきがそのまま 1 秒より速い揺れの強さになる。
  for (let j = 0; j < count; j += 1) acc.noiseM2[j] = acc.m2[j]!
  return finishColumns(acc, columnMs, firstColumn)
}

// ---- 範囲の要約を読む ---------------------------------------------------------------------

/** 返す値の単位の選び方。`gal` はカウントを換算する（換算できない時は外して数える）。`native` は記録のまま。 */
export type UnitChoice = 'gal' | 'native'

/** 1 時ぶんの値へ掛ける係数。換算できなければ `null`。 */
export function scaleOf(channel: SummaryPartChannel, unit: UnitChoice): number | null {
  if (unit === 'native' || channel.unit === 'gal') return 1
  return channel.ugPerLsb === null ? null : channel.ugPerLsb * GAL_PER_UG
}

/** 返す値の単位。 */
export function unitLabelOf(ref: ChannelRef, unit: UnitChoice): 'gal' | 'count' {
  return ref.kind === 'station' || unit === 'gal' ? 'gal' : 'count'
}

/** 要約を読んだときに見つかった不調の合計。 */
export interface ReadProblems {
  /** 元のファイルのうち読めなかった分（要約はその分を欠いている）。 */
  readonly skippedBytes: number
  readonly badRecords: number
  /** 換算の係数が判らず、外した時の数（`unit=gal` のときだけ数える）。 */
  readonly unscaledHours: number
}

export interface EnvelopeResult {
  readonly source: 'coarse' | 'fine'
  readonly unit: 'gal' | 'count'
  readonly columns: EnvelopeColumns
  readonly hours: HourTally
  /** 正常でない時（時刻の順）。範囲の手前の時（前の時からはみ出した分を拾うために開いた時）も含む。 */
  readonly irregularHours: readonly IrregularHour[]
  readonly problems: ReadProblems
}

function sumProblems(hours: readonly HourChannel[], unscaledHours: number): ReadProblems {
  let skippedBytes = 0
  let badRecords = 0
  for (const h of hours) {
    skippedBytes += h.sourceProblems.skippedBytes
    badRecords += h.sourceProblems.badRecords
  }
  return { skippedBytes, badRecords, unscaledHours }
}

/** 要約から列を作る（1 分の段か 1 秒の段）。投げない。 */
export async function readSummaryEnvelope(params: {
  readonly dirs: RecordDirs
  readonly ref: ChannelRef
  readonly source: 'coarse' | 'fine'
  readonly fromMs: number
  readonly toMs: number
  readonly columns: number
  readonly unit: UnitChoice
}): Promise<EnvelopeResult> {
  const { dirs, ref, source, fromMs, toMs, columns, unit } = params
  const bucketMs = source === 'coarse' ? SUMMARY_COARSE_MS : SUMMARY_FINE_MS
  const columnMs = columnMsFor(fromMs, toMs, columns, bucketMs)
  const read = await readHourChannels(dirs, ref, source, fromMs, toMs)
  const levels: ScaledLevel[] = []
  let unscaledHours = 0
  for (const h of read.hours) {
    if (h.channel.level === null) continue
    const scale = scaleOf(h.channel, unit)
    if (scale === null) {
      unscaledHours += 1
      continue
    }
    levels.push({ level: h.channel.level, scale })
  }
  return {
    source,
    unit: unitLabelOf(ref, unit),
    columns: levelsToColumns(levels, fromMs, toMs, columnMs),
    hours: read.tally,
    irregularHours: read.irregular,
    problems: sumProblems(read.hours, unscaledHours),
  }
}

// ---- 生のサンプル -------------------------------------------------------------------------

/**
 * 生のサンプルを読んでよい範囲の広さ。1 チャンネル 100 Hz で 6 万点（JSON で約 0.5 MB）。
 * 生データの 1 時間ぶん（約 14 MB）のうち、識別子で絞ったレコードだけを解く。
 */
export const SAMPLES_RANGE_MAX_MS = 10 * 60_000

/** そのサンプルがどう届いたか。合成波形の `revised` は、取り戻した分から作り直したもの。 */
export type SampleOrigin = 'live' | 'backlog' | 'late' | 'revised' | 'unknown'

/** 途切れの無い 1 本（生データなら 1 レコード、合成波形なら 1 まとまり）。範囲の外は切ってある。 */
export interface SampleRun {
  readonly firstSampleMs: number
  readonly msPerSample: number
  /** 換算済みの値。**有限でない値は欠け**（合成波形で軸が届かなかった）。 */
  readonly values: Float64Array
  readonly origin: SampleOrigin
  /** 生データのレコードが「時刻が疑わしい」の印を持っていたか（合成波形は常に `false`）。 */
  readonly timeQuestionable: boolean
}

/** 開いた元のファイルの数え。 */
export interface FileTally {
  read: number
  missing: number
  failed: number
}

export interface SamplesResult {
  readonly unit: 'gal' | 'count'
  /** 先頭の時刻の順。 */
  readonly runs: readonly SampleRun[]
  readonly files: FileTally
  readonly problems: ReadProblems
}

/** 波形の識別子（`…_H_N_Z`）から、同じセンサーの受信の記録（`…_L_O_G`）の識別子。 */
export function logSourceIdOf(waveId: string): string {
  return waveId.replace(/_[A-Za-z0-9]_[A-Za-z0-9]_[A-Za-z0-9]$/, '_L_O_G')
}

function trimRun(
  firstSampleMs: number,
  msPerSample: number,
  values: ArrayLike<number>,
  scale: number,
  fromMs: number,
  toMs: number,
  origin: SampleOrigin,
  timeQuestionable: boolean,
): SampleRun | null {
  if (!Number.isFinite(firstSampleMs) || !(msPerSample > 0)) return null
  const first = Math.max(0, Math.ceil((fromMs - firstSampleMs) / msPerSample))
  const end = Math.min(values.length, Math.ceil((toMs - firstSampleMs) / msPerSample))
  if (end <= first) return null
  const out = new Float64Array(end - first)
  for (let i = 0; i < out.length; i += 1) out[i] = values[first + i]! * scale
  return { firstSampleMs: firstSampleMs + first * msPerSample, msPerSample, values: out, origin, timeQuestionable }
}

/**
 * その時の生データで、そのチャンネルの 1 カウントあたりの µg を決める。受信の記録（`LOG`）が名乗った値が
 * 1 つに決まればそれ、記録が無ければ要約（作ったときに同じ記録から読んだ値）。**決まらなければ `null`**
 * （同じ時の中で分解能が変わった・どこにも名乗りが無い）。
 */
async function ugPerLsbOfHour(
  dirs: RecordDirs,
  ref: ChannelRef,
  hourStartMs: number,
  logTexts: readonly string[],
): Promise<number | null> {
  const found = new Set<number>()
  for (const text of logTexts) {
    const s = scaleOfLog(text)
    if (s === null) continue
    for (const ch of s.channels) if (mseed3SourceId(s.board, s.sensor, ch) === ref.id) found.add(s.ugPerLsb)
  }
  if (found.size === 1) return [...found][0]!
  if (found.size > 1) return null
  const fromSummary = await readOneHour(dirs, ref, 'coarse', hourStartMs)
  if ((fromSummary.state === 'ok' || fromSummary.state === 'stale') && fromSummary.found !== null) return fromSummary.found.channel.ugPerLsb
  return null
}

async function readRawSamples(dirs: RecordDirs, ref: ChannelRef, fromMs: number, toMs: number, unit: UnitChoice): Promise<SamplesResult> {
  const files: FileTally = { read: 0, missing: 0, failed: 0 }
  let skippedBytes = 0
  let badRecords = 0
  let unscaledHours = 0
  const runs: SampleRun[] = []
  const logId = logSourceIdOf(ref.id)
  // **レコードは先頭の時刻で時のファイルへ入る**ので、範囲の頭より少し前に始まったレコードは前の時にいる。
  const first = jstHourStartMs(fromMs - RECORD_SPAN_MAX_MS)
  const last = jstHourStartMs(toMs - 1)
  if (first === null || last === null) return { unit: unitLabelOf(ref, unit), runs, files, problems: { skippedBytes, badRecords, unscaledHours } }
  for (let at = first; at <= last; at += HOUR_MS) {
    const hourKey = jstHour(at)
    if (hourKey === null) continue
    let buf: Buffer
    try {
      buf = await readFile(sourcePathOf(dirs, ref, hourKey))
    } catch (error) {
      if (isMissing(error)) files.missing += 1
      else files.failed += 1
      continue
    }
    files.read += 1
    const read = readMseed3RecordsMatching(
      buf,
      (t, sid) => sid === logId || (sid === ref.id && t >= fromMs - RECORD_SPAN_MAX_MS && t < toMs),
    )
    skippedBytes += read.skippedBytes
    badRecords += read.crcFailures + read.decodeFailures
    const waves = read.records.filter((r) => r.sourceId === ref.id && r.samples !== null && r.sampleRateHz > 0)
    if (waves.length === 0) continue
    let scale = 1
    if (unit === 'gal') {
      const logTexts = read.records.filter((r) => r.sourceId === logId && r.text !== null).map((r) => r.text!)
      const ug = await ugPerLsbOfHour(dirs, ref, at, logTexts)
      if (ug === null) {
        unscaledHours += 1
        continue
      }
      scale = ug * GAL_PER_UG
    }
    for (const r of waves) {
      const run = trimRun(r.startMs, 1000 / r.sampleRateHz, r.samples!, scale, fromMs, toMs, laneOfRecord(r) ?? 'unknown', r.timeQuestionable)
      if (run !== null) runs.push(run)
    }
  }
  runs.sort((a, b) => a.firstSampleMs - b.firstSampleMs)
  return { unit: unitLabelOf(ref, unit), runs, files, problems: { skippedBytes, badRecords, unscaledHours } }
}

async function readStationSamples(
  dirs: RecordDirs,
  ref: Extract<ChannelRef, { kind: 'station' }>,
  fromMs: number,
  toMs: number,
): Promise<SamplesResult> {
  const read = await readWaveRangeByToken({ dir: dirs.waveDir, stationKey: ref.stationKey, fromMs, toMs })
  const runs: SampleRun[] = []
  for (const c of read.chunks) {
    const run = trimRun(c.firstSampleMs, c.msPerSample, c.gal[ref.axis], 1, fromMs, toMs, c.revised ? 'revised' : 'live', false)
    if (run !== null) runs.push(run)
  }
  return {
    unit: 'gal',
    runs,
    files: { read: read.filesRead, missing: read.filesMissing, failed: read.filesFailed },
    problems: { skippedBytes: read.skippedBytes, badRecords: 0, unscaledHours: 0 },
  }
}

/** 範囲 `[fromMs, toMs)` の生のサンプルを読む。範囲の広さは呼び出し側が {@link SAMPLES_RANGE_MAX_MS} 以内に抑えること。投げない。 */
export async function readSamples(params: {
  readonly dirs: RecordDirs
  readonly ref: ChannelRef
  readonly fromMs: number
  readonly toMs: number
  readonly unit: UnitChoice
}): Promise<SamplesResult> {
  const { dirs, ref, fromMs, toMs, unit } = params
  return ref.kind === 'raw' ? readRawSamples(dirs, ref, fromMs, toMs, unit) : readStationSamples(dirs, ref, fromMs, toMs)
}

/** 生のサンプルから列を作る（要約より細かく見るとき）。 */
export async function readSamplesEnvelope(params: {
  readonly dirs: RecordDirs
  readonly ref: ChannelRef
  readonly fromMs: number
  readonly toMs: number
  readonly columns: number
  readonly unit: UnitChoice
}): Promise<{ readonly unit: 'gal' | 'count'; readonly columns: EnvelopeColumns; readonly files: FileTally; readonly problems: ReadProblems }> {
  const { fromMs, toMs, columns } = params
  const samples = await readSamples(params)
  return {
    unit: samples.unit,
    // 列の幅はミリ秒の整数へ切り上げる（端数の幅だと、列の頭が範囲の頭からずれて積み上がる）。
    columns: samplesToColumns(samples.runs, 1, fromMs, toMs, Math.max(1, Math.ceil((toMs - fromMs) / columns))),
    files: samples.files,
    problems: samples.problems,
  }
}

// ---- 受信の記録 ---------------------------------------------------------------------------

/** 1 回に返す、読めなかったパケットの件数の上限。 */
export const RECEPTION_ITEMS_MAX = 2000

export interface ReceptionRangeResult {
  /** センサーごとの帯（範囲で切り、時の境目を跨いで繋いだもの）。帯が 1 本も無いセンサーは出ない。 */
  readonly sensors: SensorReception[]
  readonly unreadable: {
    /** 範囲の中の件（古い順・{@link RECEPTION_ITEMS_MAX} 件まで）。 */
    readonly items: UnreadableEntry[]
    /** 上限で切ったか（範囲の中の件を全部は返していない）。 */
    readonly truncated: boolean
    /** 要約が 1 時間ぶんの上限で件を落としていた時の数（その時は件数どおりに並んでいない）。 */
    readonly cappedHours: number
  }
  /** 中身を読めなかったホストの受信の記録の本数（開いた時の合計）。 */
  readonly unreadableLogs: number
  readonly hours: HourTally
}

function clipSpans(spans: readonly ReceptionSpan[], fromMs: number, toMs: number): ReceptionSpan[] {
  const out: ReceptionSpan[] = []
  for (const s of spans) {
    if (s.toMs <= fromMs || s.fromMs >= toMs) continue
    out.push({ fromMs: Math.max(fromMs, s.fromMs), toMs: Math.min(toMs, s.toMs) })
  }
  return out
}

/**
 * 範囲 `[fromMs, toMs)` の受信の記録の要約を読む（生データの時ごと）。`sensor` を渡せばそのセンサーだけ。
 * **要約の無い時は `pending`・`absent` として数える**（帯が無いのと「まだ作っていない」を混ぜない）。投げない。
 */
export async function readReception(params: {
  readonly dirs: RecordDirs
  readonly fromMs: number
  readonly toMs: number
  readonly sensor: string | null
}): Promise<ReceptionRangeResult> {
  const { dirs, fromMs, toMs, sensor } = params
  const tally = emptyTally()
  const bySensor = new Map<string, { backlog: ReceptionSpan[]; late: ReceptionSpan[]; questionable: ReceptionSpan[] }>()
  const items: UnreadableEntry[] = []
  let cappedHours = 0
  let unreadableLogs = 0
  const starts = hoursToOpen(fromMs, toMs)
  const readOne = async (hourStartMs: number): Promise<{ state: keyof HourTally; summary: ReceptionSummary | null }> => {
    const hourKey = jstHour(hourStartMs)
    if (hourKey === null) return { state: 'failed', summary: null }
    let sourceBytes: number | null
    try {
      sourceBytes = await sizeOrNull(rawSourcePathOf(dirs, hourKey))
    } catch {
      return { state: 'failed', summary: null }
    }
    let text: string
    try {
      text = await readFile(receptionSummaryPath(rawSummaryPath(dirs.summaryDir, hourKey)), 'utf8')
    } catch (error) {
      if (!isMissing(error)) return { state: 'failed', summary: null }
      return { state: sourceBytes === null ? 'absent' : 'pending', summary: null }
    }
    const summary = decodeReceptionSummary(text)
    if (summary === null) return { state: sourceBytes === null ? 'failed' : 'pending', summary: null }
    return { state: sourceBytes === null || sourceBytes === summary.sourceBytes ? 'ok' : 'stale', summary }
  }
  for (let i = 0; i < starts.length; i += READ_PARALLEL) {
    const batch = await Promise.all(starts.slice(i, i + READ_PARALLEL).map(readOne))
    for (const { state, summary } of batch) {
      tally[state] += 1
      if (summary === null) continue
      unreadableLogs += summary.unreadableLogs
      if (summary.unreadable.count > summary.unreadable.items.length) cappedHours += 1
      for (const it of summary.unreadable.items) if (it.atMs >= fromMs && it.atMs < toMs) items.push(it)
      for (const s of summary.sensors) {
        if (sensor !== null && s.sensor !== sensor) continue
        let entry = bySensor.get(s.sensor)
        if (entry === undefined) {
          entry = { backlog: [], late: [], questionable: [] }
          bySensor.set(s.sensor, entry)
        }
        entry.backlog.push(...clipSpans(s.backlog, fromMs, toMs))
        entry.late.push(...clipSpans(s.late, fromMs, toMs))
        entry.questionable.push(...clipSpans(s.questionable, fromMs, toMs))
      }
    }
  }
  const sensors: SensorReception[] = [...bySensor.entries()]
    .map(([name, e]) => ({ sensor: name, backlog: mergeSpans(e.backlog), late: mergeSpans(e.late), questionable: mergeSpans(e.questionable) }))
    .filter((s) => s.backlog.length + s.late.length + s.questionable.length > 0)
    .sort((a, b) => (a.sensor < b.sensor ? -1 : a.sensor > b.sensor ? 1 : 0))
  items.sort((a, b) => a.atMs - b.atMs)
  return {
    sensors,
    unreadable: { items: items.slice(0, RECEPTION_ITEMS_MAX), truncated: items.length > RECEPTION_ITEMS_MAX, cappedHours },
    unreadableLogs,
    hours: tally,
  }
}

// ---- スペクトル ---------------------------------------------------------------------------

/** 区画ごとの PSD（値の単位² / Hz）。**区画の境目は `PSD_BIN_EDGES_HZ`**（0.1〜50 Hz を対数で 40 区画）。 */
export interface SpectrumResult {
  /** 生のサンプルから Welch で出したか、1 分ごとの PSD を平均したか。 */
  readonly source: 'samples' | 'minutes'
  readonly unit: 'gal' | 'count'
  readonly binEdgesHz: readonly number[]
  /** 測れない区画（ナイキスト周波数より上・区間が 1 つも無い）は `NaN`。 */
  readonly power: Float64Array
  /** 平均した区間（約 10 秒）の数。 */
  readonly segments: number
  readonly problems: ReadProblems
}

/**
 * 範囲のスペクトル。**{@link SAMPLES_RANGE_MAX_MS} 以内なら生のサンプルから Welch で出し**、それより
 * 広ければ前もって作った 1 分ごとの PSD を、範囲に丸ごと入る分だけ区間の数で重みを付けて平均する。投げない。
 */
export async function readSpectrum(params: {
  readonly dirs: RecordDirs
  readonly ref: ChannelRef
  readonly fromMs: number
  readonly toMs: number
  readonly unit: UnitChoice
}): Promise<SpectrumResult & { readonly hours: HourTally | null; readonly files: FileTally | null }> {
  const { dirs, ref, fromMs, toMs, unit } = params
  if (toMs - fromMs <= SAMPLES_RANGE_MAX_MS) {
    const samples = await readSamples(params)
    const psd = intervalPsd(samples.runs, fromMs, toMs)
    return {
      source: 'samples',
      unit: samples.unit,
      binEdgesHz: PSD_BIN_EDGES_HZ,
      power: psd.power,
      segments: psd.segments,
      problems: samples.problems,
      hours: null,
      files: samples.files,
    }
  }
  const firstMinute = Math.ceil(fromMs / SUMMARY_COARSE_MS)
  const endMinute = Math.floor(toMs / SUMMARY_COARSE_MS)
  const read = await readHourChannels(dirs, ref, 'psd', fromMs, toMs)
  const acc = new Float64Array(PSD_BIN_COUNT)
  const n = new Float64Array(PSD_BIN_COUNT)
  let segments = 0
  let unscaledHours = 0
  for (const h of read.hours) {
    const psd = h.channel.psd
    if (psd === null) continue
    const scale = scaleOf(h.channel, unit)
    if (scale === null) {
      unscaledHours += 1
      continue
    }
    const s2 = scale * scale
    for (let i = 0; i < psd.segments.length; i += 1) {
      const minute = psd.firstMinute + i
      const seg = psd.segments[i]!
      if (seg === 0 || minute < firstMinute || minute >= endMinute) continue
      segments += seg
      for (let b = 0; b < PSD_BIN_COUNT; b += 1) {
        const p = psd.power[i * PSD_BIN_COUNT + b]!
        if (!Number.isFinite(p)) continue
        acc[b] = acc[b]! + p * s2 * seg
        n[b] = n[b]! + seg
      }
    }
  }
  const power = new Float64Array(PSD_BIN_COUNT).fill(Number.NaN)
  for (let b = 0; b < PSD_BIN_COUNT; b += 1) if (n[b]! > 0) power[b] = acc[b]! / n[b]!
  return {
    source: 'minutes',
    unit: unitLabelOf(ref, unit),
    binEdgesHz: PSD_BIN_EDGES_HZ,
    power,
    segments,
    problems: sumProblems(read.hours, unscaledHours),
    hours: read.tally,
    files: null,
  }
}

/** 列ごとの PSD（スペクトログラム）。 */
export interface SpectrogramResult {
  /** 生のサンプルから列ごとに出したか、1 分ごとの PSD を束ねたか。 */
  readonly source: 'samples' | 'minutes'
  readonly unit: 'gal' | 'count'
  readonly binEdgesHz: readonly number[]
  /** 列の幅（`samples` は 1 秒の整数倍で {@link SPECTROGRAM_SAMPLES_MIN_COLUMN_MS} 以上、`minutes` は 1 分の整数倍）。 */
  readonly columnMs: number
  readonly firstColumnMs: number
  /** 列ごとに平均した区間の数。**0 の列は作れなかった**（`power` の行はすべて `NaN`）。 */
  readonly segments: number[]
  /** `[列][区画]`。 */
  readonly power: Float64Array[]
  /** 開いた時の数え（`minutes` のとき）。`samples` は要約を読まないので `null`。 */
  readonly hours: HourTally | null
  /** 正常でない時（`minutes` のとき。画面が「要約がまだ無い」を時刻の上に塗る）。`samples` は空。 */
  readonly irregularHours: readonly IrregularHour[]
  /** 読んだ元のファイルの数え（`samples` のとき）。 */
  readonly files: FileTally | null
  readonly problems: ReadProblems
}

/**
 * 生のサンプルから作るときの列の幅の下限。**区間（約 10 秒）を進める幅（約 5 秒）より広くする** ——
 * 狭いと区間の入らない列が縞のように出る（`columnPsd`）。1 秒の整数倍に揃える。
 */
export const SPECTROGRAM_SAMPLES_MIN_COLUMN_MS = 6000
/** 生のサンプルから作るとき、範囲の前後に余分に読む幅（区間の半分 ＝ 公称 100 Hz で 5.12 秒を覆う）。 */
const SPECTROGRAM_SAMPLES_PAD_MS = 6000

/**
 * 列ごとのスペクトル。**{@link SAMPLES_RANGE_MAX_MS} 以内なら生のサンプルから**、約 10 秒の区間を中心の時刻が
 * 入る列へ積む（列は 6 秒以上）。範囲の端の列まで区間を作るため、前後を区間の半分ずつ余分に読む。
 * それより広ければ前もって作った 1 分ごとの PSD を列へ束ねる（列の幅は 1 分の整数倍。列の中の分は、
 * 区間の数で重みを付けて平均する）。投げない。
 */
export async function readSpectrogram(params: {
  readonly dirs: RecordDirs
  readonly ref: ChannelRef
  readonly fromMs: number
  readonly toMs: number
  readonly columns: number
  readonly unit: UnitChoice
}): Promise<SpectrogramResult> {
  const { dirs, ref, fromMs, toMs, columns, unit } = params
  if (toMs - fromMs <= SAMPLES_RANGE_MAX_MS) {
    const columnMs = Math.max(SPECTROGRAM_SAMPLES_MIN_COLUMN_MS, columnMsFor(fromMs, toMs, columns, 1000))
    const samples = await readSamples({ dirs, ref, fromMs: fromMs - SPECTROGRAM_SAMPLES_PAD_MS, toMs: toMs + SPECTROGRAM_SAMPLES_PAD_MS, unit })
    const psd = columnPsd(samples.runs, fromMs, toMs, columnMs)
    return {
      source: 'samples',
      unit: samples.unit,
      binEdgesHz: PSD_BIN_EDGES_HZ,
      columnMs,
      firstColumnMs: psd.firstColumn * columnMs,
      segments: psd.segments,
      power: psd.power,
      hours: null,
      irregularHours: [],
      files: samples.files,
      problems: samples.problems,
    }
  }
  const columnMs = columnMsFor(fromMs, toMs, columns, SUMMARY_COARSE_MS)
  const firstColumn = Math.floor(fromMs / columnMs)
  const count = Math.max(0, Math.floor((toMs - 1) / columnMs) - firstColumn + 1)
  const acc = Array.from({ length: count }, () => new Float64Array(PSD_BIN_COUNT))
  const n = Array.from({ length: count }, () => new Float64Array(PSD_BIN_COUNT))
  const segments = new Array<number>(count).fill(0)
  const read = await readHourChannels(dirs, ref, 'psd', fromMs, toMs)
  let unscaledHours = 0
  for (const h of read.hours) {
    const psd = h.channel.psd
    if (psd === null) continue
    const scale = scaleOf(h.channel, unit)
    if (scale === null) {
      unscaledHours += 1
      continue
    }
    const s2 = scale * scale
    for (let i = 0; i < psd.segments.length; i += 1) {
      const seg = psd.segments[i]!
      if (seg === 0) continue
      const j = Math.floor(((psd.firstMinute + i) * SUMMARY_COARSE_MS) / columnMs) - firstColumn
      if (j < 0 || j >= count) continue
      segments[j] = segments[j]! + seg
      for (let b = 0; b < PSD_BIN_COUNT; b += 1) {
        const p = psd.power[i * PSD_BIN_COUNT + b]!
        if (!Number.isFinite(p)) continue
        acc[j]![b] = acc[j]![b]! + p * s2 * seg
        n[j]![b] = n[j]![b]! + seg
      }
    }
  }
  const power = acc.map((a, j) => {
    const row = new Float64Array(PSD_BIN_COUNT).fill(Number.NaN)
    for (let b = 0; b < PSD_BIN_COUNT; b += 1) if (n[j]![b]! > 0) row[b] = a[b]! / n[j]![b]!
    return row
  })
  return {
    source: 'minutes',
    unit: unitLabelOf(ref, unit),
    binEdgesHz: PSD_BIN_EDGES_HZ,
    columnMs,
    firstColumnMs: firstColumn * columnMs,
    segments,
    power,
    hours: read.tally,
    irregularHours: read.irregular,
    files: null,
    problems: sumProblems(read.hours, unscaledHours),
  }
}
