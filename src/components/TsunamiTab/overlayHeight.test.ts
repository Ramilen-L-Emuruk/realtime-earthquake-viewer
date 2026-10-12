import { describe, it, expect } from 'vitest'
import {
  commentsOverlayMaxHeight,
  canShowCommentsOverlay,
  COMMENTS_OVERLAY_GAP,
  COMMENTS_MIN_HEIGHT,
  isBannerSticky,
  BANNER_STICKY_MIN_ROOM_PX,
} from './overlayHeight'

// バナーを貼り付けるか（→ docs/spec/tsunami-spec.md §9「スクロールの自動制御」）。
// 実測（DMDSS 版・大津波警報テスト）はバナー 182px。パネルは画面と比率で決まる。
describe('isBannerSticky', () => {
  // 正: 比率 0.2 の実測（パネル 128px）。貼ればパネルが埋まり、行に一度も届かない。
  it('行の居場所が残らないなら貼り付けない', () => {
    expect(isBannerSticky(128, 182)).toBe(false)
    expect(isBannerSticky(182 + BANNER_STICKY_MIN_ROOM_PX - 1, 182)).toBe(false)
  })

  // 対照: 境界ちょうどからは貼る。既定の比率の実測（縦 640px でパネル 288px・縦 844px で 380px）は
  // どちらも従来どおり貼り付く —— 割合（半分）で切っていた頃は 288px の側が外れていた。
  it('行の居場所が残るなら貼り付ける', () => {
    expect(isBannerSticky(182 + BANNER_STICKY_MIN_ROOM_PX, 182)).toBe(true)
    expect(isBannerSticky(288, 182)).toBe(true)
    expect(isBannerSticky(380, 182)).toBe(true)
  })

  // 安全弁: 測る前（0）は貼る側へ倒す。表示直後の数フレームだけ貼り付けが外れて見えないように。
  it('まだ測れていなければ貼り付ける', () => {
    expect(isBannerSticky(0, 182)).toBe(true)
    expect(isBannerSticky(180, 0)).toBe(true)
  })
})

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
