// @vitest-environment jsdom
//
// 受信時スクロールが「寄せ先が無い」受信をどう扱うかを固定するテスト。
//
// 要求の中身（`resetToTop`）を決めるのは `useLiveEventHandler` 側で、そちらは
// `useLiveEventHandler.tsunamiScroll.test.ts` が見ている。**ここで守るのは受け取る側** ――
// 空配列を見た瞬間に先頭へ戻す実装へ戻ると、満潮時刻の報や沖合の観測情報が
// 直前の報の位置を捨てる状態に逆戻りする。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { TsunamiTab, type FocusedDistrict } from './index'
import type { JMATsunami } from '../../types/earthquake'

// 観測点座標は取得しない（fetch を呼ばせない）。マーカーの有無はこのテストの対象外。
vi.mock('../../utils/tsunamiObsCoords', () => ({
  loadTsunamiObsCoords: () => Promise.resolve({}),
}))

const TSUNAMI = {
  kind: 'tsunami',
  id: 'tsunami-1',
  eventId: 'evt-1',
  time: '2026-04-20T08:00:00Z',
  cancelled: false,
  issue: { source: 'JMA', time: '2026-04-20T08:00:00Z', type: 'Focus' },
  areas: [{ name: '岩手県', code: '210', grade: 'Warning', immediate: false }],
  observations: [],
} as unknown as JMATsunami

function focus(resetToTop: boolean): FocusedDistrict {
  return { districts: [], top: null, resetToTop, ts: Date.now() }
}

let scrollTo: ReturnType<typeof vi.fn>

beforeEach(() => {
  // jsdom は Element.scrollTo を実装していない（呼ぶと「not implemented」で落ちる）
  scrollTo = vi.fn()
  Object.defineProperty(Element.prototype, 'scrollTo', {
    value: scrollTo, writable: true, configurable: true,
  })
  // jsdom には ResizeObserver が無い。バナー高さの実測に使っているだけなので空実装で足りる。
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: class { observe() {} unobserve() {} disconnect() {} },
    writable: true, configurable: true,
  })
})
afterEach(() => { vi.restoreAllMocks() })

describe('寄せ先が無い受信のスクロール', () => {
  it('正: resetToTop が false なら動かさない', () => {
    render(<TsunamiTab tsunamis={[TSUNAMI]} focusedDistrict={focus(false)} />)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('対照: resetToTop が true なら先頭へ戻す', () => {
    render(<TsunamiTab tsunamis={[TSUNAMI]} focusedDistrict={focus(true)} />)
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })

  it('安全弁: 要求が無ければどちらでもない（スクロールしない）', () => {
    render(<TsunamiTab tsunamis={[TSUNAMI]} focusedDistrict={null} />)
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
