// 「波形の記録」の周波数とノイズの段の当て方（#621 段 g）。描くのは `viewRecords.ts`。
// **段の作りと文言は 2026-10-08 ユーザー承認。**
//
// - **ノイズ水準の推移**: 1 秒より速い揺れの RMS を、見えている軸ぶん 1 枚の段に重ねる（縦は対数）。
//   10 分より広い範囲は要約の `noiseStd`、10 分以内は取ってある生のサンプルから 1 秒ごとに出す（同じ定義）
// - **スペクトログラム**: 軸ごとに 1 段。縦は周波数（0.1〜50 Hz を対数）、色は PSD の dB。色の物差しは段どうしで共通
// - **範囲のスペクトル**: 横は周波数・縦は dB。Peterson（1993）の低ノイズ・高ノイズのモデルを破線で重ねる
//
// **dB は 0 dB = 1 (m/s²)²/Hz**（地震計のノイズの資料と同じ基準。2026-10-08 ユーザー承認）。生の値（カウント）の
// ときは 0 dB = 1 カウント²/Hz で、モデルの線は出さない（単位が違うので比べられない）。

import { readFinite, readFiniteArray, readFiniteArrayWithGaps } from './readJson'
import {
  durationLabel,
  readIrregularHours,
  readProblems,
  readUnit,
  unitText,
  type IrregularHourView,
  type ReadProblemsView,
  type SampleRunView,
  type TimeRange,
  type ValueUnit,
} from './recordsPlot'

/** 周波数の軸の下端・上端（ホストの PSD の区画の端と同じ）。 */
export const FREQ_MIN_HZ = 0.1
export const FREQ_MAX_HZ = 50

/** 1 gal² = 1e-4 (m/s²)²。 */
const GAL2_TO_MS2 = 1e-4

/** PSD を dB へ。**gal²/Hz は (m/s²)²/Hz へ直してから**（0 dB = 1 (m/s²)²/Hz）。0 以下・有限でない値は NaN。 */
export function psdToDb(power: number, unit: ValueUnit): number {
  if (!Number.isFinite(power) || power <= 0) return Number.NaN
  return 10 * Math.log10(unit === 'gal' ? power * GAL2_TO_MS2 : power)
}

// ---- Peterson（1993）のノイズのモデル -------------------------------------------------------

/** `[周期の帯の下端（秒）, A, B]`。帯の中では `A + B log10(P)` dB（0 dB = 1 (m/s²)²/Hz）。 */
export type NoiseModel = readonly (readonly [number, number, number])[]

/**
 * 低ノイズのモデル（NLNM）。**出典: Peterson, J. (1993), Observations and modeling of seismic background noise,
 * U.S. Geological Survey Open-File Report 93-322, Table 3**（加速度・最後の帯は 100000 秒まで）。
 */
export const NLNM: NoiseModel = [
  [0.1, -162.36, 5.64],
  [0.17, -166.7, 0],
  [0.4, -170.0, -8.3],
  [0.8, -166.4, 28.9],
  [1.24, -168.6, 52.48],
  [2.4, -159.98, 29.81],
  [4.3, -141.1, 0],
  [5.0, -71.36, -99.77],
  [6.0, -97.26, -66.49],
  [10.0, -132.18, -31.57],
  [12.0, -205.27, 36.16],
  [15.6, -37.65, -104.33],
  [21.9, -114.37, -47.1],
  [31.6, -160.58, -16.28],
  [45.0, -187.5, 0],
  [70.0, -216.47, 15.7],
  [101.0, -185.0, 0],
  [154.0, -168.34, -7.61],
  [328.0, -217.43, 11.9],
  [600.0, -258.28, 26.6],
  [10000.0, -346.88, 48.75],
]

/** 高ノイズのモデル（NHNM）。**出典は同じ報告書の Table 4**（加速度・最後の帯は 100000 秒まで）。 */
export const NHNM: NoiseModel = [
  [0.1, -108.73, -17.23],
  [0.22, -150.34, -80.5],
  [0.32, -122.31, -23.87],
  [0.8, -116.85, 32.51],
  [3.8, -108.48, 18.08],
  [4.6, -74.66, -32.95],
  [6.3, 0.66, -127.18],
  [7.9, -93.37, -22.42],
  [15.4, 73.54, -162.98],
  [20.0, -151.52, 10.01],
  [354.8, -206.66, 31.63],
]

/** 表の最後の帯の上端（秒）。 */
const NOISE_MODEL_MAX_PERIOD_S = 100_000

/** 周期 `periodS` 秒でのモデルの値（dB）。表の外（0.1 秒より短い・100000 秒以上）は NaN。 */
export function noiseModelDb(model: NoiseModel, periodS: number): number {
  if (!Number.isFinite(periodS) || periodS < model[0]![0] || periodS >= NOISE_MODEL_MAX_PERIOD_S) return Number.NaN
  let row = model[0]!
  for (const r of model) {
    if (r[0] > periodS) break
    row = r
  }
  return row[1] + row[2] * Math.log10(periodS)
}

/** `fromHz`〜`toHz` を対数で `steps` 等分した点のうち、モデルの表に入る点だけ（周波数の小さい順）。 */
export function noiseModelCurve(model: NoiseModel, fromHz: number, toHz: number, steps: number): { readonly hz: number; readonly db: number }[] {
  const out: { hz: number; db: number }[] = []
  const lo = Math.log10(fromHz)
  const hi = Math.log10(toHz)
  for (let i = 0; i <= steps; i += 1) {
    const hz = 10 ** (lo + ((hi - lo) * i) / steps)
    const db = noiseModelDb(model, 1 / hz)
    if (Number.isFinite(db)) out.push({ hz, db })
  }
  // 区画の境目に近い点が丸めで外れることがあるので、表の短い側の端（10 Hz）を必ず含める。
  const edgeHz = 1 / model[0]![0]
  if (edgeHz >= fromHz && edgeHz <= toHz && (out.length === 0 || Math.abs(out[out.length - 1]!.hz - edgeHz) > 1e-9)) {
    out.push({ hz: edgeHz, db: noiseModelDb(model, model[0]![0]) })
  }
  return out
}

// ---- 応答を読む ------------------------------------------------------------------------------

export interface SpectrumData {
  readonly source: 'samples' | 'minutes'
  readonly unit: ValueUnit
  /** 区画の境目（区画の数 ＋ 1 本）。 */
  readonly binEdgesHz: readonly number[]
  /** 測れない区画は NaN。 */
  readonly power: readonly number[]
  /** 平均した区間（約 10 秒）の数。 */
  readonly segments: number
  readonly problems: ReadProblemsView
}

function readEdges(v: unknown): readonly number[] | null {
  const edges = readFiniteArray(v)
  if (edges === null || edges.length < 2) return null
  for (let i = 1; i < edges.length; i += 1) if (!(edges[i]! > edges[i - 1]!)) return null
  return edges
}

/** `spectrum` の応答を読む。**1 か所でも形が違えば null。** */
export function readSpectrumData(value: unknown): SpectrumData | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const source = v.source === 'samples' || v.source === 'minutes' ? v.source : null
  const unit = readUnit(v.unit)
  const binEdgesHz = readEdges(v.binEdgesHz)
  const power = readFiniteArrayWithGaps(v.power)
  const segments = readFinite(v.segments)
  const problems = readProblems(v.problems)
  if (source === null || unit === null || binEdgesHz === null || power === null || segments === null || problems === null) return null
  if (power.length !== binEdgesHz.length - 1) return null
  return { source, unit, binEdgesHz, power, segments, problems }
}

export interface SpectrogramData {
  readonly source: 'samples' | 'minutes'
  readonly unit: ValueUnit
  readonly binEdgesHz: readonly number[]
  readonly columnMs: number
  readonly firstColumnMs: number
  /** 列ごとの区間の数。0 の列は作れなかった。 */
  readonly segments: readonly number[]
  /** `[列][区画]`。測れない升は NaN。 */
  readonly power: readonly (readonly number[])[]
  readonly irregularHours: readonly IrregularHourView[]
  readonly problems: ReadProblemsView
}

/** `spectrogram` の応答を読む。**1 か所でも形が違えば null。** */
export function readSpectrogramData(value: unknown): SpectrogramData | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const source = v.source === 'samples' || v.source === 'minutes' ? v.source : null
  const unit = readUnit(v.unit)
  const binEdgesHz = readEdges(v.binEdgesHz)
  const columnMs = readFinite(v.columnMs)
  const firstColumnMs = readFinite(v.firstColumnMs)
  const segments = readFiniteArray(v.segments)
  const irregularHours = readIrregularHours(v.irregularHours)
  const problems = readProblems(v.problems)
  if (source === null || unit === null || binEdgesHz === null || columnMs === null || columnMs <= 0 || firstColumnMs === null) return null
  if (segments === null || irregularHours === null || problems === null || !Array.isArray(v.power) || v.power.length !== segments.length) return null
  const power: (readonly number[])[] = []
  for (const row of v.power) {
    const r = readFiniteArrayWithGaps(row)
    if (r === null || r.length !== binEdgesHz.length - 1) return null
    power.push(r)
  }
  return { source, unit, binEdgesHz, columnMs, firstColumnMs, segments, power, irregularHours, problems }
}

// ---- 周波数の軸と色 ------------------------------------------------------------------------

/**
 * 周波数の入る区画（`[edges[b], edges[b+1])`。**最後の区画だけ上端を含む** —— 枠の右端・上端ちょうどを
 * 指すと上端の周波数になるので、そこで読み取りが消えないように）。範囲の外は -1。
 */
export function binAt(edges: readonly number[], hz: number): number {
  const last = edges.length - 2
  for (let b = 0; b <= last; b += 1) {
    if (hz >= edges[b]! && (hz < edges[b + 1]! || (b === last && hz === edges[b + 1]!))) return b
  }
  return -1
}

/** 周波数を縦の位置へ（下端が {@link FREQ_MIN_HZ}、上端が {@link FREQ_MAX_HZ}・対数）。 */
export function yOfHz(hz: number, height: number): number {
  const t = (Math.log10(hz) - Math.log10(FREQ_MIN_HZ)) / (Math.log10(FREQ_MAX_HZ) - Math.log10(FREQ_MIN_HZ))
  return height * (1 - t)
}

/** {@link yOfHz} の逆。 */
export function hzOfY(y: number, height: number): number {
  const t = 1 - y / height
  return 10 ** (Math.log10(FREQ_MIN_HZ) + t * (Math.log10(FREQ_MAX_HZ) - Math.log10(FREQ_MIN_HZ)))
}

/** 周波数を横の位置へ（左端が {@link FREQ_MIN_HZ}・対数）。範囲のスペクトルの枠で使う。 */
export function xOfHz(hz: number, width: number): number {
  return width - yOfHz(hz, width)
}

/** {@link xOfHz} の逆。 */
export function hzOfX(x: number, width: number): number {
  return hzOfY(width - x, width)
}

export interface DbRange {
  readonly lo: number
  readonly hi: number
}

/** 色の物差しの刻み（dB）。 */
const DB_STEP = 5
/** 色の物差しの最小の幅（dB）。 */
const DB_MIN_SPAN = 10
/** 外れ値として外す割合（下から・上から）。 */
const DB_OUTLIER_FRACTION = 0.02

/**
 * 色の物差しの範囲。**下から 2%・上から 2% を外し**（揺れた瞬間の 1 升で物差しが潰れないように）、
 * 5 dB に丸めて外へ広げる。幅は 10 dB 以上。値が 1 つも無ければ null。
 */
export function dbRange(values: Iterable<number>): DbRange | null {
  const sorted: number[] = []
  for (const v of values) if (Number.isFinite(v)) sorted.push(v)
  if (sorted.length === 0) return null
  sorted.sort((a, b) => a - b)
  const n = sorted.length
  let lo = Math.floor(sorted[Math.floor(DB_OUTLIER_FRACTION * (n - 1))]! / DB_STEP) * DB_STEP
  let hi = Math.ceil(sorted[Math.ceil((1 - DB_OUTLIER_FRACTION) * (n - 1))]! / DB_STEP) * DB_STEP
  if (hi - lo < DB_MIN_SPAN) {
    const center = (lo + hi) / 2
    lo = Math.floor((center - DB_MIN_SPAN / 2) / DB_STEP) * DB_STEP
    hi = Math.ceil((center + DB_MIN_SPAN / 2) / DB_STEP) * DB_STEP
  }
  return { lo, hi }
}

/** 範囲のスペクトルの縦の範囲の刻み（dB）。 */
const DB_AXIS_STEP = 10

/**
 * 範囲のスペクトルの縦の範囲。**外れ値は外さない**（区画が 40 本しかなく、モデルの線の端も入れたいので）。
 * 10 dB に丸めて外へ広げ、同じ値だけなら上下に 10 dB ずつ空ける。値が 1 つも無ければ null。
 */
export function dbExtent(values: Iterable<number>): DbRange | null {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const v of values) {
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (min > max) return null
  let lo = Math.floor(min / DB_AXIS_STEP) * DB_AXIS_STEP
  let hi = Math.ceil(max / DB_AXIS_STEP) * DB_AXIS_STEP
  if (hi === lo) {
    lo -= DB_AXIS_STEP
    hi += DB_AXIS_STEP
  }
  return { lo, hi }
}

/** 色の並び（viridis の 9 点。下端が濃い紫、上端が黄色）。明るさが単調に増えるので、色覚によらず大小が読める。 */
const COLOR_STOPS: readonly (readonly [number, number, number])[] = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 73, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [110, 206, 88],
  [253, 231, 37],
]

/** 色の物差しの帯（CSS の `background`）。 */
export function colorScaleCss(): string {
  return `linear-gradient(to right, ${COLOR_STOPS.map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`).join(', ')})`
}

/** dB を色へ。範囲の外は端の色に留める。値が無ければ null（その升は描かない）。 */
export function colorOfDb(db: number, range: DbRange): [number, number, number] | null {
  if (!Number.isFinite(db)) return null
  const t = Math.min(1, Math.max(0, (db - range.lo) / (range.hi - range.lo)))
  const pos = t * (COLOR_STOPS.length - 1)
  const i = Math.min(COLOR_STOPS.length - 2, Math.floor(pos))
  const f = pos - i
  const a = COLOR_STOPS[i]!
  const b = COLOR_STOPS[i + 1]!
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)]
}

// ---- ノイズ水準 ----------------------------------------------------------------------------

/** ノイズ水準の列（列の頭の時刻と幅、値は RMS。値の無い列は NaN）。 */
export interface NoiseSeries {
  readonly columnMs: number
  readonly firstColumnMs: number
  readonly values: readonly number[]
}

/** 要約の列から（`noiseStd` は 1 秒より速い揺れの強さ）。 */
export function noiseOfEnvelopeColumns(e: { readonly columnMs: number; readonly firstColumnMs: number; readonly noiseStd: readonly number[] }): NoiseSeries {
  return { columnMs: e.columnMs, firstColumnMs: e.firstColumnMs, values: e.noiseStd }
}

const SECOND_MS = 1000

/**
 * 生のサンプルから 1 秒ごとの RMS（**その 1 秒の平均を引いたばらつき**。ホストの要約の 1 秒の段と同じ定義）。
 * サンプルが 2 つ未満の秒は NaN。範囲の外のサンプル・有限でない値は数えない。
 */
export function secondRms(runs: readonly SampleRunView[], range: TimeRange): NoiseSeries {
  const first = Math.floor(range.fromMs / SECOND_MS)
  const count = Math.max(0, Math.floor((range.toMs - 1) / SECOND_MS) - first + 1)
  const n = new Float64Array(count)
  const mean = new Float64Array(count)
  const m2 = new Float64Array(count)
  for (const r of runs) {
    for (let i = 0; i < r.values.length; i += 1) {
      const t = r.firstSampleMs + i * r.msPerSample
      if (t < range.fromMs || t >= range.toMs) continue
      const x = r.values[i]!
      if (!Number.isFinite(x)) continue
      const j = Math.floor(t / SECOND_MS) - first
      if (j < 0 || j >= count) continue
      // Welford の式（1 秒の中の平均とばらつきを 1 回で）。
      n[j] = n[j]! + 1
      const d = x - mean[j]!
      mean[j] = mean[j]! + d / n[j]!
      m2[j] = m2[j]! + d * (x - mean[j]!)
    }
  }
  const values = Array.from({ length: count }, (_, j) => (n[j]! >= 2 ? Math.sqrt(m2[j]! / n[j]!) : Number.NaN))
  return { columnMs: SECOND_MS, firstColumnMs: first * SECOND_MS, values }
}

/** 段の縦の範囲（正の値の最小・最大）。**0 以下と NaN は対数の縦に置けないので数えない。** 値が無ければ null。 */
export function noiseRange(series: readonly NoiseSeries[]): { readonly min: number; readonly max: number } | null {
  let min = Number.POSITIVE_INFINITY
  let max = 0
  for (const s of series) {
    for (const v of s.values) {
      if (!Number.isFinite(v) || v <= 0) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  return max > 0 ? { min, max } : null
}

// ---- 文言（2026-10-08 ユーザー承認） ------------------------------------------------------

export const NOISE_TITLE = 'ノイズ水準の推移'
export const SPECTRUM_TITLE = 'いま映している範囲のスペクトル'
export const SPECTRUM_EMPTY_TEXT = 'この範囲には約 10 秒続いた記録が無く、スペクトルを出せない'
export const NOISE_MODEL_LEGEND = '破線: Peterson の低ノイズ・高ノイズのモデル（NLNM・NHNM）'

/** ノイズの値（有効数字 2 桁。静かなときの `0.012` を `0.01` へ潰さない）。 */
export function formatNoise(v: number): string {
  return v >= 100 ? v.toFixed(0) : v.toPrecision(2)
}

/** ノイズの段の見出しの右（`1 秒より速い揺れの RMS（縦は対数）　0.012〜0.85 gal`）。 */
export function noiseHeader(r: { readonly min: number; readonly max: number }, unit: ValueUnit): string {
  return `1 秒より速い揺れの RMS（縦は対数）　${formatNoise(r.min)}〜${formatNoise(r.max)} ${unitText(unit)}`
}

export function spectrogramTitle(axisLabel: string): string {
  return `スペクトログラム ${axisLabel}`
}

/** スペクトログラムの段の見出しの右（`0.1〜50 Hz（縦は対数）・列の幅 1 分`）。 */
export function spectrogramHeader(columnMs: number): string {
  return `0.1〜50 Hz（縦は対数）・列の幅 ${durationLabel(columnMs)}`
}

/** dB の値（整数・負号は `−`）。 */
export function formatDb(db: number): string {
  return String(Math.round(db)).replace('-', '−')
}

/** 色の物差し（`色: −150〜−90 dB（0 dB = 1 (m/s²)²/Hz）`）。 */
export function dbScaleText(r: DbRange, unit: ValueUnit): string {
  const ref = unit === 'gal' ? '1 (m/s²)²/Hz' : '1 カウント²/Hz'
  return `色: ${formatDb(r.lo)}〜${formatDb(r.hi)} dB（0 dB = ${ref}）`
}

/** 範囲のスペクトルの枠の見出しの右（`約 10 秒の区間 58 本の平均（生のサンプルから）`）。 */
export function spectrumHeader(segments: number, source: 'samples' | 'minutes'): string {
  return `約 10 秒の区間 ${segments} 本の平均（${source === 'samples' ? '生のサンプルから' : '1 分ごとの PSD から'}）`
}

function formatHz(hz: number): string {
  return hz >= 100 ? hz.toFixed(0) : hz.toPrecision(2)
}

function dbItems(items: readonly { readonly short: string; readonly db: number }[]): string | null {
  const parts = items.filter((i) => Number.isFinite(i.db)).map((i) => `${i.short} ${formatDb(i.db)} dB`)
  return parts.length === 0 ? null : parts.join('・')
}

/** 範囲のスペクトルで指した所（`2.4 Hz（周期 0.42 秒）　X −112 dB・Y −115 dB`）。どの軸にも値が無ければ null。 */
export function spectrumReadout(hz: number, items: readonly { readonly short: string; readonly db: number }[]): string | null {
  const values = dbItems(items)
  return values === null ? null : `${formatHz(hz)} Hz（周期 ${(1 / hz).toPrecision(2)} 秒）　${values}`
}

/** スペクトログラムで指した所（`2.4 Hz　X −112 dB・Y −115 dB`）。どの軸にも値が無ければ null。 */
export function spectrogramReadout(hz: number, items: readonly { readonly short: string; readonly db: number }[]): string | null {
  const values = dbItems(items)
  return values === null ? null : `${formatHz(hz)} Hz　${values}`
}
