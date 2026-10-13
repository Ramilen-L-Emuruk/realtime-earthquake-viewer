import { describe, expect, it } from 'vitest'

import { findLocaleStrings, jsonStrings, looksJapanese, readPakStrings } from './lib/localeStrings'

// ほかのアプリの日本語の文言を、手元の言語ファイルから引く（docs/ui-wording-procedure.md「3. 語の出どころを探す」）。
// **読み方を誤ると 0 件で返り、「どのアプリもその言い方をしていない」と取り違える。**
// 2026-10-11 に Chrome の pak を区切り文字で割る読み方を試し、実際に 0 件になった。

/** Chrome の pak（版 5）を組み立てる。項目は id 順、別名は既存の項目の番号を指す。 */
function pak(resources: Array<[number, string]>, aliases: Array<[number, number]> = []): Buffer {
  const bodies = resources.map(([, s]) => Buffer.from(s, 'utf8'))
  const headerSize = 12
  const tableSize = (resources.length + 1) * 6
  const aliasSize = aliases.length * 4
  let offset = headerSize + tableSize + aliasSize
  const head = Buffer.alloc(headerSize + tableSize + aliasSize)
  head.writeUInt32LE(5, 0)
  head.writeUInt8(1, 4) // 符号化: UTF-8
  head.writeUInt16LE(resources.length, 8)
  head.writeUInt16LE(aliases.length, 10)
  resources.forEach(([id], i) => {
    head.writeUInt16LE(id, headerSize + i * 6)
    head.writeUInt32LE(offset, headerSize + i * 6 + 2)
    offset += bodies[i].length
  })
  // 終端の項目（最後の文字列の終わりを示す）
  head.writeUInt16LE(0, headerSize + resources.length * 6)
  head.writeUInt32LE(offset, headerSize + resources.length * 6 + 2)
  aliases.forEach(([id, index], j) => {
    head.writeUInt16LE(id, headerSize + tableSize + j * 4)
    head.writeUInt16LE(index, headerSize + tableSize + j * 4 + 2)
  })
  return Buffer.concat([head, ...bodies])
}

describe('readPakStrings', () => {
  it('項目表どおりに文字列を切り出す（区切り文字に頼らない）', () => {
    const buf = pak([
      [35186, 'このサイトを離れますか？'],
      [35189, '行った変更が保存されない可能性があります。'],
    ])
    expect(readPakStrings(buf)).toEqual([
      { id: 35186, text: 'このサイトを離れますか？', alias: false },
      { id: 35189, text: '行った変更が保存されない可能性があります。', alias: false },
    ])
  })

  it('別名の表にある id も、指している項目の文字列で返す（ボタン名がここに入ることがある）', () => {
    const buf = pak([[35187, 'このページを離れる']], [[35188, 0]])
    expect(readPakStrings(buf)).toContainEqual({ id: 35188, text: 'このページを離れる', alias: true })
  })

  it('版が 5 でなければ読まずに止める（作りの違う pak を黙って誤読しない）', () => {
    const buf = pak([[1, 'x']])
    buf.writeUInt32LE(4, 0)
    expect(() => readPakStrings(buf)).toThrow(/版/)
  })

  it('別名が範囲の外を指していたら止める', () => {
    const buf = pak([[1, 'x']], [[2, 5]])
    expect(() => readPakStrings(buf)).toThrow(/別名/)
  })

  it('符号化が UTF-8 でなければ止める（UTF-16 を UTF-8 で読むと、化けた文字列で 0 件になる）', () => {
    const buf = pak([[1, '保存']])
    buf.writeUInt8(2, 4)
    expect(() => readPakStrings(buf)).toThrow(/符号化/)
  })

  it('項目の位置が逆順なら止める（作りの違う pak を読むと、ここでメモリを使い切っていた）', () => {
    const buf = pak([[1, '保存'], [2, '破棄']])
    buf.writeUInt32LE(buf.readUInt32LE(12 + 6 + 2) + 100, 12 + 2) // 1 件目の位置を 2 件目より後ろへ
    expect(() => readPakStrings(buf)).toThrow(/位置/)
  })

  it('項目の位置がファイルの外なら止める（途中で切れた pak）', () => {
    const buf = pak([[1, '保存します']])
    expect(() => readPakStrings(buf.subarray(0, buf.length - 3))).toThrow(/位置/)
  })

  it('表がファイルに収まらなければ止める', () => {
    expect(() => readPakStrings(Buffer.from([5, 0, 0, 0, 1, 0, 0, 0, 0xff, 0x7f, 0, 0]))).toThrow(/表/)
  })
})

describe('jsonStrings', () => {
  it('入れ子の値をたどり、文字列だけを鍵つきで返す', () => {
    const value = { contents: { 'vs/a': { saveChangesMessage: '{0} に加えた変更を保存しますか?', n: 3 } } }
    expect(jsonStrings(value)).toEqual([{ key: 'saveChangesMessage', text: '{0} に加えた変更を保存しますか?' }])
  })

  it('配列の中の文字列も拾う', () => {
    expect(jsonStrings({ a: ['破棄', { b: '保存' }] })).toEqual([
      { key: 'a', text: '破棄' },
      { key: 'b', text: '保存' },
    ])
  })
})

describe('findLocaleStrings', () => {
  it('JSON は先頭の BOM を外して読み、語を含むものだけを返す', () => {
    const text = '﻿{"x": "変更を破棄しますか?", "y": "保存"}'
    expect(findLocaleStrings('a.i18n.json', Buffer.from(text, 'utf8'), ['破棄']).lines).toEqual(['[x] 変更を破棄しますか?'])
  })

  it('pak は id を添えて返し、別名には印を付ける', () => {
    const buf = pak([[10, '再読み込み']], [[11, 0]])
    expect(findLocaleStrings('ja.pak', buf, ['再読み込み']).lines).toEqual(['[10] 再読み込み', '[別名 11] 再読み込み'])
  })

  it('拡張子の大文字小文字は問わない', () => {
    expect(findLocaleStrings('JA.PAK', pak([[1, '保存']]), ['保存']).lines).toEqual(['[1] 保存'])
  })

  it('全角と半角の違いでは外さない（Chrome は「？」、VS Code は「?」）', () => {
    const text = '{"a": "\'{0}\' の変更を破棄しますか?"}'
    expect(findLocaleStrings('g.i18n.json', Buffer.from(text, 'utf8'), ['破棄しますか？']).lines).toHaveLength(1)
  })

  it('読んだ件数と、日本語を含む件数を返す（0 件の分母）', () => {
    const r = findLocaleStrings('ja.pak', pak([[1, '保存'], [2, 'Save']]), ['破棄'])
    expect(r).toEqual({ lines: [], total: 2, japanese: 1 })
  })

  it('日本語が半分以上なら日本語の言語ファイルとして読めたとみなす', () => {
    expect(looksJapanese(findLocaleStrings('ja.pak', pak([[1, '保存'], [2, 'OK']]), ['破棄']))).toBe(true)
  })

  it('日本語がたまたま混じっただけの別言語のファイルは、読めたとみなさない（0 件を根拠にしない）', () => {
    expect(looksJapanese(findLocaleStrings('en.pak', pak([[1, '日本語'], [2, 'Save'], [3, 'Open']]), ['保存']))).toBe(false)
  })

  it('語を 1 つも渡さなければ止める（全件を流して画面を埋めない）', () => {
    expect(() => findLocaleStrings('ja.pak', pak([[1, 'x']]), [])).toThrow(/語/)
  })

  it('空の語は止める（すべての文字列に当たる）', () => {
    expect(() => findLocaleStrings('ja.pak', pak([[1, 'x']]), [''])).toThrow(/語/)
  })
})
