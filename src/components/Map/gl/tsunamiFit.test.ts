import { describe, it, expect } from 'vitest'
import { decideTsunamiFit, type TsunamiFitInput } from './tsunamiFit'

// 「津波モードに入っていて、発表中の津波があり、直前の変化は既に反映済み」という落ち着いた状態。
// 各テストは、ここから条件を 1 つだけ動かして期待する動作を確かめる。
const settled: TsunamiFitInput = {
  isTsunamiMode: true,
  isUserInteracting: false,
  hasPendingObs: false,
  signature: '岩手県:MajorWarning,宮城県:MajorWarning',
  lastSignature: '岩手県:MajorWarning,宮城県:MajorWarning',
  hasCoastPositions: true,
  enteredTsunamiMode: false,
  isIdleReturnDue: false,
}

describe('decideTsunamiFit', () => {
  it('落ち着いた状態では何もしない', () => {
    expect(decideTsunamiFit(settled)).toBe('none')
  })

  it('津波モード以外では何もしない（他モードのカメラ追従に任せる）', () => {
    expect(decideTsunamiFit({ ...settled, isTsunamiMode: false, isIdleReturnDue: true, hasPendingObs: true }))
      .toBe('none')
  })

  it('手動操作中は何もしない', () => {
    expect(decideTsunamiFit({ ...settled, isUserInteracting: true, hasPendingObs: true })).toBe('none')
  })

  it('観測点の持ち越しがあれば観測点へ寄る', () => {
    expect(decideTsunamiFit({ ...settled, hasPendingObs: true })).toBe('obs')
  })

  it('観測点はアイドル復帰より優先する（新しい情報を先に見せる）', () => {
    expect(decideTsunamiFit({ ...settled, hasPendingObs: true, isIdleReturnDue: true })).toBe('obs')
  })

  it('観測点は区域・等級の変化より優先する', () => {
    expect(decideTsunamiFit({ ...settled, hasPendingObs: true, signature: '岩手県:MajorWarning,青森県太平洋沿岸:Warning' }))
      .toBe('obs')
  })

  it('区域・等級が変わったら対象海域へ寄る', () => {
    expect(decideTsunamiFit({ ...settled, signature: '岩手県:MajorWarning,青森県太平洋沿岸:Warning' }))
      .toBe('coast')
  })

  it('アイドル復帰の期限が来たら対象海域へ帰る', () => {
    expect(decideTsunamiFit({ ...settled, isIdleReturnDue: true })).toBe('coast')
  })

  it('津波モードへ入室したら対象海域へ寄る', () => {
    expect(decideTsunamiFit({ ...settled, enteredTsunamiMode: true })).toBe('coast')
  })

  it('海岸線が引けないときのアイドル復帰は日本全体へ帰る', () => {
    expect(decideTsunamiFit({ ...settled, hasCoastPositions: false, isIdleReturnDue: true })).toBe('japan')
  })

  it('海岸線が引けないときの入室も日本全体へ帰る', () => {
    expect(decideTsunamiFit({ ...settled, hasCoastPositions: false, enteredTsunamiMode: true })).toBe('japan')
  })

  it('発表中だった津波が消えたら日本全体へ帰る', () => {
    expect(decideTsunamiFit({ ...settled, signature: '', hasCoastPositions: false })).toBe('japan')
  })

  it('津波が消えた状態で帰還済みなら、もう動かさない', () => {
    expect(decideTsunamiFit({ ...settled, signature: '', lastSignature: '', hasCoastPositions: false }))
      .toBe('none')
  })

  it('津波が消えた帰還は、区域変化の判定より後に評価する（空 signature で coast を選ばない）', () => {
    // signature が空のときは「変化あり」に見えても寄る先が無い。coast を選ばないことを固定する。
    expect(decideTsunamiFit({ ...settled, signature: '', hasCoastPositions: true })).toBe('japan')
  })
})
