import { describe, expect, it } from 'vitest'
import { computeRealtimeIntensityTimeSeries } from '../../../src/utils/knet/realtimeIntensity'
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

describe('IntensityStream', () => {
  const ch: [number[], number[], number[]] = [
    makeWaveform(25 * RATE, 1),
    makeWaveform(25 * RATE, 2),
    makeWaveform(25 * RATE, 3),
  ]
  const opts = { sampleRateHz: RATE, stepSec: 1 }

  it('バッチ実装と厳密に一致する', () => {
    const streamed = runStream(new IntensityStream(opts), ch, [137])
    const batch = computeRealtimeIntensityTimeSeries(ch[0], ch[1], ch[2], RATE, opts.stepSec)
    expect(comparable(streamed)).toEqual(batch)
    // 山を置いてあるので、答えが全部 null では一致していても意味が無い。
    expect(batch.filter((p) => p.intensity != null).length).toBeGreaterThan(10)
  })

  it('刻み方を変えても同じ答えになる', () => {
    const base = runStream(new IntensityStream(opts), ch, [137])
    for (const sizes of [[1], [100], [7, 313, 2], [2500]]) {
      expect(comparable(runStream(new IntensityStream(opts), ch, sizes))).toEqual(comparable(base))
    }
  })

  it('位置は経過秒と対応する', () => {
    const points = runStream(new IntensityStream(opts), ch, [500])
    expect(points.length).toBeGreaterThan(0)
    for (const p of points) expect(p.endSampleIndex).toBe(Math.round(p.tSec * RATE))
    expect(points[0].endSampleIndex).toBe(RATE)
  })

  // 正: 近似フィルタは未来のサンプルを見ないので、刻みの位置まで届いたその場で出る。
  it('刻みの位置まで届いたら、その場で答えを出す', () => {
    const stream = new IntensityStream(opts)
    const zero = new Array<number>(RATE - 1).fill(0)
    expect(stream.push(0, zero, zero, zero)).toHaveLength(0)
    expect(stream.push(RATE - 1, [0], [0], [0])).toHaveLength(1)
  })

  it('締めても出し残しは無く、二度目も空', () => {
    const stream = new IntensityStream(opts)
    const n = 10 * RATE + 37
    stream.push(0, ch[0].slice(0, n), ch[1].slice(0, n), ch[2].slice(0, n))
    expect(stream.end()).toEqual([])
    expect(stream.end()).toEqual([])
  })

  it('位置が続きになっていなければ止まる', () => {
    // **弾いたパケットを組み立て側は「連続」として受理する**（あちらはサンプルの中身を
    // 見ていない）。詰めて繋ぐと、失われた時間が段差になって強い揺れとして出る。
    const stream = new IntensityStream(opts)
    stream.push(0, [1, 2], [1, 2], [1, 2])
    expect(() => stream.push(5, [3], [3], [3])).toThrow(/続きになっていない/)
    expect(() => stream.push(1, [3], [3], [3])).toThrow(/続きになっていない/)
    // 続きなら通る。
    expect(() => stream.push(2, [3], [3], [3])).not.toThrow()
  })

  it('締めたあとに流し込むと止まる', () => {
    const stream = new IntensityStream(opts)
    stream.end()
    expect(() => stream.push(0, [0], [0], [0])).toThrow(/end\(\)/)
  })

  it('3 成分の長さが揃っていなければ止まる', () => {
    const stream = new IntensityStream(opts)
    expect(() => stream.push(0, [0, 0], [0], [0])).toThrow(/長さ/)
  })

  // 安全弁: 近似フィルタが発散するほど低いサンプリング周波数では作らない。発散した出力は
  // 有限のまま大きくなるので、作ってしまうと「揺れの大きな地震」と区別が付かない。
  it('サンプリング周波数が低すぎれば作れない', () => {
    expect(() => new IntensityStream({ sampleRateHz: 50, stepSec: 1 })).toThrow(/発散/)
    expect(() => new IntensityStream({ sampleRateHz: 100, stepSec: 1 })).not.toThrow()
  })

  it('刻みが正でなければ作れない', () => {
    expect(() => new IntensityStream({ sampleRateHz: 100, stepSec: 0 })).toThrow(/stepSec/)
  })

  it('有限でないサンプルが混じっていれば止まる', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const stream = new IntensityStream(opts)
      expect(() => stream.push(0, [1, bad], [1, 1], [1, 1])).toThrow(/有限/)
    }
  })

  it('投げたときは何も通していない', () => {
    // **途中まで通してから投げると、フィルタの状態がその途中で止まったまま残る。**
    // 以後の答えは、捨てたはずのサンプルを含んだ値になる。
    const n = 5 * RATE
    const head: [number[], number[], number[]] = [ch[0].slice(0, n), ch[1].slice(0, n), ch[2].slice(0, n)]
    const bad: [number[], number[], number[]] = [
      [1, 2, 3, 4],
      [1, 2, NaN, 4],
      [1, 2, 3, 4],
    ]
    const rest: [number[], number[], number[]] = [
      ch[0].slice(n, 2 * n),
      ch[1].slice(n, 2 * n),
      ch[2].slice(n, 2 * n),
    ]

    const broken = new IntensityStream(opts)
    broken.push(0, head[0], head[1], head[2])
    expect(() => broken.push(n, bad[0], bad[1], bad[2])).toThrow(/有限/)
    const fromBroken = broken.push(n, rest[0], rest[1], rest[2])

    const clean = new IntensityStream(opts)
    clean.push(0, head[0], head[1], head[2])
    const fromClean = clean.push(n, rest[0], rest[1], rest[2])

    expect(broken.sampleCount).toBe(clean.sampleCount)
    expect(comparable(fromBroken)).toEqual(comparable(fromClean))
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

  it('静止した基板の値（重力が乗ったまま）を渡しても、静止は静止のまま出る', () => {
    // 直流を引かずにフィルタへ通すと、立ち上がりの段差が強い揺れとして出て、60 秒の窓に
    // 入ったまま 1 分間居座る。
    const points = runStream(new IntensityStream({ sampleRateHz: RATE, stepSec: 1 }), quiet, [500])
    const values = points.map((p) => p.intensity).filter((v): v is number => v != null)
    expect(values.length).toBeGreaterThan(0)
    expect(Math.max(...values)).toBeLessThan(1)
  })
})
