import { describe, expect, it } from 'vitest'

import { calcSeismicIntensity } from '../../../src/utils/knet/seismicIntensity'
import { computeRealtimeIntensityTimeSeries } from '../../../src/utils/knet/realtimeIntensity'
import { computeQuakeIntensity, QUAKE_INTENSITY_LEAD_MS } from './quakeIntensity'
import type { ArchivedWaveChunk } from './waveArchive'

const T0 = Date.parse('2026-10-03T13:25:00+09:00')
const MS = 10 // 100 Hz

/** `sec` 秒目の振幅（gal）を返す関数から、`fromSec`〜`toSec` の 3 成分の波形を作る。 */
function wave(fromSec: number, toSec: number, amp: (sec: number) => number): number[][] {
  const out: number[][] = [[], [], []]
  for (let i = Math.round(fromSec * 100); i < Math.round(toSec * 100); i++) {
    const t = i / 100
    const a = amp(t)
    // 成分ごとに周期をずらし、合成が一定値にならないようにする
    out[0].push(a * Math.sin(2 * Math.PI * 2 * t))
    out[1].push(a * Math.sin(2 * Math.PI * 3 * t + 1))
    out[2].push(0.5 * a * Math.sin(2 * Math.PI * 5 * t + 2))
  }
  return out
}

/** 波形を 0.3 秒ずつのまとまりへ切る（実機のまとまりと同じ長さ）。 */
function chunksOf(startMs: number, samples: number[][]): ArchivedWaveChunk[] {
  const chunks: ArchivedWaveChunk[] = []
  const per = 30
  for (let i = 0; i < samples[0].length; i += per) {
    const n = Math.min(per, samples[0].length - i)
    chunks.push({
      firstSampleMs: startMs + i * MS,
      msPerSample: MS,
      gal: [
        Float32Array.from(samples[0].slice(i, i + n)),
        Float32Array.from(samples[1].slice(i, i + n)),
        Float32Array.from(samples[2].slice(i, i + n)),
      ],
      dcGal: [0, 0, 980],
      memberCount: new Uint8Array(n).fill(3),
    })
  }
  return chunks
}

// 静穏 0.5 gal のあと、70〜90 秒に 40 gal の揺れ。
const quiet = (t: number): number => (t >= 70 && t < 90 ? 40 : 0.5)

describe('computeQuakeIntensity', () => {
  it('計測震度は範囲の波形へ気象庁の手順を 1 回当てた値', () => {
    const w = wave(0, 150, quiet)
    const fromMs = T0 + 60_000
    const toMs = T0 + 150_000
    const r = computeQuakeIntensity({ chunks: chunksOf(T0, w), fromMs, toMs })
    // 範囲の中だけを切り出して同じ手順へ通した値と一致する（Float32 で保存した丸めの分だけずれる）
    const cut = w.map((axis) => axis.slice(6000).map((v) => Math.fround(v)))
    expect(r.measured).toBeCloseTo(calcSeismicIntensity(cut[0], cut[1], cut[2], 100)!, 9)
    expect(r.measuredUnavailable).toBeNull()
    expect(r.gapCount).toBe(0)
  })

  it('最大リアルタイム震度は範囲の中の最大と、その時刻', () => {
    const w = wave(0, 150, quiet)
    const r = computeQuakeIntensity({ chunks: chunksOf(T0, w), fromMs: T0 + 60_000, toMs: T0 + 150_000 })
    const series = computeRealtimeIntensityTimeSeries(
      w[0].map(Math.fround),
      w[1].map(Math.fround),
      w[2].map(Math.fround),
      100,
      1,
    )
    const inRange = series.filter((p) => p.tSec * 1000 >= 60_000 && p.intensity !== null)
    const best = inRange.reduce((a, b) => (b.intensity! > a.intensity! ? b : a))
    expect(r.maxRealtime).toBeCloseTo(best.intensity!, 9)
    // 時刻は刻みの位置（その秒までのサンプルで出した値）
    expect(r.maxRealtimeAtMs).toBeCloseTo(T0 + best.tSec * 1000 - MS, 6)
  })

  // 対照: 範囲の手前の揺れは最大に数えない（前の地震を拾わない）。
  it('範囲より前の揺れは最大リアルタイム震度に数えない', () => {
    // 10〜20 秒に強い揺れ、範囲は 90 秒から（判定の窓 60 秒を過ぎて抜けた後）
    const w = wave(0, 150, (t) => (t >= 10 && t < 20 ? 40 : 0.5))
    const r = computeQuakeIntensity({ chunks: chunksOf(T0, w), fromMs: T0 + 90_000, toMs: T0 + 150_000 })
    expect(r.maxRealtime!).toBeLessThan(2)
  })

  // 安全弁: 助走を読んでいれば、範囲の頭から判定の窓が埋まった値になる。
  it('助走の長さは判定の窓（60 秒）と同じ', () => {
    expect(QUAKE_INTENSITY_LEAD_MS).toBe(60_000)
  })

  // 安全弁: 途切れた波形を繋いで計測震度を出さない。
  it('範囲の中で途切れていれば、計測震度は出さず理由を返す', () => {
    const w = wave(0, 150, quiet)
    // 100〜102 秒を抜く（200 サンプル）
    const chunks = chunksOf(T0, w).filter((c) => c.firstSampleMs < T0 + 100_000 || c.firstSampleMs >= T0 + 102_000)
    const r = computeQuakeIntensity({ chunks, fromMs: T0 + 60_000, toMs: T0 + 150_000 })
    expect(r.measured).toBeNull()
    expect(r.measuredUnavailable).toBe('gap')
    expect(r.gapCount).toBe(1)
    // 最大リアルタイム震度は、届いていた分から出す（揺れは途切れの手前にある）
    expect(r.maxRealtime).not.toBeNull()
  })

  // 対照: 範囲の外の途切れは数えない。
  it('範囲より前の途切れは計測震度を止めない', () => {
    const w = wave(0, 150, quiet)
    const chunks = chunksOf(T0, w).filter((c) => c.firstSampleMs < T0 + 20_000 || c.firstSampleMs >= T0 + 22_000)
    const r = computeQuakeIntensity({ chunks, fromMs: T0 + 60_000, toMs: T0 + 150_000 })
    expect(r.measuredUnavailable).toBeNull()
    expect(r.gapCount).toBe(0)
  })

  it('刻みのわずかな揺らぎは途切れと見なさない', () => {
    const w = wave(0, 150, quiet)
    // まとまりの頭を 1 ms ずつ前後させる（実機の刻みの揺らぎより大きい）
    const chunks = chunksOf(T0, w).map((c, i) => ({ ...c, firstSampleMs: c.firstSampleMs + (i % 2 === 0 ? 1 : -1) }))
    const r = computeQuakeIntensity({ chunks, fromMs: T0 + 60_000, toMs: T0 + 150_000 })
    expect(r.gapCount).toBe(0)
    expect(r.measuredUnavailable).toBeNull()
  })

  it('範囲の頭まで記録が届いていなければ、計測震度は出さない', () => {
    // 記録は 80 秒から（ホストが止まっていた）。範囲は 60 秒から。
    const w = wave(80, 150, quiet)
    const r = computeQuakeIntensity({ chunks: chunksOf(T0 + 80_000, w), fromMs: T0 + 60_000, toMs: T0 + 150_000 })
    expect(r.measured).toBeNull()
    expect(r.measuredUnavailable).toBe('not-covered')
  })

  it('範囲の終わりまで記録が届いていなければ、計測震度は出さない', () => {
    const w = wave(0, 120, quiet)
    const r = computeQuakeIntensity({ chunks: chunksOf(T0, w), fromMs: T0 + 60_000, toMs: T0 + 150_000 })
    expect(r.measuredUnavailable).toBe('not-covered')
  })

  it('範囲に記録が 1 つも無ければ、どちらも出さない', () => {
    const r = computeQuakeIntensity({ chunks: [], fromMs: T0, toMs: T0 + 60_000 })
    expect(r).toEqual({
      maxRealtime: null,
      maxRealtimeAtMs: null,
      measured: null,
      measuredUnavailable: 'no-data',
      gapCount: 0,
      invalidChunkCount: 0,
    })
  })

  it('有限でない値が混じったら、そこで区切る（計算器を壊さない）', () => {
    const w = wave(0, 150, quiet)
    const chunks = chunksOf(T0, w)
    const bad = chunks.findIndex((c) => c.firstSampleMs >= T0 + 120_000)
    const g = chunks[bad].gal[0].slice()
    g[5] = NaN
    chunks[bad] = { ...chunks[bad], gal: [g, chunks[bad].gal[1], chunks[bad].gal[2]] }
    const r = computeQuakeIntensity({ chunks, fromMs: T0 + 60_000, toMs: T0 + 150_000 })
    expect(r.measuredUnavailable).toBe('gap')
    expect(r.maxRealtime).not.toBeNull()
    // 「届かなかった」と見分けられるよう、捨てた数を返す
    expect(r.invalidChunkCount).toBe(1)
  })
})
