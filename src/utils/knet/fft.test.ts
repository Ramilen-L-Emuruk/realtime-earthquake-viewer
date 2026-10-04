import { describe, expect, it } from 'vitest'

import { fftInPlace } from './fft'

/** 定義どおりの DFT（O(n²)）。答え合わせの相手。 */
function naiveDft(re: readonly number[], im: readonly number[], inverse: boolean): [number[], number[]] {
  const n = re.length
  const sign = inverse ? 1 : -1
  const outRe: number[] = []
  const outIm: number[] = []
  for (let k = 0; k < n; k++) {
    let sr = 0
    let si = 0
    for (let t = 0; t < n; t++) {
      const ang = (sign * 2 * Math.PI * k * t) / n
      sr += re[t] * Math.cos(ang) - im[t] * Math.sin(ang)
      si += re[t] * Math.sin(ang) + im[t] * Math.cos(ang)
    }
    outRe.push(inverse ? sr / n : sr)
    outIm.push(inverse ? si / n : si)
  }
  return [outRe, outIm]
}

/** 決まった種から作る擬似乱数（テストの再現性のため）。 */
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648 - 0.5
  }
}

describe('fftInPlace', () => {
  it.each([1, 2, 4, 8, 64, 256])('長さ %i で定義どおりの DFT と一致する（順変換）', (n) => {
    const rand = seeded(n)
    const re = Array.from({ length: n }, rand)
    const im = Array.from({ length: n }, rand)
    const [wantRe, wantIm] = naiveDft(re, im, false)
    const gotRe = Float64Array.from(re)
    const gotIm = Float64Array.from(im)
    fftInPlace(gotRe, gotIm, false)
    for (let k = 0; k < n; k++) {
      expect(gotRe[k]).toBeCloseTo(wantRe[k], 9)
      expect(gotIm[k]).toBeCloseTo(wantIm[k], 9)
    }
  })

  it('逆変換は 1/n を掛けた定義どおりの値になる', () => {
    const rand = seeded(7)
    const re = Array.from({ length: 32 }, rand)
    const im = Array.from({ length: 32 }, rand)
    const [wantRe, wantIm] = naiveDft(re, im, true)
    const gotRe = Float64Array.from(re)
    const gotIm = Float64Array.from(im)
    fftInPlace(gotRe, gotIm, true)
    for (let k = 0; k < 32; k++) {
      expect(gotRe[k]).toBeCloseTo(wantRe[k], 9)
      expect(gotIm[k]).toBeCloseTo(wantIm[k], 9)
    }
  })

  it('順変換して逆変換すると元に戻る', () => {
    const rand = seeded(11)
    const src = Array.from({ length: 1024 }, rand)
    const re = Float64Array.from(src)
    const im = new Float64Array(1024)
    fftInPlace(re, im, false)
    fftInPlace(re, im, true)
    for (let i = 0; i < 1024; i++) {
      expect(re[i]).toBeCloseTo(src[i], 12)
      expect(im[i]).toBeCloseTo(0, 12)
    }
  })

  // 安全弁: 2 の冪でない長さは、黙って誤った答えを返す代わりに止める。
  it('2 の冪でない長さは投げる', () => {
    expect(() => fftInPlace(new Float64Array(6), new Float64Array(6), false)).toThrow()
  })

  it('実部と虚部の長さが違えば投げる', () => {
    expect(() => fftInPlace(new Float64Array(8), new Float64Array(4), false)).toThrow()
  })
})
