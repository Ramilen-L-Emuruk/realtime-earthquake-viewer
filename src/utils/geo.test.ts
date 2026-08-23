import { describe, it, expect } from 'vitest'
import { hasKnownEpicenter } from './geo'

// 「震源の位置が判っているか」の判定。**否定形で書くと NaN が素通りする**ため、この述語に
// 寄せている（`geo.ts` の注記）。素通りした NaN は地図の寄り先に渡り、MapLibre が例外を投げる。
describe('hasKnownEpicenter', () => {
  it('通常の座標は「位置あり」', () => {
    expect(hasKnownEpicenter(37.5, 137.2)).toBe(true)
    // 南半球・西半球（遠地地震）も通す。-200 は「あり得ない値」としてのセンチネル。
    expect(hasKnownEpicenter(-33.4, -70.6)).toBe(true)
  })

  it('DMDATA・P2PQuake の位置不明センチネル（-200）を弾く', () => {
    expect(hasKnownEpicenter(-200, -200)).toBe(false)
    // 片方だけでも位置は決まらない。
    expect(hasKnownEpicenter(37.5, -200)).toBe(false)
    expect(hasKnownEpicenter(-200, 137.2)).toBe(false)
  })

  it('Yahoo 強震モニタの座標欠落（NaN）を弾く', () => {
    // `services/kyoshin.ts` の parseCoord は空文字を NaN にする。NaN はどの比較でも false に
    // なるため、`lat <= -200` のような否定形の判定では弾けない（このテストの主眼）。
    expect(hasKnownEpicenter(NaN, NaN)).toBe(false)
    expect(hasKnownEpicenter(37.5, NaN)).toBe(false)
    expect(hasKnownEpicenter(NaN, 137.2)).toBe(false)
  })
})
