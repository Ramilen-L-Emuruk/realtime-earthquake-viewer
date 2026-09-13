import { describe, it, expect } from 'vitest'
import { mergeUnreceivedPointNames, groupUnreceivedPointNames } from './unreceivedPointNames'

describe('mergeUnreceivedPointNames', () => {
  it('正: 気象庁以外の観測点には印が付く', () => {
    expect(mergeUnreceivedPointNames([{ addr: '普代村銅屋', nonJma: true }]))
      .toEqual([{ name: '普代村銅屋', nonJma: true }])
  })

  it('対照: 気象庁の観測点には印が付かない', () => {
    expect(mergeUnreceivedPointNames([{ addr: '普代村' }]))
      .toEqual([{ name: '普代村', nonJma: false }])
  })

  it('渡された順序を保つ（並びは呼び出し側が決めている）', () => {
    const merged = mergeUnreceivedPointNames([{ addr: '乙' }, { addr: '甲' }, { addr: '丙' }])
    expect(merged.map(m => m.name)).toEqual(['乙', '甲', '丙'])
  })

  it('同じ名前は 1 行にまとめる', () => {
    expect(mergeUnreceivedPointNames([
      { addr: '香取市', nonJma: true },
      { addr: '香取市', nonJma: true },
    ])).toEqual([{ name: '香取市', nonJma: true }])
  })

  it('安全弁: 同名で出所が混ざったら印を付けない（気象庁の観測点に他所の印を付けない）', () => {
    expect(mergeUnreceivedPointNames([
      { addr: '中央', nonJma: true },
      { addr: '中央' },
    ])).toEqual([{ name: '中央', nonJma: false }])
    // 逆順でも同じ（先に来た方の値が残らないこと）
    expect(mergeUnreceivedPointNames([
      { addr: '中央' },
      { addr: '中央', nonJma: true },
    ])).toEqual([{ name: '中央', nonJma: false }])
  })
})

describe('groupUnreceivedPointNames', () => {
  it('正: 都道府県で区切る（県の並びは最初に現れた順）', () => {
    expect(groupUnreceivedPointNames([
      { addr: '別府市鶴見', pref: '大分県' },
      { addr: '延岡市北方町卯', pref: '宮崎県', nonJma: true },
      { addr: '佐伯市本匠', pref: '大分県', nonJma: true },
    ])).toEqual([
      { pref: '大分県', names: [{ name: '別府市鶴見', nonJma: false }, { name: '佐伯市本匠', nonJma: true }] },
      { pref: '宮崎県', names: [{ name: '延岡市北方町卯', nonJma: true }] },
    ])
  })

  it('対照: 同名でも県が違えば別の行になる（市町村名は全国で一意ではない）', () => {
    expect(groupUnreceivedPointNames([
      { addr: '府中市', pref: '東京都' },
      { addr: '府中市', pref: '広島県' },
    ])).toEqual([
      { pref: '東京都', names: [{ name: '府中市', nonJma: false }] },
      { pref: '広島県', names: [{ name: '府中市', nonJma: false }] },
    ])
    // 同じ県の中なら従来どおり 1 行へまとまる。
    expect(groupUnreceivedPointNames([
      { addr: '府中市', pref: '東京都' },
      { addr: '府中市', pref: '東京都' },
    ])).toEqual([{ pref: '東京都', names: [{ name: '府中市', nonJma: false }] }])
  })

  it('安全弁: 県を引けなかった点も落とさない（見出しの無いかたまりになる）', () => {
    expect(groupUnreceivedPointNames([{ addr: '名前だけの点', pref: '' }]))
      .toEqual([{ pref: '', names: [{ name: '名前だけの点', nonJma: false }] }])
  })
})
