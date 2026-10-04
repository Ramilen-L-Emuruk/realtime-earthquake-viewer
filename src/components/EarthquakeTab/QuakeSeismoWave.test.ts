// 到達時刻を絵の横位置へ落とすところ。
//
// **固定するのは 3 つ** ——0〜1 の比になること・**絵の外の時刻を範囲の外として返すこと**
// （描く側が捨てる）・**分母が「末尾を切った後」の列であること**。

import { describe, expect, it } from 'vitest'

import { axisZeroLabel, buildArrivalMarks } from './QuakeSeismoWave'
import { P_WAVE_COLOR, S_WAVE_COLOR } from '../Map/gl/psWaveStyle'
import type { TimedColumns } from '../../utils/seismoWaveColumns'

const FROM_MS = 1_000_000

/** 1 列 100ms × `count` 列（中身は使わないので空の列で足りる）。 */
function columns(count: number): TimedColumns {
  return { fromMs: FROM_MS, columnSpanMs: 100, columns: new Array(count).fill(null) }
}

describe('buildArrivalMarks', () => {
  it('P と S を左端 0・右端 1 の比で返す', () => {
    // 100 列 × 100ms ＝ 10 秒ぶんの絵。P は 2 秒後・S は 5 秒後。
    const marks = buildArrivalMarks(columns(100), {
      pMs: FROM_MS + 2000,
      sMs: FROM_MS + 5000,
    })
    expect(marks.map((m) => m.label)).toEqual(['P', 'S'])
    expect(marks[0].ratio).toBeCloseTo(0.2)
    expect(marks[1].ratio).toBeCloseTo(0.5)
  })

  it('絵の右より後の到達は 1 を超える比で返す（描く側が捨てる）', () => {
    // **0〜1 に丸めない。** 端へ張り付けると、まだ届いていない時刻の線が右端に出る。
    const marks = buildArrivalMarks(columns(100), {
      pMs: FROM_MS + 2000,
      sMs: FROM_MS + 30_000,
    })
    expect(marks[1].ratio).toBeGreaterThan(1)
  })

  it('分母は末尾を切った後の列（切る前の窓ではない）', () => {
    // **対照。** 同じ到達時刻でも、絵が短ければ比は右へ寄る。
    const long = buildArrivalMarks(columns(100), { pMs: FROM_MS + 2000, sMs: FROM_MS + 5000 })
    const short = buildArrivalMarks(columns(50), { pMs: FROM_MS + 2000, sMs: FROM_MS + 5000 })
    expect(short[0].ratio).toBeGreaterThan(long[0].ratio)
    expect(short[0].ratio).toBeCloseTo(0.4)
  })

  it('到達が求まらなければ 1 本も引かない', () => {
    expect(buildArrivalMarks(columns(100), null)).toEqual([])
  })

  it('列が 1 つも無ければ引かない（0 除算を作らない）', () => {
    // **安全弁。** 割ると `Infinity` になり、範囲の判定をすり抜けて端に線が出る。
    expect(buildArrivalMarks(columns(0), { pMs: FROM_MS, sMs: FROM_MS })).toEqual([])
  })

  it('P は破線・S は実線で、見た目でも見分けられる', () => {
    const marks = buildArrivalMarks(columns(100), { pMs: FROM_MS, sMs: FROM_MS + 100 })
    expect(marks[0].dashed).toBe(true)
    expect(marks[1].dashed).toBe(false)
  })

  it('色は地図の予報円から引く（直書きへ戻さない）', () => {
    // **同じ画面で同じものを指すのに色が違うと、別の量に見える。**
    const marks = buildArrivalMarks(columns(100), { pMs: FROM_MS, sMs: FROM_MS + 100 })
    expect(marks[0].color).toBe(P_WAVE_COLOR)
    expect(marks[1].color).toBe(S_WAVE_COLOR)
  })
})

describe('axisZeroLabel', () => {
  it('秒まで取れていれば「発生」', () => {
    expect(axisZeroLabel({ kind: 'origin', ms: Date.parse('2026-10-03T13:26:02+09:00'), source: 'eew' })).toBe('発生')
  })

  // 対照: 分までしか無ければ発生を名乗らず、数え始めた時刻を書く。
  it('分までしか無ければ、その分の頭の時刻', () => {
    expect(axisZeroLabel({ kind: 'minute', ms: Date.parse('2026-10-03T13:26:00+09:00') })).toBe('13:26:00')
  })
})
