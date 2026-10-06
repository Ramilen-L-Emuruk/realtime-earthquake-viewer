// @vitest-environment jsdom
//
// 「もっと見る」が取得制限で待たされている間、ボタン自身に残り時間を出す。
//
// 一覧の上の帯（「取得制限中」）は、ボタンを押した位置からは見えない。押した場所では
// 「取得中…」で止まっているだけに見えていた（2026-10-06 ユーザー指摘）。
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

const gate = vi.hoisted(() => ({ drainsAt: null as number | null }))
vi.mock('../../services/dmdataRequestGates', () => ({
  loadMoreDrainsAt: () => gate.drainsAt,
}))

import { LoadMoreButton } from './LoadMoreButton'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  gate.drainsAt = null
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('LoadMoreButton', () => {
  // 正: 押した後、門で待たされていれば残り時間を出し、毎秒減らす
  it('待たされている間は残り時間を出して数え下ろす', () => {
    gate.drainsAt = 135_000
    render(<LoadMoreButton onLoadMore={() => {}} isLoadingMore watchThrottle />)
    expect(screen.getByRole('button').textContent).toBe('取得制限中（あと 2:15）')
    expect(screen.getByRole('button')).toHaveProperty('disabled', true)

    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByRole('button').textContent).toBe('取得制限中（あと 2:14）')
  })

  // 正: 待ちが解けたら（読み込み・反映はまだ続く）「取得中…」へ戻る
  it('待ちが解けたら「取得中…」へ戻る', () => {
    gate.drainsAt = 2_000
    render(<LoadMoreButton onLoadMore={() => {}} isLoadingMore watchThrottle />)
    gate.drainsAt = null
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByRole('button').textContent).toBe('取得中…')
  })

  // 対照: 押す前は、門が埋まっていても数えない（押す前には出さない。2026-10-06 ユーザー承認）
  it('押す前は門が埋まっていても「もっと見る」のまま', () => {
    gate.drainsAt = 135_000
    render(<LoadMoreButton onLoadMore={() => {}} isLoadingMore={false} watchThrottle />)
    expect(screen.getByRole('button').textContent).toBe('もっと見る')
    expect(screen.getByRole('button')).toHaveProperty('disabled', false)
  })

  // 安全弁: 見張らない側（標準版）では門を読まず、従来どおり「取得中…」
  it('見張らない側では「取得中…」のまま', () => {
    gate.drainsAt = 135_000
    render(<LoadMoreButton onLoadMore={() => {}} isLoadingMore watchThrottle={false} />)
    expect(screen.getByRole('button').textContent).toBe('取得中…')
  })

  // 安全弁: 永久に待つ窓（上限 0 件）は数えられないので「取得中…」にする
  it('明ける時刻が無限なら数えない', () => {
    gate.drainsAt = Number.POSITIVE_INFINITY
    render(<LoadMoreButton onLoadMore={() => {}} isLoadingMore watchThrottle />)
    expect(screen.getByRole('button').textContent).toBe('取得中…')
  })
})
