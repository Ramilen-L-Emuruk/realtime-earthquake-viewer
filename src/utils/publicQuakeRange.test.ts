import { describe, expect, it } from 'vitest'
import { WAVE_HISTORY_LEAD_MS, WAVE_HISTORY_TAIL_MS } from '../services/seismoWaveHistory'
import {
  isPublicWaveRangeSettled,
  PUBLIC_S_ARRIVAL_PAD_MS,
  PUBLIC_WAVE_RANGE_MAX_MS,
  PUBLIC_WAVE_SETTLE_MARGIN_MS,
  publicWaveRange,
} from './publicQuakeRange'

const ORIGIN = Date.UTC(2026, 9, 15, 3, 0, 0)

describe('publicWaveRange', () => {
  // 対照: S 波が 4 分の内に届くなら、自作地震計と同じ 30 秒前〜4 分後。
  it('近い観測点は発生の 30 秒前〜4 分後', () => {
    expect(publicWaveRange({ originMs: ORIGIN, cutoffMs: null, sArrivalMs: ORIGIN + 30_000 })).toEqual({
      fromMs: ORIGIN - WAVE_HISTORY_LEAD_MS,
      toMs: ORIGIN + WAVE_HISTORY_TAIL_MS,
    })
  })

  // 正: S 波が 4 分より後に届く観測点は、到達に余白を足したところまで伸ばす。
  it('遠い観測点は S 波の到達まで伸ばす', () => {
    const s = ORIGIN + 300_000
    expect(publicWaveRange({ originMs: ORIGIN, cutoffMs: null, sArrivalMs: s })!.toMs).toBe(s + PUBLIC_S_ARRIVAL_PAD_MS)
  })

  // 安全弁: 伸ばしても上限を超えない。次の地震の発生でも切る。
  it('上限と次の地震で切る', () => {
    const far = publicWaveRange({ originMs: ORIGIN, cutoffMs: null, sArrivalMs: ORIGIN + 3_600_000 })!
    expect(far.toMs - far.fromMs).toBe(PUBLIC_WAVE_RANGE_MAX_MS)
    const cut = publicWaveRange({ originMs: ORIGIN, cutoffMs: ORIGIN + 90_000, sArrivalMs: null })!
    expect(cut.toMs).toBe(ORIGIN + 90_000)
  })

  it('走時が解けなければ 4 分のまま・範囲が空なら null', () => {
    expect(publicWaveRange({ originMs: ORIGIN, cutoffMs: null, sArrivalMs: null })!.toMs).toBe(ORIGIN + WAVE_HISTORY_TAIL_MS)
    expect(publicWaveRange({ originMs: ORIGIN, cutoffMs: ORIGIN - 60_000, sArrivalMs: null })).toBeNull()
    expect(publicWaveRange({ originMs: Number.NaN, cutoffMs: null, sArrivalMs: null })).toBeNull()
  })
})

describe('isPublicWaveRangeSettled', () => {
  it('範囲の終わりから余裕を過ぎるまでは入りきっていない', () => {
    const range = { fromMs: ORIGIN, toMs: ORIGIN + 240_000 }
    expect(isPublicWaveRangeSettled(range, range.toMs + PUBLIC_WAVE_SETTLE_MARGIN_MS - 1)).toBe(false)
    expect(isPublicWaveRangeSettled(range, range.toMs + PUBLIC_WAVE_SETTLE_MARGIN_MS)).toBe(true)
  })
})
