// 要約の 4 つ目の部分「合成と震度」。管理コンソールの「波形の記録」が、10 分を超える幅でも
// 合成の段と震度の推移を描くための材料。
//
// **軸の段の要約（`waveSummary.ts` の 1 秒・1 分の最小・最大）からは合成を作れない。** 各軸の山は
// まとまりの中の別の時刻にありうるので、軸ごとの最大を √Σ² しても合成の最大にならない。
// 同じ時刻に揃った値から合成を作れるのは元のサンプルを持っている作る側だけなので、ここで前もって作る。
// 震度も同じで、その場で作ると 1 日で約 1 分かかる（計測震度。作業 PC の実測）。
//
// **持つもの**
// - **合成の大きさ**（生データはセンサーごと・合成波形は観測点ごと）。**2 軸以上の組すべて**について、
//   1 秒・1 分ごとの本数と最大を持つ —— 画面は見えている軸だけで合成する（2026-10-08 ユーザー承認）ので、
//   軸を隠したときの組も要る（2026-10-11 ユーザー承認）。1 軸だけのときは軸の段の列から出せる
// - **リアルタイム震度**（合成波形だけ）。1 秒ごと・1 分ごとの最大
// - **計測震度の材料**（合成波形だけ）。気象庁のフィルターを通した 3 成分合成の、1 秒・1 分ごとの
//   **上位 K 個**（K は 0.3 秒ぶんのサンプル数。100 Hz で 30）。計測震度は「大きい順に並べて
//   K 番目」なので、区間ごとの上位 K 個を合わせれば、どの幅でもその幅の値がそのまま出る
//   （2026-10-11 ユーザー承認）
//
// **合成の作り方は画面（`admin/recordsPlot.ts` の `compositeRuns`）に合わせる。** 時刻は組の 1 本目の軸の
// 刻みに揃え、他の軸はその時刻にいちばん近い 1 点（刻みの半分より離れていれば無し）。1 軸でも値の無い時刻は
// 使わない。**各軸から引く中心だけが違う** —— 画面は範囲の平均、ここはその分の平均（範囲は後から決まるので）。
// 生データの上下の軸には重力が乗っているので、中心を引かないと合成が 980 gal 付近に張り付く。
//
// **震度は前の時の末尾から通す。** リアルタイム震度は直近 60 秒の判定で決まり、計測震度のフィルターも
// 記録の頭で立ち上がりが乱れる。時のファイルの頭から通すと、毎時 0 分の値だけ低く出る。
// そのため作るときに前の時の大きさも控え、前の時が後から伸びたら（取り戻した分の書き足し）作り直す。
//
// **10 分以内は画面がこれを使わない**（生のサンプルから合成し、震度は `/api/records/intensity` がその場で
// 計算する）。計測震度は、ここでは 1 時間ずつ（前の時の末尾から）フィルターを通すので、10 分ちょうどの
// 範囲の値と小数第 2 位あたりで食い違いうる（2026-10-11 ユーザー承認）。
//
// **1 本の要約を 2 本のファイルに分けて書く**（1 秒ごと・1 分ごと）。計測震度の 1 秒ごとの上位は
// 1 時間で約 440 KB あり、何日も俯瞰するときに要るのは 1 分ごとの方だけ（`waveSummary.ts` と同じ理由）。

import { durationThresholdIndex } from '../../../src/utils/knet/intensityCommon'
import { applyJmaFilter } from '../../../src/utils/knet/seismicIntensity'
import { realtimeSeriesOfRuns, splitRuns } from './quakeIntensity'
import { sensorOfSourceId } from './receptionSummary'
import type { ArchivedWaveChunk } from './waveArchive'
import { SUMMARY_COARSE_MS, SUMMARY_FINE_MS, type SummaryFile, type SummaryUnit } from './waveSummary'
import type { PsdChunk } from './wavePsd'

/** 本数を持つ型（`u16`）の上限。超えたら頭打ちにして数える（値は全部入っている）。 */
const COUNT_MAX = 0xffff
/** 1 つの組に入れる軸の数の上限（組は軸の印の並び 1 バイトで名乗る）。 */
const GROUP_AXES_MAX = 8
/** 組の数が軸の数とともに増えすぎないよう、合成を作るのは軸が 4 本までの記録だけ。 */
const COMPOSITE_AXES_MAX = 4

// ---- 形 ----------------------------------------------------------------------------------

/** 合成の大きさの 1 段。添字 i は `firstBucket + i` 番目のまとまり。**本数 0 は届いていない**（最大は `NaN`）。 */
export interface CompositeLevel {
  readonly bucketMs: number
  readonly firstBucket: number
  readonly n: Uint16Array
  readonly max: Float32Array
}

/** 軸の組 1 つ。`mask` は組の軸（{@link CompositeGroup.axes} の何本目か）を立てた印。 */
export interface CompositeSubset {
  readonly mask: number
  readonly fine: CompositeLevel
  readonly coarse: CompositeLevel
}

/** 合成を作る記録 1 つ（センサー 1 つ・観測点 1 つ）。 */
export interface CompositeGroup {
  /** 生データはセンサー（`FDSN:XX_<局>_<センサー>`）、合成波形は `station/<札>`。 */
  readonly key: string
  readonly unit: SummaryUnit
  /** カウントのとき、軸がそろって名乗った 1 カウントあたりの µg。食い違う・分からないなら `null`。 */
  readonly ugPerLsb: number | null
  /** 軸のチャンネル（識別子の順）。 */
  readonly axes: readonly string[]
  /** 2 軸以上の組（印の小さい順）。 */
  readonly subsets: readonly CompositeSubset[]
}

/** 値 1 つの段（リアルタイム震度）。**値の無いまとまりは `NaN`。** */
export interface ValueLevel {
  readonly bucketMs: number
  readonly firstBucket: number
  readonly value: Float32Array
}

/**
 * 上位 K 個の段（計測震度の材料）。`values[i × k + j]` が i 番目のまとまりの j 番目に大きい値で、
 * 入っているのは `count[i]` 個まで（残りは `NaN`）。
 */
export interface TopLevel {
  readonly bucketMs: number
  readonly firstBucket: number
  readonly k: number
  readonly count: Uint16Array
  readonly values: Float32Array
}

export interface StationIntensitySummary {
  readonly realtimeFine: ValueLevel | null
  readonly realtimeCoarse: ValueLevel | null
  readonly measuredFine: TopLevel | null
  readonly measuredCoarse: TopLevel | null
}

/** 要約の 4 つ目の部分の中身。 */
export interface DerivedSummary {
  /** 作ったときの元のファイルの大きさ（バイト）。 */
  readonly sourceBytes: number
  /** 作ったときの前の時の元のファイルの大きさ。**前の時を読まない（生データ）・無かったなら `null`。** */
  readonly prevSourceBytes: number | null
  readonly composites: readonly CompositeGroup[]
  /** 合成波形だけ。生データは `null`。 */
  readonly intensity: StationIntensitySummary | null
}

// ---- 合成の大きさ ------------------------------------------------------------------------

/** チャンネルの識別子から、合成を作る記録の名前。合成を作らないものは `null`。 */
export function compositeGroupOf(id: string): string | null {
  if (id.startsWith('station/')) {
    const at = id.lastIndexOf('/')
    return at > 'station/'.length ? id.slice(0, at) : null
  }
  const sensor = sensorOfSourceId(id)
  return sensor !== id ? sensor : null
}

/** 軸の数 `count` の記録で、2 軸以上の組の印（小さい順）。 */
export function compositeMasks(count: number): number[] {
  const out: number[] = []
  for (let m = 1; m < 1 << count; m += 1) {
    let bits = 0
    for (let b = m; b !== 0; b &= b - 1) bits += 1
    if (bits >= 2) out.push(m)
  }
  return out
}

/** まとまりの並び（先頭の時刻の順）から、ある時刻にいちばん近い 1 点を引く。時刻が進む向きに速い。 */
class NearestCursor {
  private p = 0
  private lastT = Number.NEGATIVE_INFINITY

  constructor(private readonly chunks: readonly PsdChunk[]) {}

  valueAt(t: number): number {
    const cs = this.chunks
    if (cs.length === 0) return Number.NaN
    if (t < this.lastT) {
      // 時刻が戻った（まとまりが重なっている）。引き直す。
      let lo = 0
      let hi = cs.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (cs[mid]!.firstSampleMs - cs[mid]!.msPerSample / 2 <= t) lo = mid
        else hi = mid - 1
      }
      this.p = lo
    }
    this.lastT = t
    while (this.p + 1 < cs.length && cs[this.p + 1]!.firstSampleMs - cs[this.p + 1]!.msPerSample / 2 <= t) this.p += 1
    for (const q of [this.p, this.p - 1]) {
      const c = cs[q]
      if (c === undefined) continue
      const i = Math.round((t - c.firstSampleMs) / c.msPerSample)
      if (i < 0 || i >= c.values.length) continue
      if (Math.abs(c.firstSampleMs + i * c.msPerSample - t) > c.msPerSample / 2) continue
      const v = c.values[i]!
      if (Number.isFinite(v)) return v
    }
    return Number.NaN
  }
}

function sortedChunks(chunks: readonly PsdChunk[]): PsdChunk[] {
  return chunks.filter((c) => Number.isFinite(c.firstSampleMs) && c.msPerSample > 0).sort((a, b) => a.firstSampleMs - b.firstSampleMs)
}

/** 1 秒の段の積み（届いた所の最初と最後の間だけを段にする）。 */
function compositeFineOf(n: Uint32Array, max: Float64Array, firstFine: number): CompositeLevel | null {
  let first = -1
  let last = -1
  for (let k = 0; k < n.length; k += 1) {
    if (n[k]! === 0) continue
    if (first < 0) first = k
    last = k
  }
  if (first < 0) return null
  const len = last - first + 1
  const level: CompositeLevel = {
    bucketMs: SUMMARY_FINE_MS,
    firstBucket: firstFine + first,
    n: new Uint16Array(len),
    max: new Float32Array(len).fill(Number.NaN),
  }
  for (let i = 0; i < len; i += 1) {
    const c = n[first + i]!
    if (c === 0) continue
    level.n[i] = Math.min(c, COUNT_MAX)
    level.max[i] = max[first + i]!
  }
  return level
}

/** 1 秒の段を 1 分ずつ束ねる（本数は足し、最大は最大）。 */
export function compositeCoarseOf(fine: CompositeLevel): CompositeLevel {
  const ratio = SUMMARY_COARSE_MS / SUMMARY_FINE_MS
  const firstCoarse = Math.floor(fine.firstBucket / ratio)
  const lastCoarse = Math.floor((fine.firstBucket + fine.n.length - 1) / ratio)
  const len = lastCoarse - firstCoarse + 1
  const n = new Float64Array(len)
  const max = new Float32Array(len).fill(Number.NaN)
  for (let i = 0; i < fine.n.length; i += 1) {
    if (fine.n[i]! === 0) continue
    const j = Math.floor((fine.firstBucket + i) / ratio) - firstCoarse
    n[j] = n[j]! + fine.n[i]!
    if (!(fine.max[i]! <= max[j]!)) max[j] = fine.max[i]!
  }
  const out = new Uint16Array(len)
  for (let j = 0; j < len; j += 1) out[j] = Math.min(n[j]!, COUNT_MAX)
  return { bucketMs: SUMMARY_COARSE_MS, firstBucket: firstCoarse, n: out, max }
}

/**
 * 軸の要約（`SummaryFile`）と、積んだまとまり（`SummaryBuilder.chunksOf`）から合成の大きさを作る。
 * `window` は受け入れるサンプルの時刻（`SummaryBuilder.sampleWindow`）。**投げない。**
 */
export function compositeGroupsOf(
  file: SummaryFile,
  chunksOf: (id: string) => readonly PsdChunk[],
  window: { readonly fromMs: number; readonly toMs: number },
): CompositeGroup[] {
  const byGroup = new Map<string, SummaryFile['channels'][number][]>()
  for (const c of file.channels) {
    const key = compositeGroupOf(c.id)
    if (key === null) continue
    let list = byGroup.get(key)
    if (list === undefined) {
      list = []
      byGroup.set(key, list)
    }
    list.push(c)
  }
  const firstFine = Math.floor(window.fromMs / SUMMARY_FINE_MS)
  const fineCount = Math.ceil(window.toMs / SUMMARY_FINE_MS) - firstFine
  const groups: CompositeGroup[] = []
  for (const [key, list] of byGroup) {
    const axes = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (axes.length < 2 || axes.length > COMPOSITE_AXES_MAX) continue
    const unit = axes[0]!.unit
    if (axes.some((a) => a.unit !== unit)) continue
    const ug = axes[0]!.ugPerLsb
    const ugPerLsb = ug !== null && axes.every((a) => a.ugPerLsb === ug) ? ug : null
    const chunks = axes.map((a) => sortedChunks(chunksOf(a.id)))
    // 各軸から引く中心: その分の平均（軸の 1 分の段）。
    const centerOf = axes.map((a) => {
      const coarse = a.coarse
      return (t: number): number => {
        const j = Math.floor(t / SUMMARY_COARSE_MS) - coarse.firstBucket
        return j >= 0 && j < coarse.n.length && coarse.n[j]! > 0 ? coarse.mean[j]! : Number.NaN
      }
    })
    const subsets: CompositeSubset[] = []
    for (const mask of compositeMasks(axes.length)) {
      const members: number[] = []
      for (let k = 0; k < axes.length; k += 1) if ((mask & (1 << k)) !== 0) members.push(k)
      const base = members[0]!
      const others = members.slice(1).map((k) => ({ cursor: new NearestCursor(chunks[k]!), center: centerOf[k]! }))
      const n = new Uint32Array(fineCount)
      const max = new Float64Array(fineCount).fill(Number.NEGATIVE_INFINITY)
      for (const c of chunks[base]!) {
        for (let i = 0; i < c.values.length; i += 1) {
          const t = c.firstSampleMs + i * c.msPerSample
          if (t < window.fromMs || t >= window.toMs) continue
          const v0 = c.values[i]!
          const c0 = centerOf[base]!(t)
          if (!Number.isFinite(v0) || !Number.isFinite(c0)) continue
          let sum = (v0 - c0) ** 2
          let ok = true
          for (const o of others) {
            const v = o.cursor.valueAt(t)
            const center = o.center(t)
            if (!Number.isFinite(v) || !Number.isFinite(center)) {
              ok = false
              break
            }
            sum += (v - center) ** 2
          }
          if (!ok) continue
          const m = Math.sqrt(sum)
          const k = Math.floor(t / SUMMARY_FINE_MS) - firstFine
          n[k] = n[k]! + 1
          if (m > max[k]!) max[k] = m
        }
      }
      const fine = compositeFineOf(n, max, firstFine)
      if (fine !== null) subsets.push({ mask, fine, coarse: compositeCoarseOf(fine) })
    }
    if (subsets.length > 0) groups.push({ key, unit, ugPerLsb, axes: axes.map((a) => a.id), subsets })
  }
  groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return groups
}

// ---- 震度 --------------------------------------------------------------------------------

/** 上位 K 個へ切る（大きい順）。 */
function topOf(values: number[], k: number): number[] {
  values.sort((a, b) => b - a)
  return values.length > k ? values.slice(0, k) : values
}

function topLevelOf(lists: readonly (number[] | undefined)[], firstBucket: number, bucketMs: number, k: number): TopLevel | null {
  let first = -1
  let last = -1
  for (let i = 0; i < lists.length; i += 1) {
    if (lists[i] === undefined || lists[i]!.length === 0) continue
    if (first < 0) first = i
    last = i
  }
  if (first < 0) return null
  const len = last - first + 1
  const count = new Uint16Array(len)
  const values = new Float32Array(len * k).fill(Number.NaN)
  for (let i = 0; i < len; i += 1) {
    const list = lists[first + i]
    if (list === undefined) continue
    const top = topOf(list, k)
    count[i] = top.length
    for (let j = 0; j < top.length; j += 1) values[i * k + j] = top[j]!
  }
  return { bucketMs, firstBucket: firstBucket + first, k, count, values }
}

/** 上位 K 個の 1 秒の段を 1 分ずつ束ねる。 */
export function topCoarseOf(fine: TopLevel): TopLevel {
  const ratio = SUMMARY_COARSE_MS / SUMMARY_FINE_MS
  const firstCoarse = Math.floor(fine.firstBucket / ratio)
  const lastCoarse = Math.floor((fine.firstBucket + fine.count.length - 1) / ratio)
  const lists: number[][] = Array.from({ length: lastCoarse - firstCoarse + 1 }, () => [])
  for (let i = 0; i < fine.count.length; i += 1) {
    const j = Math.floor((fine.firstBucket + i) / ratio) - firstCoarse
    for (let m = 0; m < fine.count[i]!; m += 1) lists[j]!.push(fine.values[i * fine.k + m]!)
  }
  return topLevelOf(lists, firstCoarse, SUMMARY_COARSE_MS, fine.k) ?? { bucketMs: SUMMARY_COARSE_MS, firstBucket: firstCoarse, k: fine.k, count: new Uint16Array(0), values: new Float32Array(0) }
}

function valueFineOf(points: readonly { readonly atMs: number; readonly value: number | null }[]): ValueLevel | null {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const p of points) {
    if (p.value === null) continue
    const b = Math.floor(p.atMs / SUMMARY_FINE_MS)
    if (b < lo) lo = b
    if (b > hi) hi = b
  }
  if (!(hi >= lo)) return null
  const value = new Float32Array(hi - lo + 1).fill(Number.NaN)
  for (const p of points) {
    if (p.value === null) continue
    const i = Math.floor(p.atMs / SUMMARY_FINE_MS) - lo
    if (!(p.value <= value[i]!)) value[i] = p.value
  }
  return { bucketMs: SUMMARY_FINE_MS, firstBucket: lo, value }
}

/** 1 秒の段を 1 分ずつ束ねる（最大）。 */
export function valueCoarseOf(fine: ValueLevel): ValueLevel {
  const ratio = SUMMARY_COARSE_MS / SUMMARY_FINE_MS
  const firstCoarse = Math.floor(fine.firstBucket / ratio)
  const lastCoarse = Math.floor((fine.firstBucket + fine.value.length - 1) / ratio)
  const value = new Float32Array(lastCoarse - firstCoarse + 1).fill(Number.NaN)
  for (let i = 0; i < fine.value.length; i += 1) {
    const v = fine.value[i]!
    if (!Number.isFinite(v)) continue
    const j = Math.floor((fine.firstBucket + i) / ratio) - firstCoarse
    if (!(v <= value[j]!)) value[j] = v
  }
  return { bucketMs: SUMMARY_COARSE_MS, firstBucket: firstCoarse, value }
}

/** 計測震度の「上位 K 個」の K（0.3 秒ぶんのサンプル数。`calcSeismicIntensityFromSynthesized` の添字 + 1）。 */
export function measuredTopK(sampleRateHz: number): number {
  return durationThresholdIndex(sampleRateHz) + 1
}

/**
 * 合成波形の時のファイル 1 本の震度の要約。`own` はこの時のまとまり、`lead` は前の時のまとまり
 * （窓を埋めるための助走。値は出さない）。`window` はこの時が受け入れるサンプルの時刻。**投げない。**
 *
 * - リアルタイム震度: 刻みの最後のサンプルが時の頭から `window.toMs`（時の終わり＋はみ出しの幅）までのものを出す
 *   （はみ出しの幅の分は次の時の要約にも出るが、束ねるときに最大を取るので重なっても数え直しにならない）
 * - 計測震度: 途切れずに続いた波形ごとにフィルターを通し、**この時のまとまりのサンプルだけ**を上位へ積む
 *   （前の時のサンプルは前の時の要約に積んである。重ねて積むと、束ねたときに同じサンプルを 2 度数える）。
 *   時の頭をまたぐ前の時のまとまりの後ろ半分も、前の時の要約に積まれる —— 前の時の窓もはみ出しの幅まで伸びている
 */
export function stationIntensityOf(params: {
  readonly own: readonly ArchivedWaveChunk[]
  readonly lead: readonly ArchivedWaveChunk[]
  readonly window: { readonly fromMs: number; readonly toMs: number }
}): StationIntensitySummary | null {
  const { own, lead, window } = params
  // **この時のまとまりの頭は、窓の中に先頭があるものだけで測る**（時計が合う前の 1970 年のまとまりが
  // 混じっていても、前の時からはみ出したサンプルを「この時の分」として積まない）。
  let ownStart = Number.POSITIVE_INFINITY
  for (const c of own) {
    if (c.firstSampleMs >= window.fromMs && c.firstSampleMs < window.toMs && c.firstSampleMs < ownStart) ownStart = c.firstSampleMs
  }
  if (!Number.isFinite(ownStart)) return null
  const { runs } = splitRuns([...lead, ...own])

  const points = realtimeSeriesOfRuns(runs, window.fromMs, Number.POSITIVE_INFINITY).filter((p) => p.atMs < window.toMs)
  const realtimeFine = valueFineOf(points)

  const firstFine = Math.floor(window.fromMs / SUMMARY_FINE_MS)
  const lists: (number[] | undefined)[] = new Array(Math.ceil(window.toMs / SUMMARY_FINE_MS) - firstFine)
  let k = 0
  for (const run of runs) {
    const last = run.t[run.t.length - 1]!
    if (last < ownStart || last < window.fromMs || run.t[0]! >= window.toMs) continue
    const rateHz = 1000 / run.msPerSample
    k = Math.max(k, measuredTopK(rateHz))
    const fx = applyJmaFilter(run.v[0], rateHz)
    const fy = applyJmaFilter(run.v[1], rateHz)
    const fz = applyJmaFilter(run.v[2], rateHz)
    for (let i = 0; i < run.t.length; i += 1) {
      const t = run.t[i]!
      if (t < ownStart || t < window.fromMs || t >= window.toMs) continue
      const a = Math.sqrt(fx[i]! * fx[i]! + fy[i]! * fy[i]! + fz[i]! * fz[i]!)
      if (!Number.isFinite(a)) continue
      const b = Math.floor(t / SUMMARY_FINE_MS) - firstFine
      let list = lists[b]
      if (list === undefined) {
        list = []
        lists[b] = list
      }
      list.push(a)
    }
  }
  const measuredFine = k > 0 ? topLevelOf(lists, firstFine, SUMMARY_FINE_MS, k) : null
  if (realtimeFine === null && measuredFine === null) return null
  return {
    realtimeFine,
    realtimeCoarse: realtimeFine === null ? null : valueCoarseOf(realtimeFine),
    measuredFine,
    measuredCoarse: measuredFine === null ? null : topCoarseOf(measuredFine),
  }
}

// ---- 書き出しと読み込み ----------------------------------------------------------------
//
// すべて little endian。頭の形は他の部分（`waveSummary.ts`）と同じ目印・版・部分の番号で始め、
// 元のファイルの大きさの後ろに前の時の大きさを置く。
//
// 頭: magic u32・版 u8・部分 u8（4 = 1 秒・5 = 1 分）・予備 u8×2・元のファイルの大きさ f64・前の時の大きさ f64（無ければ NaN）
// 合成: 記録の数 u32・記録ごとに（名前の長さ u16・名前・単位 u8・µg/カウント f64・軸の数 u8・
//     軸ごとに（長さ u16・識別子）・組の数 u8・組ごとに（印 u8・段））
// 段（合成）: 最初のまとまり f64・数 u32・本数 u16 × 数・最大 f32 × 数
// 震度: 有無 u8・（リアルタイム: 有無 u8・最初のまとまり f64・数 u32・値 f32 × 数）・
//     （計測: 有無 u8・最初のまとまり f64・数 u32・K u16・入っている数 u16 × 数・値 f32 × 数 × K）

export type DerivedPart = 'derived-fine' | 'derived-coarse'
/** 部分の番号。**`waveSummary.ts` の 1〜3 と重ねない。** */
export const DERIVED_PART_CODES: Record<DerivedPart, number> = { 'derived-fine': 4, 'derived-coarse': 5 }
/** 書く順。**作り直すかは最後の部分（1 分）の頭で決める。** */
export const DERIVED_PARTS: readonly DerivedPart[] = ['derived-fine', 'derived-coarse']
export const DERIVED_LAST_PART: DerivedPart = 'derived-coarse'

const MAGIC = 0x4d555357
const FORMAT_VERSION = 1
const UNIT_CODES = { count: 0, gal: 1 } as const
const HEAD_BYTES = 24
/** 作り直すか決めるために、頭だけ読む長さ。 */
export const DERIVED_PEEK_BYTES = HEAD_BYTES

class Writer {
  private buf = Buffer.alloc(1 << 16)
  private p = 0

  private room(n: number): void {
    if (this.p + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.p + n) size *= 2
    const next = Buffer.alloc(size)
    this.buf.copy(next, 0, 0, this.p)
    this.buf = next
  }
  u8(v: number): void {
    this.room(1)
    this.buf.writeUInt8(v, this.p)
    this.p += 1
  }
  u16(v: number): void {
    this.room(2)
    this.buf.writeUInt16LE(v, this.p)
    this.p += 2
  }
  u32(v: number): void {
    this.room(4)
    this.buf.writeUInt32LE(v, this.p)
    this.p += 4
  }
  f64(v: number): void {
    this.room(8)
    this.buf.writeDoubleLE(v, this.p)
    this.p += 8
  }
  f32s(a: ArrayLike<number>): void {
    this.room(a.length * 4)
    for (let i = 0; i < a.length; i += 1) {
      this.buf.writeFloatLE(a[i]!, this.p)
      this.p += 4
    }
  }
  u16s(a: ArrayLike<number>): void {
    this.room(a.length * 2)
    for (let i = 0; i < a.length; i += 1) {
      this.buf.writeUInt16LE(a[i]!, this.p)
      this.p += 2
    }
  }
  text(s: string): void {
    const b = Buffer.from(s, 'utf8')
    this.u16(b.length)
    this.room(b.length)
    b.copy(this.buf, this.p)
    this.p += b.length
  }
  done(): Buffer {
    return this.buf.subarray(0, this.p)
  }
}

/** 要約の 4 つ目の部分の 1 本を書く。 */
export function encodeDerivedPart(d: DerivedSummary, part: DerivedPart): Buffer {
  const coarse = part === 'derived-coarse'
  const w = new Writer()
  w.u32(MAGIC)
  w.u8(FORMAT_VERSION)
  w.u8(DERIVED_PART_CODES[part])
  w.u16(0)
  w.f64(d.sourceBytes)
  w.f64(d.prevSourceBytes ?? Number.NaN)
  w.u32(d.composites.length)
  for (const g of d.composites) {
    w.text(g.key)
    w.u8(UNIT_CODES[g.unit])
    w.f64(g.ugPerLsb ?? Number.NaN)
    w.u8(g.axes.length)
    for (const a of g.axes) w.text(a)
    w.u8(g.subsets.length)
    for (const s of g.subsets) {
      w.u8(s.mask)
      const level = coarse ? s.coarse : s.fine
      w.f64(level.firstBucket)
      w.u32(level.n.length)
      w.u16s(level.n)
      w.f32s(level.max)
    }
  }
  const it = d.intensity
  w.u8(it === null ? 0 : 1)
  if (it !== null) {
    const rt = coarse ? it.realtimeCoarse : it.realtimeFine
    w.u8(rt === null ? 0 : 1)
    if (rt !== null) {
      w.f64(rt.firstBucket)
      w.u32(rt.value.length)
      w.f32s(rt.value)
    }
    const ms = coarse ? it.measuredCoarse : it.measuredFine
    w.u8(ms === null ? 0 : 1)
    if (ms !== null) {
      w.f64(ms.firstBucket)
      w.u32(ms.count.length)
      w.u16(ms.k)
      w.u16s(ms.count)
      w.f32s(ms.values)
    }
  }
  return w.done()
}

/** 頭だけを見て、控えている元のファイルの大きさと前の時の大きさを返す。目印・版・部分が違えば `null`。 */
export function peekDerivedHead(head: Buffer): { readonly sourceBytes: number; readonly prevSourceBytes: number | null } | null {
  if (head.length < HEAD_BYTES) return null
  if (head.readUInt32LE(0) !== MAGIC || head.readUInt8(4) !== FORMAT_VERSION) return null
  const code = head.readUInt8(5)
  if (!DERIVED_PARTS.some((p) => DERIVED_PART_CODES[p] === code)) return null
  const sourceBytes = head.readDoubleLE(8)
  const prev = head.readDoubleLE(16)
  if (!Number.isFinite(sourceBytes)) return null
  return { sourceBytes, prevSourceBytes: Number.isFinite(prev) ? prev : null }
}

/** 読んだ記録 1 つ（1 部分ぶん）。 */
export interface DerivedGroupPart {
  readonly key: string
  readonly unit: SummaryUnit
  readonly ugPerLsb: number | null
  readonly axes: readonly string[]
  readonly subsets: readonly { readonly mask: number; readonly level: CompositeLevel }[]
}

export interface DerivedPartFile {
  readonly part: DerivedPart
  readonly sourceBytes: number
  readonly prevSourceBytes: number | null
  readonly groups: readonly DerivedGroupPart[]
  /** 震度を持たない（生データ）なら `null`。 */
  readonly intensity: { readonly realtime: ValueLevel | null; readonly measured: TopLevel | null } | null
}

class Reader {
  p = 0
  constructor(private readonly buf: Buffer) {}
  need(n: number): void {
    if (this.p + n > this.buf.length) throw new RangeError('短い')
  }
  u8(): number {
    this.need(1)
    return this.buf.readUInt8(this.p++)
  }
  u16(): number {
    this.need(2)
    const v = this.buf.readUInt16LE(this.p)
    this.p += 2
    return v
  }
  u32(): number {
    this.need(4)
    const v = this.buf.readUInt32LE(this.p)
    this.p += 4
    return v
  }
  f64(): number {
    this.need(8)
    const v = this.buf.readDoubleLE(this.p)
    this.p += 8
    return v
  }
  f32s(n: number): Float32Array {
    this.need(n * 4)
    const a = new Float32Array(n)
    for (let i = 0; i < n; i += 1) {
      a[i] = this.buf.readFloatLE(this.p)
      this.p += 4
    }
    return a
  }
  u16s(n: number): Uint16Array {
    this.need(n * 2)
    const a = new Uint16Array(n)
    for (let i = 0; i < n; i += 1) {
      a[i] = this.buf.readUInt16LE(this.p)
      this.p += 2
    }
    return a
  }
  skip(n: number): void {
    this.need(n)
    this.p += n
  }
  text(): string {
    const len = this.u16()
    this.need(len)
    const s = this.buf.toString('utf8', this.p, this.p + len)
    this.p += len
    return s
  }
  get atEnd(): boolean {
    return this.p === this.buf.length
  }
}

/**
 * 要約の 4 つ目の部分の 1 本を読む。`keepGroup` を通る記録の合成だけを解き、**通らない記録は長さだけ
 * 確かめて飛ばす**。`withIntensity` が偽なら震度も飛ばす。**形が合わなければ `null`**（作り直せばよい）。投げない。
 */
export function decodeDerivedPart(
  buf: Buffer,
  keepGroup: (key: string) => boolean,
  withIntensity = true,
): DerivedPartFile | null {
  try {
    const r = new Reader(buf)
    if (r.u32() !== MAGIC || r.u8() !== FORMAT_VERSION) return null
    const code = r.u8()
    const part = DERIVED_PARTS.find((p) => DERIVED_PART_CODES[p] === code)
    if (part === undefined) return null
    const bucketMs = part === 'derived-coarse' ? SUMMARY_COARSE_MS : SUMMARY_FINE_MS
    r.u16()
    const sourceBytes = r.f64()
    const prev = r.f64()
    const groupCount = r.u32()
    const groups: DerivedGroupPart[] = []
    for (let g = 0; g < groupCount; g += 1) {
      const key = r.text()
      const unitCode = r.u8()
      const unit = unitCode === UNIT_CODES.gal ? 'gal' : unitCode === UNIT_CODES.count ? 'count' : null
      if (unit === null) return null
      const ug = r.f64()
      const axisCount = r.u8()
      if (axisCount > GROUP_AXES_MAX) return null
      const axes: string[] = []
      for (let a = 0; a < axisCount; a += 1) axes.push(r.text())
      const subsetCount = r.u8()
      const keep = keepGroup(key)
      const subsets: { mask: number; level: CompositeLevel }[] = []
      for (let s = 0; s < subsetCount; s += 1) {
        const mask = r.u8()
        // 軸の数に合わない印は壊れた（別の形の）要約。読み返しは印のビットで軸を引く。
        if (mask === 0 || mask >= 1 << axisCount) return null
        const firstBucket = r.f64()
        const len = r.u32()
        if (!keep) {
          r.skip(len * 6)
          continue
        }
        const n = r.u16s(len)
        const max = r.f32s(len)
        subsets.push({ mask, level: { bucketMs, firstBucket, n, max } })
      }
      if (keep) groups.push({ key, unit, ugPerLsb: Number.isFinite(ug) ? ug : null, axes, subsets })
    }
    let intensity: DerivedPartFile['intensity'] = null
    const hasIntensity = r.u8()
    if (hasIntensity > 1) return null
    if (hasIntensity === 1) {
      let realtime: ValueLevel | null = null
      let measured: TopLevel | null = null
      const hasRt = r.u8()
      if (hasRt > 1) return null
      if (hasRt === 1) {
        const firstBucket = r.f64()
        const len = r.u32()
        if (withIntensity) realtime = { bucketMs, firstBucket, value: r.f32s(len) }
        else r.skip(len * 4)
      }
      const hasMs = r.u8()
      if (hasMs > 1) return null
      if (hasMs === 1) {
        const firstBucket = r.f64()
        const len = r.u32()
        const k = r.u16()
        if (withIntensity) {
          const count = r.u16s(len)
          const values = r.f32s(len * k)
          measured = { bucketMs, firstBucket, k, count, values }
        } else r.skip(len * 2 + len * k * 4)
      }
      intensity = withIntensity ? { realtime, measured } : null
    }
    if (!r.atEnd) return null
    return { part, sourceBytes, prevSourceBytes: Number.isFinite(prev) ? prev : null, groups, intensity }
  } catch {
    return null
  }
}
