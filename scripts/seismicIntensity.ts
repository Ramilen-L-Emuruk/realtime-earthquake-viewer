// 気象庁の計測震度算出アルゴリズム（平成8年気象庁告示第4号）の実装。
//
// 参考: https://www.jma.go.jp/jma/kishou/know/jishin/kyoshin/kaisetsu/calc_sindo.html
//   1. 3成分（NS/EW/UD）それぞれの加速度波形をFFTし、周期補正フィルターを掛けて逆FFTする
//   2. 3成分をベクトル合成する（sqrt(ns²+ew²+ud²)）
//   3. 合成加速度の絶対値がある値a以上となる時間の合計がちょうど0.3秒になるaを求める
//   4. I = 2*log10(a) + 0.94 で計測震度を得る
//
// このスクリプトはローカル限定のリプレイ用データ生成（capture-kyoshin-waveform.ts）でのみ使う
// オフライン処理で、気象庁の公式実装そのものではない。ウィンドウ処理（後述）を導入している時点で
// 「本物の強震モニタの計測値」ではなく「実波形から求めた近似的な連続震度」であることを認識すること。
// fft-jsはCommonJSパッケージ。named importだとNode本体のESMローダー（cjs-module-lexerの
// 静的解析）が named export を認識できず実行時に落ちる（vitestのVite変換では問題なく通るため
// テストでは気付けず、`npx tsx`で直接実行して初めて発覚した）。default importしてから
// 分割代入することで実行時解決に切り替え、この問題を避ける。
import fftJs from 'fft-js'
import type { Complex } from 'fft-js'
const { fft, ifft } = fftJs

/** 0.3秒基準で震度に変換する際の定数（気象庁告示式）。 */
const SINDO_LOG_COEFFICIENT = 2
const SINDO_OFFSET = 0.94
/** 継続時間0.3秒基準（気象庁告示式で固定値）。 */
const DURATION_THRESHOLD_SEC = 0.3

/** 次の2の冪を返す（n<=1なら1）。 */
function nextPowerOfTwo(n: number): number {
  if (n <= 1) return 1
  return 2 ** Math.ceil(Math.log2(n))
}

/**
 * 気象庁の周期補正フィルター（ローカット・ハイカット・周期効果の積）の振幅ゲインを返す。
 * f=0（直流成分）はゲイン0とする（周期効果フィルター 1/√f が発散するため。計測震度は
 * 周期的な地動を対象とし直流オフセットは物理的に意味を持たない）。
 */
export function jmaFilterGain(fHz: number): number {
  if (fHz <= 0) return 0
  const fl = Math.sqrt(1 - Math.exp(-((fHz / 0.5) ** 3)))
  const y = fHz / 10
  const y2 = y * y
  const fh = (1 + 0.694 * y2 + 0.241 * y2 ** 2 + 0.0557 * y2 ** 3
    + 0.009664 * y2 ** 4 + 0.00134 * y2 ** 5 + 0.000155 * y2 ** 6) ** -0.5
  const ff = Math.sqrt(1 / fHz)
  return fl * fh * ff
}

/**
 * 加速度波形（等間隔サンプル）に気象庁の周期補正フィルターを適用する。
 * 内部でFFTのため2の冪へゼロ詰めし、フィルター後に逆FFTして元の長さへ切り詰める。
 * 実信号のみを扱うため逆FFT結果の虚部は無視する（丸め誤差程度に収まる前提）。
 */
export function applyJmaFilter(samples: number[], sampleRateHz: number): number[] {
  const n = samples.length
  if (n === 0) return []
  const padded = nextPowerOfTwo(n)
  const input = new Array<number>(padded).fill(0)
  for (let i = 0; i < n; i++) input[i] = samples[i]

  const spectrum = fft(input)
  const filtered: Complex[] = spectrum.map(([re, im], k) => {
    // 実信号のFFTは N-k 側に共役対称の周波数成分が現れる（負周波数相当）。
    // フィルターは周波数の絶対値に対して定義されているため、|f| を使う。
    const kMirror = k <= padded / 2 ? k : padded - k
    const f = (kMirror * sampleRateHz) / padded
    const gain = jmaFilterGain(f)
    return [re * gain, im * gain]
  })
  const restored = ifft(filtered)
  return restored.slice(0, n).map(([re]) => re)
}

/** 3成分の加速度波形をベクトル合成する。長さが揃っていない場合は最短に合わせる。 */
export function synthesize3Components(ns: number[], ew: number[], ud: number[]): number[] {
  const len = Math.min(ns.length, ew.length, ud.length)
  const out = new Array<number>(len)
  for (let i = 0; i < len; i++) {
    out[i] = Math.sqrt(ns[i] * ns[i] + ew[i] * ew[i] + ud[i] * ud[i])
  }
  return out
}

/**
 * フィルター済み・合成済みの加速度波形（gal, 非負）から計測震度を算出する。
 * 「絶対値がある値a以上となる時間の合計が0.3秒になるa」を、降順ソートして
 * `floor(0.3/dt)-1` 番目の値を取ることで求める（合成加速度は sqrt(...) により非負のため
 * 絶対値を取る必要はない）。
 *
 * データ長が0.3秒に満たない場合はnull（震度を確定できない）。
 */
export function calcSeismicIntensityFromSynthesized(synthesized: number[], sampleRateHz: number): number | null {
  const dt = 1 / sampleRateHz
  const idx = Math.floor(DURATION_THRESHOLD_SEC / dt) - 1
  if (idx < 0 || idx >= synthesized.length) return null
  const sorted = [...synthesized].sort((a, b) => b - a)
  const a = sorted[idx]
  if (!(a > 0)) return null
  return SINDO_LOG_COEFFICIENT * Math.log10(a) + SINDO_OFFSET
}

/** 3成分の加速度波形（同一サンプリング周波数・同一長）から単発の計測震度を算出する。 */
export function calcSeismicIntensity(
  ns: number[],
  ew: number[],
  ud: number[],
  sampleRateHz: number,
): number | null {
  const filteredNs = applyJmaFilter(ns, sampleRateHz)
  const filteredEw = applyJmaFilter(ew, sampleRateHz)
  const filteredUd = applyJmaFilter(ud, sampleRateHz)
  const synthesized = synthesize3Components(filteredNs, filteredEw, filteredUd)
  return calcSeismicIntensityFromSynthesized(synthesized, sampleRateHz)
}

export interface IntensityTimeSeriesOptions {
  /** スライディングウィンドウの長さ（秒）。 */
  windowSec: number
  /** ウィンドウを進める間隔（秒）。 */
  stepSec: number
}

export interface IntensityTimeSeriesPoint {
  /** 波形先頭からの経過秒（ウィンドウ終端の時刻）。 */
  tSec: number
  /** 計測震度。ウィンドウ内のデータが0.3秒に満たない場合はnull。 */
  intensity: number | null
}

/**
 * 巡回畳み込み（FFTベースのフィルタリング）の境界劣化を避けるため、解析ウィンドウの終端を
 * 報告時刻より未来へずらす先読みマージン（秒）。`applyJmaFilter`はブロック（ウィンドウ）の
 * 両端付近で精度が落ちる（`seismicIntensity.test.ts`の「端点のゼロ詰め・エッジ効果があるため
 * 中央区間だけで比較する」参照）。ウィンドウの終端をそのまま報告時刻にすると、直近1秒に
 * 現れる急激な立ち上がり（＝最も見たい瞬間）がその劣化域に重なる。オフラインバッチ処理で
 * 波形全体を先に持っているため、未来のデータを少し混ぜて報告点を境界から遠ざける
 * （記録の末尾数秒だけは先読み分の未来データが無く、この緩和が効かない）。
 */
const EDGE_MARGIN_SEC = 2

/**
 * 3成分の加速度波形からスライディングウィンドウで計測震度の時系列を算出する。
 *
 * 気象庁の実際の計測震度計はIIRフィルタによる真の連続処理で遅延が無いが、ここではオフライン
 * バッチ処理のため、各時刻ごとに直近 `windowSec` 秒（記録冒頭に限り取得可能な範囲）を切り出して
 * 毎回FFT→フィルター→逆FFTをやり直す近似で代用する。ウィンドウが短いほど追従が速く、長いほど
 * 0.3秒基準の統計が安定する（レプリカとしての見栄えを優先したトレードオフであり、公式の計測震度計と
 * 数値が一致することは保証しない）。
 */
export function computeIntensityTimeSeries(
  ns: number[],
  ew: number[],
  ud: number[],
  sampleRateHz: number,
  opts: IntensityTimeSeriesOptions,
): IntensityTimeSeriesPoint[] {
  const len = Math.min(ns.length, ew.length, ud.length)
  const windowSamples = Math.round(opts.windowSec * sampleRateHz)
  const stepSamples = Math.max(1, Math.round(opts.stepSec * sampleRateHz))
  const marginSamples = Math.round(EDGE_MARGIN_SEC * sampleRateHz)
  const points: IntensityTimeSeriesPoint[] = []

  for (let end = stepSamples; end <= len; end += stepSamples) {
    const analysisEnd = Math.min(len, end + marginSamples)
    const start = Math.max(0, analysisEnd - windowSamples)
    const slice = (arr: number[]) => arr.slice(start, analysisEnd)
    const intensity = calcSeismicIntensity(slice(ns), slice(ew), slice(ud), sampleRateHz)
    points.push({ tSec: end / sampleRateHz, intensity })
  }
  return points
}
