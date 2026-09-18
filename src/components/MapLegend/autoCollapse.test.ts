import { describe, it, expect } from 'vitest'
import { isMapAreaShort, LEGEND_AUTO_COLLAPSE_MAP_HEIGHT_PX } from './autoCollapse'

describe('isMapAreaShort', () => {
  it('境界の手前だけを「低い」と見なす', () => {
    expect(isMapAreaShort(LEGEND_AUTO_COLLAPSE_MAP_HEIGHT_PX - 1)).toBe(true)
    expect(isMapAreaShort(LEGEND_AUTO_COLLAPSE_MAP_HEIGHT_PX)).toBe(false)
    expect(isMapAreaShort(LEGEND_AUTO_COLLAPSE_MAP_HEIGHT_PX + 1)).toBe(false)
  })

  it('上下分割のモバイル縦（地図 387px）は畳む側に入り、タブレット縦（同 700px）は入らない', () => {
    expect(isMapAreaShort(387)).toBe(true)
    expect(isMapAreaShort(700)).toBe(false)
  })

  it('測れていない値では判定しない（偽ではなく undefined を返す）', () => {
    // 0 は上下分割の折りたたみの途中などで来る。偽を返すと「低くない」と決めてしまう。
    expect(isMapAreaShort(0)).toBeUndefined()
    expect(isMapAreaShort(-1)).toBeUndefined()
    expect(isMapAreaShort(Number.NaN)).toBeUndefined()
    expect(isMapAreaShort(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(isMapAreaShort(undefined)).toBeUndefined()
  })
})
