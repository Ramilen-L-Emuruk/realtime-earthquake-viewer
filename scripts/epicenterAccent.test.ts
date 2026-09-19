import { describe, it, expect } from 'vitest'
import {
  MIN_TAIL_MORAS, SUFFIXES, chihouAccentEntry, splitEpicenter, toAccentEntry,
  type EpicenterSplit,
} from './epicenterAccent'
import { countMoras, toKana } from './stationReading'

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
    expect(splitEpicenter('硫黄島', 'いおうじま')).toBeNull()
  })

  // 2 モーラの後部要素は、読み上げ文で直後に付く助詞を取り込むと短い句が浮く（→ MIN_TAIL_MORAS）。
  // 割らずに 1 句のまま渡せば、エンジンが「沖」の直前へ核を置いた形になる。
  it('後部要素が短すぎるものは割らない', () => {
    expect(splitEpicenter('能登半島沖', 'のとはんとうおき')).toBeNull()   // オキ（2 モーラ）
    expect(splitEpicenter('日向灘', 'ひゅうがなだ')).toBeNull()          // ナダ（2 モーラ）
    // 方位を伴う沖は 5〜6 モーラあるので従来どおり割る
    expect(splitEpicenter('根室半島南東沖', 'ねむろはんとうなんとうおき')?.tail).toBe('南東沖')
  })
})

describe('toAccentEntry の核', () => {
  const split = (name: string, kana: string) => splitEpicenter(name, kana) as EpicenterSplit

  // 正: 実測の核が渡されたら、その位置へ置く（末尾核ではない）
  it('渡された核をその位置へ置く', () => {
    const s = split('八丈島近海', 'はちじょうじまきんかい')
    expect(toAccentEntry(s, { head: 3, tail: null })).toBe("ハチジョ'ウジマ/キンカイ'")
  })

  // 対照: 「〜地方」だけは実測より優先して「チ」へ置く
  // （エンジンは語によって「ホ」へ核を置くので、任せると同じ「〜地方」が語ごとに違う位置で割れる）
  it('「〜地方」の前部要素は、渡された核より優先して「チ」へ置く', () => {
    const s = split('十勝地方北部', 'とかちちほうほくぶ')
    expect(toAccentEntry(s, { head: 5, tail: 1 })).toBe("トカチチ'ホウ/ホ'クブ")
    // 核を渡さなくても「チ」。後部要素だけが末尾核へ倒れる
    expect(toAccentEntry(s)).toBe("トカチチ'ホウ/ホクブ'")
  })

  // 安全弁 1: 核を渡さなければ末尾核（この変更を入れる前の挙動）
  it('核を渡さなければ末尾核へ倒れる', () => {
    const s = split('宮古島近海', 'みやこじまきんかい')
    expect(toAccentEntry(s)).toBe("ミヤコジマ'/キンカイ'")
    expect(toAccentEntry(s, { head: null, tail: null })).toBe("ミヤコジマ'/キンカイ'")
  })

  // 安全弁 2: 値域の外は採らない（0 は平板でこの記法では書けず、モーラ数超は位置が無い）
  it('値域の外の核は採らず末尾核へ倒れる', () => {
    const s = split('宮古島近海', 'みやこじまきんかい')
    expect(toAccentEntry(s, { head: 0, tail: 99 })).toBe("ミヤコジマ'/キンカイ'")
    expect(toAccentEntry(s, { head: -1, tail: null })).toBe("ミヤコジマ'/キンカイ'")
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

describe('SUFFIXES の並び', () => {
  // 安全弁: `splitEpicenterDetailed` は後部要素が短すぎるとその場で打ち切る。
  // 短いものが表の途中にあると、その後ろにある当たりうる候補を試さないまま
  // 「割らない」と決めてしまう。打ち切ってよいのは表の末尾にまとまっている間だけ。
  it('MIN_TAIL_MORAS を下回る後部要素は、表の末尾にまとまっている', () => {
    const short = SUFFIXES.map(([, kana]) => countMoras(toKana(kana)) < MIN_TAIL_MORAS)
    const firstShort = short.indexOf(true)
    expect(firstShort).toBeGreaterThanOrEqual(0)
    expect(short.slice(firstShort).every(Boolean)).toBe(true)
  })
})

describe('chihouAccentEntry', () => {
  const entryOf = (name: string, kana: string) => {
    const outcome = chihouAccentEntry(name, kana)
    return 'entry' in outcome ? outcome.entry : null
  }
  const reasonOf = (name: string, kana: string) => {
    const outcome = chihouAccentEntry(name, kana)
    return 'entry' in outcome ? null : outcome.reason
  }

  // **長音はここでは開かない。** ふりがなをそのままカナにするので `ホウ` のまま出る。
  // 開くのは生成の最終段階（→ `scripts/lib/longVowel.ts`）で、生成物は `チ'ホオ` になる。

  // 正: 県名が前に付かなければ割らずに核だけ「チ」へ置く
  it('県名が付かない名前は割らずに核を「チ」へ置く', () => {
    expect(entryOf('檜山地方', 'ひやまちほう')).toBe("ヒヤマチ'ホウ")
    expect(entryOf('北見地方', 'きたみちほう')).toBe("キタミチ'ホウ")
  })

  // 正: 県名が前に付けば「県」の後で割る。県の核は「県」の直前
  it('県名が付く名前は「県」の後で割る', () => {
    expect(entryOf('石川県能登地方', 'いしかわけんのとちほう')).toBe("イシカワ'ケン/ノトチ'ホウ")
    expect(entryOf('岐阜県飛騨地方', 'ぎふけんひだちほう')).toBe("ギフ'ケン/ヒダチ'ホウ")
  })

  // 対照: 「〜地方」で終わらない名前は扱わない（句割りの担当）
  it('「〜地方」で終わらない名前は扱わない', () => {
    expect(reasonOf('十勝地方北部', 'とかちちほうほくぶ')).toBe('not-chihou')
    expect(reasonOf('宮古島近海', 'みやこじまきんかい')).toBe('not-chihou')
  })

  // 対照: 中黒を含む名前は扱わない（割れ目が 3 つになる）
  it('中黒を含む名前は扱わない', () => {
    expect(reasonOf('熊本県天草・芦北地方', 'くまもとけんあまくさあしきたちほう')).toBe('nakaguro')
  })

  // 安全弁: 漢字と読みの「県」が 1 対 1 に対応しないときは割らない。
  // 連結すれば元の読みへ戻るので、生成時の往復検証では誤った割り方を捕まえられない
  it('「県」が 2 つあるときは割らない', () => {
    expect(reasonOf('東京県大阪県地方', 'とうきょうけんおおさかけんちほう')).toBe('ambiguous-prefecture')
  })

  it('読みに「けん」が 2 つあるときは割らない', () => {
    expect(reasonOf('三重県剣岳地方', 'みえけんけんだけちほう')).toBe('ambiguous-prefecture')
  })
})
