import { describe, it, expect } from 'vitest'
import {
  applyOpenedReading, openingProblem, readingOfEntry, unifyOpenedPhrases, verifyOpenedEntries,
} from './lib/longVowel'
import { normalizeReading } from './stationReading'

// 読みの長音を開く仕組みのうち、**形態素解析を要さない部分**を固定する。
// 解析そのもの（`open_long_vowels.py`）は Python と辞書が要るので CI では動かせない
// —— そちらの正しさは生成時の検証（`verifyOpenedEntries`）が受け持つ。

describe('readingOfEntry', () => {
  it('核と句区切りを落として読みだけを返す', () => {
    expect(readingOfEntry("トオベツチョオ'/シラカバ'")).toBe('トオベツチョオシラカバ')
  })
})

describe('applyOpenedReading', () => {
  // 正: 開いた読みを書き戻しても、核と句区切りの位置が動かない
  it('核と句区切りの位置を保つ', () => {
    expect(applyOpenedReading("トウベツチョウ'/シラカバ'", 'トオベツチョオシラカバ'))
      .toBe("トオベツチョオ'/シラカバ'")
  })

  it('核が句の途中にあっても位置を保つ', () => {
    expect(applyOpenedReading("タラ'チョウ/オオウラノ'ザキ", 'タラチョオオオウラノザキ'))
      .toBe("タラ'チョオ/オオウラノ'ザキ")
  })

  // 対照: 長さが合わなければ落とす。元の文字で埋めると、句区切りと核の位置だけが正しく見えて
  // 読みの一部が開かれないまま残る（生成物は形として成立するので声を聞くまで気づけない）
  it('開いた読みが短ければ落とす', () => {
    expect(() => applyOpenedReading("トウベツチョウ'/シラカバ'", 'トオベツチョオ'))
      .toThrow('長さが合いません')
  })

  it('開いた読みが長すぎても落とす', () => {
    expect(() => applyOpenedReading("トウベツ'", 'トオベツチョオ'))
      .toThrow('長さが合いません')
  })
})

describe('verifyOpenedEntries', () => {
  // 正: 長音の書き方が変わっただけなら通す（正規化すると同じ読みを指す）
  it('長音の書き方が変わっただけなら通る', async () => {
    const problems = await verifyOpenedEntries(
      [{ name: '十勝地方北部', before: "トカチチ'ホウ/ホ'クブ", after: "トカチチ'ホオ/ホ'クブ" }],
      async () => 'トカチチホオホクブ',
      normalizeReading,
    )
    expect(problems).toEqual([])
  })

  // 対照: 読みが別の音へ化けていたら捕まえる（正規化しても差が残る形）
  it('別の音へ化けていたら捕まえる', async () => {
    const problems = await verifyOpenedEntries(
      [{ name: '当別町白樺', before: "トウベツチョウ'/シラカバ'", after: "トオベツチョオ'/シラカワ'" }],
      async () => 'トオベツチョオシラカワ',
      normalizeReading,
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('当別町白樺')
  })

  // **語の切れ目を取り違えて開いた誤りは、ここでは捕まえられない。**
  // 正規化すると開く前と同じ形になるため。字の動き方は openingProblem が縛り、
  // 切れ目の正しさは形態素解析の側が受け持つ（この非対称を忘れないために固定する）
  it('語の切れ目を取り違えた誤りは素通りする（既知の限界）', async () => {
    const problems = await verifyOpenedEntries(
      [{ name: '壱岐島郷ノ浦港', before: "ゴオノウラ'コオ", after: "ゴオノオラ'コオ" }],
      async () => 'ゴオノオラコオ',
      normalizeReading,
    )
    expect(problems).toEqual([])
  })

  // 安全弁: 読ませられなかったものを「通った」に混ぜない
  it('読ませられなかったものを問題として挙げる', async () => {
    const problems = await verifyOpenedEntries(
      [{ name: '試験', before: "シケン'", after: "シケン'" }],
      async () => { throw new Error('400 UNKNOWN_TEXT') },
      normalizeReading,
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('400 UNKNOWN_TEXT')
  })
})

describe('openingProblem', () => {
  // 正: 長音の開き方（ウ → オ・イ → エ）は通す
  it('母音の開きは通す', () => {
    expect(openingProblem('トウベツチョウシラカバ', 'トオベツチョオシラカバ')).toBeNull()
    expect(openingProblem('ホクエイ', 'ホクエエ')).toBeNull()
  })

  // 対照: それ以外の書き換えは弾く
  it('母音の開き以外の書き換えを弾く', () => {
    expect(openingProblem('シラカバ', 'シラカワ')).toContain('4 文字目')
    expect(openingProblem('チョウ', 'チョア')).toContain('3 文字目')
  })

  // 安全弁: 長さが変わったら弾く（核の位置が読みの長さで決まるため）
  it('長さが変わったら弾く', () => {
    expect(openingProblem('チョウ', 'チョオオ')).toContain('長さが')
  })

  // 安全弁: 逆向き（オ → ウ）は許さない。開く方向だけを通す
  it('逆向きの書き換えは弾く', () => {
    expect(openingProblem('チョオ', 'チョウ')).toContain('3 文字目')
  })
})

describe('unifyOpenedPhrases', () => {
  const origin = (...kanji: string[]) => kanji.map(k => ({ kanji: k }))

  // 正: 同じ句（漢字＋開く前の読みが同じ）は、開けた側へ揃える
  it('片方だけ開いた句を揃える', () => {
    const before = new Map([
      ['浜中町湯沸', "ハマナカチョウ'/トウフツ'"],
      ['浜中町茶内', "ハマナカチョウ'/チャナイ'"],
    ])
    const after = new Map([
      ['浜中町湯沸', "ハマナカチョウ'/トオフツ'"],     // 前半が開かれなかった
      ['浜中町茶内', "ハマナカチョオ'/チャナイ'"],
    ])
    const origins = new Map([
      ['浜中町湯沸', origin('浜中町', '湯沸')],
      ['浜中町茶内', origin('浜中町', '茶内')],
    ])
    const out = unifyOpenedPhrases(before, after, origins)
    expect(out.get('浜中町湯沸')).toBe("ハマナカチョオ'/トオフツ'")
  })

  // 対照: **漢字が違えば揃えない。** 同じ読みで別の語を指す句が実データに 37 件ある
  // （`鷹栖町` と `高鷲町` はどちらも `タカスチョウ`）。読みだけを鍵にすると、
  // 「開かないのが正しい」と判定した句を同音の別語が上書きする
  it('読みが同じでも漢字が違えば揃えない', () => {
    const before = new Map([
      ['鷹栖町北野', "タカスチョウ'/キタノ'"],
      ['高鷲町大鷲', "タカスチョウ'/オオワシ'"],
    ])
    const after = new Map([
      ['鷹栖町北野', "タカスチョオ'/キタノ'"],
      ['高鷲町大鷲', "タカスチョウ'/オオワシ'"],       // こちらは開かれていない
    ])
    const origins = new Map([
      ['鷹栖町北野', origin('鷹栖町', '北野')],
      ['高鷲町大鷲', origin('高鷲町', '大鷲')],
    ])
    const out = unifyOpenedPhrases(before, after, origins)
    expect(out.get('高鷲町大鷲')).toBe("タカスチョウ'/オオワシ'")
  })

  // 安全弁: 開けた数が同じで中身が違えば、どちらが正しいか決める材料が無いので揃えない
  it('開けた数が同じで中身が違えば揃えない', () => {
    const before = new Map([
      ['試験町甲', "シケイチョウ'/コウ'"],
      ['試験町乙', "シケイチョウ'/オツ'"],
    ])
    const after = new Map([
      ['試験町甲', "シケエチョウ'/コウ'"],            // 前半だけ開いた
      ['試験町乙', "シケイチョオ'/オツ'"],            // 後半だけ開いた（同数・別位置）
    ])
    const origins = new Map([
      ['試験町甲', origin('試験町', '甲')],
      ['試験町乙', origin('試験町', '乙')],
    ])
    const out = unifyOpenedPhrases(before, after, origins)
    expect(out.get('試験町甲')).toBe("シケエチョウ'/コウ'")
    expect(out.get('試験町乙')).toBe("シケイチョオ'/オツ'")
  })

  // 安全弁: **並び順で結果が変わらない。** 候補を全部集めてから最多を採る形でないと、
  // あとからもっと開けた候補が来ても救えず、辞書の並びだけで結果が動く
  it('辞書の並び順で結果が変わらない', () => {
    const pairs: [string, string][] = [
      ['甲町一', "シケイチョウ'/イチ'"],
      ['甲町二', "シケイチョウ'/ニ'"],
      ['甲町三', "シケイチョウ'/サン'"],
    ]
    const opened: [string, string][] = [
      ['甲町一', "シケエチョウ'/イチ'"],             // 1 箇所
      ['甲町二', "シケイチョオ'/ニ'"],               // 1 箇所（別位置）
      ['甲町三', "シケエチョオ'/サン'"],             // 2 箇所（最多）
    ]
    const origins = new Map(pairs.map(([n]) => [n, origin('甲町', n.slice(2))]))
    const forward = unifyOpenedPhrases(new Map(pairs), new Map(opened), origins)
    const reversed = unifyOpenedPhrases(
      new Map([...pairs].reverse()), new Map([...opened].reverse()), origins,
    )
    expect(forward.get('甲町一')).toBe("シケエチョオ'/イチ'")
    expect(reversed.get('甲町一')).toBe(forward.get('甲町一'))
  })

  // 安全弁: 漢字を渡さなかった句は触らない
  it('漢字が無い句は触らない', () => {
    const before = new Map([['某', "シケイ'"]])
    const after = new Map([['某', "シケイ'"]])
    const out = unifyOpenedPhrases(before, after, new Map())
    expect(out.get('某')).toBe("シケイ'")
  })
})
