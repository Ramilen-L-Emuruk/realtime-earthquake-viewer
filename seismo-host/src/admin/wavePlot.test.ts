import { describe, expect, it } from 'vitest'

import {
  SENSOR_COLORS,
  colorForIndex,
  formatClock,
  formatGal,
  needsTenths,
  niceHalfSpanGal,
  timeTicks,
} from './wavePlot'

describe('niceHalfSpanGal', () => {
  it('切りのいい値へ上向きに丸める', () => {
    // 下向きに丸めると、いちばん大きい山が枠の外へ出る。
    expect(niceHalfSpanGal(1.2)).toBe(2)
    expect(niceHalfSpanGal(2.1)).toBe(5)
    expect(niceHalfSpanGal(5.1)).toBe(10)
    expect(niceHalfSpanGal(43)).toBe(50)
    expect(niceHalfSpanGal(310)).toBe(500)
  })

  it('ちょうど切りのいい値なら、そのまま', () => {
    expect(niceHalfSpanGal(2)).toBe(2)
    expect(niceHalfSpanGal(50)).toBe(50)
  })

  it('揺れていない窓でも下限より狭くしない（安全弁）', () => {
    // **静かなことと揺れていることを絵で見分けられるように。** 0 へ潰すと、
    // ノイズが画面いっぱいに描かれる。
    expect(niceHalfSpanGal(0)).toBe(1)
    expect(niceHalfSpanGal(0.0001)).toBe(1)
  })

  it('数として読めない値でも下限へ倒す', () => {
    expect(niceHalfSpanGal(Number.NaN)).toBe(1)
    expect(niceHalfSpanGal(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('timeTicks', () => {
  it('刻みの倍数へ揃える（窓の端から等間隔に置かない）', () => {
    // 端から置くと、少しスクロールするだけで数字が全部動き、目で追えなくなる。
    const ticks = timeTicks(10_150, 15_150, 6)

    expect(ticks.every((t) => t % 1000 === 0)).toBe(true)
    expect(ticks[0]).toBe(11_000)
  })

  it('目盛りの数が上限を超えないように刻みを選ぶ', () => {
    expect(timeTicks(0, 300_000, 6).length).toBeLessThanOrEqual(6)
    expect(timeTicks(0, 10_000, 6).length).toBeLessThanOrEqual(6)
    expect(timeTicks(0, 1_000, 6).length).toBeLessThanOrEqual(6)
  })

  it('いちばん粗い刻みでも収まらなければ、そのまま使う（安全弁）', () => {
    // **空にしない。** 目盛りが 1 つも無い絵は、時間が読めないだけの絵になる。
    expect(timeTicks(0, 3_600_000, 2).length).toBeGreaterThan(0)
  })

  it('窓が逆向き・幅ゼロ・目盛り 0 個なら空', () => {
    expect(timeTicks(100, 100, 6)).toEqual([])
    expect(timeTicks(200, 100, 6)).toEqual([])
    expect(timeTicks(0, 1000, 0)).toEqual([])
  })
})

describe('formatClock', () => {
  it('時刻を hh:mm:ss で出す', () => {
    // vitest は TZ=Asia/Tokyo で走る（`vitest.config.ts`）。
    const at = new Date('2026-09-28T14:03:07.850+09:00').getTime()

    expect(formatClock(at, false)).toBe('14:03:07')
  })

  it('窓が短いときは小数第 1 位まで出す', () => {
    const at = new Date('2026-09-28T14:03:07.850+09:00').getTime()

    expect(formatClock(at, true)).toBe('14:03:07.8')
  })

  it('読めない時刻は印を出す', () => {
    expect(formatClock(Number.NaN, false)).toBe('—')
  })
})

describe('formatGal', () => {
  it('大きいほど桁を落とす', () => {
    // 重力が乗った軸は 980 付近になるので、小数 2 桁を出しても読む意味が無い。
    expect(formatGal(980.665)).toBe('981')
    expect(formatGal(12.34)).toBe('12.3')
    expect(formatGal(1.234)).toBe('1.23')
    expect(formatGal(-1.234)).toBe('-1.23')
  })

  it('値が無いときは印を出す（0 と書かない）', () => {
    expect(formatGal(null)).toBe('—')
    expect(formatGal(Number.NaN)).toBe('—')
  })
})

describe('needsTenths', () => {
  it('窓が 10 秒より短いときだけ小数を付ける', () => {
    expect(needsTenths(5_000)).toBe(true)
    expect(needsTenths(10_000)).toBe(false)
    expect(needsTenths(300_000)).toBe(false)
  })
})

describe('colorForIndex', () => {
  it('本数が色数を超えたら巡回する', () => {
    expect(colorForIndex(0)).toBe(SENSOR_COLORS[0])
    expect(colorForIndex(SENSOR_COLORS.length)).toBe(SENSOR_COLORS[0])
  })

  it('負の添字でも色を返す（安全弁）', () => {
    expect(SENSOR_COLORS).toContain(colorForIndex(-1))
  })
})
