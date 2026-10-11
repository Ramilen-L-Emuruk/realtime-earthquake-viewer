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
// 時刻は unix ミリ秒（約 1.79×10¹²）で入ってくるが、中で最初のアンカーを原点にして差だけを
// 持つので、呼び出す側で基準時刻を引いておく必要は無い。**原点を引くのは忘れる当てはめのため** ——
// 重みが整数でなくなると、1.79×10¹² の桁のまま平均を持つ丸め（1 ulp ≈ 0.24 µs）が傾きへ漏れる。
//
// **古いアンカーほど軽くできる**（{@link IncrementalLineFit} の `forgetAfterX`）。サンプルを刻む
// 発振器の速さは温度で動くので、何時間も続く区間を 1 本の直線で通すと、直線と実際の時刻が
// 離れていく。2026-10-11 の実機では IIS2ICLX の間隔が一晩で約 200 ppm 動き、区間全体の直線からの
// ずれが最大 ±1.5 秒になった（合成の待ち 0.6 秒を超え、MPU6050 の分が丸ごと合成から落ちた）。
// 重みを `x` の離れ方に応じて指数的に減らせば、直線は直近の速さに沿って動き続ける。

/** 当てはめた直線。値を読む前に必ず `usable` を見ること。 */
export interface LineFit {
  /** 足したアンカーの数（忘れた分も含めた通算）。 */
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
   * 突き合わせられる。**忘れる当てはめでは重みの合計で割る**（直近のばらつきになる）。
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
 *
 * `forgetAfterX` は重みが 1/e になる `x` の離れ（時定数）。**`Infinity` なら忘れない**（全アンカーが
 * 同じ重み）。**省略させない** —— 渡し忘れると黙って忘れない当てはめになり、長い区間でまた
 * 時刻がずれる。
 *
 * **`x` は増える順に足すこと。** 重みは「最後に足した `x` からどれだけ進んだか」で減らすので、
 * 戻った `x` では減らさない（区間の組み立ては通し番号の戻ったパケットを受理しない）。
 *
 * **`x` も `y` も有限の値だけを渡すこと。** 1 度でも `NaN` を足すと平均が `NaN` になり、区間が閉じるまで
 * `usable` が偽のまま戻らない。いまの呼び出し元（`segmenter.ts`）が渡す時刻は、パケットを読む段
 * （`parsePacket.ts`）が有限の値だけを通している。
 */
export class IncrementalLineFit {
  private readonly forgetAfterX: number
  private n = 0
  /** 重みの合計。忘れなければ `n` と同じ。 */
  private w = 0
  private lastX = Number.NEGATIVE_INFINITY
  /** 最初に足した `y`。中の `y` はこれを引いた差で持つ。 */
  private originY = 0
  private meanX = 0
  /** 原点からの差の平均。 */
  private meanY = 0
  /** Σw(x−x̄)² */
  private cxx = 0
  /** Σw(x−x̄)(y−ȳ) */
  private cxy = 0
  /** Σw(y−ȳ)² */
  private cyy = 0

  constructor(forgetAfterX: number) {
    if (!(forgetAfterX > 0)) throw new RangeError(`forgetAfterX は正の数にすること（${forgetAfterX}）`)
    this.forgetAfterX = forgetAfterX
  }

  add(x: number, yAbs: number): void {
    if (this.n === 0) this.originY = yAbs
    const y = yAbs - this.originY
    // **先に今までの分を軽くする。** 平均は重みを一律に掛けても動かないので、和だけを縮める。
    if (this.n > 0 && x > this.lastX && Number.isFinite(this.forgetAfterX)) {
      const keep = Math.exp(-(x - this.lastX) / this.forgetAfterX)
      this.w *= keep
      this.cxx *= keep
      this.cxy *= keep
      this.cyy *= keep
    }
    if (x > this.lastX) this.lastX = x
    this.n += 1
    this.w += 1
    const dx = x - this.meanX
    const dy = y - this.meanY
    this.meanX += dx / this.w
    this.meanY += dy / this.w
    // **更新後の平均を使うこと。** 更新前の平均で掛けると別の量になる
    // （重み付きでも同じ形になる: dx·(x − 新しい平均) = 縮めた重み/新しい重み × dx²）。
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
    const intercept = this.originY + (this.meanY - slope * this.meanX)
    // 残差平方和 = Σ(y−ȳ)² − 傾き×Σ(x−x̄)(y−ȳ)。
    // 丸めで僅かに負へ落ちることがあるので 0 で止める。
    const sse = Math.max(0, this.cyy - slope * this.cxy)
    return {
      count: this.n,
      slope,
      intercept,
      residualRms: Math.sqrt(sse / this.w),
      usable: Number.isFinite(slope) && Number.isFinite(intercept),
    }
  }
}
