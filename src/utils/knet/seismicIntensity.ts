// 気象庁の計測震度算出アルゴリズム（平成8年気象庁告示第4号）の実装。
//
// 参考: https://www.jma.go.jp/jma/kishou/know/jishin/kyoshin/kaisetsu/calc_sindo.html
//   1. 3成分（NS/EW/UD）それぞれの加速度波形をFFTし、周期補正フィルターを掛けて逆FFTする
//   2. 3成分をベクトル合成する（sqrt(ns²+ew²+ud²)）
//   3. 合成加速度の絶対値がある値a以上となる時間の合計がちょうど0.3秒になるaを求める
//   4. I = 2*log10(a) + 0.94 で計測震度を得る
//
// 記録全体へ 1 回当てて、その地震の計測震度を出すための実装（気象庁の公式実装そのものではない）。
// **時々刻々の震度（強震モニタと同じリアルタイム震度）はここではなく `realtimeIntensity.ts` が出す。**
// 周波数領域のフィルタは記録全体を要するので、届いた順に値を出す用途には向かない。
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
export const DURATION_THRESHOLD_SEC = 0.3

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
 * 0.3秒の継続時間を測るために見る位置（降順に並べたときの添字）。
 *
 * **ストリーミング処理（`seismo-host/`）が窓の下限を決めるのにも使う単一情報源。**
 * 同じ境界を2つの式で書くと、サンプリング周波数を変えたときに片方だけ古くなる
 * （`0.3 * hz` と書き換えたくなるが、丸めの経路が変わるため式はこのまま保つ）。
 */
export function durationThresholdIndex(sampleRateHz: number): number {
  const dt = 1 / sampleRateHz
  return Math.floor(DURATION_THRESHOLD_SEC / dt) - 1
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
  const idx = durationThresholdIndex(sampleRateHz)
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

/**
 * 震度を時系列で出すときの刻み（秒）。
 *
 * **計算と同じ場所に置く。** K-NET取り込み（`buildEventResultFromZip.ts`）と自作センサーの
 * 受け手（`seismo-host/src/receiver/`）が共有する——どちらの値も最後は同じ画面へ並ぶので、
 * 物差しが違えば「揺れ方の違い」と「測り方の違い」を見分けられない。取得経路のどちらかに
 * 置くともう片方がそこへ引きに行くことになり、Nodeで動く受け手の型検査へブラウザ専用の
 * コードが入り込む。
 *
 * `STEP_SEC_DEFAULT`は`kyoshinLocalArchiveSource.ts`の`getMergedKyoshinArchive`呼び出しにも
 * 使われる——インポート時に刻んだ秒間隔とマージ時に読み出す秒間隔がずれると、`buildEventFrames`
 * （厳密なepoch秒の完全一致ルックアップ、補間なし）が該当秒を「データ無し」とみなし、
 * 震度データが無警告で欠測（-1）扱いに化けるため、必ず同じ定数を使うこと。
 *
 * **時系列の震度そのものは `realtimeIntensity.ts`（強震モニタと同じ方式）が出す。** この
 * ファイルが持つ気象庁の手順は、記録全体へ 1 回当てて「その地震の計測震度」を出す用途。
 */
export const STEP_SEC_DEFAULT = 1

/**
 * 秒をサンプル数へ直す。
 *
 * **バッチ処理（`realtimeIntensity.ts` の `computeRealtimeIntensityTimeSeries`）と、届いたそばから
 * 計算するストリーミング処理（`seismo-host/`）で同じ刻みを返すための単一情報源。** 両者が厳密に
 * 一致することは後者の要件で、その一致は丸め方が揃っていることに依存している。
 */
export function samplesForSeconds(sec: number, sampleRateHz: number): number {
  return Math.round(sec * sampleRateHz)
}

/** ウィンドウを進める幅。0サンプルでは前に進まないので最低1とする。 */
export function stepSamplesForSeconds(sec: number, sampleRateHz: number): number {
  return Math.max(1, samplesForSeconds(sec, sampleRateHz))
}
