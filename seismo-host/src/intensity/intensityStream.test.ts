import { describe, expect, it } from 'vitest'
import {
  EDGE_MARGIN_SEC,
  calcSeismicIntensity,
  computeIntensityTimeSeries,
} from '../../../src/utils/knet/seismicIntensity'
import { IntensityStream, type IntensityPoint } from './intensityStream'

const RATE = 100

/**
 * 決まった形の波を作る。
 *
 * **乱数の種を固定する。** 厳密一致を見るテストなので、入力が走るたびに変わると
 * 「一致しなかった」が実装の欠陥なのか入力のせいなのか分けられない。
 */
function makeWaveform(count: number, seed: number): number[] {
  const out = new Array<number>(count)
  let state = seed >>> 0
  for (let i = 0; i < count; i++) {
    state = (state * 1103515245 + 12345) >>> 0
    const noise = (state / 0xffffffff) * 2 - 1
    const t = i / RATE
    // 10 秒あたりから減衰しながら揺れる山を置く（平坦な入力では震度が出ない）。
    const burst = t > 10 ? 40 * Math.exp(-(t - 10) / 3) * Math.sin(2 * Math.PI * 3.1 * t) : 0
    out[i] = noise * 0.8 + burst
  }
  return out
}

/** 区間を刻んで流し込み、出てきた答えを全部集める。 */
function runStream(
  stream: IntensityStream,
  ch: readonly [number[], number[], number[]],
  chunkSizes: readonly number[],
): IntensityPoint[] {
  const points: IntensityPoint[] = []
  let i = 0
  let k = 0
  while (i < ch[0].length) {
    const size = Math.min(chunkSizes[k % chunkSizes.length], ch[0].length - i)
    k += 1
    points.push(
      ...stream.push(
        i,
        ch[0].slice(i, i + size),
        ch[1].slice(i, i + size),
        ch[2].slice(i, i + size),
      ),
    )
    i += size
  }
  points.push(...stream.end())
  return points
}

function comparable(points: readonly IntensityPoint[]) {
  return points.map((p) => ({ tSec: p.tSec, intensity: p.intensity }))
}

function mean(values: readonly number[]): number {
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/**
 * 「窓ごとに平均を引く」側の答え合わせ。**バッチ実装の走り方をここへ書き写して**、
 * 平均を引く一手だけを足したもの。実装とは別に組むから答え合わせになる。
 */
function batchWithDemean(
  a: number[],
  b: number[],
  c: number[],
  rate: number,
  opts: { windowSec: number; stepSec: number },
) {
  const len = Math.min(a.length, b.length, c.length)
  const windowSamples = Math.round(opts.windowSec * rate)
  const stepSamples = Math.max(1, Math.round(opts.stepSec * rate))
  const marginSamples = Math.round(EDGE_MARGIN_SEC * rate)
  const out: { tSec: number; intensity: number | null }[] = []
  for (let end = stepSamples; end <= len; end += stepSamples) {
    const analysisEnd = Math.min(len, end + marginSamples)
    const start = Math.max(0, analysisEnd - windowSamples)
    const cut = (arr: number[]) => {
      const seg = arr.slice(start, analysisEnd)
      const m = mean(seg)
      return seg.map((v) => v - m)
    }
    out.push({
      tSec: end / rate,
      intensity: calcSeismicIntensity(cut(a), cut(b), cut(c), rate),
    })
  }
  return out
}

describe('IntensityStream', () => {
  const ch: [number[], number[], number[]] = [
    makeWaveform(25 * RATE, 1),
    makeWaveform(25 * RATE, 2),
    makeWaveform(25 * RATE, 3),
  ]
  const opts = { sampleRateHz: RATE, windowSec: 5, stepSec: 1 }

  it('バッチ実装と厳密に一致する', () => {
    const streamed = runStream(
      new IntensityStream({ ...opts, demeanWindow: false }),
      ch,
      [137],
    )
    const batch = computeIntensityTimeSeries(ch[0], ch[1], ch[2], RATE, opts)
    expect(comparable(streamed)).toEqual(batch)
    // 山を置いてあるので、答えが全部 null では一致していても意味が無い。
    expect(batch.filter((p) => p.intensity != null).length).toBeGreaterThan(10)
  })

  it('刻み方を変えても同じ答えになる', () => {
    const base = runStream(new IntensityStream({ ...opts, demeanWindow: false }), ch, [137])
    for (const sizes of [[1], [100], [7, 313, 2], [2500]]) {
      const other = runStream(
        new IntensityStream({ ...opts, demeanWindow: false }),
        ch,
        sizes,
      )
      expect(comparable(other)).toEqual(comparable(base))
    }
  })

  it('実運用の窓（20 秒）でもバッチ実装と一致する', () => {
    const long: [number[], number[], number[]] = [
      makeWaveform(40 * RATE, 11),
      makeWaveform(40 * RATE, 12),
      makeWaveform(40 * RATE, 13),
    ]
    const real = { sampleRateHz: RATE, windowSec: 20, stepSec: 1 }
    const streamed = runStream(
      new IntensityStream({ ...real, demeanWindow: false }),
      long,
      [256],
    )
    expect(comparable(streamed)).toEqual(
      computeIntensityTimeSeries(long[0], long[1], long[2], RATE, real),
    )
  })

  it('窓ごとに平均を引く側も、同じ窓の切り方で答えを出す', () => {
    const expected = batchWithDemean(ch[0], ch[1], ch[2], RATE, opts)
    for (const sizes of [[91], [1], [7, 313, 2], [2500]]) {
      const streamed = runStream(new IntensityStream({ ...opts, demeanWindow: true }), ch, sizes)
      expect(comparable(streamed)).toEqual(expected)
    }
  })

  it('窓より短い区間でもバッチ実装と一致する', () => {
    // 区間は切れ目で終わるので、窓（5 秒）に満たないまま締めることがある。
    // このとき解析の範囲は「溜まっている分」で、先読みの位置まで伸ばしてはならない。
    const n = Math.round(2.5 * RATE)
    const short: [number[], number[], number[]] = [
      ch[0].slice(0, n),
      ch[1].slice(0, n),
      ch[2].slice(0, n),
    ]
    const streamed = runStream(
      new IntensityStream({ ...opts, demeanWindow: false }),
      short,
      [n],
    )
    expect(streamed).not.toHaveLength(0)
    expect(comparable(streamed)).toEqual(
      computeIntensityTimeSeries(short[0], short[1], short[2], RATE, opts),
    )
  })

  it('位置は経過秒と対応する', () => {
    const points = runStream(new IntensityStream({ ...opts, demeanWindow: false }), ch, [500])
    expect(points.length).toBeGreaterThan(0)
    for (const p of points) expect(p.endSampleIndex).toBe(Math.round(p.tSec * RATE))
    expect(points[0].endSampleIndex).toBe(RATE)
  })

  it('先読みの分が届くまで答えを出さない', () => {
    const stream = new IntensityStream({ ...opts, demeanWindow: false })
    const needed = RATE + EDGE_MARGIN_SEC * RATE
    const zero = new Array<number>(needed - 1).fill(0)
    expect(stream.push(0, zero, zero, zero)).toHaveLength(0)
    expect(stream.push(needed - 1, [0], [0], [0])).toHaveLength(1)
  })

  it('締めると、先読みが足りない分も出し切る', () => {
    const stream = new IntensityStream({ ...opts, demeanWindow: false })
    const n = 10 * RATE
    const cut: [number[], number[], number[]] = [
      ch[0].slice(0, n),
      ch[1].slice(0, n),
      ch[2].slice(0, n),
    ]
    stream.push(0, cut[0], cut[1], cut[2])
    const tail = stream.end()
    // 先読み 2 秒ぶんが届かなかった末尾の 2 点。
    expect(tail.map((p) => p.tSec)).toEqual([9, 10])
    expect(stream.end()).toEqual([])
  })

  it('位置が続きになっていなければ止まる', () => {
    // **弾いたパケットを組み立て側は「連続」として受理する**（あちらはサンプルの中身を
    // 見ていない）。詰めて繋ぐと、失われた時間が段差になって強い揺れとして出る。
    const stream = new IntensityStream({ ...opts, demeanWindow: false })
    stream.push(0, [1, 2], [1, 2], [1, 2])
    expect(() => stream.push(5, [3], [3], [3])).toThrow(/続きになっていない/)
    expect(() => stream.push(1, [3], [3], [3])).toThrow(/続きになっていない/)
    // 続きなら通る。
    expect(() => stream.push(2, [3], [3], [3])).not.toThrow()
  })

  it('締めたあとに流し込むと止まる', () => {
    const stream = new IntensityStream({ ...opts, demeanWindow: false })
    stream.end()
    expect(() => stream.push(0, [0], [0], [0])).toThrow(/end\(\)/)
  })

  it('3 成分の長さが揃っていなければ止まる', () => {
    const stream = new IntensityStream({ ...opts, demeanWindow: false })
    expect(() => stream.push(0, [0, 0], [0], [0])).toThrow(/長さ/)
  })

  it('窓が 0.3 秒を覆えなければ作れない', () => {
    // 覆えないと答えが恒久的に null になり、先読み待ちと見分けが付かない。
    expect(
      () => new IntensityStream({ sampleRateHz: 100, windowSec: 0.29, stepSec: 1, demeanWindow: false }),
    ).toThrow(/windowSec/)
    expect(
      () => new IntensityStream({ sampleRateHz: 100, windowSec: 0.3, stepSec: 1, demeanWindow: false }),
    ).not.toThrow()
    // **下限は計算核と同じ境界から引く。** 毎秒 101 回では 30 サンプルで足りるので、
    // 独自に切り上げていた頃はここを過剰に拒んでいた。
    expect(
      () => new IntensityStream({ sampleRateHz: 101, windowSec: 30 / 101, stepSec: 1, demeanWindow: false }),
    ).not.toThrow()
  })

  it('有限でないサンプルが混じっていれば止まる', () => {
    // 通すと窓 1 つぶんの答えがまとめて null へ落ち、その間の揺れが黙って消える。
    for (const bad of [NaN, Infinity, -Infinity]) {
      const stream = new IntensityStream({ ...opts, demeanWindow: false })
      expect(() => stream.push(0, [1, bad], [1, 1], [1, 1])).toThrow(/有限/)
    }
  })

  it('投げたときは何も溜め込んでいない', () => {
    // **途中まで入れてから投げると、成分ごとに溜まった数がずれる。** 窓が埋まれば件数は
    // 上限で揃うので、以後どの検査にも掛からないまま別の時刻の値どうしを合成し続ける。
    const n = 5 * RATE
    const head: [number[], number[], number[]] = [
      ch[0].slice(0, n),
      ch[1].slice(0, n),
      ch[2].slice(0, n),
    ]
    // 軸 1 の 3 つ目を壊す（軸 0 の 3 つ分は「確かめる前に触る」実装なら入ってしまう）。
    const bad: [number[], number[], number[]] = [
      [1, 2, 3, 4],
      [1, 2, NaN, 4],
      [1, 2, 3, 4],
    ]

    const broken = new IntensityStream({ ...opts, demeanWindow: false })
    broken.push(0, head[0], head[1], head[2])
    expect(() => broken.push(n, bad[0], bad[1], bad[2])).toThrow(/有限/)

    const clean = new IntensityStream({ ...opts, demeanWindow: false })
    clean.push(0, head[0], head[1], head[2])

    expect(broken.sampleCount).toBe(clean.sampleCount)
    expect(comparable(broken.end())).toEqual(comparable(clean.end()))
  })
})

describe('重力の直流成分', () => {
  // 机に置いた基板の実測（`cap-quiet1`）にならった値。3 軸の平均は 65.9 / -62.1 / 1009.2 gal。
  const OFFSETS = [65.9, -62.1, 1009.2] as const
  const quiet: [number[], number[], number[]] = [
    makeWaveform(25 * RATE, 21).map((v) => v * 0.02 + OFFSETS[0]),
    makeWaveform(25 * RATE, 22).map((v) => v * 0.02 + OFFSETS[1]),
    makeWaveform(25 * RATE, 23).map((v) => v * 0.02 + OFFSETS[2]),
  ]
  const opts = { sampleRateHz: RATE, windowSec: 20, stepSec: 1 }

  function maxIntensity(demeanWindow: boolean): number {
    const points = runStream(new IntensityStream({ ...opts, demeanWindow }), quiet, [500])
    const values = points.map((p) => p.intensity).filter((v): v is number => v != null)
    expect(values.length).toBeGreaterThan(0)
    return Math.max(...values)
  }

  it('引かなければ、静止していても強い揺れとして出る', () => {
    // FFT のためのゼロ詰めで直流の段差が低い周波数へ漏れる。実データでは 4.48〜6.23 だった。
    expect(maxIntensity(false)).toBeGreaterThan(4)
  })

  it('窓ごとに平均を引けば、静止は静止のまま出る', () => {
    expect(maxIntensity(true)).toBeLessThan(2)
  })
})
