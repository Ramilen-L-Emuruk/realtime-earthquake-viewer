import { describe, it, expect } from 'vitest'
import { GRADES_IN_CARD_ORDER, TSUNAMI_GRADE_SHORT_LABEL } from './tsunami'
import { tsunamiToText, tsunamiDowngradeToText } from './ttsText'
import type { JMATsunami, TsunamiArea, TsunamiGrade } from '../types/earthquake'

/**
 * 津波の等級を読む順が、カードが等級カードを積む順（`GRADES_IN_CARD_ORDER`）と一致していること。
 *
 * 一致していないと、読み上げに合わせたカードの追従スクロールが上下へ往復する
 * （→ docs/spec/audio-tts-spec.md §4「津波の区域の並び順」）。読み上げ側が並びを手書きで
 * 写していると、等級を増やしたときに片方だけ漏れる。
 */
describe('津波の等級を読む順', () => {
  /** 読み上げが等級として語れるもの（`'Unknown'` は呼び名が空文字のため対象外）。 */
  const speakableGrades = GRADES_IN_CARD_ORDER.filter(g => g !== 'Unknown')

  function makeTsunami(areas: TsunamiArea[]): JMATsunami {
    const now = '2026-01-01T00:00:00Z'
    return {
      kind: 'tsunami',
      id: 'test-tsunami-grade-order',
      time: now,
      cancelled: false,
      issue: { source: 'テスト', time: now, type: 'Focus' },
      areas,
    }
  }

  function makeArea(grade: TsunamiGrade, index: number): TsunamiArea {
    return {
      grade,
      immediate: false,
      name: `検証区域${index}`,
      code: `90${index}`,
      maxHeight: { description: `${index + 1}ｍ`, value: index + 1 },
    }
  }

  // 正: 等級ごとの区域が、カードと同じ順（重い等級が先）で読まれる。
  // 電文の並びをわざと逆にして渡し、電文順がそのまま残っていないことも併せて見る
  it('カードが等級カードを積む順で読む', () => {
    const areas = speakableGrades.map(makeArea)
    const text = tsunamiToText(makeTsunami([...areas].reverse()))

    const positions = areas.map(a => text.indexOf(a.name))
    expect(positions.some(p => p < 0)).toBe(false)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  // 正: どの等級も呼び名を伴って読まれる（呼び名が空の等級を混ぜていない）
  it('等級の呼び名を欠いた文を作らない', () => {
    const text = tsunamiToText(makeTsunami(speakableGrades.map(makeArea)))
    expect(text).not.toContain('にが発表')
    expect(text).not.toContain('。が発表')
  })

  // 対照: 呼び名を持たない `'Unknown'` の区域は、上位の等級と混ざって届いても読まない
  it('等級が取れない区域は読まない', () => {
    const text = tsunamiToText(makeTsunami([
      { grade: 'Warning', immediate: true, name: '青森県太平洋沿岸', code: '901', maxHeight: { description: '３ｍ', value: 3 } },
      { grade: 'Unknown', immediate: false, name: '等級不明の区域', code: '902', maxHeight: { description: '１ｍ', value: 1 } },
    ]))

    expect(text).toContain('青森県太平洋沿岸')
    expect(text).not.toContain('等級不明の区域')
    expect(text).not.toContain('にが発表')
  })

  // 安全弁: 区域はあるのに等級が 1 つも取れない電文で、引き下げ側が解除の文言へ落ちる。
  // `'Unknown'` を並びへ含めるとここが「〇〇に切り替えられました。」の壊れた文に化ける
  it('全区域の等級が取れない電文は等級として語らない', () => {
    const tsunami = makeTsunami([makeArea('Unknown', 0)])

    expect(tsunamiDowngradeToText(tsunami)).toContain('津波警報等は全て解除されました。')
    expect(tsunamiToText(tsunami)).toBe('')
  })

  // 安全弁: `'Unknown'` だけを除く根拠。他の等級に呼び名の無いものが混ざったら、
  // 上の「呼び名を欠いた文を作らない」が守れなくなる
  it('呼び名を持たない等級は Unknown だけ', () => {
    for (const grade of speakableGrades) {
      expect(TSUNAMI_GRADE_SHORT_LABEL[grade]).not.toBe('')
    }
    expect(TSUNAMI_GRADE_SHORT_LABEL.Unknown).toBe('')
  })
})
