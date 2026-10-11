// 要約の 4 つ目の部分（合成と震度・`waveSummaryDerived.ts`）を範囲で読み返す。管理コンソールの
// 「波形の記録」が、10 分を超える幅で合成の段と震度の推移を描く材料（`/api/records/composite`・
// `/api/records/intensity` の広い幅）。
//
// **時の数え方は軸の段（`waveRecords.ts` の `readHourChannels`）に揃える。** 前の時も開き（はみ出した分）、
// 要約が無い時は `pending`・元が無い時は `absent`。合成波形の震度を読むときは**前の時の大きさも比べて**、作ったあとで
// 前の時が伸びていれば `stale` に数える（震度を前の時の末尾から通しているので。合成の大きさは比べない）。
//
// **計測震度はその場でフィルターを掛けない。** 区間ごとの上位 K 個（K は 0.3 秒ぶんのサンプル数）を
// 合わせて K 番目を取る —— 範囲に丸ごと入る分は 1 分の段、両端の分の途中は 1 秒の段の、範囲に丸ごと入る
// 秒だけを使う（範囲の端の 1 秒に満たない端数は入れない）。1 秒の段で列を描く幅なら、全部を 1 秒の段で合わせる。

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { jstHour } from './jstTime'
import { sensorOfSourceId } from './receptionSummary'
import { waveFileNameOfToken } from './waveArchive'
import {
  GAL_PER_UG,
  SAMPLES_RANGE_MAX_MS,
  chooseEnvelopeSource,
  columnMsFor,
  hoursToOpen,
  round6,
  type HourTally,
  type IrregularHour,
  type RecordDirs,
  type UnitChoice,
} from './waveRecords'
import { SUMMARY_COARSE_MS, SUMMARY_FINE_MS } from './waveSummary'
import { decodeDerivedPart, type DerivedPart, type DerivedPartFile } from './waveSummaryDerived'
import { rawSummaryPath, summaryPartPath, waveSummaryPath } from './waveSummaryFiles'

const HOUR_MS = 3_600_000
/** 同時に開く要約の数（`waveRecords.ts` と同じ）。 */
const READ_PARALLEL = 16
/** 計測震度の式の定数（気象庁告示。`src/utils/knet/seismicIntensity.ts` と同じ）。 */
const SINDO_LOG_COEFFICIENT = 2
const SINDO_OFFSET = 0.94

/** 合成を作る記録の名乗り。生データはセンサー（`FDSN:XX_<局>_<センサー>`）、合成波形は `station/<札>`。 */
export type GroupRef =
  | { readonly kind: 'raw'; readonly key: string }
  | { readonly kind: 'station'; readonly key: string; readonly stationKey: string }

const STATION_GROUP_RE = /^station\/([A-Za-z0-9_-]{1,64})$/
const RAW_GROUP_RE = /^FDSN:[A-Za-z0-9_-]{1,64}$/

/**
 * 記録の名乗りを解く。**形に合わなければ `null`**（名乗りからファイルの場所を作るので、区切り文字を通さない）。
 * 生データは**センサーの名乗り**だけを通す（軸まで名乗ったチャンネルの識別子は通さない）。
 */
export function parseGroupId(id: string): GroupRef | null {
  const station = STATION_GROUP_RE.exec(id)
  if (station !== null) return { kind: 'station', key: id, stationKey: station[1]! }
  if (RAW_GROUP_RE.test(id) && sensorOfSourceId(id) === id) return { kind: 'raw', key: id }
  return null
}

function sourcePathOf(dirs: RecordDirs, g: GroupRef, hourKey: string): string {
  return g.kind === 'raw'
    ? join(dirs.rawDir, hourKey.slice(0, 10), `raw-${hourKey}.mseed3`)
    : join(dirs.waveDir, waveFileNameOfToken(g.stationKey, hourKey))
}

function summaryBaseOf(dirs: RecordDirs, g: GroupRef, hourKey: string): string {
  return g.kind === 'raw' ? rawSummaryPath(dirs.summaryDir, hourKey) : waveSummaryPath(dirs.summaryDir, g.stationKey, hourKey)
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

type DerivedHourOutcome =
  | { readonly state: 'ok' | 'stale'; readonly file: DerivedPartFile }
  | { readonly state: 'pending' | 'failed' | 'absent' }

async function readDerivedHour(
  dirs: RecordDirs,
  g: GroupRef,
  part: DerivedPart,
  hourStartMs: number,
  withIntensity: boolean,
): Promise<DerivedHourOutcome> {
  const hourKey = jstHour(hourStartMs)
  const prevKey = jstHour(hourStartMs - HOUR_MS)
  if (hourKey === null || prevKey === null) return { state: 'failed' }
  let sourceBytes: number | null
  let prevBytes: number | null = null
  try {
    sourceBytes = await sizeOrNull(sourcePathOf(dirs, g, hourKey))
    if (g.kind === 'station' && withIntensity) prevBytes = await sizeOrNull(sourcePathOf(dirs, g, prevKey))
  } catch {
    return { state: 'failed' }
  }
  let buf: Buffer
  try {
    buf = await readFile(summaryPartPath(summaryBaseOf(dirs, g, hourKey), part))
  } catch (error) {
    if (!isMissing(error)) return { state: 'failed' }
    return { state: sourceBytes === null ? 'absent' : 'pending' }
  }
  const file = decodeDerivedPart(buf, (key) => key === g.key, withIntensity)
  if (file === null || file.part !== part) return { state: sourceBytes === null ? 'failed' : 'pending' }
  // 元が消えた要約は、そのまま描く（元の無い要約は見回りの係が捨てる）。
  if (sourceBytes === null) return { state: 'ok', file }
  // **前の時の大きさを比べるのは震度を読むときだけ** —— 前の時の末尾から通すのは震度で、合成はこの時の
  // サンプルだけで決まる。合成だけを読むときに比べると、前の時が伸びただけで合成の段に灰色の斜線が出る。
  const prevMatters = g.kind === 'station' && withIntensity
  const fresh = file.sourceBytes === sourceBytes && (!prevMatters || file.prevSourceBytes === prevBytes)
  return { state: fresh ? 'ok' : 'stale', file }
}

interface DerivedHours {
  readonly hours: readonly { readonly hourStartMs: number; readonly file: DerivedPartFile }[]
  readonly tally: HourTally
  readonly irregular: readonly IrregularHour[]
}

/**
 * 範囲に触れる時（前の時を含む）の要約の 4 つ目の部分を集める。**投げるのは `signal` が中断されたときだけ。**
 * `starts` を渡せばその時だけを開く（計測震度の端の 1 秒の段）。
 */
async function readDerivedHours(
  dirs: RecordDirs,
  g: GroupRef,
  part: DerivedPart,
  fromMs: number,
  toMs: number,
  withIntensity: boolean,
  signal: AbortSignal,
  starts: readonly number[] = hoursToOpen(fromMs, toMs),
): Promise<DerivedHours> {
  const tally: HourTally = { ok: 0, stale: 0, pending: 0, failed: 0, absent: 0 }
  const hours: { hourStartMs: number; file: DerivedPartFile }[] = []
  const irregular: IrregularHour[] = []
  for (let i = 0; i < starts.length; i += READ_PARALLEL) {
    signal.throwIfAborted()
    const slice = starts.slice(i, i + READ_PARALLEL)
    const batch = await Promise.all(slice.map((h) => readDerivedHour(dirs, g, part, h, withIntensity)))
    batch.forEach((outcome, k) => {
      tally[outcome.state] += 1
      if (outcome.state === 'stale' || outcome.state === 'pending' || outcome.state === 'failed') {
        irregular.push({ hourStartMs: slice[k]!, state: outcome.state })
      }
      if (outcome.state === 'ok' || outcome.state === 'stale') hours.push({ hourStartMs: slice[k]!, file: outcome.file })
    })
  }
  return { hours, tally, irregular }
}

/** 段の選び方。**生のサンプルは使わない**（10 分以内は画面が生のサンプルから合成する）。 */
function derivedSourceFor(fromMs: number, toMs: number, columns: number): 'coarse' | 'fine' {
  return chooseEnvelopeSource(fromMs, toMs, columns, SAMPLES_RANGE_MAX_MS) === 'coarse' ? 'coarse' : 'fine'
}

function partOf(source: 'coarse' | 'fine'): DerivedPart {
  return source === 'coarse' ? 'derived-coarse' : 'derived-fine'
}

// ---- 合成 ---------------------------------------------------------------------------------

/** 軸の組 1 つの列（**本数 0 の列の最大は `null`**）。 */
export interface CompositeSubsetColumns {
  /** 組の軸のチャンネル（識別子の順）。 */
  readonly channels: readonly string[]
  readonly n: number[]
  readonly max: (number | null)[]
}

export interface CompositeResult {
  readonly source: 'coarse' | 'fine'
  readonly unit: 'gal' | 'count'
  readonly columnMs: number
  readonly firstColumnMs: number
  /** 2 軸以上の組すべて（範囲のどこかの時に要約があった組。識別子の並びの順）。 */
  readonly subsets: readonly CompositeSubsetColumns[]
  readonly hours: HourTally
  readonly irregularHours: readonly IrregularHour[]
  /** 換算の係数が判らず、外した時の数（`unit=gal` で生データのときだけ数える）。 */
  readonly unscaledHours: number
}

/**
 * 記録の合成の大きさを列へ束ねる（列ごとに本数を足し、最大を取る）。範囲の外のまとまりは捨てる。
 * 投げるのは `signal` が中断されたときだけ。
 */
export async function readCompositeEnvelope(params: {
  readonly dirs: RecordDirs
  readonly group: GroupRef
  readonly fromMs: number
  readonly toMs: number
  readonly columns: number
  readonly unit: UnitChoice
  readonly signal: AbortSignal
}): Promise<CompositeResult> {
  const { dirs, group, fromMs, toMs, columns, unit, signal } = params
  const source = derivedSourceFor(fromMs, toMs, columns)
  const columnMs = columnMsFor(fromMs, toMs, columns, source === 'coarse' ? SUMMARY_COARSE_MS : SUMMARY_FINE_MS)
  const firstColumn = Math.floor(fromMs / columnMs)
  const count = Math.max(0, Math.floor((toMs - 1) / columnMs) - firstColumn + 1)
  const read = await readDerivedHours(dirs, group, partOf(source), fromMs, toMs, false, signal)
  const acc = new Map<string, { channels: string[]; n: Float64Array; max: Float64Array }>()
  let unscaledHours = 0
  for (const { file } of read.hours) {
    const g = file.groups.find((x) => x.key === group.key)
    if (g === undefined) continue
    let scale = 1
    if (unit === 'gal' && g.unit === 'count') {
      if (g.ugPerLsb === null) {
        unscaledHours += 1
        continue
      }
      scale = g.ugPerLsb * GAL_PER_UG
    }
    for (const s of g.subsets) {
      const channels = g.axes.filter((_, k) => (s.mask & (1 << k)) !== 0)
      const id = channels.join(',')
      let a = acc.get(id)
      if (a === undefined) {
        a = { channels, n: new Float64Array(count), max: new Float64Array(count).fill(Number.NEGATIVE_INFINITY) }
        acc.set(id, a)
      }
      const level = s.level
      for (let i = 0; i < level.n.length; i += 1) {
        const nb = level.n[i]!
        if (nb === 0) continue
        const t = (level.firstBucket + i) * level.bucketMs
        if (t < fromMs || t >= toMs) continue
        const j = Math.floor(t / columnMs) - firstColumn
        if (j < 0 || j >= count) continue
        a.n[j] = a.n[j]! + nb
        const v = level.max[i]! * scale
        if (v > a.max[j]!) a.max[j] = v
      }
    }
  }
  const subsets = [...acc.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, a]) => ({
      channels: a.channels,
      n: Array.from(a.n),
      max: Array.from(a.max, (v, j) => (a.n[j]! > 0 && Number.isFinite(v) ? round6(v) : null)),
    }))
  return {
    source,
    unit: group.kind === 'station' || unit === 'gal' ? 'gal' : 'count',
    columnMs,
    firstColumnMs: firstColumn * columnMs,
    subsets,
    hours: read.tally,
    irregularHours: read.irregular,
    unscaledHours,
  }
}

// ---- 震度 ---------------------------------------------------------------------------------

/** 大きい順に `k` 個だけ残す。値の数に対して重くならないよう、残っている最小より小さい値はすぐ捨てる。 */
class TopK {
  private readonly values: number[] = []
  constructor(readonly k: number) {}

  push(v: number): void {
    if (!Number.isFinite(v)) return
    const vs = this.values
    if (vs.length === this.k && v <= vs[vs.length - 1]!) return
    let i = vs.length
    while (i > 0 && vs[i - 1]! < v) i -= 1
    vs.splice(i, 0, v)
    if (vs.length > this.k) vs.pop()
  }

  /** `k` 番目に大きい値。`k` 個に満たなければ `null`。 */
  kth(): number | null {
    return this.values.length === this.k ? this.values[this.k - 1]! : null
  }
}

export interface IntensitySummaryResult {
  readonly source: 'coarse' | 'fine'
  readonly columnMs: number
  readonly firstColumnMs: number
  /** 列ごとのリアルタイム震度の最大。値の無い列は `null`。 */
  readonly realtime: (number | null)[]
  readonly maxRealtime: number | null
  /** いちばん大きかったまとまりの頭の時刻（そのまとまりの幅のどこか）。 */
  readonly maxRealtimeAtMs: number | null
  /** そのまとまりの幅（1 秒か 1 分）。画面が「12:03:04 ごろ」「12:03 ごろ」を選ぶ。 */
  readonly maxRealtimeBucketMs: number | null
  /** 範囲の計測震度（上位を合わせた K 番目から）。材料が K 個に満たない・まとまりで K が揃わなければ `null`。 */
  readonly measured: number | null
  readonly hours: HourTally
  readonly irregularHours: readonly IrregularHour[]
}

/**
 * 観測点の合成波形の、要約から作る震度の推移（10 分を超える幅）。投げるのは `signal` が中断されたときだけ。
 */
export async function readIntensitySummary(params: {
  readonly dirs: RecordDirs
  readonly stationKey: string
  readonly fromMs: number
  readonly toMs: number
  readonly columns: number
  readonly signal: AbortSignal
}): Promise<IntensitySummaryResult> {
  const { dirs, stationKey, fromMs, toMs, columns, signal } = params
  const group: GroupRef = { kind: 'station', key: `station/${stationKey}`, stationKey }
  const source = derivedSourceFor(fromMs, toMs, columns)
  const columnMs = columnMsFor(fromMs, toMs, columns, source === 'coarse' ? SUMMARY_COARSE_MS : SUMMARY_FINE_MS)
  const firstColumn = Math.floor(fromMs / columnMs)
  const count = Math.max(0, Math.floor((toMs - 1) / columnMs) - firstColumn + 1)
  const read = await readDerivedHours(dirs, group, partOf(source), fromMs, toMs, true, signal)

  const realtime = new Array<number | null>(count).fill(null)
  let maxRealtime: number | null = null
  let maxRealtimeAtMs: number | null = null
  let maxRealtimeBucketMs: number | null = null
  for (const { file } of read.hours) {
    const rt = file.intensity?.realtime ?? null
    if (rt === null) continue
    for (let i = 0; i < rt.value.length; i += 1) {
      const v = rt.value[i]!
      if (!Number.isFinite(v)) continue
      const t = (rt.firstBucket + i) * rt.bucketMs
      if (t < fromMs || t >= toMs) continue
      const j = Math.floor(t / columnMs) - firstColumn
      if (j < 0 || j >= count) continue
      if (realtime[j] === null || v > realtime[j]!) realtime[j] = v
      if (maxRealtime === null || v > maxRealtime) {
        maxRealtime = v
        maxRealtimeAtMs = t
        maxRealtimeBucketMs = rt.bucketMs
      }
    }
  }

  // 計測震度: 範囲に丸ごと入るまとまりの上位を合わせる。
  let top: TopK | null = null
  let consistent = true
  const take = (file: DerivedPartFile, inside: (t: number, bucketMs: number) => boolean): void => {
    const ms = file.intensity?.measured ?? null
    if (ms === null) return
    if (top === null) top = new TopK(ms.k)
    else if (top.k !== ms.k) consistent = false
    for (let i = 0; i < ms.count.length; i += 1) {
      const t = (ms.firstBucket + i) * ms.bucketMs
      if (!inside(t, ms.bucketMs)) continue
      for (let m = 0; m < ms.count[i]!; m += 1) top.push(ms.values[i * ms.k + m]!)
    }
  }
  const whole = (t: number, bucketMs: number): boolean => t >= fromMs && t + bucketMs <= toMs
  for (const { file } of read.hours) take(file, whole)
  if (source === 'coarse') {
    // 両端の分の途中は 1 秒の段から（範囲に丸ごと入る秒だけ）。
    const edges: { fromMs: number; toMs: number }[] = []
    const headMinute = Math.floor(fromMs / SUMMARY_COARSE_MS) * SUMMARY_COARSE_MS
    if (headMinute < fromMs) edges.push({ fromMs, toMs: Math.min(toMs, headMinute + SUMMARY_COARSE_MS) })
    const tailMinute = Math.floor((toMs - 1) / SUMMARY_COARSE_MS) * SUMMARY_COARSE_MS
    if (tailMinute + SUMMARY_COARSE_MS > toMs && tailMinute >= headMinute + SUMMARY_COARSE_MS) edges.push({ fromMs: tailMinute, toMs })
    for (const e of edges) {
      const starts = hoursToOpen(e.fromMs, e.toMs)
      const fine = await readDerivedHours(dirs, group, 'derived-fine', e.fromMs, e.toMs, true, signal, starts)
      const inEdge = (t: number, bucketMs: number): boolean => t >= e.fromMs && t + bucketMs <= e.toMs
      for (const { file } of fine.hours) take(file, inEdge)
    }
  }
  const finalTop = top as TopK | null
  const a = consistent && finalTop !== null ? finalTop.kth() : null
  const measured = a !== null && a > 0 ? SINDO_LOG_COEFFICIENT * Math.log10(a) + SINDO_OFFSET : null

  return {
    source,
    columnMs,
    firstColumnMs: firstColumn * columnMs,
    realtime: realtime.map((v) => (v === null ? null : round6(v))),
    maxRealtime: maxRealtime === null ? null : round6(maxRealtime),
    maxRealtimeAtMs,
    maxRealtimeBucketMs,
    measured,
    hours: read.tally,
    irregularHours: read.irregular,
  }
}
