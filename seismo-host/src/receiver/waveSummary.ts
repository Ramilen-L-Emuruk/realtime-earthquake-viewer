// 保存した波形の要約。管理コンソールで何日・何週ぶんを一度に俯瞰するために、前もって作って残す。
//
// **その場で読んで間引く作りでは俯瞰が成り立たない。** 生データ 1 時間ぶん（約 14.6 MB・
// 27 チャンネル・972 万サンプル）の復号に、作業 PC の実測で 0.58 秒かかる。1 日で 14 秒、
// 1 週間で 100 秒になり、寄せる・送るたびにそれを払う。要約があれば重さは画面の列数だけで決まる。
//
// **要約は元のファイル 1 本から作る（受信の経路には手を入れない）。** 生データの時のファイル、
// または合成波形の時のファイルを読んで要約を作り、作ったときの元のファイルの大きさを控える。
// 取り戻した分が過去の時のファイルへ後から足されても（`mseedStore.ts`）、大きさが変われば作り直せる。
// 受信と並行して積む経路を別に持つと、同じ時について 2 通りの作り方が並び、食い違っても気づけない。
//
// **段は 2 つ。** 1 秒ごと（数時間までの俯瞰）と 1 分ごと（日〜月の俯瞰）。それより細かく見るときは
// 生のサンプルを読む。各まとまりが持つのは本数・最小・最大・平均・ばらつき（母分散）で、
// 1 分の段だけは「ノイズの分散」（その 1 分に含まれる 1 秒ごとのばらつきの、本数で重みを付けた平均）も持つ。
//
// **ばらつきは二乗和ではなく、平均からの偏差で積む**（Welford の方法）。生のカウントには重力
// （1g ≒ 16384 カウント）が乗っていて、二乗和を f32 で持つと数カウントのノイズが桁落ちで消える。
//
// **ノイズの分散を別に持つのは、1 分の段のばらつきが平均の動き（傾き・温度でゆっくり動く直流）まで
// 含むから。** 家の揺れの昼夜差やセンサーの劣化を見たいのは 1 秒より速い揺れの強さなので、
// 1 秒ごとのばらつきを束ねたものを使う。
//
// **時刻はまとまりの秒・分へ割り付ける（UTC の秒・分の頭に揃える）。** 日本時間の時・分の頭とも一致する。
// サンプルの時刻は「まとまりの先頭 ＋ i × 刻み」で、刻みのわずかな揺らぎはここでは問題にならない
// （割り付ける先が 1 秒の幅を持つので、誤差が積み上がって偽の欠けに化けることはない）。

import { MAX_CHUNK_SPAN_MS } from './waveArchive'
import { PSD_BIN_COUNT, minutePsd, type MinutePsd, type PsdChunk } from './wavePsd'

/** 細かい段の 1 まとまりの長さ。 */
export const SUMMARY_FINE_MS = 1000
/** 粗い段の 1 まとまりの長さ。 */
export const SUMMARY_COARSE_MS = 60_000

/**
 * 時の終わりを越えて受け入れる長さ。
 *
 * **元のファイルはまとまりの先頭の時刻で選ばれる**（生データは `recordAssembler.ts` の `fileTimeOf`、
 * 合成波形は `waveArchive.ts`）ので、時の終わりの直前に始まったまとまりは次の時へはみ出す。
 * 合成波形のまとまりは最長 10 分まで許している（`waveArchive.ts` の `MAX_CHUNK_SPAN_MS`）ので、
 * それに合わせる（**同じ定数を引く** —— 別に書くと、片方だけ伸ばしたときに長いまとまりが黙って窓から落ちる）。
 * 読み返す側は前の時の要約も重ねる。
 */
const OVERHANG_MS = MAX_CHUNK_SPAN_MS

/** 細かい段の本数を持つ型（`u16`）の上限。超えたら頭打ちにして数える。 */
const FINE_COUNT_MAX = 0xffff

const MAGIC = 0x4d555357 // 'WSUM'（little endian で読むと W S U M）
const FORMAT_VERSION = 1
const UNIT_CODES = { count: 0, gal: 1 } as const

export type SummaryUnit = keyof typeof UNIT_CODES

/** 1 つの段。**添字 i は `firstBucket + i` 番目のまとまり**（`firstBucket` は時刻 ÷ 長さの切り捨て）。 */
export interface SummaryLevel {
  readonly bucketMs: number
  readonly firstBucket: number
  /** 本数。**0 は「届いていない」**（そのとき他の欄は `NaN`）。 */
  readonly n: Uint16Array | Uint32Array
  readonly min: Float32Array
  readonly max: Float32Array
  readonly mean: Float32Array
  /** 母分散（そのまとまりの平均からの偏差の二乗の平均）。 */
  readonly variance: Float32Array
  /** 粗い段だけ。1 秒ごとの母分散を本数で重みを付けて平均したもの。細かい段は `null`。 */
  readonly noiseVariance: Float32Array | null
}

export interface SummaryChannel {
  /**
   * 生データは miniSEED の識別子（`FDSN:XX_<局>_<センサー>_H_N_<向き>`）、合成波形は
   * `station/<観測点>/<向き>`。名前の付け方は要約を作る側（`waveSummarySources.ts`）が決める。
   */
  readonly id: string
  /** 値の単位。生データはカウント、合成波形は gal。 */
  readonly unit: SummaryUnit
  /** カウントのとき、1 カウントあたりの µg。分からない・食い違ったなら `null`。 */
  readonly ugPerLsb: number | null
  readonly fine: SummaryLevel
  readonly coarse: SummaryLevel
  /** 1 分ごとの PSD（`wavePsd.ts`）。区間を 1 つも作れなかった（1 区間 ≒ 10 秒に満たない）なら `null`。 */
  readonly psd: MinutePsd | null
}

export interface SummaryFile {
  /** 作ったときの元のファイルの大きさ（バイト）。**変わっていれば作り直す。** */
  readonly sourceBytes: number
  readonly channels: readonly SummaryChannel[]
  /** ファイルの時間から外れていて入れなかったサンプルの数（時計が合う前の 1970 年など）。 */
  readonly outOfWindowSamples: number
  /** 有限でなかったので入れなかったサンプルの数。 */
  readonly droppedNonFinite: number
  /** 違う分解能を名乗ったチャンネルの数（そのチャンネルは `ugPerLsb` が `null`）。 */
  readonly conflictingScales: number
  /**
   * 元のファイルのうち読めなかった分。**0 でなければ、要約はその分を欠いている**
   * （俯瞰では「届いていない」と区別が付かないので、画面へ出すのは読み返す側の仕事）。
   */
  readonly sourceProblems: SourceProblems
}

/** 元のファイルを読んだときの不調。 */
export interface SourceProblems {
  /** 末尾で読まなかったバイト数（書いている最中の時のファイルなら、作りかけのレコードの分が出る）。 */
  readonly skippedBytes: number
  /** 検査値が合わない・復号できない・中身を読めなかったレコードの数。 */
  readonly badRecords: number
}

const NO_PROBLEMS: SourceProblems = { skippedBytes: 0, badRecords: 0 }

interface ChannelMeta {
  unit: SummaryUnit
  ugPerLsb: number | null
  conflicting: boolean
}

interface Accumulator {
  readonly n: Uint32Array
  readonly min: Float64Array
  readonly max: Float64Array
  readonly mean: Float64Array
  readonly m2: Float64Array
  touched: boolean
  /** PSD のために、時の中に先頭があるまとまりをそのまま持つ（写さない）。 */
  readonly chunks: PsdChunk[]
}

/**
 * 要約を積む。**サンプルを 1 つずつ足す形にしてあり、元のファイルの読み方には関わらない。**
 * 1 時間ぶんの元のファイル 1 本につき 1 つ作り、{@link build} で締める。
 */
export class SummaryBuilder {
  private readonly firstFine: number
  private readonly fineCount: number
  private readonly fromMs: number
  private readonly toMs: number
  private readonly meta = new Map<string, ChannelMeta>()
  private readonly acc = new Map<string, Accumulator>()
  private outOfWindow = 0
  private nonFinite = 0

  /** `fromMs`〜`toMs` は元のファイルが受け持つ時（日本時間の 1 時間）。 */
  constructor(window: { readonly fromMs: number; readonly toMs: number }) {
    this.fromMs = window.fromMs
    this.toMs = window.toMs + OVERHANG_MS
    this.firstFine = Math.floor(this.fromMs / SUMMARY_FINE_MS)
    this.fineCount = Math.ceil(this.toMs / SUMMARY_FINE_MS) - this.firstFine
  }

  /**
   * チャンネルの単位を名乗る。**同じチャンネルが違う分解能を名乗ったら換算できないものとして扱う**
   * （同じ時の中で基板のセンサーの設定が変わった。カウントの値のまま俯瞰はできる）。
   */
  declare(id: string, meta: { readonly unit: SummaryUnit; readonly ugPerLsb: number | null }): void {
    const known = this.meta.get(id)
    if (known === undefined) {
      this.meta.set(id, { unit: meta.unit, ugPerLsb: meta.ugPerLsb, conflicting: false })
      return
    }
    if (known.ugPerLsb !== meta.ugPerLsb) known.conflicting = true
  }

  /** まとまり 1 つを足す。**投げない**（外れた値・時刻は数えて外す）。 */
  add(id: string, firstSampleMs: number, msPerSample: number, values: ArrayLike<number>): void {
    if (!Number.isFinite(firstSampleMs) || !Number.isFinite(msPerSample) || msPerSample <= 0) {
      this.outOfWindow += values.length
      return
    }
    let acc = this.acc.get(id)
    if (acc === undefined) {
      acc = {
        n: new Uint32Array(this.fineCount),
        min: new Float64Array(this.fineCount).fill(Number.POSITIVE_INFINITY),
        max: new Float64Array(this.fineCount).fill(Number.NEGATIVE_INFINITY),
        mean: new Float64Array(this.fineCount),
        m2: new Float64Array(this.fineCount),
        touched: false,
        chunks: [],
      }
      this.acc.set(id, acc)
    }
    if (firstSampleMs >= this.fromMs && firstSampleMs < this.toMs) acc.chunks.push({ firstSampleMs, msPerSample, values })
    for (let i = 0; i < values.length; i += 1) {
      const t = firstSampleMs + i * msPerSample
      if (t < this.fromMs || t >= this.toMs) {
        this.outOfWindow += 1
        continue
      }
      const x = values[i]!
      if (!Number.isFinite(x)) {
        this.nonFinite += 1
        continue
      }
      const k = Math.floor(t / SUMMARY_FINE_MS) - this.firstFine
      const n = acc.n[k]! + 1
      acc.n[k] = n
      const d = x - acc.mean[k]!
      acc.mean[k] = acc.mean[k]! + d / n
      acc.m2[k] = acc.m2[k]! + d * (x - acc.mean[k]!)
      if (x < acc.min[k]!) acc.min[k] = x
      if (x > acc.max[k]!) acc.max[k] = x
      acc.touched = true
    }
  }

  /** 締める。`sourceBytes` は要約を作った元のファイルの大きさ。 */
  build(sourceBytes: number, sourceProblems: SourceProblems = NO_PROBLEMS): SummaryFile {
    const channels: SummaryChannel[] = []
    let conflictingScales = 0
    for (const [id, acc] of this.acc) {
      if (!acc.touched) continue
      const meta = this.meta.get(id)
      if (meta?.conflicting === true) conflictingScales += 1
      const fine = fineLevelOf(acc, this.firstFine)
      if (fine === null) continue
      channels.push({
        id,
        unit: meta?.unit ?? 'count',
        ugPerLsb: meta === undefined || meta.conflicting ? null : meta.ugPerLsb,
        fine,
        coarse: coarseLevelOf(fine),
        psd: minutePsd(acc.chunks),
      })
    }
    channels.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return {
      sourceBytes,
      channels,
      outOfWindowSamples: this.outOfWindow,
      droppedNonFinite: this.nonFinite,
      conflictingScales,
      sourceProblems,
    }
  }
}

/** 積んだものから細かい段を作る。最初と最後に届いたまとまりの間だけを持つ。 */
function fineLevelOf(acc: Accumulator, firstFine: number): SummaryLevel | null {
  let first = -1
  let last = -1
  for (let k = 0; k < acc.n.length; k += 1) {
    if (acc.n[k]! === 0) continue
    if (first < 0) first = k
    last = k
  }
  if (first < 0) return null
  const len = last - first + 1
  const level = emptyLevel(SUMMARY_FINE_MS, firstFine + first, len, false)
  for (let i = 0; i < len; i += 1) {
    const k = first + i
    const n = acc.n[k]!
    if (n === 0) continue
    // **頭打ちは数え方の上限であって、値は全部入っている**（最小・最大・平均・ばらつきは正しい）。
    level.n[i] = Math.min(n, FINE_COUNT_MAX)
    level.min[i] = acc.min[k]!
    level.max[i] = acc.max[k]!
    level.mean[i] = acc.mean[k]!
    level.variance[i] = acc.m2[k]! / n
  }
  return level
}

/** 細かい段を 1 分ずつ束ねる。 */
function coarseLevelOf(fine: SummaryLevel): SummaryLevel {
  const ratio = SUMMARY_COARSE_MS / SUMMARY_FINE_MS
  const firstCoarse = Math.floor(fine.firstBucket / ratio)
  const lastCoarse = Math.floor((fine.firstBucket + fine.n.length - 1) / ratio)
  const len = lastCoarse - firstCoarse + 1
  const level = emptyLevel(SUMMARY_COARSE_MS, firstCoarse, len, true)
  const n = new Float64Array(len)
  const mean = new Float64Array(len)
  const m2 = new Float64Array(len)
  const noiseM2 = new Float64Array(len)
  const min = new Float64Array(len).fill(Number.POSITIVE_INFINITY)
  const max = new Float64Array(len).fill(Number.NEGATIVE_INFINITY)
  for (let i = 0; i < fine.n.length; i += 1) {
    const nb = fine.n[i]!
    if (nb === 0) continue
    const j = Math.floor((fine.firstBucket + i) / ratio) - firstCoarse
    const mb = fine.mean[i]!
    const m2b = fine.variance[i]! * nb
    // 2 つの群の平均とばらつきを合わせる（Chan らの式）。
    const na = n[j]!
    const total = na + nb
    const d = mb - mean[j]!
    mean[j] = mean[j]! + (d * nb) / total
    m2[j] = m2[j]! + m2b + (d * d * na * nb) / total
    n[j] = total
    noiseM2[j] = noiseM2[j]! + m2b
    if (fine.min[i]! < min[j]!) min[j] = fine.min[i]!
    if (fine.max[i]! > max[j]!) max[j] = fine.max[i]!
  }
  for (let j = 0; j < len; j += 1) {
    if (n[j]! === 0) continue
    level.n[j] = n[j]!
    level.min[j] = min[j]!
    level.max[j] = max[j]!
    level.mean[j] = mean[j]!
    level.variance[j] = m2[j]! / n[j]!
    level.noiseVariance![j] = noiseM2[j]! / n[j]!
  }
  return level
}

function emptyLevel(bucketMs: number, firstBucket: number, len: number, coarse: boolean): {
  bucketMs: number
  firstBucket: number
  n: Uint16Array | Uint32Array
  min: Float32Array
  max: Float32Array
  mean: Float32Array
  variance: Float32Array
  noiseVariance: Float32Array | null
} {
  return {
    bucketMs,
    firstBucket,
    n: coarse ? new Uint32Array(len) : new Uint16Array(len),
    min: new Float32Array(len).fill(Number.NaN),
    max: new Float32Array(len).fill(Number.NaN),
    mean: new Float32Array(len).fill(Number.NaN),
    variance: new Float32Array(len).fill(Number.NaN),
    noiseVariance: coarse ? new Float32Array(len).fill(Number.NaN) : null,
  }
}

// ---- 書き出しと読み込み ----------------------------------------------------------------
//
// すべて little endian。`Buffer` の読み書きの関数で 1 つずつ読む —— 読み込んだ `Buffer` の先頭位置が
// 4 の倍数である保証が無く、`Float32Array` の view は作れない（`waveArchive.ts` と同じ理由）。
//
// **1 つの要約を 3 本のファイルに分けて書く**（1 秒ごとの段・1 分ごとの段・PSD）。1 か月を俯瞰するときに
// 要るのは 1 分ごとの段だけで、1 時間あたり 2 MB の本体のうち 40 KB しか無い —— 1 本にまとめると、
// 1 か月の俯瞰で 1.4 GB を読むことになる。
//
// 頭: magic u32・版 u8・部分 u8（1 秒・1 分・PSD）・予備 u8×2・元のファイルの大きさ f64・外したサンプル f64・
//     有限でない f64・読まなかったバイト f64・読めなかったレコード f64・分解能の食い違い u32・チャンネル数 u32
// チャンネル: 識別子の長さ u16・識別子（UTF-8）・単位 u8・µg/カウント f64（無ければ NaN）・部分の中身
// 段（1 秒・1 分）: 長さ（ms）u32・最初のまとまり f64・数 u32・旗 u8（ノイズの分散の有無・本数の幅）・
//     本数（細かい段は u16、粗い段は u32）・最小 f32・最大 f32・平均 f32・母分散 f32・（ノイズの分散 f32）
// PSD: 有無 u8・（最初の分 f64・数 u32・区画の数 u16・区間の数 u8 × 数・PSD f32 × 数 × 区画の数）

const HEADER_BYTES = 4 + 4 + 8 + 8 + 8 + 8 + 8 + 4 + 4

/** 要約を分けて書く部分。 */
export type SummaryPart = 'fine' | 'coarse' | 'psd'
const PART_CODES: Record<SummaryPart, number> = { fine: 1, coarse: 2, psd: 3 }
/** 書く順。**作り直すかは最後に書く部分の頭で決める**（途中で落ちたら、その部分が古いまま残るので作り直しになる）。 */
export const SUMMARY_PARTS: readonly SummaryPart[] = ['fine', 'coarse', 'psd']
export const SUMMARY_LAST_PART: SummaryPart = 'psd'

/** 1 部分だけを読んだもの。 */
export interface SummaryPartChannel {
  readonly id: string
  readonly unit: SummaryUnit
  readonly ugPerLsb: number | null
  /** `fine`・`coarse` の部分なら段、`psd` なら `null`。 */
  readonly level: SummaryLevel | null
  /** `psd` の部分なら PSD（作れなかったチャンネルは `null`）、それ以外は `null`。 */
  readonly psd: MinutePsd | null
}

export interface SummaryPartFile {
  readonly part: SummaryPart
  readonly sourceBytes: number
  readonly channels: readonly SummaryPartChannel[]
  readonly outOfWindowSamples: number
  readonly droppedNonFinite: number
  readonly conflictingScales: number
  readonly sourceProblems: SourceProblems
}

function levelBytes(level: SummaryLevel): number {
  const len = level.n.length
  const nBytes = level.n instanceof Uint16Array ? 2 : 4
  return 4 + 8 + 4 + 1 + len * (nBytes + 16 + (level.noiseVariance === null ? 0 : 4))
}

function psdBytes(psd: MinutePsd | null): number {
  if (psd === null) return 1
  return 1 + 8 + 4 + 2 + psd.segments.length + psd.power.length * 4
}

function partBytes(c: SummaryChannel, part: SummaryPart): number {
  if (part === 'fine') return levelBytes(c.fine)
  if (part === 'coarse') return levelBytes(c.coarse)
  return psdBytes(c.psd)
}

/** 要約の 1 部分を書く。 */
export function encodeSummaryPart(file: SummaryFile, part: SummaryPart): Buffer {
  const ids = file.channels.map((c) => Buffer.from(c.id, 'utf8'))
  let total = HEADER_BYTES
  file.channels.forEach((c, i) => {
    total += 2 + ids[i]!.length + 1 + 8 + partBytes(c, part)
  })
  const buf = Buffer.alloc(total)
  let p = 0
  buf.writeUInt32LE(MAGIC, p)
  buf.writeUInt8(FORMAT_VERSION, p + 4)
  buf.writeUInt8(PART_CODES[part], p + 5)
  p += 8
  buf.writeDoubleLE(file.sourceBytes, p)
  buf.writeDoubleLE(file.outOfWindowSamples, p + 8)
  buf.writeDoubleLE(file.droppedNonFinite, p + 16)
  buf.writeDoubleLE(file.sourceProblems.skippedBytes, p + 24)
  buf.writeDoubleLE(file.sourceProblems.badRecords, p + 32)
  buf.writeUInt32LE(file.conflictingScales, p + 40)
  buf.writeUInt32LE(file.channels.length, p + 44)
  p += 48
  file.channels.forEach((c, i) => {
    const id = ids[i]!
    buf.writeUInt16LE(id.length, p)
    id.copy(buf, p + 2)
    p += 2 + id.length
    buf.writeUInt8(UNIT_CODES[c.unit], p)
    buf.writeDoubleLE(c.ugPerLsb ?? Number.NaN, p + 1)
    p += 9
    if (part === 'fine') p = writeLevel(buf, p, c.fine)
    else if (part === 'coarse') p = writeLevel(buf, p, c.coarse)
    else p = writePsd(buf, p, c.psd)
  })
  return buf
}

function writePsd(buf: Buffer, at: number, psd: MinutePsd | null): number {
  let p = at
  buf.writeUInt8(psd === null ? 0 : 1, p)
  p += 1
  if (psd === null) return p
  buf.writeDoubleLE(psd.firstMinute, p)
  buf.writeUInt32LE(psd.segments.length, p + 8)
  buf.writeUInt16LE(PSD_BIN_COUNT, p + 12)
  p += 14
  for (let i = 0; i < psd.segments.length; i += 1) buf.writeUInt8(psd.segments[i]!, p + i)
  p += psd.segments.length
  for (let i = 0; i < psd.power.length; i += 1) {
    buf.writeFloatLE(psd.power[i]!, p)
    p += 4
  }
  return p
}

/** PSD を読む。**区画の数がいまの定義と違えば読まない**（`null` を返して要約ごと作り直させる）。 */
function readPsd(buf: Buffer, at: number): { psd: MinutePsd | null; end: number } | null {
  let p = at
  const has = buf.readUInt8(p)
  p += 1
  if (has === 0) return { psd: null, end: p }
  if (has !== 1) return null
  const firstMinute = buf.readDoubleLE(p)
  const len = buf.readUInt32LE(p + 8)
  const bins = buf.readUInt16LE(p + 12)
  p += 14
  if (bins !== PSD_BIN_COUNT) return null
  if (p + len + len * bins * 4 > buf.length) return null
  const segments = new Uint8Array(len)
  for (let i = 0; i < len; i += 1) segments[i] = buf.readUInt8(p + i)
  p += len
  const power = new Float32Array(len * bins)
  for (let i = 0; i < power.length; i += 1) {
    power[i] = buf.readFloatLE(p)
    p += 4
  }
  return { psd: { firstMinute, segments, power }, end: p }
}

function writeLevel(buf: Buffer, at: number, level: SummaryLevel): number {
  let p = at
  const len = level.n.length
  const wide = level.n instanceof Uint32Array
  buf.writeUInt32LE(level.bucketMs, p)
  buf.writeDoubleLE(level.firstBucket, p + 4)
  buf.writeUInt32LE(len, p + 12)
  buf.writeUInt8((wide ? 0b10 : 0) | (level.noiseVariance === null ? 0 : 0b1), p + 16)
  p += 17
  for (let i = 0; i < len; i += 1) {
    if (wide) {
      buf.writeUInt32LE(level.n[i]!, p)
      p += 4
    } else {
      buf.writeUInt16LE(level.n[i]!, p)
      p += 2
    }
  }
  const arrays = [level.min, level.max, level.mean, level.variance]
  if (level.noiseVariance !== null) arrays.push(level.noiseVariance)
  for (const a of arrays) {
    for (let i = 0; i < len; i += 1) {
      buf.writeFloatLE(a[i]!, p)
      p += 4
    }
  }
  return p
}

/** 作り直すか決めるために、頭だけ読む長さ。 */
export const SUMMARY_PEEK_BYTES = 16

/**
 * 頭だけを見て、要約が控えている元のファイルの大きさを返す。目印・版が合わなければ `null`
 * （作り直せばよい）。**本体を読まずに済ませるためにある** —— 作り直すかの判断は毎分全部の要約に掛かる。
 */
export function peekSummarySourceBytes(head: Buffer): number | null {
  if (head.length < SUMMARY_PEEK_BYTES) return null
  if (head.readUInt32LE(0) !== MAGIC || head.readUInt8(4) !== FORMAT_VERSION) return null
  const bytes = head.readDoubleLE(8)
  return Number.isFinite(bytes) ? bytes : null
}

/**
 * 要約の 1 部分を読む。**目印・版・部分・長さのどれかが合わなければ `null`**（要約を作り直せばよいので、
 * 読める分だけ拾うことはしない —— 書きかけ・別の形式を部分的に信じると、俯瞰に偽の欠けが出る）。投げない。
 */
export function decodeSummaryPart(buf: Buffer): SummaryPartFile | null {
  return decodeSummaryPartWhere(buf, () => true)
}

/**
 * `decodeSummaryPart` のうち、識別子が `keep` を通るチャンネルだけを解く。**通らないチャンネルは
 * 長さだけ確かめて飛ばす**（配列を作らない）—— 読み返しが欲しいのはふつう 1 チャンネルで、1 秒の段の
 * 1 時間ぶん（27 チャンネル・約 1.9 MB）を全部解くと、1 日の俯瞰で 24 回それを払う。
 *
 * 飛ばしたチャンネルも長さが合わなければ `null`（形が壊れていることに変わりはない）。
 */
export function decodeSummaryPartWhere(buf: Buffer, keep: (id: string) => boolean): SummaryPartFile | null {
  try {
    if (buf.length < HEADER_BYTES) return null
    if (buf.readUInt32LE(0) !== MAGIC || buf.readUInt8(4) !== FORMAT_VERSION) return null
    const partCode = buf.readUInt8(5)
    const part = SUMMARY_PARTS.find((p) => PART_CODES[p] === partCode)
    if (part === undefined) return null
    const sourceBytes = buf.readDoubleLE(8)
    const outOfWindowSamples = buf.readDoubleLE(16)
    const droppedNonFinite = buf.readDoubleLE(24)
    const sourceProblems = { skippedBytes: buf.readDoubleLE(32), badRecords: buf.readDoubleLE(40) }
    const conflictingScales = buf.readUInt32LE(48)
    const count = buf.readUInt32LE(52)
    let p = HEADER_BYTES
    const channels: SummaryPartChannel[] = []
    for (let c = 0; c < count; c += 1) {
      const idLen = buf.readUInt16LE(p)
      if (p + 2 + idLen > buf.length) return null
      const id = buf.toString('utf8', p + 2, p + 2 + idLen)
      p += 2 + idLen
      const unitCode = buf.readUInt8(p)
      const unit = unitCode === UNIT_CODES.gal ? 'gal' : unitCode === UNIT_CODES.count ? 'count' : null
      if (unit === null) return null
      const ug = buf.readDoubleLE(p + 1)
      p += 9
      const ugPerLsb = Number.isFinite(ug) ? ug : null
      if (!keep(id)) {
        const end = part === 'psd' ? skipPsd(buf, p) : skipLevel(buf, p)
        if (end === null) return null
        p = end
        continue
      }
      if (part === 'psd') {
        const psd = readPsd(buf, p)
        if (psd === null) return null
        p = psd.end
        channels.push({ id, unit, ugPerLsb, level: null, psd: psd.psd })
      } else {
        const level = readLevel(buf, p)
        if (level === null) return null
        p = level.end
        channels.push({ id, unit, ugPerLsb, level: level.level, psd: null })
      }
    }
    if (p !== buf.length) return null
    return { part, sourceBytes, channels, outOfWindowSamples, droppedNonFinite, conflictingScales, sourceProblems }
  } catch {
    // 長さの欄を信じて範囲の外を読んだ（`RangeError`）。壊れたファイルとして扱う。
    return null
  }
}

/**
 * 要約の 1 部分に入っているチャンネルの名乗りだけを読む（中身は長さを確かめて飛ばす）。
 * チャンネルの一覧を作るのに使う。形が合わなければ `null`。投げない。
 */
export function listSummaryPartChannels(
  buf: Buffer,
): { readonly part: SummaryPart; readonly channels: readonly { readonly id: string; readonly unit: SummaryUnit; readonly ugPerLsb: number | null }[] } | null {
  try {
    if (buf.length < HEADER_BYTES) return null
    if (buf.readUInt32LE(0) !== MAGIC || buf.readUInt8(4) !== FORMAT_VERSION) return null
    const part = SUMMARY_PARTS.find((p) => PART_CODES[p] === buf.readUInt8(5))
    if (part === undefined) return null
    const count = buf.readUInt32LE(52)
    let p = HEADER_BYTES
    const channels: { id: string; unit: SummaryUnit; ugPerLsb: number | null }[] = []
    for (let c = 0; c < count; c += 1) {
      const idLen = buf.readUInt16LE(p)
      if (p + 2 + idLen > buf.length) return null
      const id = buf.toString('utf8', p + 2, p + 2 + idLen)
      p += 2 + idLen
      const unitCode = buf.readUInt8(p)
      const unit = unitCode === UNIT_CODES.gal ? 'gal' : unitCode === UNIT_CODES.count ? 'count' : null
      if (unit === null) return null
      const ug = buf.readDoubleLE(p + 1)
      p += 9
      const end = part === 'psd' ? skipPsd(buf, p) : skipLevel(buf, p)
      if (end === null) return null
      p = end
      channels.push({ id, unit, ugPerLsb: Number.isFinite(ug) ? ug : null })
    }
    return p === buf.length ? { part, channels } : null
  } catch {
    return null
  }
}

/** 段を読まずに飛ばした先。長さが足りなければ `null`。 */
function skipLevel(buf: Buffer, at: number): number | null {
  const len = buf.readUInt32LE(at + 12)
  const flags = buf.readUInt8(at + 16)
  const end = at + 17 + len * ((flags & 0b10) !== 0 ? 4 : 2) + len * (16 + ((flags & 0b1) !== 0 ? 4 : 0))
  return end <= buf.length ? end : null
}

/** PSD を読まずに飛ばした先。形が違う・長さが足りなければ `null`（`readPsd` と同じ条件）。 */
function skipPsd(buf: Buffer, at: number): number | null {
  const has = buf.readUInt8(at)
  if (has === 0) return at + 1
  if (has !== 1) return null
  const len = buf.readUInt32LE(at + 9)
  const bins = buf.readUInt16LE(at + 13)
  if (bins !== PSD_BIN_COUNT) return null
  const end = at + 15 + len + len * bins * 4
  return end <= buf.length ? end : null
}

function readLevel(buf: Buffer, at: number): { level: SummaryLevel; end: number } | null {
  let p = at
  const bucketMs = buf.readUInt32LE(p)
  const firstBucket = buf.readDoubleLE(p + 4)
  const len = buf.readUInt32LE(p + 12)
  const flags = buf.readUInt8(p + 16)
  p += 17
  const wide = (flags & 0b10) !== 0
  const hasNoise = (flags & 0b1) !== 0
  const need = len * ((wide ? 4 : 2) + 16 + (hasNoise ? 4 : 0))
  if (p + need > buf.length) return null
  const n = wide ? new Uint32Array(len) : new Uint16Array(len)
  for (let i = 0; i < len; i += 1) {
    n[i] = wide ? buf.readUInt32LE(p) : buf.readUInt16LE(p)
    p += wide ? 4 : 2
  }
  const readFloats = (): Float32Array => {
    const a = new Float32Array(len)
    for (let i = 0; i < len; i += 1) {
      a[i] = buf.readFloatLE(p)
      p += 4
    }
    return a
  }
  const min = readFloats()
  const max = readFloats()
  const mean = readFloats()
  const variance = readFloats()
  const noiseVariance = hasNoise ? readFloats() : null
  return { level: { bucketMs, firstBucket, n, min, max, mean, variance, noiseVariance }, end: p }
}
