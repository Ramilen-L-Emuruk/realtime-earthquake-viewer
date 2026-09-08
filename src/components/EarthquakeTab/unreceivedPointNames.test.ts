import { describe, it, expect } from 'vitest'
import { mergeUnreceivedPointNames } from './unreceivedPointNames'

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
