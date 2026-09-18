import { describe, it, expect, beforeEach } from 'vitest'
import { redrawIntervalMs, MOUNT_HEALTH_ID } from './DayNightGL'
import { DAY_NIGHT_LAYER_ID, DAY_NIGHT_LAYER_LABEL } from './gl/dayNightLayer'
import {
  clearRenderFailure,
  getRenderHealth,
  reportRenderFailure,
  resetRenderHealthForTest,
} from '../../utils/renderHealth'

/** 太陽が画面上で動く速さ（物理ピクセル／ミリ秒）。テスト側で独立に組み立てる。 */
function sunPixelsPerMs(zoom: number, dpr: number): number {
  const pxPerDeg = (512 * Math.pow(2, zoom) * dpr) / 360
  return (pxPerDeg * 360) / 86400000
}

describe('redrawIntervalMs', () => {
  it('寄るほど間隔が短くなる', () => {
    let previous = Infinity
    for (const zoom of [3, 4, 5, 6, 7]) {
      const ms = redrawIntervalMs(zoom, 1)
      expect(ms).toBeLessThan(previous)
      previous = ms
    }
  })

  it('境目が動く距離が、どのズームでもおおむね一定になる', () => {
    // 正。間隔 × 動く速さ ＝ 動く距離。上限・下限に当たらない範囲で見る。
    for (const zoom of [4, 5, 6] as const) {
      const moved = redrawIntervalMs(zoom, 1) * sunPixelsPerMs(zoom, 1)
      expect(moved).toBeCloseTo(2, 6)
    }
  })

  it('引いた画では上限で頭打ちになる', () => {
    // 対照。ここで上限を外すと、全球を眺めているだけで毎秒描き直すことになる。
    expect(redrawIntervalMs(0, 1)).toBe(60000)
    expect(redrawIntervalMs(1, 1)).toBe(60000)
    expect(redrawIntervalMs(2, 1)).toBe(60000)
  })

  it('寄った画でも下限を下回らない', () => {
    // 安全弁。上限と下限の両方を置かないと、寄るほど描き直しが際限なく増える。
    for (const zoom of [10, 14, 18, 22]) {
      expect(redrawIntervalMs(zoom, 1)).toBe(1000)
    }
  })

  it('画素密度が高い端末では間隔が短くなる', () => {
    // 同じズームでも物理ピクセルでは倍動くので、半分の間隔で描き直す。
    const single = redrawIntervalMs(5, 1)
    const double = redrawIntervalMs(5, 2)
    expect(double).toBeCloseTo(single / 2, 6)
  })

  it('読めない値では上限へ倒れる（描き直しが止まらない側）', () => {
    // 安全弁。0 や NaN を返すと `setInterval` の判定が常に真になって毎周回描き直すか、
    // 逆に永久に描き直さなくなる。どちらでもない「いちばん緩い正常値」へ寄せる。
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(redrawIntervalMs(bad, 1)).toBe(60000)
      expect(redrawIntervalMs(5, bad)).toBe(60000)
    }
    expect(redrawIntervalMs(5, 0)).toBe(60000)
    expect(redrawIntervalMs(5, -1)).toBe(60000)
  })
})

// 「レイヤーを載せられなかった」は React 側が報告し、「シェーダーを用意できない」は
// `render()` の中が報告する。**報告する主体が 2 つあるので鍵を分ける** —— 同じ鍵にすると、
// 取り下げは互いの内部状態（自分が報告したか）で決めるため、載せられなかった側を
// 取り下げられる者がいなくなり、画面の印がリロードまで残る。
describe('描けなかったことを画面へ出す鍵', () => {
  beforeEach(() => {
    resetRenderHealthForTest()
  })

  it('マウントの失敗は描画の失敗と別の鍵で報告する', () => {
    expect(MOUNT_HEALTH_ID).not.toBe(DAY_NIGHT_LAYER_ID)
  })

  it('マウントの失敗は、報告した側が取り下げられる', () => {
    // 正。載せられなかったときは `render()` が一度も呼ばれないので、取り下げはここにしか置けない。
    reportRenderFailure(MOUNT_HEALTH_ID, DAY_NIGHT_LAYER_LABEL, 'draw')
    expect(getRenderHealth().broken).toEqual([DAY_NIGHT_LAYER_LABEL])
    clearRenderFailure(MOUNT_HEALTH_ID, 'draw')
    expect(getRenderHealth().broken).toEqual([])
  })

  it('レイヤー側の取り下げはマウントの失敗も消す', () => {
    // 安全弁。載って描けているなら「載せられなかった」は嘘なので、消える側が正しい
    //（`utils/renderHealth.ts` が `<鍵>:` の前方一致でも消すことに依っている）。
    reportRenderFailure(MOUNT_HEALTH_ID, DAY_NIGHT_LAYER_LABEL, 'draw')
    clearRenderFailure(DAY_NIGHT_LAYER_ID, 'draw')
    expect(getRenderHealth().broken).toEqual([])
  })

  it('マウントの取り下げは描画の失敗を消さない', () => {
    // 対照。載せられたことは、描けるようになった証拠ではない。
    reportRenderFailure(DAY_NIGHT_LAYER_ID, DAY_NIGHT_LAYER_LABEL, 'draw')
    clearRenderFailure(MOUNT_HEALTH_ID, 'draw')
    expect(getRenderHealth().broken).toEqual([DAY_NIGHT_LAYER_LABEL])
  })
})
