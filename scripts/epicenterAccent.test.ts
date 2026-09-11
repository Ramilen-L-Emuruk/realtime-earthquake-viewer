import { describe, it, expect } from 'vitest'
import { splitEpicenter, toAccentEntry } from './epicenterAccent'

// 震央地名の句割りの検証。
// 「読み上げで長すぎる 1 句を 2 つに割る」ための処理で、割る位置と割らない条件を固定する。

describe('splitEpicenter', () => {
  it('後部要素の境界で割る（正）', () => {
    expect(splitEpicenter('宮古島近海', 'みやこじまきんかい')).toEqual({
      head: '宮古島', headKana: 'みやこじま', tail: '近海', tailKana: 'きんかい',
    })
  })

  it('方位を伴う沖は、方位ごと後部要素として扱う', () => {
    // `沖` を先に当てると `根室半島南東 / 沖` に割れてしまう。長い後部要素を先に並べてある。
    expect(splitEpicenter('根室半島南東沖', 'ねむろはんとうなんとうおき')?.tail).toBe('南東沖')
    expect(splitEpicenter('房総半島南方沖', 'ぼうそうはんとうなんぽうおき')?.tailKana).toBe('なんぽうおき')
  })

  it('割るのは 1 回だけ（前部要素はそれ以上刻まない）', () => {
    const split = splitEpicenter('小笠原諸島西方沖', 'おがさわらしょとうせいほうおき')
    expect(split?.headKana).toBe('おがさわらしょとう')
    expect(split?.tailKana).toBe('せいほうおき')
  })

  // 対照 —— 割ってはいけない形。
  it('漢字が一致しても読みが合わなければ割らない', () => {
    // 読みを見ずに漢字だけで割ると、前部要素の読みが後部要素ぶん多く残る（あるいは足りない）。
    expect(splitEpicenter('宮古島近海', 'みやこじま')).toBeNull()
  })

  it('後部要素だけの名前は割らない', () => {
    expect(splitEpicenter('近海', 'きんかい')).toBeNull()
  })

  it('後部要素を持たない名前は割らない', () => {
    expect(splitEpicenter('日向灘', 'ひゅうがなだ')?.tail).toBe('灘')
    expect(splitEpicenter('硫黄島', 'いおうじま')).toBeNull()
  })
})

describe('toAccentEntry', () => {
  it('句区切りと各句末のアクセント核を付ける', () => {
    const split = splitEpicenter('宮古島近海', 'みやこじまきんかい')
    expect(toAccentEntry(split!)).toBe("ミヤコジマ'/キンカイ'")
  })

  // 安全弁 —— 長音記号は AquesTalk 風カナで受け付けられない（400 UNKNOWN_TEXT）。
  it('長音記号を残さない', () => {
    const split = splitEpicenter('カムチャツカ半島付近', 'かむちゃつかはんとうふきん')
    expect(toAccentEntry(split!)).not.toContain('ー')
  })
})
