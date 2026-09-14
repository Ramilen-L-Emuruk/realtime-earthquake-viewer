// @vitest-environment jsdom
//
// 津波の区域名をクリックすると、地図がその予報区の範囲へ寄ること
// （→ docs/spec/tsunami-spec.md §9「観測点の行・区域名をクリックしたときの寄り先」）。
//
// 観測点の行は以前から押せるが、**区域そのものは押せなかった**。押せるかどうかは観測点と同じ
// 規律で決める —— 寄り先を作れる区域だけが押せる。行全体ではなく区域名だけを当たり判定に
// するのは、この行が観測点の一覧を抱えているため。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TsunamiTab } from './index'
import type { JMATsunami, TsunamiArea } from '../../types/earthquake'

// 海岸線は実行時に fetch で取る。**福島県だけ**を与え、岩手県は与えない
// （境界を引けない区域が押せないことの対照）。
const FUKUSHIMA_LINES: [number, number][][] = [[[36.9, 140.9], [37.9, 141.1]]]
vi.mock('../../hooks/useTsunamiZones', () => ({
  useTsunamiZones: () => ({ 福島県: FUKUSHIMA_LINES }),
}))

afterEach(cleanup)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver

const AREAS: TsunamiArea[] = [
  {
    code: '250', name: '福島県', grade: 'MajorWarning', immediate: true,
    maxHeight: { description: '6m', value: 6.0 },
  },
  // 海岸線データを持たない区域（押せないことの対照）。
  { code: '220', name: '岩手県', grade: 'Warning', immediate: false, maxHeight: { description: '3m', value: 3.0 } },
]

const TSUNAMI: JMATsunami = {
  kind: 'tsunami',
  id: 'test-tsunami-area-focus',
  eventId: '20260420050000',
  time: '2026-04-20T05:30:00',
  cancelled: false,
  issue: { source: 'テスト', time: '2026-04-20T05:30:00', type: 'Focus' },
  areas: AREAS,
  observations: [],
}

function renderTab(onFocusMap: (positions: [number, number][]) => void) {
  render(<TsunamiTab tsunamis={[TSUNAMI]} onFocusMap={onFocusMap} />)
}

describe('津波の区域名をクリックしたときの寄り先', () => {
  // 正: 海岸線を引ける区域は押せて、その外接矩形が寄り先になる。
  it('海岸線を引ける区域名を押すと、その予報区の範囲へ寄る', () => {
    const onFocusMap = vi.fn()
    renderTab(onFocusMap)

    const label = screen.getByText('福島県')
    expect(label.getAttribute('role')).toBe('button')
    fireEvent.click(label)

    expect(onFocusMap).toHaveBeenCalledWith([[36.9, 140.9], [37.9, 141.1]])
  })

  // 対照: 海岸線を引けない区域は押せる見た目にしない（押しても何も起きない行を作らない）。
  it('海岸線を引けない区域名は押せる見た目にならない', () => {
    const onFocusMap = vi.fn()
    renderTab(onFocusMap)

    const label = screen.getByText('岩手県')
    expect(label.getAttribute('role')).toBeNull()
    fireEvent.click(label)

    expect(onFocusMap).not.toHaveBeenCalled()
  })

  // 安全弁: 寄せ先を渡していない呼び出し元では、区域名が押せる見た目にならない。
  // **押せる見た目だけ与えて何も起きない**のがいちばん困る形なので、経路の有無で分ける。
  it('寄せ先の受け口が無ければ区域名は押せない', () => {
    render(<TsunamiTab tsunamis={[TSUNAMI]} />)

    expect(screen.getByText('福島県').getAttribute('role')).toBeNull()
  })
})
