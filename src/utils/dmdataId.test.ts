import { describe, it, expect } from 'vitest'
import { normalizeDmdataTelegramId } from './dmdataId'

describe('normalizeDmdataTelegramId', () => {
  // 正: 旧書式で保存された既読の記録が、いまの書式と突き合わせられる。
  it('旧書式の `xml-` を落として現行の書式に揃える', () => {
    expect(normalizeDmdataTelegramId('dmdata-xml-nankai-commentary-20260904120000-1')).toBe(
      'dmdata-nankai-commentary-20260904120000-1',
    )
    // 揃えた結果、旧書式と現行書式が同じものを指すと判定できる。
    expect(normalizeDmdataTelegramId('dmdata-xml-quake-20260904120000-2')).toBe(
      normalizeDmdataTelegramId('dmdata-quake-20260904120000-2'),
    )
  })

  // 対照: 現行の書式は素通しする（二重に削らない）。
  it('現行の書式はそのまま返す', () => {
    expect(normalizeDmdataTelegramId('dmdata-nankai-commentary-20260904120000-1')).toBe(
      'dmdata-nankai-commentary-20260904120000-1',
    )
  })

  // 安全弁: 落とすのは**先頭の**接頭辞だけ。id の途中に現れる同じ並びには触らない。
  // 削る位置を緩めると、別の電文を同じものと見なす方向へ倒れる。
  it('先頭以外の `dmdata-xml-` は削らない', () => {
    expect(normalizeDmdataTelegramId('p2p-dmdata-xml-quake-20260904120000-1')).toBe(
      'p2p-dmdata-xml-quake-20260904120000-1',
    )
    expect(normalizeDmdataTelegramId('dmdata-quake-dmdata-xml-1')).toBe('dmdata-quake-dmdata-xml-1')
  })

  it('DMDATA 以外の id には触らない', () => {
    expect(normalizeDmdataTelegramId('p2p-12345')).toBe('p2p-12345')
    expect(normalizeDmdataTelegramId('')).toBe('')
  })
})
