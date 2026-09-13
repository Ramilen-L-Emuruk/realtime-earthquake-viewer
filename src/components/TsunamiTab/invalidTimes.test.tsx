// @vitest-environment jsdom
//
// 津波カードの時刻表示が、日時として読めない値のときに何を出すか。
//
// `formatTimeMin` / `formatDateTimeMin` は読めない値で `null` を返す（→ `utils/formatters.ts` の
// `readDateTime`）。**素で埋めるとラベルだけが残る** —— 「到達予想 」「満潮 」「 更新」。
// 型検査は通ってしまうので、DOM で固定する。
//
// このファイルは津波カードの中でも**時刻の落とし先が最も多い**（区域の到達予想・観測点の
// 到達／最大波・満潮・発表時刻・観測時点）。落とし方は欄ごとに違うので、代表を押さえる。
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { TsunamiTab } from './index'
import type { JMATsunami, TsunamiArea, TsunamiObservation } from '../../types/earthquake'

afterEach(cleanup)

// jsdom は ResizeObserver を持たない（バナーの実寸はこのテストの対象ではない）。
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver

const GOOD = '2026-04-20T17:30:00+09:00'
const BROKEN = '壊れた値'

function makeTsunami(over: {
  areaArrival?: string
  obsArrival?: string
  obsMaxHeight?: string
  highTide?: string
  time?: string
} = {}): JMATsunami {
  const observations: TsunamiObservation[] = [{
    name: '銚子',
    height: { description: '8.5m', value: 8.5 },
    arrivalTime: over.obsArrival ?? GOOD,
    maxHeightDateTime: over.obsMaxHeight ?? GOOD,
  }]
  const areas: TsunamiArea[] = [{
    code: '100',
    name: '岩手県',
    grade: 'Warning',
    immediate: true,
    maxHeight: { description: '3m', value: 3.0 },
    firstHeight: { arrivalTime: over.areaArrival ?? GOOD, condition: '' },
    stations: [{ code: '10001', name: '宮古', highTideDateTime: over.highTide ?? GOOD }],
  }]
  return {
    kind: 'tsunami',
    id: 'test-tsunami-1',
    eventId: '20260420165000',
    time: over.time ?? '2026-04-20T16:50:00+09:00',
    cancelled: false,
    issue: { source: 'テスト', time: '2026-04-20T16:50:00+09:00', type: 'Focus' },
    areas,
    observations,
  }
}

const renderTab = (t: JMATsunami) => render(<TsunamiTab tsunamis={[t]} isVisible />)

describe('津波カードの時刻が読めないとき', () => {
  // 対照: 読める値では従来どおり「◯◯ HH:MM」が並ぶ。ガードが正常な値まで止めていないこと。
  it('読める値では従来どおり出す', () => {
    const { container } = renderTab(makeTsunami())
    const text = container.textContent ?? ''
    expect(text).toContain('到達予想 17:30')
    expect(text).toContain('満潮 17:30')
    expect(text).toContain('最大波 17:30')
  })

  // 正: 区域の到達予想時刻が読めなければ、ラベルごと落とす。
  it('区域の到達予想時刻が読めなければ「到達予想 」を残さない', () => {
    const { container } = renderTab(makeTsunami({ areaArrival: BROKEN }))
    expect(container.textContent ?? '').not.toContain('到達予想')
  })

  // 正: 満潮時刻も同じ（「満潮 」だけが残ると値を読み落としたように見える）。
  it('満潮時刻が読めなければ「満潮 」を残さない', () => {
    const { container } = renderTab(makeTsunami({ highTide: BROKEN }))
    expect(container.textContent ?? '').not.toContain('満潮')
  })

  // 正: 最大波の観測時刻も同じ。
  it('最大波の観測時刻が読めなければ「最大波 」を残さない', () => {
    const { container } = renderTab(makeTsunami({ obsMaxHeight: BROKEN }))
    expect(container.textContent ?? '').not.toContain('最大波')
  })

  // 正: 発表時刻が読めなければ「 更新」の行ごと落とす。
  it('発表時刻が読めなければ「更新」の行を出さない', () => {
    const { container } = renderTab(makeTsunami({ time: BROKEN }))
    expect(container.textContent ?? '').not.toContain('更新')
  })

  // 安全弁: `NaN` も `null` も画面へ出ない（これが元の症状）。
  it('NaN・null を画面に出さない', () => {
    const { container } = renderTab(makeTsunami({
      areaArrival: BROKEN, obsArrival: BROKEN, obsMaxHeight: BROKEN, highTide: BROKEN, time: BROKEN,
    }))
    const text = container.textContent ?? ''
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('null')
    // 対照: 時刻が全部読めなくても、区域名・波高といった他の事実は残る。
    expect(text).toContain('岩手県')
    expect(text).toContain('8.5m')
  })
})
