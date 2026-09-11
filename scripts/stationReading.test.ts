import { describe, it, expect } from 'vitest'
import { hasUnreadableFurigana, isMisreading, normalizeReading, stripReadingTail, toKanaEntry } from './stationReading'

// 震度観測点名の読みを突き合わせる処理の検証。
// 「同じ音の別表記」を吸収しつつ「別の地名に聞こえる誤読」は残す、という線引きを固定する。

describe('normalizeReading', () => {
  it('長音の 3 通りの書き方を同じ列へ揃える', () => {
    // 気象庁のふりがな / エンジンが返すモーラ列 / カナ表記
    expect(normalizeReading('とうべつ')).toBe(normalizeReading('トオベツ'))
    expect(normalizeReading('とうべつ')).toBe(normalizeReading('トーベツ'))
  })

  it('長音記号は直前のかなの母音へ開く', () => {
    expect(normalizeReading('センター')).toBe('せんたあ')
    // 実データに半角ハイフンで書かれた点がある（山鹿市老人福祉センター）
    expect(normalizeReading('せんた-')).toBe('せんたあ')
  })

  it('え段 + い を長音として扱う', () => {
    expect(normalizeReading('ていね')).toBe(normalizeReading('テエネ'))
  })

  it('づ・ぢ を ず・じ へ寄せる（同じ音の別表記）', () => {
    expect(normalizeReading('あいづ')).toBe(normalizeReading('アイズ'))
  })

  it('アクセント記号と句区切りを落とす', () => {
    expect(normalizeReading("イシカリシ'ハナ/カワ")).toBe('いしかりしはなかわ')
  })

  // 対照 —— 吸収してはいけない違い。
  it('「町」の読みの違いは吸収しない', () => {
    expect(normalizeReading('たかさごちょう')).not.toBe(normalizeReading('タカサゴマチ'))
  })

  it('促音・撥音は落とさない', () => {
    expect(normalizeReading('さっぽろ')).toBe('さっぽろ')
    expect(normalizeReading('しんことに')).toBe('しんことに')
  })
})

describe('isMisreading', () => {
  it('別の読みを誤読と判定する（正）', () => {
    // 実測: 札幌北区太平 を「オオヒラ」と読む
    expect(isMisreading('サッポロキタクオオヒラ', 'さっぽろきたくたいへい')).toBe(true)
    // 実測: 江別市高砂町 の「町」を「マチ」と読む
    expect(isMisreading('エベツシタカサゴマチ', 'えべつしたかさごちょう')).toBe(true)
  })

  it('表記の違いだけなら誤読としない（対照）', () => {
    expect(isMisreading('イシカリシハナカワ', 'いしかりしはなかわ')).toBe(false)
    expect(isMisreading('チュウオオ', 'ちゅうおう')).toBe(false)
    expect(isMisreading('シンチトセクウコオ', 'しんちとせくうこう')).toBe(false)
  })
})

describe('stripReadingTail', () => {
  // 判定は名前を単体で読ませて済ませてはいけない（誤読は後ろに続く文字で反転する）。
  // 読み上げ文の形で読ませ、助詞ぶんを差し引いて名前の読みを取り出す。
  it('末尾の助詞ぶんを差し引く（正）', () => {
    // 実測: 「石狩市花川では、」→「イシカリシハナカワデワ」
    expect(stripReadingTail('イシカリシハナカワデワ', 'デワ')).toBe('いしかりしはなかわ')
  })

  it('助詞が無い形はそのまま揃えて返す（対照）', () => {
    expect(stripReadingTail('イシカリシハナカワ', '')).toBe('いしかりしはなかわ')
  })

  it('名前の読みが助詞と同じ音で終わっても、差し引くのは末尾の 1 回だけ', () => {
    expect(stripReadingTail('ナニカデワデワ', 'デワ')).toBe('なにかでわ')
  })

  // 安全弁 —— 助詞の読みが想定と違ったら差し引かず null。ここで通すと、名前の末尾を削った列で
  // 比較して誤読を捏造する（あるいは見逃す）。
  it('末尾が助詞の読みと合わなければ null', () => {
    expect(stripReadingTail('イシカリシハナカワ', 'デワ')).toBeNull()
  })

  it('正規化は冪等（差し引いた列をそのまま比較に回せる）', () => {
    const once = normalizeReading('トウキョウブンキョウクスポーツセンタ')
    expect(normalizeReading(once)).toBe(once)
  })
})

describe('toKanaEntry', () => {
  it('カタカナ化して末尾にアクセント核を置く', () => {
    expect(toKanaEntry('さっぽろきたくたいへい')).toBe("サッポロキタクタイヘイ'")
  })

  // 安全弁 —— 長音記号は AquesTalk 風カナで受け付けられず、混ぜると
  // /accent_phrases?is_kana=true が 400 UNKNOWN_TEXT で落ちる。
  it('長音記号を残さない', () => {
    expect(toKanaEntry('こもろしぶんかせんたー')).toBe("コモロシブンカセンタア'")
    expect(toKanaEntry('やまがしろうじんふくしせんた-')).toBe("ヤマガシロウジンフクシセンタア'")
  })

  it('作った読みは元のふりがなと同じ音を指す', () => {
    const furigana = 'こもろしぶんかせんたー'
    expect(isMisreading(toKanaEntry(furigana), furigana)).toBe(false)
  })
})

describe('hasUnreadableFurigana', () => {
  it('かなと長音記号だけなら読める', () => {
    expect(hasUnreadableFurigana('いしかりしはなかわ')).toBe(false)
    expect(hasUnreadableFurigana('こもろしぶんかせんたー')).toBe(false)
    expect(hasUnreadableFurigana('やまがしろうじんふくしせんた-')).toBe(false)
  })

  it('空と漢字混じりは読めない', () => {
    expect(hasUnreadableFurigana('')).toBe(true)
    expect(hasUnreadableFurigana('石狩市はなかわ')).toBe(true)
  })
})
