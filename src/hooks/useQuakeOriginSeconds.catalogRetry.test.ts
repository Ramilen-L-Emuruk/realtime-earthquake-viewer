// @vitest-environment jsdom
// 長期震源カタログの取り直し（年ごとの成否・60 秒おき・3 回まで）を、フックを立てて確かめる。
// 純関数のテスト（`useQuakeOriginSeconds.test.ts`）では effect の取り直しが見えない。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { EEWAlert, JMAQuake } from '../types/earthquake'

const h = vi.hoisted(() => ({
  loadHypocenterIndex: vi.fn(),
  loadHypocenterYear: vi.fn(),
}))
vi.mock('../utils/hypocenterCatalog', () => ({
  loadHypocenterIndex: h.loadHypocenterIndex,
  loadHypocenterYear: h.loadHypocenterYear,
}))
vi.mock('../utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger')>()
  return { ...actual, log: { ...actual.log, warn: vi.fn() } }
})

import { useQuakeOriginSeconds } from './useQuakeOriginSeconds'
import { quakeEventKey } from '../utils/quakeMerge'

const CATALOG_MS = Date.parse('2026-10-03T13:26:00.85+09:00')
const card = {
  id: 'dmdata-quake-20261003132605-3',
  time: '2026-10-03T13:26:00+09:00',
  issue: { source: '', time: '2026-10-03T13:26:00+09:00', type: '震源・震度情報' },
  earthquake: {
    time: '2026-10-03T13:26:00+09:00',
    hypocenter: { name: '熊本県天草・芦北地方', latitude: 32.5, longitude: 130.5, depth: 10, magnitude: 3.5 },
    maxScale: 10,
    domesticTsunami: 'None',
  },
  points: [],
} as unknown as JMAQuake
const QUAKES = [card]
const NO_EEWS: ReadonlyMap<string, EEWAlert> = new Map()
const YEAR_2026 = { year: 2026, timeMs: [CATALOG_MS], lat: [32.5], lng: [130.5], magnitude: [3.5] }

/** 待っている Promise を流し切る（偽のタイマーは進めない）。 */
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

function render() {
  return renderHook(() =>
    // API キーを渡さないので緊急地震速報の一覧は取りに行かない（カタログだけを見る）。
    useQuakeOriginSeconds({ enabled: true, isDmdss: true, apiKey: '', classifications: null, quakes: QUAKES, activeEEWs: NO_EEWS, replayOffsetMs: null }),
  )
}

describe('useQuakeOriginSeconds（長期震源カタログの取り直し）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    h.loadHypocenterIndex.mockReset().mockResolvedValue({ years: [2026], coveredThroughMs: CATALOG_MS + 10 * 86400_000 })
    h.loadHypocenterYear.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  // 正: 1 回目に読めなかった年を、60 秒後に取り直して秒を引ける。
  test('読めなかった年は 60 秒後に取り直す', async () => {
    h.loadHypocenterYear.mockRejectedValueOnce(new Error('network')).mockResolvedValue(YEAR_2026)
    const { result } = render()
    await flush()
    expect(result.current.size).toBe(0)
    expect(h.loadHypocenterYear).toHaveBeenCalledTimes(1)

    // 対照: 60 秒に届かないうちは取り直さない。
    await act(async () => { await vi.advanceTimersByTimeAsync(59_000) })
    expect(h.loadHypocenterYear).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    await flush()
    expect(h.loadHypocenterYear).toHaveBeenCalledTimes(2)
    expect(result.current.get(quakeEventKey(card))).toEqual({ originMs: CATALOG_MS, source: 'catalog' })
  })

  // 安全弁: 読めないままでも取り直しは 3 回で止まる（初回と合わせて 4 回）。
  test('取り直しは 3 回で止まる', async () => {
    h.loadHypocenterYear.mockRejectedValue(new Error('network'))
    const { result } = render()
    await flush()
    for (let i = 0; i < 6; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      await flush()
    }
    expect(h.loadHypocenterYear).toHaveBeenCalledTimes(4)
    expect(result.current.size).toBe(0)
  })

  test('索引が読めなかったときも取り直す', async () => {
    h.loadHypocenterIndex.mockReset()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ years: [2026], coveredThroughMs: CATALOG_MS + 10 * 86400_000 })
    h.loadHypocenterYear.mockResolvedValue(YEAR_2026)
    const { result } = render()
    await flush()
    expect(h.loadHypocenterYear).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    await flush()
    expect(result.current.get(quakeEventKey(card))).toEqual({ originMs: CATALOG_MS, source: 'catalog' })
  })
})
