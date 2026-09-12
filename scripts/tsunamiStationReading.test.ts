import { describe, it, expect } from 'vitest'
import {
  classifyTsunamiStation,
  isHeaderOnlyStationName,
  isOffshoreStationName,
  offshoreExpectedReading,
  splitDistance,
} from './tsunamiStationReading'

describe('classifyTsunamiStation', () => {
  it('沿岸の観測点は地名だけなので coastal', () => {
    expect(classifyTsunamiStation('浜中町霧多布港', 'はまなかちょうきりたっぷこう'))
      .toEqual({ kind: 'coastal' })
    expect(classifyTsunamiStation('竜飛', 'たっぴ')).toEqual({ kind: 'coastal' })
  })

  it('長音記号を含むふりがなも coastal として通す', () => {
    // hasUnreadableFurigana が長音記号を通すこと（toKanaEntry が母音の重ねへ開く）に依る。
    expect(classifyTsunamiStation('テスト港', 'てすとこー')).toEqual({ kind: 'coastal' })
  })

  it('沖合の観測点は地名と距離に分かれる', () => {
    expect(classifyTsunamiStation('宮城沖５０ｋｍＢ', 'みやぎおき５０ｋｍＢ'))
      .toEqual({ kind: 'offshore', placeFurigana: 'みやぎおき', distance: '５０ｋｍＢ' })
    expect(classifyTsunamiStation('釧路沖１００ｋｍＡ', 'くしろおき１００ｋｍＡ'))
      .toEqual({ kind: 'offshore', placeFurigana: 'くしろおき', distance: '１００ｋｍＡ' })
  })

  it('識別英字が付かない簡略名も沖合として扱う', () => {
    // ヘッダ部でのみ使う形（`宮城沖５０ｋｍ`）。見出し文を読むため声になる。
    expect(classifyTsunamiStation('宮城沖５０ｋｍ', 'みやぎおき５０ｋｍ'))
      .toEqual({ kind: 'offshore', placeFurigana: 'みやぎおき', distance: '５０ｋｍ' })
  })

  it('距離部分は最長の地名を残すように切る', () => {
    // `(.+?)` は最短一致だが、距離部分が末尾に固定されているので地名側が最長になる。
    // 地名に数字が入る形が来ても、切れ目は末尾の「数字＋ｋｍ＋英字」に合う。
    expect(classifyTsunamiStation('青森東方沖１００ｋｍＡ', 'あおもりとうほうおき１００ｋｍＡ'))
      .toEqual({ kind: 'offshore', placeFurigana: 'あおもりとうほうおき', distance: '１００ｋｍＡ' })
  })

  it('名前だけが沖合の形なら unreadable', () => {
    // ふりがな側が距離をカナ化した（上流の書き方が変わった）形。距離部分を名前から推測して
    // 埋めると、ふりがなと食い違ったまま辞書を作ることになる。
    const shape = classifyTsunamiStation('宮城沖５０ｋｍＢ', 'みやぎおきごじゅっきろめーとるびー')
    expect(shape.kind).toBe('unreadable')
  })

  it('ふりがなだけが沖合の形なら unreadable', () => {
    const shape = classifyTsunamiStation('宮城沖', 'みやぎおき５０ｋｍ')
    expect(shape.kind).toBe('unreadable')
  })

  it('距離部分が名前とふりがなで食い違えば unreadable', () => {
    const shape = classifyTsunamiStation('宮城沖５０ｋｍＢ', 'みやぎおき６０ｋｍＢ')
    expect(shape.kind).toBe('unreadable')
    if (shape.kind === 'unreadable') expect(shape.reason).toContain('５０ｋｍＢ')
  })

  it('地名部分のふりがなが読めなければ unreadable', () => {
    const shape = classifyTsunamiStation('宮城沖５０ｋｍＢ', '宮城おき５０ｋｍＢ')
    expect(shape.kind).toBe('unreadable')
  })

  it('ふりがなが空なら unreadable', () => {
    expect(classifyTsunamiStation('竜飛', '').kind).toBe('unreadable')
  })

  it('ふりがなに漢字が混じれば unreadable', () => {
    expect(classifyTsunamiStation('竜飛', 'たっ飛').kind).toBe('unreadable')
  })
})

describe('isOffshoreStationName', () => {
  it('沖合の名前を識別英字の有無に関わらず拾う', () => {
    expect(isOffshoreStationName('宮城沖５０ｋｍＢ')).toBe(true)
    expect(isOffshoreStationName('宮城沖５０ｋｍ')).toBe(true)
  })

  it('沿岸の名前は拾わない', () => {
    expect(isOffshoreStationName('竜飛')).toBe(false)
    expect(isOffshoreStationName('岩手宮古沖')).toBe(false)
  })
})

describe('isHeaderOnlyStationName', () => {
  it('識別英字が付かない沖合の名前だけを拾う', () => {
    // 座標表に載らないのはこの形だけ。識別英字が付く形は突き合わせで実在を確かめられる。
    expect(isHeaderOnlyStationName('宮城沖５０ｋｍ')).toBe(true)
    expect(isHeaderOnlyStationName('宮城沖５０ｋｍＢ')).toBe(false)
  })

  it('沿岸の名前は拾わない', () => {
    expect(isHeaderOnlyStationName('竜飛')).toBe(false)
    expect(isHeaderOnlyStationName('岩手宮古沖')).toBe(false)
  })
})

describe('splitDistance', () => {
  it('数字と識別英字へ分ける', () => {
    expect(splitDistance('５０ｋｍＢ')).toEqual({ number: '５０', letter: 'Ｂ' })
    expect(splitDistance('３１０ｋｍＡ')).toEqual({ number: '３１０', letter: 'Ａ' })
  })

  it('識別英字が付かない形は空文字で返す', () => {
    expect(splitDistance('５０ｋｍ')).toEqual({ number: '５０', letter: '' })
  })

  it('距離の形でなければ null', () => {
    expect(splitDistance('宮城沖５０ｋｍＢ')).toBeNull()
    expect(splitDistance('５０km')).toBeNull()
    expect(splitDistance('')).toBeNull()
  })
})

describe('offshoreExpectedReading', () => {
  it('地名のふりがなに距離部分の読みを繋ぐ', () => {
    expect(offshoreExpectedReading('みやぎおき', 'ゴジュッキロメエトルビイ'))
      .toBe('みやぎおきごじゅっきろめえとるびい')
  })

  it('長音の書き方の違いを吸収する', () => {
    // 正規化を通すので、距離部分の読みが長音記号でもモーラの重ねでも同じ列になる。
    expect(offshoreExpectedReading('みやぎおき', 'ゴジュッキロメートルビー'))
      .toBe(offshoreExpectedReading('みやぎおき', 'ゴジュッキロメエトルビイ'))
  })

  it('地名側の長音・お段+う も正規化する', () => {
    // `あおもりとうほうおき` は正規化で `あおもりとおほおおき` になる（お段+う → お段+お）。
    expect(offshoreExpectedReading('あおもりとうほうおき', 'エー'))
      .toBe('あおもりとおほおおきええ')
  })
})
