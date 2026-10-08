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
 * なら繋ぐ**。それ以外（欠け・重なり・刻みの変化）で切る。区間はその中心の時刻が入る分へ数える。
 */
export function minutePsd(chunks: readonly PsdChunk[]): MinutePsd | null {
  const sums = accumulateSegments(chunks, (_startMs, centerMs) => Math.floor(centerMs / MINUTE_MS))
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
 * スペクトルに使う。区間の作り方（繋ぎ方・有限でない区間を外す）は {@link minutePsd} と同じ。
 * 区間を 1 つも作れなければ区間 0・すべて `NaN`。投げない。
 */
export function intervalPsd(
  chunks: readonly PsdChunk[],
  fromMs: number,
  toMs: number,
): { readonly power: Float64Array; readonly segments: number } {
  const sums = accumulateSegments(chunks, (startMs, _centerMs, endMs) => (startMs >= fromMs && endMs <= toMs ? 0 : null))
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
 * 範囲 `[fromMs, toMs)` を `columnMs` ごとの列に分け、**中心の時刻が入る列へ区間を積む**（{@link minutePsd} と
 * 同じ数え方で、列の幅だけが違う）。中心が範囲の外にある区間は使わない。投げない。
 *
 * 区間（約 10 秒）は列より長いことがあり、そのときは列の外のサンプルも使う。範囲の端の列まで区間を作るには、
 * 呼び出し側が範囲の前後に区間の半分ずつ余分に読んで渡す。**列の幅は区間を進める幅（{@link PSD_HOP} 点）
 * より広くする** —— 狭いと区間の入らない列が出る。
 */
export function columnPsd(chunks: readonly PsdChunk[], fromMs: number, toMs: number, columnMs: number): ColumnPsd {
  const firstColumn = Math.floor(fromMs / columnMs)
  const count = Math.max(0, Math.floor((toMs - 1) / columnMs) - firstColumn + 1)
  const sums = accumulateSegments(chunks, (_startMs, centerMs) => (centerMs >= fromMs && centerMs < toMs ? Math.floor(centerMs / columnMs) : null))
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

/**
 * まとまりを繋いで区間に切り、区間ごとに `keyOf` が返す鍵へ積む。`keyOf` が `null` を返した区間は使わない。
 * 鍵は区間の先頭・中心・末尾（末尾の次のサンプル）の時刻から決める。
 *
 * まとまりは時刻で並べ直し、**先頭が前の末尾の次のサンプルの近くにあり、刻みが同じ（1% 以内）
 * なら繋ぐ**。それ以外（欠け・重なり・刻みの変化）で切る。
 */
function accumulateSegments(
  chunks: readonly PsdChunk[],
  keyOf: (startMs: number, centerMs: number, endMs: number) => number | null,
): Map<number, RebinSums> {
  const sorted = chunks
    .filter((c) => Number.isFinite(c.firstSampleMs) && Number.isFinite(c.msPerSample) && c.msPerSample > 0 && c.values.length > 0)
    .slice()
    .sort((a, b) => a.firstSampleMs - b.firstSampleMs)

  // 刻みが走ごとに違うと区画の重みも違うので、鍵ごとに「重み付きの和」を走の刻みごとに分けて持つ。
  const sums = new Map<number, RebinSums>()

  const flush = (run: PsdChunk[]): void => {
    let total = 0
    for (const c of run) total += c.values.length
    if (total < PSD_NFFT) return
    const x = new Float64Array(total)
    let at = 0
    for (const c of run) {
      for (let i = 0; i < c.values.length; i += 1) x[at + i] = c.values[i]!
      at += c.values.length
    }
    const ms = run[0]!.msPerSample
    const fs = 1000 / ms
    const rebin = rebinFor(fs)
    const start = run[0]!.firstSampleMs
    for (let from = 0; from + PSD_NFFT <= total; from += PSD_HOP) {
      const key = keyOf(start + from * ms, start + (from + PSD_NFFT / 2) * ms, start + (from + PSD_NFFT) * ms)
      if (key === null) continue
      // **値が有限でない区間は使わない**（FFT が全部の線を NaN にする）。
      let finite = true
      for (let i = 0; i < PSD_NFFT; i += 1) {
        if (!Number.isFinite(x[from + i]!)) {
          finite = false
          break
        }
      }
      if (!finite) continue
      let byRebin = sums.get(key)
      if (byRebin === undefined) {
        byRebin = new Map()
        sums.set(key, byRebin)
      }
      let s = byRebin.get(rebin)
      if (s === undefined) {
        s = { acc: new Float64Array(PSD_BIN_COUNT), segments: 0 }
        byRebin.set(rebin, s)
      }
      addSegment(x, from, fs, rebin, s.acc)
      s.segments += 1
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
      flush(run)
      run = []
    }
    run.push(c)
    runEnd = c.firstSampleMs + c.values.length * c.msPerSample
    // **継ぎ目の許容は「刻みの半分 ＋ まとまりの長さの 1%」。** 生データのレコードが名乗る刻みは公称
    // （100 Hz）で、実際の刻みは 0.16% ほど速い（実測 100.16 Hz）。5 秒のレコードの終わりを公称の刻みで
    // 見積もると 8 ms ずれ、刻みの半分（5 ms）だけでは継ぎ目の多くを欠けと取り違える
    // （評価台の 1 時間で、1 分あたりの区間が本来の 11 から 6 へ減っていた）。本物の欠けはパケット
    // 1 つぶん（約 0.3 秒）以上なので、この許容では詰めない。
    slack = c.msPerSample / 2 + c.values.length * c.msPerSample * 0.01
  }
  flush(run)
  return sums
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
