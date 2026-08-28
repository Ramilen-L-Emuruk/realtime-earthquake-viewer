declare module 'fft-js' {
  /** 複素数を [実部, 虚部] のタプルで表す。 */
  export type Complex = [number, number]

  /**
   * FFT（Cooley-Tukey法）。`vector.length` は2の冪であること（呼び出し側の責務。
   * 2の冪でない場合、内部の偶奇分割が破綻し無警告で誤った結果を返す）。
   */
  export function fft(vector: number[] | Complex[]): Complex[]

  /** 逆FFT。長さは2の冪であること（fft と同じ制約）。 */
  export function ifft(phasors: Complex[]): Complex[]

  // CommonJSパッケージのためdefault importで受けて分割代入する（seismicIntensity.ts参照）。
  const fftJs: { fft: typeof fft; ifft: typeof ifft }
  export default fftJs
}
