// @vitest-environment jsdom
//
// 初回だけ初期値を組み立てる ref の検証。
//
// **見たいのは「2 回目以降に組み立て直さない」こと**。ここが崩れても画面には何も現れず、
// 型検査もテストも通ってしまい、ただ静かに重くなる（このフックが消したはずの無駄がそのまま戻る）。
// 実装は 3 行だが、壊れたことに気づける手段が他に無いのでテストで固定する。
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLazyRef } from './useLazyRef'

describe('useLazyRef', () => {
  it('何度再レンダーしても初期化は 1 回だけ', () => {
    const init = vi.fn(() => ({ v: 1 }))
    const { result, rerender } = renderHook(() => useLazyRef(init))
    expect(init).toHaveBeenCalledTimes(1)
    const first = result.current.current
    rerender()
    rerender()
    rerender()
    expect(init).toHaveBeenCalledTimes(1)
    expect(result.current.current).toBe(first)
  })

  it('ref の実体が再レンダーをまたいで変わらない', () => {
    const { result, rerender } = renderHook(() => useLazyRef(() => ({ v: 1 })))
    const ref = result.current
    rerender()
    expect(result.current).toBe(ref)
  })

  it('書き換えた値が再レンダーで巻き戻らない', () => {
    // 検知エンジンの状態はこの ref の上で毎秒書き換わる。巻き戻ると学習が積み上がらない。
    const init = vi.fn(() => ({ v: 1 }))
    const { result, rerender } = renderHook(() => useLazyRef(init))
    result.current.current = { v: 99 }
    rerender()
    expect(result.current.current).toEqual({ v: 99 })
    expect(init).toHaveBeenCalledTimes(1)
  })

  it('別々に使っても互いの値を共有しない', () => {
    const a = renderHook(() => useLazyRef(() => ({ v: 'a' })))
    const b = renderHook(() => useLazyRef(() => ({ v: 'b' })))
    expect(a.result.current.current).toEqual({ v: 'a' })
    expect(b.result.current.current).toEqual({ v: 'b' })
  })
})
