// P/S の到達線の横位置。**範囲の外の時刻は比が 0〜1 の外へ落ち、描く側（`paintMarks`）が捨てる** —— その前提をここで固定する
// （地図の下端の波形で「いま」より先の線を入れないのは `liveLanes.ts` の `liveArrivalMarks`）。

import { describe, expect, it } from 'vitest'

import { buildArrivalMarksForRange } from './arrivalMarks'

const RANGE = { fromMs: 1_000_000, toMs: 1_060_000 }

describe('buildArrivalMarksForRange', () => {
  // 正: 範囲の中の時刻は 0〜1 の比へ落ちる。P が破線・S が実線。
  it('範囲の中の到達は 0〜1 の比になる', () => {
    const [p, s] = buildArrivalMarksForRange(RANGE, { pMs: 1_015_000, sMs: 1_030_000 })
    expect(p).toMatchObject({ label: 'P', dashed: true })
    expect(p.ratio).toBeCloseTo(0.25)
    expect(s).toMatchObject({ label: 'S', dashed: false })
    expect(s.ratio).toBeCloseTo(0.5)
  })

  // 対照: まだ来ていない時刻（右端より後）は比が 1 を超える —— 描く側がこれを捨てる。
  it('右端より後の到達は比が 1 を超える', () => {
    const [, s] = buildArrivalMarksForRange(RANGE, { pMs: 1_050_000, sMs: 1_070_000 })
    expect(s.ratio).toBeGreaterThan(1)
  })

  // 安全弁: 到達が無い・範囲の幅が 0 以下なら線を作らない。
  it('到達が無いか範囲が壊れていれば線を作らない', () => {
    expect(buildArrivalMarksForRange(RANGE, null)).toEqual([])
    expect(buildArrivalMarksForRange({ fromMs: 5, toMs: 5 }, { pMs: 1, sMs: 2 })).toEqual([])
  })
})
