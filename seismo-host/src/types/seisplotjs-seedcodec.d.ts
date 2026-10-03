// `seisplotjs-seedcodec`（MIT）の型。**テストだけが使う**（miniSEED の符号化器を、出どころの違う
// 復号器で確かめるため）。本体は型宣言を配っていないので、使う関数だけをここで宣言する。
declare module 'seisplotjs-seedcodec' {
  /**
   * Steim2 を復号する。`swapBytes` は「小さいバイト順で読むか」の意味で、
   * Steim2 は大きいバイト順なので `false` を渡す。`bias` は 0（先頭値を X0 から取る）。
   */
  export function decodeSteim2(dataView: DataView, numSamples: number, swapBytes: boolean, bias: number): Int32Array
}
