// 帯域通過フィルタ（地震検出の前処理。REQUIREMENTS.md §6）。
//
// **2 次の帯域通過（RBJ の式・中心で 0 dB）を同じものを 2 段重ねる。** 1 段だけだと裾が
// なだらかで、帯域の外（生活振動の多い 20 Hz 以上や、建物の揺れの 1 Hz 前後）が残りすぎる。
// 重ねると帯域の端で約 −6 dB になるが、検出が見るのは「平常時の何倍か」という比なので、
// 絶対値の目減りは効かない。
//
// **サンプルごとに 1 つずつ通す**（因果的）。ホストは届いた順に流すしかなく、後ろの値を
// 待つ作り（ゼロ位相）にはできない。位相のずれで到達の時刻がわずかに遅れて見えるが、
// 帯域 5〜10 Hz なら 0.1 秒の桁（P/S の拾い出しは別に前処理を持つ）。

/** 2 次の帯域通過 1 段。 */
class Biquad {
  private readonly b0: number
  private readonly b2: number
  private readonly a1: number
  private readonly a2: number
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  constructor(centerHz: number, q: number, sampleHz: number) {
    const w = (2 * Math.PI * centerHz) / sampleHz
    const alpha = Math.sin(w) / (2 * q)
    const a0 = 1 + alpha
    this.b0 = alpha / a0
    this.b2 = -alpha / a0
    this.a1 = (-2 * Math.cos(w)) / a0
    this.a2 = (1 - alpha) / a0
  }

  step(x: number): number {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }
}

/** 帯域 `[lowHz, highHz]` の帯域通過（2 段重ね）。 */
export class BandPass {
  private readonly first: Biquad
  private readonly second: Biquad

  constructor(lowHz: number, highHz: number, sampleHz: number) {
    if (!(lowHz > 0 && highHz > lowHz && highHz < sampleHz / 2)) {
      throw new Error(`帯域が不正: ${lowHz}〜${highHz} Hz（サンプリング ${sampleHz} Hz）`)
    }
    const center = Math.sqrt(lowHz * highHz)
    const q = center / (highHz - lowHz)
    this.first = new Biquad(center, q, sampleHz)
    this.second = new Biquad(center, q, sampleHz)
  }

  step(x: number): number {
    return this.second.step(this.first.step(x))
  }
}
