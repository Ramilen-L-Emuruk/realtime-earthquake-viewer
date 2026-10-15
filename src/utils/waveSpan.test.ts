// 地図の下端の波形の時間幅（設定）を読むところ。
import { describe, expect, it } from 'vitest'
import { DEFAULT_WAVE_SPAN_SEC, ensureWaveSpanSec, MAX_WAVE_SPAN_SEC, WAVE_SPAN_CHOICES } from './waveSpan'

describe('ensureWaveSpanSec', () => {
  // 正: 選べる幅はそのまま通す。
  it('選べる幅はそのまま', () => {
    for (const sec of WAVE_SPAN_CHOICES) expect(ensureWaveSpanSec(sec, DEFAULT_WAVE_SPAN_SEC)).toBe(sec)
  })

  // 対照: 選べない値（間の数・文字列・非有限）は既定へ戻す。
  it('選べない値は既定へ', () => {
    for (const v of [90, '120', Number.NaN, null, undefined]) expect(ensureWaveSpanSec(v, 120)).toBe(120)
  })

  // 安全弁: 抱える長さの基準はいちばん長い幅（短くすると、幅を広げたとき左が空く）。既定は 120 秒（2026-10-14 ユーザー承認）。
  it('いちばん長い幅は 180 秒・既定は 120 秒', () => {
    expect(MAX_WAVE_SPAN_SEC).toBe(Math.max(...WAVE_SPAN_CHOICES))
    expect(DEFAULT_WAVE_SPAN_SEC).toBe(120)
  })
})
