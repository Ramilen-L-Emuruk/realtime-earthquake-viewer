import { describe, expect, test } from 'vitest'
import { buildTimeTicks } from './timeTicks'

const T0 = 1_791_000_000_000

describe('buildTimeTicks', () => {
  test('地震カード: 左端の 0 に名前、以降は +秒', () => {
    const ticks = buildTimeTicks({ fromMs: T0, toMs: T0 + 60_000, zeroMs: T0, zeroLabel: '発生', widthPx: 360 })
    expect(ticks.map((t) => t.label)).toEqual(['発生', '+10s', '+20s', '+30s', '+40s', '+50s', '+60s'])
    expect(ticks[0]).toMatchObject({ ratio: 0, align: 'left' })
    expect(ticks[ticks.length - 1]).toMatchObject({ ratio: 1, align: 'right' })
  })

  test('地図の下の波形: 右端が 0s、左へ -秒', () => {
    const ticks = buildTimeTicks({ fromMs: T0 - 60_000, toMs: T0, zeroMs: T0, zeroLabel: '0s', widthPx: 400 })
    expect(ticks.map((t) => t.label)).toEqual(['-60s', '-50s', '-40s', '-30s', '-20s', '-10s', '0s'])
    expect(ticks[ticks.length - 1]?.align).toBe('right')
  })

  test('幅が狭ければ刻みを粗くする（文字を重ねない）', () => {
    const ticks = buildTimeTicks({ fromMs: T0, toMs: T0 + 60_000, zeroMs: T0, zeroLabel: '発生', widthPx: 200 })
    // 10 秒刻みだと 33px 間隔で詰まるので 20 秒刻みへ。
    expect(ticks.map((t) => t.label)).toEqual(['発生', '+20s', '+40s', '+60s'])
  })

  // 安全弁: 0 の名前（時刻）は長いので、隣とぶつかるなら隣を落とす。名前は残す。
  test('0 の名前と隣の目盛りが近すぎれば、隣を落とす', () => {
    const ticks = buildTimeTicks({ fromMs: T0, toMs: T0 + 120_000, zeroMs: T0, zeroLabel: '13:26:00', widthPx: 528 })
    // 20 秒刻み（88px）。名前の幅（約 53px）＋余白より遠いので +20s は残る。
    expect(ticks[0].label).toBe('13:26:00')
    expect(ticks.map((t) => t.label)).not.toContain('+10s')
    expect(ticks.map((t) => t.label)).toContain('+20s')
  })

  // 正: 隣を落とす境は 0 の名前の幅で決まる。長い名前なら、短い名前では残る隣も落とす。
  test('0 の名前が長いほど隣を落としやすい', () => {
    const args = { fromMs: T0, toMs: T0 + 60_000, zeroMs: T0, widthPx: 400 } // 10 秒刻み・66px 間隔
    expect(buildTimeTicks({ ...args, zeroLabel: '発生' }).map((t) => t.label)).toContain('+10s')
    expect(buildTimeTicks({ ...args, zeroLabel: '13:26:00' }).map((t) => t.label)).not.toContain('+10s')
  })

  // 正: 詳細の窓で 2 秒まで寄せても目盛りが入る（以前は 5 秒刻みからで 1 本も出なかった）。
  test('短い窓では 1 秒より短い刻みも使う', () => {
    const ticks = buildTimeTicks({ fromMs: T0 + 27_000, toMs: T0 + 29_000, zeroMs: T0, zeroLabel: '発生', widthPx: 500 })
    expect(ticks.map((t) => t.label)).toEqual(['+27s', '+27.5s', '+28s', '+28.5s', '+29s'])
  })

  // 対照: 地震カードの幅と長さでは短い刻みは選ばれない（上の 10 秒刻みのテストと同じ条件）。
  test('長い窓では短い刻みを選ばない', () => {
    const ticks = buildTimeTicks({ fromMs: T0, toMs: T0 + 60_000, zeroMs: T0, zeroLabel: '発生', widthPx: 360 })
    expect(ticks.every((t) => !t.label.includes('.'))).toBe(true)
  })

  test('長さ・幅が不正なら目盛りを出さない', () => {
    expect(buildTimeTicks({ fromMs: T0, toMs: T0, zeroMs: T0, zeroLabel: '発生', widthPx: 300 })).toEqual([])
    expect(buildTimeTicks({ fromMs: T0, toMs: T0 + 60_000, zeroMs: T0, zeroLabel: '発生', widthPx: 0 })).toEqual([])
  })
})

describe('buildTimeTicks（端の寄せ方）', () => {
  // 地震カードの左端は列の幅に丸めて切るので、0 は左端からわずかに内側へずれる。
  // 比で判定すると窓が短いほど中央寄せになり、0 の名前の左半分が切れていた。
  test('0 が左端から列 1 つぶん内側でも左寄せにする', () => {
    const ticks = buildTimeTicks({ fromMs: T0 - 225, toMs: T0 + 60_000, zeroMs: T0, zeroLabel: '発生', widthPx: 360 })
    expect(ticks[0]).toMatchObject({ label: '発生', align: 'left' })
  })

  // 対照: 端から離れた目盛りは中央寄せのまま。
  test('端から離れた目盛りは中央寄せ', () => {
    const ticks = buildTimeTicks({ fromMs: T0, toMs: T0 + 60_000, zeroMs: T0, zeroLabel: '発生', widthPx: 360 })
    expect(ticks.find((t) => t.label === '+30s')?.align).toBe('center')
  })
})
