import { describe, it, expect } from 'vitest'
import {
  type QuakeOverlay, toggleLpgmOverlay, toggleDistributionOverlay,
  closeLpgmOverlay, closeEewLpgmOverlay, shouldCloseOverlayOnSelection,
} from './quakeOverlay'

const lpgm = (eventId: string, source: 'earthquake' | 'eew' = 'earthquake'): QuakeOverlay =>
  ({ kind: 'lpgm', eventId, source })
const distribution = (eventKey: string): QuakeOverlay => ({ kind: 'distribution', eventKey })

describe('追加表示は同時に 1 つだけ（長周期と震度分布の排他）', () => {
  // 正: 一方を開くと他方が閉じる
  it('震度分布を開いている状態で長周期を開くと、分布は閉じる', () => {
    expect(toggleLpgmOverlay(distribution('k1'), '20240101160010', 'earthquake'))
      .toEqual(lpgm('20240101160010'))
  })

  it('長周期を開いている状態で震度分布を開くと、長周期は閉じる', () => {
    expect(toggleDistributionOverlay(lpgm('20240101160010'), 'k1')).toEqual(distribution('k1'))
  })

  // 対照: 同じものを再度押したときはトグルとして閉じる（切り替えではない）
  it('表示中の長周期をもう一度押すと閉じる', () => {
    expect(toggleLpgmOverlay(lpgm('20240101160010'), '20240101160010', 'earthquake')).toBeNull()
  })

  it('表示中の震度分布をもう一度押すと閉じる', () => {
    expect(toggleDistributionOverlay(distribution('k1'), 'k1')).toBeNull()
  })

  it('別の地震の長周期を押したときは切り替える（閉じない）', () => {
    expect(toggleLpgmOverlay(lpgm('20240101160010'), '20240101174200', 'earthquake'))
      .toEqual(lpgm('20240101174200'))
  })

  it('別の地震の震度分布を押したときは切り替える（閉じない）', () => {
    expect(toggleDistributionOverlay(distribution('k1'), 'k2')).toEqual(distribution('k2'))
  })

  // 同じ地震を地震カードと EEW カードの両方から開ける。どちらから押しても
  // 「表示中のものを押したら閉じる」——source で判定を分けるとトグルが切り替えに化ける。
  it('EEW カードから開いた長周期を地震カード側から押しても閉じる', () => {
    expect(toggleLpgmOverlay(lpgm('20240101160010', 'eew'), '20240101160010', 'earthquake')).toBeNull()
  })
})

describe('閉じる操作は対象を絞る', () => {
  // 正: 長周期を閉じる
  it('長周期を閉じる操作は長周期を落とす', () => {
    expect(closeLpgmOverlay(lpgm('20240101160010'))).toBeNull()
  })

  // 安全弁: 震度分布まで閉じない（「長周期を閉じる」以上のことをしない）
  it('長周期を閉じる操作は震度分布に触らない', () => {
    const prev = distribution('k1')
    expect(closeLpgmOverlay(prev)).toBe(prev)
  })

  // 正: EEW が消えたら EEW 由来の長周期を落とす
  it('EEW 由来の長周期は EEW 側の解除で落ちる', () => {
    expect(closeEewLpgmOverlay(lpgm('20240101160010', 'eew'))).toBeNull()
  })

  // 安全弁: 地震カードから開いた長周期は EEW 側の解除で落とさない
  it('地震カードから開いた長周期は EEW 側の解除で落とさない', () => {
    const prev = lpgm('20240101160010', 'earthquake')
    expect(closeEewLpgmOverlay(prev)).toBe(prev)
  })

  it('EEW 側の解除は震度分布に触らない', () => {
    const prev = distribution('k1')
    expect(closeEewLpgmOverlay(prev)).toBe(prev)
  })

  it('何も開いていなければどの閉じる操作も null のまま', () => {
    expect(closeLpgmOverlay(null)).toBeNull()
    expect(closeEewLpgmOverlay(null)).toBeNull()
  })
})

describe('追加表示を閉じるのは別の地震へ移るときだけ', () => {
  // 正: 別の地震へ移ったら閉じる（症状: 分布を開いたまま別の地震へ移り、そのカードへ
  // 戻ると復活していた）
  it('選択が別の地震へ移ったら閉じる', () => {
    expect(shouldCloseOverlayOnSelection('20240101160010', '20240101174200')).toBe(true)
  })

  // 対照: 同じ地震の続報では閉じない。続報は発生から 10 分以上あとにも届くため、
  // ここを「受信のたびに閉じる」にすると開いた分布・階級が数分後に勝手に消える
  it('同じ地震の続報では閉じない', () => {
    expect(shouldCloseOverlayOnSelection('20240101160010', '20240101160010')).toBe(false)
  })

  // 安全弁: 選択が外れたときも閉じる（取消しで選択を解いた地震の表示は残さない）
  it('選択が外れたら閉じる', () => {
    expect(shouldCloseOverlayOnSelection('20240101160010', null)).toBe(true)
  })

  it('選択が無い状態から選んだときも閉じる（前の地震の表示を持ち込まない）', () => {
    expect(shouldCloseOverlayOnSelection(null, '20240101160010')).toBe(true)
  })

  it('どちらも選択が無いなら閉じない', () => {
    expect(shouldCloseOverlayOnSelection(null, null)).toBe(false)
  })
})
