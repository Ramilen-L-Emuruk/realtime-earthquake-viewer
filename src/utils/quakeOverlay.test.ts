import { describe, it, expect } from 'vitest'
import {
  type QuakeOverlay, toggleLpgmOverlay, toggleDistributionOverlay, toggleUnreceivedOverlay,
  openDistributionOverlay,
  closeLpgmOverlay, closeEewLpgmOverlay, closeUnreceivedOverlay, closeUnreceivedOverlayFor,
  closeDistributionOverlayOnQuakeReport,
  decideUnreceivedSpeechOpen, shouldCloseOverlayOnSelection,
} from './quakeOverlay'
import type { TabId } from '../components/IconNav'

const lpgm = (eventId: string, source: 'earthquake' | 'eew' = 'earthquake'): QuakeOverlay =>
  ({ kind: 'lpgm', eventId, source })
const distribution = (eventKey: string): QuakeOverlay => ({ kind: 'distribution', eventKey })
const unreceived = (eventKey: string): QuakeOverlay => ({ kind: 'unreceived', eventKey })

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

// 推計震度分布図の受信で自動的に開く経路は、**受信の瞬間と読み上げの順番が来た瞬間の 2 回**
// 呼ぶ（→ `audio-tts-spec.md` §6「推計震度分布図は地震情報の音を借りる」）。
// トグルを流用すると 2 回目で閉じるため、開くだけの遷移を分けてある。
describe('震度分布モードを自動で開く', () => {
  // 正: 開いていなければ開く
  it('何も開いていなければ震度分布を開く', () => {
    expect(openDistributionOverlay(null, 'k1')).toEqual(distribution('k1'))
  })

  // 正: 二度目でも閉じない（トグルとの違い）
  it('同じ分布を二度開こうとしても閉じない', () => {
    expect(openDistributionOverlay(distribution('k1'), 'k1')).not.toBeNull()
  })

  // 正: 同じ値なら前の参照をそのまま返す（内容が同じなのに描き直さない）
  it('同じ分布が開いていれば前の状態をそのまま返す', () => {
    const prev = distribution('k1')
    expect(openDistributionOverlay(prev, 'k1')).toBe(prev)
  })

  // 対照: 別の地震の分布なら切り替える
  it('別の地震の分布が開いていれば切り替える', () => {
    expect(openDistributionOverlay(distribution('k1'), 'k2')).toEqual(distribution('k2'))
  })

  // 安全弁: 排他は保つ（他の追加表示は閉じる）
  it('長周期が開いていれば閉じて震度分布を開く', () => {
    expect(openDistributionOverlay(lpgm('20240101160010'), 'k1')).toEqual(distribution('k1'))
  })

  it('未入電が開いていれば閉じて震度分布を開く', () => {
    expect(openDistributionOverlay(unreceived('k1'), 'k1')).toEqual(distribution('k1'))
  })
})

describe('未入電の表示も同じ排他に乗る', () => {
  // 正: 未入電を開くと他の追加表示は閉じる。
  it('震度分布を開いている状態で未入電を開くと、分布は閉じる', () => {
    expect(toggleUnreceivedOverlay(distribution('k1'), 'k1')).toEqual(unreceived('k1'))
  })

  it('長周期を開いている状態で未入電を開くと、長周期は閉じる', () => {
    expect(toggleUnreceivedOverlay(lpgm('20240101160010'), 'k1')).toEqual(unreceived('k1'))
  })

  // 正: 逆向きも同じ（未入電を開いているところへ他を開く）。
  it('未入電を開いている状態で震度分布を開くと、未入電は閉じる', () => {
    expect(toggleDistributionOverlay(unreceived('k1'), 'k1')).toEqual(distribution('k1'))
  })

  it('表示中の未入電をもう一度押すと閉じる', () => {
    expect(toggleUnreceivedOverlay(unreceived('k1'), 'k1')).toBeNull()
  })

  // 対照: 別の地震の未入電を押したときは切り替える（閉じない）。
  it('別の地震の未入電を押したときは切り替える', () => {
    expect(toggleUnreceivedOverlay(unreceived('k1'), 'k2')).toEqual(unreceived('k2'))
  })

  // 安全弁: 「長周期を閉じる」操作は未入電に触らない（対象を絞る規則は新しい種別にも効く）。
  it('長周期を閉じる操作は未入電に触らない', () => {
    const prev = unreceived('k1')
    expect(closeLpgmOverlay(prev)).toBe(prev)
    expect(closeEewLpgmOverlay(prev)).toBe(prev)
  })

  // 正: 未入電が無くなったら閉じる。カードのボタンは件数で出しているので続報で 0 件になると
  // 消えるが、この状態が残ると地図が震源の印だけで固定され、閉じる手段が無くなる。
  it('未入電を閉じる操作は未入電を落とす', () => {
    expect(closeUnreceivedOverlay(unreceived('k1'))).toBeNull()
  })

  // 安全弁: 他の追加表示には触らない（閉じる理由は「未入電が無くなった」ことなので）。
  it('未入電を閉じる操作は長周期・震度分布に触らない', () => {
    const lp = lpgm('20240101160010')
    const dist = distribution('k1')
    expect(closeUnreceivedOverlay(lp)).toBe(lp)
    expect(closeUnreceivedOverlay(dist)).toBe(dist)
    expect(closeUnreceivedOverlay(null)).toBeNull()
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
  // ここを「受信のたびに閉じる」にすると開いた階級が数分後に勝手に消える
  // （震度分布だけは別の理由で閉じる。下の describe を参照）
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

describe('震度分布モードは、その地震の電文を受けたら閉じる', () => {
  // 正: 同じ地震の続報でも閉じる（症状: 分布を開いたまま震度情報の続報が届いても分布の面が
  // 出たままで、区域塗りも観測点ドットも出ないため、どこの震度が変わったのか地図に現れない）
  it('同じ地震の電文なら閉じる', () => {
    expect(closeDistributionOverlayOnQuakeReport(distribution('k1'), 'k1')).toBeNull()
  })

  // 対照: 別の地震の電文では触らない（そちらは選択が移った時点で
  // `shouldCloseOverlayOnSelection` が閉じる。ここが二重に効くと、呼ぶ順序で結果が変わる）
  it('別の地震の電文では閉じない', () => {
    expect(closeDistributionOverlayOnQuakeReport(distribution('k1'), 'k2')).toEqual(distribution('k1'))
  })

  // 安全弁: 長周期と未入電は巻き込まない。閉じる理由は「分布モードが発表値を隠している」
  // ことなので、発表値を隠していない表示には当たらない
  it('長周期は閉じない', () => {
    expect(closeDistributionOverlayOnQuakeReport(lpgm('20240101160010'), 'k1'))
      .toEqual(lpgm('20240101160010'))
  })

  it('未入電の一覧は閉じない', () => {
    expect(closeDistributionOverlayOnQuakeReport(unreceived('k1'), 'k1')).toEqual(unreceived('k1'))
  })

  it('何も開いていないなら何も起きない', () => {
    expect(closeDistributionOverlayOnQuakeReport(null, 'k1')).toBeNull()
  })
})

describe('読み上げが開いた未入電を閉じるのは、開いたときと同じ地震のときだけ', () => {
  it('正: 同じ鍵なら閉じる', () => {
    expect(closeUnreceivedOverlayFor(unreceived('A'), 'A')).toBeNull()
  })

  it('対照: 別の地震の未入電が開いていたら触らない', () => {
    // 開けてから閉じるまでの間に選択が移ると、そこにあるのは利用者が開き直した別の表示。
    const other = unreceived('B')
    expect(closeUnreceivedOverlayFor(other, 'A')).toBe(other)
  })

  it('安全弁: 未入電以外の追加表示には当たらない', () => {
    const dist = distribution('A')
    expect(closeUnreceivedOverlayFor(dist, 'A')).toBe(dist)
    const lp = lpgm('A')
    expect(closeUnreceivedOverlayFor(lp, 'A')).toBe(lp)
  })
})

describe('読み上げに合わせて未入電モードを開いてよいか', () => {
  const base = {
    activeTab: 'earthquake' as TabId,
    overlay: null as QuakeOverlay | null,
    subject: 'A' as string | undefined,
    selectedKey: 'A' as string | null,
    hasUnreceivedPoints: true,
  }

  it('正: 地震タブで、読んでいる地震が画面に出ていて、未入電の地点があれば開く', () => {
    expect(decideUnreceivedSpeechOpen(base)).toBe('opened')
  })

  it('対照: 地震タブを見ていなければ開かない（見送りであって食い違いではない）', () => {
    expect(decideUnreceivedSpeechOpen({ ...base, activeTab: 'tsunami' })).toBe('declined')
  })

  it('安全弁: 手で開かれている別の追加表示は奪わない', () => {
    // 3 つは排他なので、ここで開くと震度分布・長周期が閉じる。しかも閉じる番は元へ戻さない。
    expect(decideUnreceivedSpeechOpen({ ...base, overlay: distribution('A') })).toBe('declined')
    expect(decideUnreceivedSpeechOpen({ ...base, overlay: lpgm('A') })).toBe('declined')
  })

  it('安全弁: 読んでいる地震と画面の地震が違えば開かない（食い違いとして記録する）', () => {
    // 読み上げの順番待ちのあいだに別の地震が届くと、選択だけが先に移る。
    expect(decideUnreceivedSpeechOpen({ ...base, selectedKey: 'B' })).toBe('mismatch')
    expect(decideUnreceivedSpeechOpen({ ...base, selectedKey: null })).toBe('mismatch')
    expect(decideUnreceivedSpeechOpen({ ...base, subject: undefined })).toBe('mismatch')
  })

  it('安全弁: その地震に未入電の地点が無ければ開かない（食い違いとして記録する）', () => {
    expect(decideUnreceivedSpeechOpen({ ...base, hasUnreceivedPoints: false })).toBe('mismatch')
  })

  it('既に未入電が開いているときも奪わない（手で開かれた可能性がある）', () => {
    expect(decideUnreceivedSpeechOpen({ ...base, overlay: unreceived('A') })).toBe('declined')
  })
})
