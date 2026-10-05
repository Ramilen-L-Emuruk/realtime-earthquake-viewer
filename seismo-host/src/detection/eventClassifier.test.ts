import { describe, expect, it } from 'vitest'

import { classifyShake, shakeRatios } from './eventClassifier'

/** 評価台の出力（5〜10 Hz の水平動に対する比）から区間を組み立てる。 */
function event(zh: number, lo: number, mid: number, hi: number, vhi: number, ref = 0.8) {
  return {
    bandRmsH: [lo * ref, mid * ref, ref, hi * ref, vhi * ref],
    bandRmsZ: [0, 0, zh * ref, 0, 0],
  }
}

// 実機の記録（2026-09-28〜10-03）で気象庁の地震と一致した 6 件の揺れ方。
const QUAKES = {
  '一致 1（M3.5）': event(0.43, 0.23, 0.36, 0.5, 0.43),
  '一致 2（M3.5）': event(0.58, 0.29, 0.46, 0.64, 0.5),
  '一致 3（M3.1）': event(0.49, 0.29, 0.47, 0.58, 0.51),
  '一致 4（M3.0）': event(0.55, 0.33, 0.49, 0.73, 0.56),
  '一致 5（M3.5）': event(0.38, 0.22, 0.35, 0.58, 0.38),
  '一致 6（M2.8）': event(0.54, 0.26, 0.44, 0.74, 0.55),
}

describe('classifyShake', () => {
  it.each(Object.entries(QUAKES))('正: 実機で一致した地震 %s は地震らしい', (_, e) => {
    expect(classifyShake(e)).toBe('quake-like')
  })

  it('対照: お掃除ロボット（上下動が少ない・低い周波数が少ない）は生活振動らしい', () => {
    // 39 秒・平常時の 18 倍
    expect(classifyShake(event(0.17, 0.1, 0.31, 0.34, 0.24))).toBe('local-like')
  })

  it('対照: 基板を手で動かした揺れ（上下動と低い周波数が多い）は生活振動らしい', () => {
    // 6 面法の持ち替え
    expect(classifyShake(event(0.81, 3.31, 1.21, 0.83, 0.45))).toBe('local-like')
  })

  it('対照: 細かい揺れが多い（10〜20 Hz・20〜45 Hz が強い）ものは生活振動らしい', () => {
    // 09-30 11:37:29
    expect(classifyShake(event(0.29, 0.2, 0.48, 1.18, 2.48))).toBe('local-like')
  })

  it('境目: 上下動の割合の枠（0.30〜0.65）の内外', () => {
    expect(classifyShake(event(0.3, 0.2, 0.4, 0.6, 0.5))).toBe('quake-like')
    expect(classifyShake(event(0.29, 0.2, 0.4, 0.6, 0.5))).toBe('local-like')
    expect(classifyShake(event(0.65, 0.2, 0.4, 0.6, 0.5))).toBe('quake-like')
    expect(classifyShake(event(0.66, 0.2, 0.4, 0.6, 0.5))).toBe('local-like')
  })

  it('安全弁: 振幅の大きさでは弾かない（強い地震ほど大きい）', () => {
    expect(classifyShake(event(0.43, 0.23, 0.36, 0.5, 0.43, 500))).toBe('quake-like')
  })

  it('安全弁: 引き金の帯が 0・非有限なら比を出さず生活振動らしい側へ倒す', () => {
    expect(shakeRatios({ bandRmsH: [1, 1, 0, 1, 1], bandRmsZ: [0, 0, 1, 0, 0] })).toBeNull()
    expect(classifyShake({ bandRmsH: [1, 1, Number.NaN, 1, 1], bandRmsZ: [0, 0, 1, 0, 0] })).toBe('local-like')
    expect(classifyShake(event(Number.NaN, 0.2, 0.4, 0.6, 0.5))).toBe('local-like')
  })
})
