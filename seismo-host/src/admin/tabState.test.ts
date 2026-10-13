import { describe, expect, it } from 'vitest'
import { TabStates, formatHash, memoryStorage, parseHash, type KeyValueStorage } from './tabState'

describe('parseHash / formatHash', () => {
  it('タブと選択を往復できる', () => {
    const hash = formatHash('records', { group: 'station/a', from: '100', to: '200' })
    expect(parseHash(hash)).toEqual({ tab: 'records', selection: { group: 'station/a', from: '100', to: '200' } })
  })

  it('選択が無ければタブ名だけになる', () => {
    expect(formatHash('status', {})).toBe('#status')
    expect(parseHash('#status')).toEqual({ tab: 'status', selection: {} })
  })

  it('同じ選択は並び順によらず同じ文字列になる（URL を比べられる）', () => {
    expect(formatHash('boards', { b: '1', a: '2' })).toBe(formatHash('boards', { a: '2', b: '1' }))
  })

  it('記号を含む値も壊さずに往復する', () => {
    const selection = { board: 'mac:aa&bb=cc#dd', diff: 'p:s/1?x' }
    expect(parseHash(formatHash('waves', selection))?.selection).toEqual(selection)
  })

  it('知らないタブ名・空の hash は読めない扱い', () => {
    expect(parseHash('#nope')).toBeNull()
    expect(parseHash('')).toBeNull()
    expect(parseHash('#')).toBeNull()
  })

  it('空の値は選択に含めない', () => {
    expect(parseHash('#stations?station=&x=1')?.selection).toEqual({ x: '1' })
  })
})

describe('TabStates', () => {
  it('選択はタブごとに分かれ、sessionStorage を通して作り直しても残る', () => {
    const session = memoryStorage()
    const a = new TabStates(session, memoryStorage())
    a.storesFor('boards', new AbortController().signal, () => {}).selection.set({ board: 'k1' })
    a.storesFor('stations', new AbortController().signal, () => {}).selection.set({ station: 's1' })

    const b = new TabStates(session, memoryStorage())
    expect(b.selectionOf('boards')).toEqual({ board: 'k1' })
    expect(b.selectionOf('stations')).toEqual({ station: 's1' })
  })

  it('null を渡したキーだけ消し、ほかのキーは残す', () => {
    const states = new TabStates(memoryStorage(), memoryStorage())
    const { selection } = states.storesFor('records', new AbortController().signal, () => {})
    selection.set({ group: 'g', from: '1', to: '2' })
    selection.set({ from: null })
    expect(states.selectionOf('records')).toEqual({ group: 'g', to: '2' })
  })

  it('選択が変わったら知らせる', () => {
    const states = new TabStates(memoryStorage(), memoryStorage())
    let calls = 0
    states.storesFor('shakes', new AbortController().signal, () => calls++).selection.set({ shake: 'x' })
    expect(calls).toBe(1)
  })

  it('打ち切られた後の書き込みは捨てる（前のタブの遅れた応答が URL を汚さない）', () => {
    const states = new TabStates(memoryStorage(), memoryStorage())
    const controller = new AbortController()
    const { selection, prefs } = states.storesFor('waves', controller.signal, () => {})
    controller.abort()
    selection.set({ diff: 'late' })
    prefs.save({ spanMs: 5000 })
    expect(states.selectionOf('waves')).toEqual({})
    expect(states.storesFor('waves', new AbortController().signal, () => {}).prefs.load()).toBeNull()
  })

  it('表示の好みは JSON で往復し、壊れた中身は null として読む', () => {
    const local = memoryStorage()
    const states = new TabStates(memoryStorage(), local)
    const { prefs } = states.storesFor('records', new AbortController().signal, () => {})
    prefs.save({ unit: 'native' })
    expect(prefs.load()).toEqual({ unit: 'native' })
    local.setItem('seismo-admin-view:records', '{壊れている')
    expect(prefs.load()).toBeNull()
  })

  it('Storage が投げても画面は止めない（読めなければ空、書けなければ捨てる）', () => {
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    const states = new TabStates(throwing, throwing)
    const { selection, prefs } = states.storesFor('boards', new AbortController().signal, () => {})
    expect(() => selection.set({ board: 'k' })).not.toThrow()
    // メモリには残る（いまの画面では選択が効く）
    expect(selection.get('board')).toBe('k')
    expect(() => prefs.save({ a: 1 })).not.toThrow()
    expect(prefs.load()).toBeNull()
  })
})
