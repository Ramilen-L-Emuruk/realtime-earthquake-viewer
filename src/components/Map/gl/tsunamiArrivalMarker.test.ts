import { describe, it, expect } from 'vitest'
import {
  arrivalMetrics, popupOffset, BADGE_RADIUS, BADGE_RING, MIN_CORE_RATIO, POPUP_OFFSET_X,
} from './tsunamiArrivalMarker'
import { BAR_WIDTH, BAR_FOOT } from './tsunamiObsBar'

// 到達確認マーカーの寸法計算。観測棒（tsunamiObsBar.test.ts）と対にしてある。
// あちらは波高に応じて高さが変わるが、こちらは**倍率だけで決まる**——量を示さない印なので、
// 観測点ごとに大きさが変わってはいけない。

describe('arrivalMetrics', () => {
  it('等倍では基準値をそのまま返す', () => {
    expect(arrivalMetrics(1)).toEqual({ r: BADGE_RADIUS, ring: BADGE_RING, size: BADGE_RADIUS * 2 })
  })

  it('倍率を上げると半径と外形が同じ比で伸びる', () => {
    expect(arrivalMetrics(2.5)).toEqual({ r: 11.25, ring: BADGE_RING, size: 22.5 })
  })

  it('倍率を下げると半径は同じ比で縮み、白フチは芯を残すため細くなる（設定の下限 0.5）', () => {
    const m = arrivalMetrics(0.5)
    expect(m.r).toBe(2.25)
    expect(m.size).toBe(4.5)
    // 芯の取り分（2/3）から導く値なので、割り算の丸めが乗る。ここだけ実数比較にする。
    expect(m.ring).toBeCloseTo(0.75, 10)
  })

  it('設定の上限 3 でも比例する', () => {
    expect(arrivalMetrics(3)).toEqual({ r: 13.5, ring: BADGE_RING, size: 27 })
  })

  // 寸法は観測棒から導く。単独の数字にすると棒より大きく見え、値を持たない印のほうが目立つ
  // （実機で一度そうなった）。この 2 つが崩れたら、棒との釣り合いを決め直したということ。
  it('等倍の直径は観測棒の台座の幅に等しい（海岸線での専有幅が棒と揃う）', () => {
    expect(arrivalMetrics(1).size).toBe(BAR_WIDTH + BAR_FOOT)
  })

  it('等倍で白フチを内側に引いた残りの芯は、観測棒の本体幅に等しい', () => {
    const m = arrivalMetrics(1)
    expect(m.size - m.ring * 2).toBe(BAR_WIDTH)
  })

  // 枠線・影は装飾のヘアラインとして倍率の対象外（settings-pwa-spec.md §2）。
  // 半径だけを伸ばして白フチも太らせると、この規約から外れる。
  it('等倍以上では白フチが太らない', () => {
    for (const scale of [1, 1.5, 2, 3]) expect(arrivalMetrics(scale).ring).toBe(BADGE_RING)
  })

  // 対照: 下限側だけは細らせる。上限に張り付いたままだと、倍率 0.5 で灰色の芯が 1.5px しか残らず、
  // 「ほぼ白い丸」になって色が担う「値が無い」の合図が消える。
  it('等倍を下回ると白フチが細くなる', () => {
    expect(arrivalMetrics(0.75).ring).toBeLessThan(BADGE_RING)
    expect(arrivalMetrics(0.5).ring).toBeLessThan(arrivalMetrics(0.75).ring)
  })

  // 安全弁: どの倍率でも芯の取り分を割り込まない。上の 2 つを両方いじっても、ここが残っていれば
  // 「フチだけの丸」にはならない。
  it('どの倍率でも芯は直径の 2/3 以上を保つ', () => {
    for (const scale of [0.5, 0.75, 1, 1.5, 2, 3]) {
      const m = arrivalMetrics(scale)
      expect(m.size - m.ring * 2).toBeGreaterThanOrEqual(m.size * MIN_CORE_RATIO)
    }
  })

  // 白フチは丸の内側に描く（DOM は box-sizing:border-box、共有カードは r - ring/2 で stroke）。
  // 外形に足すと、画面と画像で大きさがずれる。
  it('外形は直径のみで、白フチのぶんを足さない', () => {
    for (const scale of [0.5, 1, 2, 3]) {
      const m = arrivalMetrics(scale)
      expect(m.size).toBe(m.r * 2)
    }
  })

  // 観測棒と違い、寸法は観測点の値に依存しない（引数が倍率だけであることを型が保証している）。
  it('同じ倍率なら常に同じ寸法を返す', () => {
    expect(arrivalMetrics(2)).toEqual(arrivalMetrics(2))
  })
})

describe('popupOffset', () => {
  it('丸の右脇に出す（横は基準値 + 半径、縦は 0）', () => {
    expect(popupOffset(1)).toEqual([POPUP_OFFSET_X + BADGE_RADIUS, 0])
  })

  it('倍率を上げると半径のぶんだけ横へ広がる（基準値は倍率に連動しない）', () => {
    expect(popupOffset(2)).toEqual([POPUP_OFFSET_X + BADGE_RADIUS * 2, 0])
  })

  // マーカーは中心アンカー（TsunamiArrivalMarkersGL の anchor:'center'）なので、
  // 観測棒（底辺アンカーで上方向へずらす）と違い縦のずらしを持たない。
  it('縦オフセットは倍率によらず 0', () => {
    for (const scale of [0.5, 1, 2.5, 3]) expect(popupOffset(scale)[1]).toBe(0)
  })
})
