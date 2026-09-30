// パケットが名乗る時刻の列へ直線を当てはめる。
//
// **1 パケットに 1 つの目印（アンカー）しか無い。** 基板は FIFO を抜き出した瞬間の
// 時刻から先頭サンプルの時刻を逆算して送ってくるので、抜き出しの間隔が揺れた分だけ
// その値も揺れる。1 つの値をそのまま信じると、区間ごとに数ミリ秒ずれた時間軸ができる。
// 直線を通せばその揺れは平均され、**別々の区間が同じ絶対時刻の上に乗る**。
//
// **素朴な正規方程式で書かないこと。** `Σx`・`Σx²` をそのまま貯めて
// `(nΣxy − ΣxΣy) / (nΣx² − (Σx)²)` を解く形は、分子も分母も「大きな値どうしの引き算」に
// なるため、区間が長いほど有効桁を失う。ここでは平均を保ちながら偏差の積だけを貯める
// （Welford の共分散更新）。**引き算が偏差の計算に閉じるので、桁落ちが起きない。**
//
// 時刻は unix ミリ秒（約 1.79×10¹²）で入ってくるが、平均を先に引く形なので
// 呼び出す側で基準時刻を引いておく必要は無い。

/** 当てはめた直線。値を読む前に必ず `usable` を見ること。 */
export interface LineFit {
  /** 使ったアンカーの数。 */
  readonly count: number
  /**
   * 傾き。**`usable` が偽のときは意味を持たない**（アンカーが 1 つ以下か、
   * 全部が同じ位置にある）。
   */
  readonly slope: number
  /** 切片。同じく `usable` が偽なら意味を持たない。 */
  readonly intercept: number
  /**
   * 残差の二乗平均平方根。**ばらつきの目安であって誤差の保証ではない** ——
   * 抜き出しの遅れが片側へ偏っていれば、残差が小さくても直線ごとずれている。
   * `numpy` の `std()` と同じく n で割る（n−2 ではない）ので、offline の解析と
   * 突き合わせられる。
   */
  readonly residualRms: number
  /** 傾きと切片を読んでよいか。 */
  readonly usable: boolean
}

/**
 * アンカーを 1 つずつ足しながら当てはめを保つ。
 *
 * **区間が閉じるのを待たない。** 受信しながら計測震度を出す以上、いま持っている
 * アンカーだけで時間軸を答えられる必要がある。
 */
export class IncrementalLineFit {
  private n = 0
  private meanX = 0
  private meanY = 0
  /** Σ(x−x̄)² */
  private cxx = 0
  /** Σ(x−x̄)(y−ȳ) */
  private cxy = 0
  /** Σ(y−ȳ)² */
  private cyy = 0

  add(x: number, y: number): void {
    this.n += 1
    const dx = x - this.meanX
    const dy = y - this.meanY
    this.meanX += dx / this.n
    this.meanY += dy / this.n
    // **更新後の平均を使うこと。** 更新前の平均で掛けると別の量になる。
    this.cxx += dx * (x - this.meanX)
    this.cxy += dx * (y - this.meanY)
    this.cyy += dy * (y - this.meanY)
  }

  get count(): number {
    return this.n
  }

  result(): LineFit {
    // **`cxx` が 0 なら傾きは決まらない。** アンカーが 1 つのときと、
    // 同じ位置のアンカーばかりのとき（起こりえないが、起きても落ちない形にする）。
    if (this.n < 2 || this.cxx <= 0) {
      return { count: this.n, slope: NaN, intercept: NaN, residualRms: NaN, usable: false }
    }
    const slope = this.cxy / this.cxx
    const intercept = this.meanY - slope * this.meanX
    // 残差平方和 = Σ(y−ȳ)² − 傾き×Σ(x−x̄)(y−ȳ)。
    // 丸めで僅かに負へ落ちることがあるので 0 で止める。
    const sse = Math.max(0, this.cyy - slope * this.cxy)
    return {
      count: this.n,
      slope,
      intercept,
      residualRms: Math.sqrt(sse / this.n),
      usable: Number.isFinite(slope) && Number.isFinite(intercept),
    }
  }
}
