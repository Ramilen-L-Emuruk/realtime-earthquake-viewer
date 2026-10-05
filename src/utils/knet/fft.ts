// 高速フーリエ変換（基数 2・その場で書き換える）。
//
// **気象庁の計測震度のフィルタ（`seismicIntensity.ts`）のためにある。** 以前は `fft-js` を
// 使っていたが、複素数を `[re, im]` の配列で 1 つずつ持つ作りで、10 分ぶん（100 Hz・
// 2^16 点）の 3 成分に 1 秒あまりかかった。自作地震計のホストはイベントループが 1 秒止まると
// 「止まった」と記録する作り（`seismo-host/src/receiver/loopStall.ts`）なので、地震 1 件の
// 計測震度を出すたびにそれを踏む。型付き配列で持てば同じ計算が 1/10 ほどで済む
// （2026-10-04 の実測で 1 成分 432 ms → 37 ms。出力の差は最大 2.9e-13）。

/**
 * `re`・`im` をその場で変換する。**長さは 2 の冪に限る**（呼び出し側がゼロで詰める）。
 *
 * - 順変換は `X[k] = Σ x[t]·e^(−2πikt/n)`
 * - 逆変換は `x[t] = (1/n)·Σ X[k]·e^(+2πikt/n)`（1/n をここで掛ける）
 *
 * **2 の冪でない長さは投げる。** 基数 2 の手順は長さが合わないと、例外も出さずに
 * 誤った答えを返す。
 */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  if (im.length !== n) throw new Error(`実部と虚部の長さが違う: ${n}/${im.length}`)
  if (n === 0 || (n & (n - 1)) !== 0) throw new Error(`長さが 2 の冪でない: ${n}`)

  // ビット反転の並べ替え
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }

  const sign = inverse ? 1 : -1
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = (sign * 2 * Math.PI) / len
    for (let k = 0; k < half; k++) {
      // **回転因子は毎回 cos/sin から求める。** 掛け算で回し続けると、長い段ほど誤差が積もる。
      const wr = Math.cos(step * k)
      const wi = Math.sin(step * k)
      for (let i = k; i < n; i += len) {
        const j = i + half
        const tr = re[j] * wr - im[j] * wi
        const ti = re[j] * wi + im[j] * wr
        re[j] = re[i] - tr
        im[j] = im[i] - ti
        re[i] += tr
        im[i] += ti
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}
