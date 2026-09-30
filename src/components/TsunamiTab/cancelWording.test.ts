// @vitest-environment jsdom
//
// 津波の終わり方（解除・取消・失効）を**画面と声で同じ語で伝えている**ことを固定する。
//
// **片方だけを見るテストでは足りない。** `ttsText.test.ts` は読み上げの文を完全一致で
// 押さえているが、あれは画面側を 1 文字も見ていない —— 画面の文言だけが将来書き換わっても
// 通ってしまう。逆も同じ。だから**両方から同じ語を引いて突き合わせる**。
//
// 語を揃える理由は、3 つの終わり方が利用者には「その津波の表示が消えた」という 1 つの
// 出来事として届くため。画面が「失効」・声が「有効期間が終了」だと、同じことを指している
// と気づけない（→ `docs/spec/tsunami-spec.md` §3 の cancelReason 表）。
//
// **完全一致は求めない。** 画面は見出し・短文・バッジの 3 つに割れており、読み上げは
// 1 文で言い切る形なので、文としては別物であることが正しい（`tts-sentence-inventory.md`
// §4-6）。共有するのは**述語の核になる語**だけ。
import { describe, it, expect } from 'vitest'
import { CANCEL_REASON_LABEL } from './index'
import { tsunamiCancelToText } from '../../utils/ttsText'
import type { JMATsunami } from '../../types/earthquake'

/**
 * 終わり方ごとに、画面と読み上げが共有していなければならない語。
 *
 * **気象庁の語から採る。** 失効は電文の要素名（`ValidDateTime`＝失効時刻）、解除・取消は
 * 気象庁が運用で使う述語。ここを緩めると、画面と声が別々の言い換えへ流れる。
 */
const SHARED_TERM: Record<NonNullable<JMATsunami['cancelReason']>, string> = {
  lifted: '解除',
  retracted: '取り消され',
  expired: '失効時刻',
}

describe('津波の終わり方は画面と声で同じ語を使う', () => {
  // 正: 3 つの終わり方すべてで、画面の短文と読み上げの文が同じ語を含む。
  it.each(Object.keys(SHARED_TERM) as NonNullable<JMATsunami['cancelReason']>[])(
    '%s は画面と読み上げが同じ語を含む',
    reason => {
      const term = SHARED_TERM[reason]
      expect(CANCEL_REASON_LABEL[reason].desc).toContain(term)
      expect(tsunamiCancelToText(reason)).toContain(term)
    },
  )

  // 対照: 終わり方どうしで語が混ざらない。失効の文に「解除」が入る等の取り違えを落とす
  // （3 つとも `tsunamiCancelToText` の 1 つの分岐から返るため、条件を書き間違えると
  // 別の終わり方の文が出る）。
  it('終わり方どうしで語が混ざらない', () => {
    expect(tsunamiCancelToText('expired')).not.toContain('解除')
    expect(tsunamiCancelToText('expired')).not.toContain('取り消され')
    expect(tsunamiCancelToText('lifted')).not.toContain('失効')
    expect(tsunamiCancelToText('retracted')).not.toContain('失効')
  })

  // 安全弁: 旧い語へ戻っていない。**画面と読み上げの両方**を見る —— 片方だけ言い換えても
  // 上の「同じ語を含む」は通ってしまう（「有効期間が終了しました」にも「失効時刻」を
  // 併記すれば両立するため）。2026-09-30 に気象庁の語へ寄せる前は「有効期間」だった。
  it('旧い「有効期間」へ戻っていない', () => {
    for (const reason of Object.keys(SHARED_TERM) as NonNullable<JMATsunami['cancelReason']>[]) {
      expect(CANCEL_REASON_LABEL[reason].title).not.toContain('有効期間')
      expect(CANCEL_REASON_LABEL[reason].desc).not.toContain('有効期間')
      expect(CANCEL_REASON_LABEL[reason].badge).not.toContain('終了')
      expect(tsunamiCancelToText(reason)).not.toContain('有効期間')
    }
  })
})
