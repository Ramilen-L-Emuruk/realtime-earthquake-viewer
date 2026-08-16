import { describe, it, expect } from 'vitest'
import { barMetrics, popupOffset, BAR_WIDTH, BAR_FOOT, POPUP_OFFSET_X } from './tsunamiObsBar'
import type { TsunamiObsBar } from '../../../hooks/useTsunamiLayerData'

function makeBar(barPx: number): TsunamiObsBar {
  return {
    name: 'テスト観測点',
    lat: 38.3,
    lng: 141.5,
    barPx,
    color: '#ff2222',
    height: { value: 1.2, description: '1.2m' },
    blinking: false,
  }
}

describe('barMetrics', () => {
  it('等倍では基準値と波高由来の高さをそのまま返す', () => {
    expect(barMetrics(makeBar(80), 1)).toEqual({ w: BAR_WIDTH, foot: BAR_FOOT, barPx: 80 })
  })

  it('倍率を上げると幅・脚・高さがすべて同じ比で伸びる', () => {
    expect(barMetrics(makeBar(80), 2.5)).toEqual({ w: 15, foot: 7.5, barPx: 200 })
  })

  it('倍率を下げても同じ比で縮む（設定の下限 0.5）', () => {
    expect(barMetrics(makeBar(80), 0.5)).toEqual({ w: 3, foot: 1.5, barPx: 40 })
  })

  it('設定の上限 3 でも各値が比例する', () => {
    expect(barMetrics(makeBar(10), 3)).toEqual({ w: 18, foot: 9, barPx: 30 })
  })

  it('実運用の下限（useTsunamiLayerData が OBS_MIN_PX=8 でクランプした値）でも比例する', () => {
    expect(barMetrics(makeBar(8), 2.5).barPx).toBe(20)
  })

  // barPx=0 は実運用では起きない（生成側が 8px を下限にクランプする）。
  // 純粋関数としての防御的な契約確認として置く。
  it('波高 0 のバーは高さ 0 になる（負値にならない）', () => {
    expect(barMetrics(makeBar(0), 2.5).barPx).toBe(0)
  })

  it('幅と脚は波高に依存しない', () => {
    const low = barMetrics(makeBar(8), 2)
    const high = barMetrics(makeBar(400), 2)
    expect(low.w).toBe(high.w)
    expect(low.foot).toBe(high.foot)
  })
})

describe('popupOffset', () => {
  it('縦オフセットはバー高さの半分を上方向（負値）に取る', () => {
    expect(popupOffset(makeBar(80), 1)).toEqual([POPUP_OFFSET_X, -40])
  })

  it('倍率を上げると縦オフセットも同じ比で伸びる', () => {
    expect(popupOffset(makeBar(80), 2.5)).toEqual([POPUP_OFFSET_X, -100])
  })

  it('横オフセットは倍率によらず一定（装飾側の値のため）', () => {
    const scales = [0.5, 1, 2.5, 3]
    expect(scales.map((s) => popupOffset(makeBar(80), s)[0])).toEqual(scales.map(() => POPUP_OFFSET_X))
  })

  it('縦オフセットは barMetrics の高さと整合する', () => {
    const bar = makeBar(123)
    expect(popupOffset(bar, 1.75)[1]).toBe(-barMetrics(bar, 1.75).barPx / 2)
  })

  // 符号（-0 か 0 か）は表示位置に影響しないため問わない。厳密一致で固定すると、
  // 挙動の変わらない式の書き換えでテストだけが落ちる。
  it('波高 0 のバーでは縦オフセットも 0 になる', () => {
    expect(popupOffset(makeBar(0), 2.5)[1]).toBeCloseTo(0)
  })
})
