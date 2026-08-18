// @vitest-environment jsdom
//
// 入力途中の中間状態で重い副作用が走らないことを保証する。
// APIキー欄は 1 文字ごとに設定を更新するため、このデバウンスが外れると
// 未完成のキーで接続・履歴取得をやり直し、401/403 がコンソールを埋める。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebouncedValue } from './useDebouncedValue'

afterEach(() => {
  vi.useRealTimers()
})

describe('useDebouncedValue', () => {
  it('初期値はそのまま返す（初回は待たせない）', () => {
    const { result } = renderHook(() => useDebouncedValue('abc', 800))

    expect(result.current).toBe('abc')
  })

  it('遅延時間が経つまで新しい値を返さない', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 800), {
      initialProps: { v: 'a' },
    })

    rerender({ v: 'ab' })
    expect(result.current).toBe('a')

    act(() => { vi.advanceTimersByTime(799) })
    expect(result.current).toBe('a')

    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current).toBe('ab')
  })

  it('連続して変わる間は確定させず、最後の値だけを一度で反映する', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 800), {
      initialProps: { v: '' },
    })

    // 1 文字ずつ入力していく様子。途中の値は一度も外に出てはいけない。
    for (const v of ['k', 'ke', 'key', 'key1']) {
      rerender({ v })
      act(() => { vi.advanceTimersByTime(200) })
      expect(result.current).toBe('')
    }

    act(() => { vi.advanceTimersByTime(800) })
    expect(result.current).toBe('key1')
  })

  it('元の値へ戻ったときは何も起きない（無駄な反映をしない）', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 800), {
      initialProps: { v: 'a' },
    })

    rerender({ v: 'ab' })
    rerender({ v: 'a' })
    act(() => { vi.advanceTimersByTime(2000) })

    expect(result.current).toBe('a')
  })
})
