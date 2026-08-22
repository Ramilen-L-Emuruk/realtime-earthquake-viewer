import { describe, it, expect } from 'vitest'
import {
  computePlacement,
  tipMaxWidth,
  TIP_GAP_PX,
  TIP_MAX_WIDTH_REM,
  VIEWPORT_MARGIN_PX,
  type AnchorRect,
  type Viewport,
} from './tipPlacement'

/** PC を想定したビューポート。 */
const DESKTOP: Viewport = { width: 1280, height: 900 }
/** スマホ縦を想定したビューポート。 */
const PHONE: Viewport = { width: 375, height: 812 }

function anchor(left: number, top: number, height = 20): AnchorRect {
  return { left, top, bottom: top + height }
}

describe('tipMaxWidth', () => {
  it('画面に余裕があれば倍率どおりの幅（18rem）になる', () => {
    expect(tipMaxWidth(DESKTOP.width, 16)).toBe(TIP_MAX_WIDTH_REM * 16)
  })

  it('UI 倍率を上げると幅も追従する', () => {
    // ルートの font-size を変える設計なので、rem 基準の幅は倍率に比例する
    expect(tipMaxWidth(DESKTOP.width, 40)).toBe(TIP_MAX_WIDTH_REM * 40)
  })

  it('画面幅に収まらない倍率では画面幅で頭打ちになる', () => {
    // 18rem × 40px = 720px は 375px の画面に収まらない
    expect(tipMaxWidth(PHONE.width, 40)).toBe(PHONE.width - VIEWPORT_MARGIN_PX * 2)
  })
})

describe('computePlacement: 縦の配置', () => {
  it('下に収まるときは行の下へ置く（反転しない）', () => {
    const a = anchor(100, 200)
    const p = computePlacement(a, 60, 288, DESKTOP)
    expect(p.top).toBe(a.bottom + TIP_GAP_PX)
  })

  it('下に収まらないときは行の上へ反転する', () => {
    // 画面下端に近い行 + 高い吹き出し
    const a = anchor(100, 800)
    const tipHeight = 146
    const p = computePlacement(a, tipHeight, 288, DESKTOP)
    expect(p.top).toBe(a.top - TIP_GAP_PX - tipHeight)
    // 反転した結果、吹き出しの下端が行の上端を越えない
    expect(p.top + tipHeight).toBeLessThanOrEqual(a.top)
  })

  it('境界のちょうど手前では反転しない（下に収まる限り下へ出す）', () => {
    const tipHeight = 100
    // bottom + GAP + height がちょうど「画面高 - 余白」に等しくなる位置
    const bottom = DESKTOP.height - VIEWPORT_MARGIN_PX - tipHeight - TIP_GAP_PX
    const a = { left: 100, top: bottom - 20, bottom }
    const p = computePlacement(a, tipHeight, 288, DESKTOP)
    expect(p.top).toBe(bottom + TIP_GAP_PX)
  })

  it('上下どちらにも収まらないときは画面内へクランプする', () => {
    // 画面高 900 に対して 880 の吹き出し（上下どちらにも入らない）
    const a = anchor(100, 500)
    const tipHeight = 880
    const p = computePlacement(a, tipHeight, 288, DESKTOP)
    expect(p.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX)
    expect(p.top).toBe(DESKTOP.height - VIEWPORT_MARGIN_PX - tipHeight)
  })

  it('画面高より高い吹き出しでも上端が画面外へ出ない（安全弁）', () => {
    const a = anchor(100, 500)
    const p = computePlacement(a, 2000, 288, DESKTOP)
    expect(p.top).toBe(VIEWPORT_MARGIN_PX)
  })
})

describe('computePlacement: 横の配置', () => {
  it('収まるときは基準の左端に揃える', () => {
    const p = computePlacement(anchor(100, 200), 60, 288, DESKTOP)
    expect(p.left).toBe(100)
  })

  it('右にはみ出す分だけ左へ寄せる', () => {
    // 右パネル内の行から 288px 幅を出すと画面右端を越える位置
    const p = computePlacement(anchor(1100, 200), 60, 288, DESKTOP)
    expect(p.left).toBe(DESKTOP.width - VIEWPORT_MARGIN_PX - 288)
    expect(p.left + 288).toBeLessThanOrEqual(DESKTOP.width - VIEWPORT_MARGIN_PX)
  })

  it('左にもはみ出す場合は左の余白位置で止める（安全弁）', () => {
    // 画面幅より広い吹き出しを渡しても左端が負にならない
    const p = computePlacement(anchor(10, 200), 60, 2000, PHONE)
    expect(p.left).toBe(VIEWPORT_MARGIN_PX)
  })

  it('スマホ縦でも画面内に収まる', () => {
    const maxWidth = tipMaxWidth(PHONE.width, 16)
    const p = computePlacement(anchor(29, 560), 146, maxWidth, PHONE)
    expect(p.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX)
    expect(p.left + maxWidth).toBeLessThanOrEqual(PHONE.width - VIEWPORT_MARGIN_PX)
  })
})

describe('computePlacement: 定数の不変条件', () => {
  it('間隔は余白より小さい（反転の判定が余白に飲まれない）', () => {
    // TIP_GAP_PX が VIEWPORT_MARGIN_PX を超えると、下に出す判定と
    // クランプ位置の関係が崩れて「反転したのに画面外」が起こりうる
    expect(TIP_GAP_PX).toBeLessThanOrEqual(VIEWPORT_MARGIN_PX)
  })
})
