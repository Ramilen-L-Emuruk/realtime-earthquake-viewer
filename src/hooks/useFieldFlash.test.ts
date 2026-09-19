// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { useFieldFlash } from './useFieldFlash'
import { EEW_HIGHLIGHT_HOLD_RATIO } from '../utils/updateMark'

describe('欄ごとの減衰（useFieldFlash）', () => {
  // 正: 値が動いたら連番が進み、向きが付く。
  it('値が上がったら連番が進み、上がったの印になる', () => {
    const { result, rerender } = renderHook(
      ({ m }: { m: number }) => useFieldFlash('eew-1', { magnitude: { key: String(m), rank: m } }),
      { initialProps: { m: 6.5 } },
    )
    expect(result.current.magnitude).toBeUndefined()
    act(() => { rerender({ m: 6.8 }) })
    expect(result.current.magnitude).toEqual({ tick: 1, status: 'raised' })
  })

  // 対照: 下がったら別の向きになる。
  it('値が下がったら下がったの印になる', () => {
    const { result, rerender } = renderHook(
      ({ m }: { m: number }) => useFieldFlash('eew-1', { magnitude: { key: String(m), rank: m } }),
      { initialProps: { m: 6.8 } },
    )
    act(() => { rerender({ m: 6.5 }) })
    expect(result.current.magnitude?.status).toBe('lowered')
  })

  // 対照: **初めて現れた値は「動いた」ではない。** 仮定震源要素の報では規模・深さの欄自体が
  // 出ないので、確定してから現れた瞬間に光らせない。
  it('欄が初めて現れただけでは光らせない', () => {
    const { result, rerender } = renderHook(
      ({ m }: { m: number | undefined }) =>
        useFieldFlash('eew-1', { magnitude: m === undefined ? undefined : { key: String(m), rank: m } }),
      { initialProps: { m: undefined as number | undefined } },
    )
    act(() => { rerender({ m: 6.5 }) })
    expect(result.current.magnitude).toBeUndefined()
  })

  // 対照: 値が動いていなければ連番は進まない。
  it('値が同じなら連番は進まない', () => {
    const { result, rerender } = renderHook(
      ({ m }: { m: number }) => useFieldFlash('eew-1', { magnitude: { key: String(m), rank: m } }),
      { initialProps: { m: 6.5 } },
    )
    act(() => { rerender({ m: 6.5 }) })
    expect(result.current.magnitude).toBeUndefined()
  })

  // 安全弁: 別のものになったら連番を 0 へ戻す。**前の地震の値と比べない。**
  it('対象が別のものへ変わったら連番を戻す', () => {
    const { result, rerender } = renderHook(
      ({ id, m }: { id: string; m: number }) => useFieldFlash(id, { magnitude: { key: String(m), rank: m } }),
      { initialProps: { id: 'eew-1', m: 6.5 } },
    )
    act(() => { rerender({ id: 'eew-1', m: 6.8 }) })
    expect(result.current.magnitude?.tick).toBe(1)
    act(() => { rerender({ id: 'eew-2', m: 5.0 }) })
    expect(result.current.magnitude).toBeUndefined()
  })

  // 安全弁: 続けて動いたら連番が進む（要素を作り直して減衰をやり直させるため）。
  it('続けて動いたら連番が進む', () => {
    const { result, rerender } = renderHook(
      ({ m }: { m: number }) => useFieldFlash('eew-1', { magnitude: { key: String(m), rank: m } }),
      { initialProps: { m: 6.5 } },
    )
    act(() => { rerender({ m: 6.8 }) })
    act(() => { rerender({ m: 7.1 }) })
    expect(result.current.magnitude?.tick).toBe(2)
  })
})

describe('減衰の保持時間', () => {
  /**
   * **CSS の `@keyframes` は定数から組み立てられない**（オフセットにカスタムプロパティを
   * 使えない）。`EEW_HIGHLIGHT_HOLD_RATIO` と `src/index.css` は人の手で揃えるしかないので、
   * 揃っていることを機械で確かめる。**片方だけ動かすと、意図した保持時間と実際が静かにずれる。**
   */
  it('CSS の保持位置が EEW_HIGHLIGHT_HOLD_RATIO と揃っている', () => {
    const css = readFileSync('src/index.css', 'utf8')
    const offsets = [...css.matchAll(/@keyframes update-fade-(?:text|bg) \{\s*0%,\s*(\d+)%/g)]
      .map(m => Number(m[1]))
    // 走査そのものが空振りしていないこと（規則の名前を変えたら気づけるように）。
    expect(offsets.length).toBe(2)
    for (const offset of offsets) expect(offset / 100).toBe(EEW_HIGHLIGHT_HOLD_RATIO)
  })
})
