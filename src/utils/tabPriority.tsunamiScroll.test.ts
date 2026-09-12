// 津波カードの先頭復帰を出すかどうかの判定テスト。
//
// 直したかった症状: 津波優先の既定タブで津波カードを読んでいると、無操作 30 秒のアイドル復帰の
// たびにスクロール位置が先頭へ戻されていた。カードが長いほど効き、新しく届いた観測値の行が
// 静止位置では画面外に置かれる（読み上げ追従が送っている間だけ見え、復帰で連れ戻される）。
//
// 原因は復帰の経路が独自に先頭復帰を要求していたことで、そちらには「タブが実際に変わったときだけ」
// の条件が掛かっていなかった。判定を 1 つへ集約し、復帰もこの述語を通す形にした。
import { describe, it, expect } from 'vitest'
import { TAB_PRIORITY, shouldResetTsunamiScroll } from './tabPriority'

// 復帰系（アイドル復帰・EEW 全解除・揺れ検知終了・揺れの可能性の失効）が `forceTab` へ渡す優先度。
const REVERT = TAB_PRIORITY.quake

describe('shouldResetTsunamiScroll', () => {
  it('正: 他のタブから自動で津波タブへ連れてきたら先頭へ戻す', () => {
    expect(shouldResetTsunamiScroll('tsunami', TAB_PRIORITY.tsunami, 'earthquake')).toBe(true)
  })

  it('正: 既定の状態への復帰も、他のタブからなら先頭へ戻す', () => {
    expect(shouldResetTsunamiScroll('tsunami', REVERT, 'realtime')).toBe(true)
  })

  it('対照: 既に津波タブを表示しているなら戻さない（続報・読み上げ追従で画面が飛ばない）', () => {
    expect(shouldResetTsunamiScroll('tsunami', TAB_PRIORITY.tsunami, 'tsunami')).toBe(false)
  })

  it('対照: 既に津波タブを表示しているなら、既定の状態への復帰でも戻さない', () => {
    // 津波優先の既定タブで津波を見ている間、アイドル復帰はこの形で繰り返し通る。
    expect(shouldResetTsunamiScroll('tsunami', REVERT, 'tsunami')).toBe(false)
  })

  it('対照: 手動で開いたときは戻さない（読んでいた場所を保つ）', () => {
    expect(shouldResetTsunamiScroll('tsunami', TAB_PRIORITY.manual, 'earthquake')).toBe(false)
  })

  it('安全弁: 移動先が津波タブ以外なら、どの優先度でも津波カードに触らない', () => {
    for (const priority of Object.values(TAB_PRIORITY)) {
      expect(shouldResetTsunamiScroll('realtime', priority, 'tsunami')).toBe(false)
      expect(shouldResetTsunamiScroll('earthquake', priority, 'tsunami')).toBe(false)
    }
  })

  it('安全弁: 手動選択の除外は津波タブへの移動にだけ効き、他の条件を緩めない', () => {
    // 手動以外は通る、という対称を固定する。`manual` だけを弾く形が崩れたら落ちる。
    for (const priority of Object.values(TAB_PRIORITY)) {
      expect(shouldResetTsunamiScroll('tsunami', priority, 'catalog'))
        .toBe(priority !== TAB_PRIORITY.manual)
    }
  })
})
