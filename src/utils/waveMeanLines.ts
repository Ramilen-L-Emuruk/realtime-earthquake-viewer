// 波形に重ねる「平均の線」の計算。**PWA の詳細の窓と、ホストの管理コンソールが同じものを読む。**
//
// - 合成の段の「前後を均した線」（`movingAverage`）
// - 成分の段の「正側・負側の平均の線」（`signedMovingAverages`）
//
// **何も読み込まない。** 管理コンソールも読むので、ここが画面側の部品を引き込むと、あちらの束にまで入る
// （`measuredIntensityRounding.ts` と同じ事情）。

/**
 * 平均を取る幅（ms）。**各時刻の前後 0.5 秒ずつ・計 1 秒**（2026-10-05 のユーザー判断。PWA の合成の均した線で決め、
 * 成分の平均の線も同じ幅にした）。小さな地震の S 波の山（数秒）は形が残り、ノイズのギザギザは消える。
 */
export const MEAN_LINE_WINDOW_MS = 1_000

/** 時刻の並び。**`t` は小さい順**（同じ添字の値と組で使う）。 */
export interface TimedPoints {
  readonly t: ArrayLike<number>
  readonly length: number
}

/**
 * 前後 `windowMs` の幅（各時刻を中心に）で値を平均した並び。**揺れの強さの輪郭**を見せるために使う。
 *
 * - 窓の中の値の無い点は数えない（平均は値のある点だけで取る）
 * - **元が `NaN` の点は `NaN` のまま** —— 途切れで線を切る扱いを均した線でも保つ
 *
 * 窓へ入った点を足し出た点を引くので、点の数に比例する手間で済む（作業用の配列も作らない）。
 */
export function movingAverage(series: TimedPoints, values: ArrayLike<number>, windowMs: number): Float32Array {
  const n = series.length
  const half = windowMs / 2
  const out = new Float32Array(n)
  // 窓へ入った点を足し、出た点を引く（累積の配列を作らない。管理コンソールは 100 ms ごとに描き直す）。
  let sum = 0
  let cnt = 0
  let lo = 0
  let hi = 0
  for (let i = 0; i < n; i += 1) {
    const t = series.t[i]
    while (hi < n && series.t[hi] <= t + half) {
      const v = values[hi]
      if (Number.isFinite(v)) {
        sum += v
        cnt += 1
      }
      hi += 1
    }
    while (lo < n && series.t[lo] < t - half) {
      const v = values[lo]
      if (Number.isFinite(v)) {
        sum -= v
        cnt -= 1
      }
      lo += 1
    }
    out[i] = !Number.isFinite(values[i]) || cnt === 0 ? Number.NaN : sum / cnt
  }
  return out
}

/**
 * 前後 `windowMs` の幅で、**正側に振れた値の平均と負側に振れた値の平均を別々に**出す（2026-10-05 のユーザー判断）。
 *
 * 成分は ＋ と − に行き来するので、値をそのまま平均すると 0 付近に潰れて揺れの大きさが消える。正側・負側に
 * 分けて平均すれば、ふつうの揺れでは 2 本がほぼ対称に並び、**片側に偏った動き（一方向のパルスや傾き）だけ
 * 2 本の高さが食い違う**。線は振れの頂点ではなく平均なので、山の頂点よりかなり内側を通る。
 *
 * **正負は 0 で分ける。** 重力の乗った値を渡すなら、呼び出し側が中心を引いてから渡す。
 *
 * - 0 ちょうどの値はどちらにも数えない。窓の中にその側の値が 1 つも無ければ 0
 * - **元が `NaN` の点は `NaN` のまま**（途切れで線を切る）
 *
 * @returns `pos` は 0 以上、`neg` は 0 以下
 */
export function signedMovingAverages(
  series: TimedPoints,
  values: ArrayLike<number>,
  windowMs: number,
): { readonly pos: Float32Array; readonly neg: Float32Array } {
  const n = series.length
  const half = windowMs / 2
  const pos = new Float32Array(n)
  const neg = new Float32Array(n)
  // 窓へ入った点を足し、出た点を引く（`movingAverage` と同じ）。
  let posSum = 0
  let posCnt = 0
  let negSum = 0
  let negCnt = 0
  const add = (v: number, sign: 1 | -1): void => {
    if (!Number.isFinite(v)) return
    if (v > 0) {
      posSum += sign * v
      posCnt += sign
    } else if (v < 0) {
      negSum += sign * v
      negCnt += sign
    }
  }
  let lo = 0
  let hi = 0
  for (let i = 0; i < n; i += 1) {
    const t = series.t[i]
    while (hi < n && series.t[hi] <= t + half) {
      add(values[hi], 1)
      hi += 1
    }
    while (lo < n && series.t[lo] < t - half) {
      add(values[lo], -1)
      lo += 1
    }
    if (!Number.isFinite(values[i])) {
      pos[i] = Number.NaN
      neg[i] = Number.NaN
      continue
    }
    pos[i] = posCnt === 0 ? 0 : posSum / posCnt
    neg[i] = negCnt === 0 ? 0 : negSum / negCnt
  }
  return { pos, neg }
}
