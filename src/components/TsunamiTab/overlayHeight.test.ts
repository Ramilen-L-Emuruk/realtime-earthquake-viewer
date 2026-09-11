import { describe, it, expect } from 'vitest'
import {
  commentsOverlayMaxHeight,
  canShowCommentsOverlay,
  COMMENTS_OVERLAY_GAP,
  COMMENTS_MIN_HEIGHT,
} from './overlayHeight'

// バナーから開く付加文の面の高さ（→ docs/spec/tsunami-spec.md §9）。
//
// **この数値はブラウザで描かないと出てこない**ため、コンポーネントの中に置いていた頃は
// テストで押さえられず、同じ箇所に 3 巡続けて指摘が出た（床を足す → 床が残りを超える →
// 床を外す）。外へ出したのでここで固定する。
describe('commentsOverlayMaxHeight', () => {
  // 正: 通常の上下分割。実測値（パネル 342px・バナー 182px）で残りが上限になる。
  it('パネルからバナーと隙間を引いた残りを返す', () => {
    expect(commentsOverlayMaxHeight(342, 182)).toBe(342 - 182 - COMMENTS_OVERLAY_GAP)
  })

  // 対照: まだ測れていない。上限を付けずに呼び出し側へ判断を渡す。
  it('測れていなければ undefined', () => {
    expect(commentsOverlayMaxHeight(0, 182)).toBeUndefined()
  })

  // 安全弁: パネルを縮めてバナーが入りきらなくなっても、負の上限を返さない。
  it('残りが無くても負にならない', () => {
    expect(commentsOverlayMaxHeight(150, 182)).toBe(0)
  })

  // 安全弁: 床を置かない。かつては 120px の床を置いていたが、パネルを縮めた実測値
  // （パネル 243px・バナー 182px）では残りが 53px しかなく、床の方が大きくなって
  // パネルを 67px はみ出していた。
  it('狭いときに下限へ引き上げない', () => {
    const maxHeight = commentsOverlayMaxHeight(243, 182)
    expect(maxHeight).toBe(243 - 182 - COMMENTS_OVERLAY_GAP)
    expect(maxHeight).toBeLessThan(120)
  })
})

describe('canShowCommentsOverlay', () => {
  // 正: 2 行ぶん入るなら開かせる。
  it('最低の高さがあれば開かせる', () => {
    expect(canShowCommentsOverlay(COMMENTS_MIN_HEIGHT)).toBe(true)
    expect(canShowCommentsOverlay(143)).toBe(true)
  })

  // 対照: 1 行も見えない面は開かせない。開いても矢印が変わるだけで何も起きない。
  it('最低の高さに満たなければ開かせない', () => {
    expect(canShowCommentsOverlay(COMMENTS_MIN_HEIGHT - 1)).toBe(false)
    expect(canShowCommentsOverlay(0)).toBe(false)
  })

  // 安全弁: 測る前は開かせる側へ倒す。閉じると表示直後だけ押せない入口になる。
  it('まだ測れていなければ開かせる', () => {
    expect(canShowCommentsOverlay(undefined)).toBe(true)
  })
})
