import { describe, it, expect } from 'vitest'
import {
  arrivalMetrics, popupOffset, RING_RADIUS, RING_STROKE, CENTER_DOT_RADIUS, POPUP_OFFSET_X,
} from './tsunamiArrivalMarker'

// 到達確認マーカーの寸法計算。観測棒（tsunamiObsBar.test.ts）と対にしてある。
// あちらは波高に応じて高さが変わるが、こちらは**倍率だけで決まる**——量を示さない印なので、
// 観測点ごとに大きさが変わってはいけない。

describe('arrivalMetrics', () => {
  it('等倍では基準値をそのまま返す', () => {
    expect(arrivalMetrics(1)).toEqual({
      r: RING_RADIUS,
      stroke: RING_STROKE,
      dot: CENTER_DOT_RADIUS,
      size: RING_RADIUS * 2 + RING_STROKE,
    })
  })

  it('倍率を上げると半径・線幅・中心点がすべて同じ比で伸びる', () => {
    expect(arrivalMetrics(2.5)).toEqual({ r: 17.5, stroke: 5, dot: 3.75, size: 40 })
  })

  it('倍率を下げても同じ比で縮む（設定の下限 0.5）', () => {
    expect(arrivalMetrics(0.5)).toEqual({ r: 3.5, stroke: 1, dot: 0.75, size: 8 })
  })

  it('設定の上限 3 でも各値が比例する', () => {
    expect(arrivalMetrics(3)).toEqual({ r: 21, stroke: 6, dot: 4.5, size: 48 })
  })

  // 外形は「輪の直径 + 線幅」。DOM 側は inset:0 の輪をこの一辺の箱に収めるので、
  // ここがずれると輪が切れる。
  it('外形の一辺は輪の直径に線幅を足した値になる', () => {
    for (const scale of [0.5, 1, 2, 3]) {
      const m = arrivalMetrics(scale)
      expect(m.size).toBe(m.r * 2 + m.stroke)
    }
  })

  // 観測棒と違い、寸法は観測点の値に依存しない（引数が倍率だけであることを型が保証している）。
  it('同じ倍率なら常に同じ寸法を返す', () => {
    expect(arrivalMetrics(2)).toEqual(arrivalMetrics(2))
  })
})

describe('popupOffset', () => {
  it('輪の右脇に出す（横は基準値 + 半径、縦は 0）', () => {
    expect(popupOffset(1)).toEqual([POPUP_OFFSET_X + RING_RADIUS, 0])
  })

  it('倍率を上げると半径のぶんだけ横へ広がる（基準値は倍率に連動しない）', () => {
    expect(popupOffset(2)).toEqual([POPUP_OFFSET_X + RING_RADIUS * 2, 0])
  })

  // マーカーは中心アンカー（TsunamiArrivalMarkersGL の anchor:'center'）なので、
  // 観測棒（底辺アンカーで上方向へずらす）と違い縦のずらしを持たない。
  it('縦オフセットは倍率によらず 0', () => {
    for (const scale of [0.5, 1, 2.5, 3]) expect(popupOffset(scale)[1]).toBe(0)
  })
})
