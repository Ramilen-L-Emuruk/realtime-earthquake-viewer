// 波形のパワースペクトル密度（PSD）。管理コンソールで「どの周波数がどれだけ揺れているか」を見るためにある
// （REQUIREMENTS §9「処理済みデータ」の PSD。#502 から #621 へ畳んだ。2026-10-07 ユーザー承認）。
//
// **方式は Welch 法。** 1024 点（100 Hz で約 10 秒）の区間を半分ずつ重ねて切り、区間ごとに平均を引いて
// Hann 窓を掛け、FFT の二乗を平均する。片側 PSD（値の単位² / Hz）で、周波数で積分すると分散に戻る。
//
// **区間の平均を引く。** 生のカウントには重力が乗っていて、引かないと最初の数本の線へ漏れた直流が
// 低い周波数を埋める。
//
// **周波数は 0.1〜50 Hz を対数で 40 区画に分けて持つ。** FFT の線をそのまま 513 本持つと 1 日 90 MB に
// なる。区画への振り分けは「線が覆う幅（中心 ± 線の間隔の半分）と区画の重なり」で重みを付けた平均で、
// 線が 1 本も入らないほど細い低い区画にも値が入る（その代わり、そこは隣と同じ値に近くなる）。
// 区画を周波数で決めておけば、刻みが基板ごとに少し違っても（公称 100 Hz・実測で 0.16% 揺らぐ）
// 同じ区画で比べられる。ナイキスト周波数より上の区画は `NaN`（測れない）。
//
// **欠けを跨いで区間を作らない。** 届かなかった間を詰めて繋ぐと、継ぎ目の段差が全周波数へ漏れる。
//
// **区間の中心は時刻の格子に置き、サンプルは実時刻から引く**（#742。2026-10-13 ユーザー承認）。
// 生データのレコードが名乗る刻みは公称（100 Hz・104 Hz）で、実際の刻みは基板ごとに数パーミル違う。
// 走りの頭から「添字 × 名乗る刻み」で時刻を数えると、長い走りほど実時刻から離れる（実機の 12 時間で
// MPU6050 は最大 84 秒、IIS2ICLX は最大 211 秒）。そこで、分・列ごとに中心の時刻を等間隔に決め、
// その時刻に当たるサンプルを、まとまり（レコード）が持つ実時刻から引いて区間を切る。1 分ごとの PSD と
// 列ごとの PSD は同じ置き方なので、1 分の列なら両者は同じ区間で作られる（材料が切り替わる境目で段差を作らない）。
// ただし範囲の頭・末尾が分の境目に揃っていないとき、端の列は範囲に入る部分だけで中心を置くので、同じ分の
// 1 分 PSD とは区間が少し違う（揃った列どうしは一致する）。

import { fftInPlace } from '../../../src/utils/knet/fft'

/** 1 区間の点数（2 の冪）。 */
export const PSD_NFFT = 1024
/** 区間を進める点数（半分ずつ重ねる）。 */
export const PSD_HOP = PSD_NFFT / 2
/** 区画の数。 */
export const PSD_BIN_COUNT = 40
const PSD_MIN_HZ = 0.1
const PSD_MAX_HZ = 50

/** 区画の境目（`PSD_BIN_COUNT + 1` 本）。区画 b は `[edges[b], edges[b+1])`。 */
export const PSD_BIN_EDGES_HZ: readonly number[] = Array.from(
  { length: PSD_BIN_COUNT + 1 },
  (_, b) => PSD_MIN_HZ * (PSD_MAX_HZ / PSD_MIN_HZ) ** (b / PSD_BIN_COUNT),
)

/** 1 分。区間はその中心の時刻が入る分へ数える。 */
const MINUTE_MS = 60_000
/**
 * まとまりの継ぎ目の許容のうち、長さに比例する分の上限。生データの 5 秒のレコードでは 1% が 50 ms で、これに
 * 掛からない。本物の欠け（パケット 1 つぶん・約 0.3 秒）より十分小さく取る。
 */
const SLACK_SCALE_MAX_MS = 100
/** 名乗る刻みと実際の刻みの違いの見込み。繋ぐときに許す刻みの違い（1%）と同じにする。 */
const RATE_TOLERANCE = 0.01
/** 非同期で区間を計算するとき、続けて計算してよい長さ（ミリ秒）。これを超えたら 1 度譲る（#745）。 */
export const PSD_YIELD_SLICE_MS = 50

/**
 * 区間（{@link PSD_NFFT} 点）の中心から端までの長さ（ミリ秒）。名乗る刻みと実際の刻みの違い（1%）を見込む。
 * 範囲の端の列まで区間を作るために前後へ余分に読む幅は、これ以上にする（#743）。
 */
export function segmentHalfSpanMs(msPerSample: number): number {
  return (PSD_NFFT / 2) * msPerSample * (1 + RATE_TOLERANCE)
}

/** 周期 Hann 窓と、その二乗和（PSD の換算に使う）。 */
const WINDOW = Float64Array.from({ length: PSD_NFFT }, (_, n) => 0.5 * (1 - Math.cos((2 * Math.PI * n) / PSD_NFFT)))
const WINDOW_POWER = WINDOW.reduce((s, w) => s + w * w, 0)

/** 区画へ振り分ける重み（線 k が区画 b に寄与する幅）。刻みごとに作って控える。 */
interface Rebin {
  /** 線ごとの `[区画, 重み, 区画, 重み, ...]`。 */
  readonly lines: readonly number[][]
  /** 区画ごとの重みの和。0 なら測れない区画。 */
  readonly weight: Float64Array
}

const rebinCache = new Map<number, Rebin>()

function rebinFor(sampleRateHz: number): Rebin {
  const key = Math.round(sampleRateHz * 1e6)
  const known = rebinCache.get(key)
  if (known !== undefined) return known
  const df = sampleRateHz / PSD_NFFT
  const lines: number[][] = []
  const weight = new Float64Array(PSD_BIN_COUNT)
  // 直流（k = 0）は区間ごとに引いてあるので使わない。
  for (let k = 0; k <= PSD_NFFT / 2; k += 1) {
    const pairs: number[] = []
    if (k > 0) {
      const lo = k * df - df / 2
      const hi = Math.min(k * df + df / 2, sampleRateHz / 2)
      for (let b = 0; b < PSD_BIN_COUNT; b += 1) {
        const overlap = Math.min(hi, PSD_BIN_EDGES_HZ[b + 1]!) - Math.max(lo, PSD_BIN_EDGES_HZ[b]!)
        if (overlap > 0) {
          pairs.push(b, overlap)
          weight[b] = weight[b]! + overlap
        }
      }
    }
    lines.push(pairs)
  }
  const rebin = { lines, weight }
  // **際限なく溜めない。** 刻みは基板の数ほどしか無いが、壊れた値が来続けても膨らまないように。
  if (rebinCache.size > 64) rebinCache.clear()
  rebinCache.set(key, rebin)
  return rebin
}

/**
 * 1 区間の片側 PSD を区画へ振り分けて `acc` へ足す。`x` の `from` から `PSD_NFFT` 点を使う。
 */
function addSegment(x: ArrayLike<number>, from: number, sampleRateHz: number, rebin: Rebin, acc: Float64Array): void {
  const re = new Float64Array(PSD_NFFT)
  const im = new Float64Array(PSD_NFFT)
  let mean = 0
  for (let i = 0; i < PSD_NFFT; i += 1) mean += x[from + i]!
  mean /= PSD_NFFT
  for (let i = 0; i < PSD_NFFT; i += 1) re[i] = (x[from + i]! - mean) * WINDOW[i]!
  fftInPlace(re, im, false)
  const scale = 1 / (sampleRateHz * WINDOW_POWER)
  for (let k = 1; k <= PSD_NFFT / 2; k += 1) {
    const pairs = rebin.lines[k]!
    if (pairs.length === 0) continue
    // 片側にするので、両端（直流・ナイキスト）以外は 2 倍。
    const p = (re[k]! * re[k]! + im[k]! * im[k]!) * scale * (k === PSD_NFFT / 2 ? 1 : 2)
    for (let j = 0; j < pairs.length; j += 2) acc[pairs[j]!] = acc[pairs[j]!]! + p * pairs[j + 1]!
  }
}

/** 足した重み付きの和を、区画の PSD へ。測れない区画は `NaN`。 */
function finish(acc: Float64Array, segments: number, rebin: Rebin): Float64Array {
  const out = new Float64Array(PSD_BIN_COUNT).fill(Number.NaN)
  if (segments === 0) return out
  for (let b = 0; b < PSD_BIN_COUNT; b += 1) {
    const w = rebin.weight[b]!
    if (w > 0) out[b] = acc[b]! / w / segments
  }
  return out
}

/**
 * 途切れの無い 1 本のサンプル列の PSD（区画ごと）。区間に満たなければ区間 0・すべて `NaN`。
 * 管理コンソールで選んだ区間のスペクトルを、その場で出すときに使う。
 */
export function welchPsd(x: ArrayLike<number>, sampleRateHz: number): { readonly power: Float64Array; readonly segments: number } {
  const rebin = rebinFor(sampleRateHz)
  const acc = new Float64Array(PSD_BIN_COUNT)
  let segments = 0
  if (Number.isFinite(sampleRateHz) && sampleRateHz > 0) {
    for (let from = 0; from + PSD_NFFT <= x.length; from += PSD_HOP) {
      addSegment(x, from, sampleRateHz, rebin, acc)
      segments += 1
    }
  }
  return { power: finish(acc, segments, rebin), segments }
}

/** 要約へ渡すまとまり（生データのレコード・合成波形のまとまり）。 */
export interface PsdChunk {
  readonly firstSampleMs: number
  readonly msPerSample: number
  readonly values: ArrayLike<number>
}

/** 1 分ごとの PSD。添字 i は `firstMinute + i` 分目。 */
export interface MinutePsd {
  readonly firstMinute: number
  /** その分へ数えた区間の数（頭打ち 255）。**0 なら作れなかった分**（`power` は `NaN`）。 */
  readonly segments: Uint8Array
  /** `[分 × PSD_BIN_COUNT + 区画]`。 */
  readonly power: Float32Array
}

/**
 * まとまりの列から 1 分ごとの PSD を作る。区間を 1 つも作れなければ `null`。投げない。
 *
 * まとまりは時刻で並べ直し、**先頭が前の末尾の次のサンプル（± 刻みの半分）にあり、刻みが同じ（1% 以内）
 * なら繋ぐ**。それ以外（欠け・重なり・刻みの変化）で切る。区間の中心は分ごとに等間隔に置き
 * （{@link cellCenters}）、中心の時刻が入る分へ数える。
 */
export function minutePsd(chunks: readonly PsdChunk[]): MinutePsd | null {
  const sums = accumulateSegments(chunks, cellCenters(MINUTE_MS, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY))
  if (sums.size === 0) return null
  const minutes = [...sums.keys()]
  const firstMinute = Math.min(...minutes)
  const len = Math.max(...minutes) - firstMinute + 1
  const segments = new Uint8Array(len)
  const power = new Float32Array(len * PSD_BIN_COUNT).fill(Number.NaN)
  for (const [minute, byRebin] of sums) {
    const i = minute - firstMinute
    const combined = combineRebins(byRebin)
    segments[i] = Math.min(255, combined.segments)
    for (let b = 0; b < PSD_BIN_COUNT; b += 1) power[i * PSD_BIN_COUNT + b] = combined.power[b]!
  }
  return { firstMinute, segments, power }
}

/**
 * 範囲 `[fromMs, toMs)` に収まる区間だけで作る 1 本の PSD（区画ごと）。管理コンソールで選んだ区間の
 * スペクトルに使う。区間の作り方（繋ぎ方・有限でない区間を外す）は {@link minutePsd} と同じ。区間の中心は
 * 範囲の頭から半分重ねの送りで並べる（{@link rangeCenters}）。区間を 1 つも作れなければ区間 0・すべて `NaN`。
 * 投げない。
 */
export function intervalPsd(
  chunks: readonly PsdChunk[],
  fromMs: number,
  toMs: number,
): { readonly power: Float64Array; readonly segments: number } {
  // **はみ出しは半サンプルまで許す。** 中心の時刻からサンプルを引くときの丸めで、区間の頭・末尾は最大で
  // 半サンプル範囲の外へ出る。許さないと、範囲いっぱいに収まるはずの端の区間を落とす。
  const sums = accumulateSegments(
    chunks,
    rangeCenters(fromMs, toMs),
    (startMs, endMs, ms) => startMs >= fromMs - ms / 2 && endMs <= toMs + ms / 2,
  )
  const byRebin = sums.get(0)
  if (byRebin === undefined) return { power: new Float64Array(PSD_BIN_COUNT).fill(Number.NaN), segments: 0 }
  return combineRebins(byRebin)
}

/** 列ごとの PSD。添字 j は `firstColumn + j` 列目（列 c は `[c × columnMs, (c + 1) × columnMs)`）。 */
export interface ColumnPsd {
  readonly firstColumn: number
  /** 列へ数えた区間の数。**0 なら作れなかった列**（`power` の行はすべて `NaN`）。 */
  readonly segments: number[]
  /** `[列][区画]`。 */
  readonly power: Float64Array[]
}

/**
 * 範囲 `[fromMs, toMs)` を `columnMs` ごとの列に分け、**列ごとに中心の時刻を等間隔に置いて区間を積む**
 * （{@link cellCenters}。{@link minutePsd} と同じ置き方で、列の幅だけが違う）。中心が範囲の外に来る区間は使わない。
 * 投げない。
 *
 * 区間（約 10 秒）は列より長いことがあり、そのときは列の外のサンプルも使う。範囲の端の列まで区間を作るには、
 * 呼び出し側が範囲の前後に {@link segmentHalfSpanMs} ずつ余分に読んで渡す。
 *
 * **列が送り（約 5 秒）より細ければ 1 列に 1 本**（列の真ん中）。どの列にも中心が置かれるので、区間の入らない
 * 列は欠けと範囲の端にしか出ない。細かくしても 1 本の区間の長さ（約 10 秒）は変わらないので、1 列が見ている
 * 長さは約 10 秒のまま。列が刻みより細ければ、同じサンプルを中心にする列は最初の 1 列だけが取る。
 */
export function columnPsd(chunks: readonly PsdChunk[], fromMs: number, toMs: number, columnMs: number): ColumnPsd {
  return columnsOf(accumulateSegments(chunks, cellCenters(columnMs, fromMs, toMs)), fromMs, toMs, columnMs)
}

/** 非同期で区間を計算するときの指定（#745）。 */
export interface PsdYieldOptions {
  /** 譲るたびに確かめ、中断されていれば投げる。 */
  readonly signal: AbortSignal
  /** 続けて計算してよい長さ（ミリ秒）。既定 {@link PSD_YIELD_SLICE_MS}。 */
  readonly sliceMs?: number
  /** 譲り方（既定は `setImmediate`。受信の処理や基板への返事を先に通す）。テストで差し替える。 */
  readonly pause?: () => Promise<void>
}

/**
 * {@link columnPsd} と同じ結果を、**計算の途中で譲りながら**作る。12 時間ぶんの区間（約 8000 本）を同期で
 * 計算すると、ホストのイベントループが 1 軸あたり 1〜1.6 秒止まる（手元の PC で実測。画面は 3 軸を続けて取る）。
 * 同じプロセスが UDP の受信と基板への返事を持つので、{@link PsdYieldOptions.sliceMs} ごとに 1 度譲る。
 * 中断されたら投げる。
 */
export async function columnPsdAsync(
  chunks: readonly PsdChunk[],
  fromMs: number,
  toMs: number,
  columnMs: number,
  options: PsdYieldOptions,
): Promise<ColumnPsd> {
  const sums = await accumulateSegmentsAsync(chunks, cellCenters(columnMs, fromMs, toMs), options)
  return columnsOf(sums, fromMs, toMs, columnMs)
}

function columnsOf(sums: Map<number, RebinSums>, fromMs: number, toMs: number, columnMs: number): ColumnPsd {
  const firstColumn = Math.floor(fromMs / columnMs)
  const count = Math.max(0, Math.floor((toMs - 1) / columnMs) - firstColumn + 1)
  const segments = new Array<number>(count).fill(0)
  const power = Array.from({ length: count }, () => new Float64Array(PSD_BIN_COUNT).fill(Number.NaN))
  for (const [column, byRebin] of sums) {
    const j = column - firstColumn
    if (j < 0 || j >= count) continue
    const combined = combineRebins(byRebin)
    segments[j] = combined.segments
    power[j] = Float64Array.from(combined.power)
  }
  return { firstColumn, segments, power }
}

type RebinSums = Map<Rebin, { acc: Float64Array; segments: number }>

/** 区間の中心 1 つ。`key` はその区間を積む先（分・列の番号）。 */
interface SegmentCenter {
  readonly atMs: number
  readonly key: number
}

/**
 * 走り 1 本が覆う時刻 `[runFromMs, runToMs]`（頭と末尾のサンプルの実時刻）と、走りの名乗る刻みを受け取り、
 * そこへ置く区間の中心を時刻の順に返す。
 */
type CenterPlan = (runFromMs: number, runToMs: number, msPerSample: number) => Iterable<SegmentCenter>

/**
 * 幅 `cellMs` の升（分・列。升 c は `[c × cellMs, (c + 1) × cellMs)`）ごとに、中心を等間隔に置く。升を半分重ねの
 * 送り（{@link PSD_HOP} 点）を超えない数に等分し、その真ん中ごとに 1 本。**升の幅と刻みだけで決まる**ので、
 * 走りの頭がどこにあっても、同じ升には同じ時刻に中心が置かれる（範囲に丸ごと入る升なら、1 分 PSD と 1 分の列が
 * 同じ区間になる）。
 * **升が範囲 `[fromMs, toMs)` に一部しか入らないときは、入っている部分を等分する**（範囲の頭・末尾が升の境目に
 * 揃っていないと、升の真ん中が範囲の外へ出て端の升が空くため）。範囲に丸ごと入る升では上と同じ置き方になる。
 */
function cellCenters(cellMs: number, fromMs: number, toMs: number): CenterPlan {
  return function* (runFromMs, runToMs, msPerSample) {
    const lo = Math.max(runFromMs, fromMs)
    const hi = Math.min(runToMs, toMs)
    if (!(hi >= lo)) return
    for (let c = Math.floor(lo / cellMs); c * cellMs <= hi; c += 1) {
      const cellFrom = Math.max(c * cellMs, fromMs)
      const cellTo = Math.min((c + 1) * cellMs, toMs)
      if (!(cellTo > cellFrom)) continue
      const perCell = Math.max(1, Math.ceil((cellTo - cellFrom) / (PSD_HOP * msPerSample)))
      const step = (cellTo - cellFrom) / perCell
      for (let i = 0; i < perCell; i += 1) {
        const atMs = cellFrom + (i + 0.5) * step
        // 走りの外の中心は、この走りでは区間を作れない（別の走りが受け持つ）
        if (atMs < runFromMs || atMs > runToMs) continue
        yield { atMs, key: c }
      }
    }
  }
}

/**
 * 範囲 `[fromMs, toMs)` の頭から、半分重ねの送り（{@link PSD_HOP} 点）で中心を並べる。鍵はすべて 0。範囲を 1 本の
 * PSD にまとめる {@link intervalPsd} 用（区間を範囲に詰めて並べ、数を最も多く取る）。
 */
function rangeCenters(fromMs: number, toMs: number): CenterPlan {
  return function* (runFromMs, runToMs, msPerSample) {
    const step = PSD_HOP * msPerSample
    const first = fromMs + (PSD_NFFT / 2) * msPerSample
    const lo = Math.max(runFromMs, first)
    const hi = Math.min(runToMs, toMs)
    for (let k = Math.max(0, Math.ceil((lo - first) / step)); first + k * step <= hi && first + k * step < toMs; k += 1) {
      yield { atMs: first + k * step, key: 0 }
    }
  }
}

/** 区間を使うかを、区間の頭と末尾（末尾の次のサンプル）の実時刻と、走りの刻みで決める。 */
type SegmentAccept = (startMs: number, endMs: number, msPerSample: number) => boolean

/** 区間を同期で積む（{@link segmentSteps} を回し切る）。 */
function accumulateSegments(chunks: readonly PsdChunk[], plan: CenterPlan, accept?: SegmentAccept): Map<number, RebinSums> {
  const sums = new Map<number, RebinSums>()
  for (const step = segmentSteps(chunks, plan, accept, sums); !step.next().done; ) {
    // 回し切るだけ
  }
  return sums
}

/** 区間を、時間の予算ごとに譲りながら積む（#745）。中断されたら投げる。 */
async function accumulateSegmentsAsync(
  chunks: readonly PsdChunk[],
  plan: CenterPlan,
  options: PsdYieldOptions,
  accept?: SegmentAccept,
): Promise<Map<number, RebinSums>> {
  const sliceMs = options.sliceMs ?? PSD_YIELD_SLICE_MS
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)))
  options.signal.throwIfAborted()
  const sums = new Map<number, RebinSums>()
  let since = performance.now()
  for (const step = segmentSteps(chunks, plan, accept, sums); !step.next().done; ) {
    if (performance.now() - since < sliceMs) continue
    await pause()
    options.signal.throwIfAborted()
    since = performance.now()
  }
  // 最後の譲りの後に中断されていたら、仕上がった結果も返さない
  options.signal.throwIfAborted()
  return sums
}

/**
 * まとまりを繋いで走りにし、走りごとに `plan` が置く中心で区間を切って `sums` へ積む。**区間 1 本ごとに
 * 1 度 `yield` する**（呼び出し側が譲る機会。同期の呼び出し側はそのまま回し切る）。
 *
 * まとまりは時刻で並べ直し、**先頭が前の末尾の次のサンプルの近くにあり、刻みが同じ（1% 以内）
 * なら繋ぐ**。それ以外（欠け・重なり・刻みの変化）で切る。
 *
 * **中心の時刻からサンプルを引くときは、まとまりの実時刻を使う**: 中心が入るまとまりを探し、その頭の時刻から
 * まとまりの名乗る刻みで数える。まとまり（生データのレコードは約 5 秒）の中のずれは刻みの違いぶん（1% 未満）
 * で、走りの長さに沿って積もらない。区間の頭・末尾の時刻も同じ引き方で `accept` へ渡す。
 */
function* segmentSteps(
  chunks: readonly PsdChunk[],
  plan: CenterPlan,
  accept: SegmentAccept | undefined,
  sums: Map<number, RebinSums>,
): Generator<void, void, void> {
  const sorted = chunks
    .filter((c) => Number.isFinite(c.firstSampleMs) && Number.isFinite(c.msPerSample) && c.msPerSample > 0 && c.values.length > 0)
    .slice()
    .sort((a, b) => a.firstSampleMs - b.firstSampleMs)

  // 刻みが走ごとに違うと区画の重みも違うので、鍵ごとに「重み付きの和」を走の刻みごとに分けて持つ。
  function* flush(run: PsdChunk[]): Generator<void, void, void> {
    const offsets: number[] = []
    let total = 0
    for (const c of run) {
      offsets.push(total)
      total += c.values.length
    }
    if (total < PSD_NFFT) return
    const x = new Float64Array(total)
    for (let j = 0; j < run.length; j += 1) {
      const c = run[j]!
      const at = offsets[j]!
      for (let i = 0; i < c.values.length; i += 1) x[at + i] = c.values[i]!
    }
    yield
    // 添字 i のサンプルの実時刻。`i === total`（末尾の次）は最後のまとまりから外挿する。
    const timeAt = (i: number): number => {
      const j = lastAtOrBefore(offsets, Math.min(i, total - 1), (o) => o)
      const c = run[j]!
      return c.firstSampleMs + (i - offsets[j]!) * c.msPerSample
    }
    // 時刻 t に当たるサンプルの添字。走りの頭より前なら -1。まとまりの末尾と次の頭の間（継ぎ目）は、まとまりの
    // 末尾の次（＝次のまとまりの頭）までに収める。
    const indexAt = (t: number): number => {
      const j = lastAtOrBefore(run, t, (c) => c.firstSampleMs)
      if (j < 0) return -1
      const c = run[j]!
      const local = Math.min(c.values.length, Math.max(0, Math.round((t - c.firstSampleMs) / c.msPerSample)))
      return offsets[j]! + local
    }
    const ms = run[0]!.msPerSample
    const fs = 1000 / ms
    const rebin = rebinFor(fs)
    let lastFrom = -1
    for (const center of plan(timeAt(0), timeAt(total - 1), ms)) {
      const index = indexAt(center.atMs)
      if (index < 0) continue
      const from = index - PSD_NFFT / 2
      // 中心は時刻の順に来るので、同じサンプルを中心にする 2 本目（列が刻みより細いとき）は捨てる。
      if (from < 0 || from + PSD_NFFT > total || from <= lastFrom) continue
      lastFrom = from
      if (accept !== undefined && !accept(timeAt(from), timeAt(from + PSD_NFFT), ms)) continue
      // **値が有限でない区間は使わない**（FFT が全部の線を NaN にする）。
      let finite = true
      for (let i = 0; i < PSD_NFFT; i += 1) {
        if (!Number.isFinite(x[from + i]!)) {
          finite = false
          break
        }
      }
      if (!finite) continue
      let byRebin = sums.get(center.key)
      if (byRebin === undefined) {
        byRebin = new Map()
        sums.set(center.key, byRebin)
      }
      let s = byRebin.get(rebin)
      if (s === undefined) {
        s = { acc: new Float64Array(PSD_BIN_COUNT), segments: 0 }
        byRebin.set(rebin, s)
      }
      addSegment(x, from, fs, rebin, s.acc)
      s.segments += 1
      yield
    }
  }

  let run: PsdChunk[] = []
  let runEnd = Number.NaN
  let slack = 0
  for (const c of sorted) {
    const head = run[0]
    const joins =
      head !== undefined &&
      Math.abs(c.msPerSample - head.msPerSample) <= head.msPerSample * 0.01 &&
      Math.abs(c.firstSampleMs - runEnd) <= slack
    if (!joins) {
      yield* flush(run)
      run = []
    }
    run.push(c)
    runEnd = c.firstSampleMs + c.values.length * c.msPerSample
    // **継ぎ目の許容は「刻みの半分 ＋ まとまりの長さの 1%」。** 生データのレコードが名乗る刻みは公称
    // （100 Hz）で、実際の刻みは 0.16% ほど速い（実測 100.16 Hz）。5 秒のレコードの終わりを公称の刻みで
    // 見積もると 8 ms ずれ、刻みの半分（5 ms）だけでは継ぎ目の多くを欠けと取り違える
    // （評価台の 1 時間で、1 分あたりの区間が本来の 11 から 6 へ減っていた）。本物の欠けはパケット
    // 1 つぶん（約 0.3 秒）以上なので、この許容では詰めない。
    // **長さに比例する分には上限（SLACK_SCALE_MAX_MS）を置く** —— 合成波形の 0.3 秒のまとまりを繋いだ長い走り
    // （数十秒〜数時間）では、1% が数秒〜数十秒になり、0.3 秒の欠けを繋いでしまう。
    slack = c.msPerSample / 2 + Math.min(SLACK_SCALE_MAX_MS, c.values.length * c.msPerSample * 0.01)
  }
  yield* flush(run)
}

/** 昇順の列で、`key(item) <= value` を満たす最後の添字（無ければ -1）。 */
function lastAtOrBefore<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0
  let hi = items.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (key(items[mid]!) <= value) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/** 刻みの違う走が同じ鍵にあれば、区間の数で重みを付けて平均する。 */
function combineRebins(byRebin: RebinSums): { readonly power: Float64Array; readonly segments: number } {
  const acc = new Float64Array(PSD_BIN_COUNT)
  const n = new Float64Array(PSD_BIN_COUNT)
  let segments = 0
  for (const [rebin, s] of byRebin) {
    const psd = finish(s.acc, s.segments, rebin)
    for (let b = 0; b < PSD_BIN_COUNT; b += 1) {
      if (!Number.isFinite(psd[b]!)) continue
      acc[b] = acc[b]! + psd[b]! * s.segments
      n[b] = n[b]! + s.segments
    }
    segments += s.segments
  }
  const power = new Float64Array(PSD_BIN_COUNT).fill(Number.NaN)
  for (let b = 0; b < PSD_BIN_COUNT; b += 1) if (n[b]! > 0) power[b] = acc[b]! / n[b]!
  return { power, segments }
}
