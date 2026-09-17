// 既読の巻き戻し（`rollbackSpokenEntry`）。
//
// **守るのは「他が上書きしていたら触らない」の一点。** ここが緩むと、あとから声になった事実を
// 失敗した発話が消す —— 症状は「その EEW では以後どんな続報も読み上げない」という沈黙で、
// 例外もログも出ない。呼び出し側（`useLiveEventHandler` の第 1・第 2 フェーズ）は発話が
// 終わってから呼ぶので、そのあいだに別のフェーズが書き込む余地がある。
import { describe, it, expect } from 'vitest'
import { rollbackSpokenEntry } from './rollbackSpoken'

describe('既読の巻き戻し', () => {
  // 正: 自分が書いた値のままなら、前の値へ戻す
  it('自分が書いた値のままなら前の値へ戻す', () => {
    const map = new Map<string, number>([['a', 1]])
    map.set('a', 2)
    rollbackSpokenEntry(map, 'a', 2, 1)
    expect(map.get('a')).toBe(1)
  })

  // 正: 前の値が無ければ消す（初めて書いた場合）
  it('前の値が無ければ消す', () => {
    const map = new Map<string, number>()
    map.set('a', 2)
    rollbackSpokenEntry(map, 'a', 2, undefined)
    expect(map.has('a')).toBe(false)
  })

  // 対照: 他が上書きしていたら触らない
  it('他が上書きしていたら触らない', () => {
    const map = new Map<string, number>([['a', 1]])
    map.set('a', 2)
    map.set('a', 3)          // 別のフェーズが声にした値
    rollbackSpokenEntry(map, 'a', 2, 1)
    expect(map.get('a')).toBe(3)
  })

  // 安全弁: 判定は同一性。**同じ中身でも別のオブジェクトなら「他が書いた」とみなす**
  // （呼び出し元は毎回新しいオブジェクトを作る。JSDoc の前提そのもの）
  it('中身が同じでも別のオブジェクトなら触らない', () => {
    const written = { scale: 50 }
    const map = new Map<string, { scale: number }>()
    map.set('a', written)
    map.set('a', { scale: 50 })   // 中身は同じだが別の書き込み
    rollbackSpokenEntry(map, 'a', written, undefined)
    expect(map.has('a')).toBe(true)
  })

  // 安全弁: 別の鍵には触らない
  it('別の鍵には触らない', () => {
    const map = new Map<string, number>([['a', 1], ['b', 9]])
    rollbackSpokenEntry(map, 'a', 1, undefined)
    expect(map.has('a')).toBe(false)
    expect(map.get('b')).toBe(9)
  })
})
