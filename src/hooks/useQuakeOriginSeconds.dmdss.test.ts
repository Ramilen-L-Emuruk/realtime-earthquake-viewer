// @vitest-environment jsdom
// DMDSS 版で過去の緊急地震速報の最終報を取りに行く配線を、フックを立てて確かめる
// （取り方そのものは `services/dmdataReplay.test.ts` の `fetchDmdataEewOrigins`）。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { EEWAlert, JMAQuake } from '../types/earthquake'
import type { DmdataClassification } from '../services/dmdataClassifications'

const h = vi.hoisted(() => ({
  fetchDmdataEewOrigins: vi.fn(),
  loadHypocenterIndex: vi.fn(),
}))
vi.mock('../services/dmdataReplay', () => ({ fetchDmdataEewOrigins: h.fetchDmdataEewOrigins }))
// カタログは引かせない（索引が読めないまま。秒は緊急地震速報からだけ決まる）。
vi.mock('../utils/hypocenterCatalog', () => ({
  loadHypocenterIndex: h.loadHypocenterIndex,
  loadHypocenterYear: vi.fn(),
}))
vi.mock('../utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger')>()
  return { ...actual, log: { ...actual.log, warn: vi.fn(), info: vi.fn() } }
})

import { useQuakeOriginSeconds } from './useQuakeOriginSeconds'
import { quakeEventKey } from '../utils/quakeMerge'

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
const NO_EEWS: ReadonlyMap<string, EEWAlert> = new Map()

/** 最終報（本文を読んだ結果の形）。 */
function finalReport(condition: string, originTime = '2026-10-03T13:26:01.400+09:00'): EEWAlert {
  return {
    id: 'dmdata-eew-x', test: false, cancelled: false,
    issue: { eventId: '20261003132605' },
    earthquake: { originTime, condition },
  } as unknown as EEWAlert
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

function render(classifications: readonly DmdataClassification[] | null) {
  return renderHook(({ cls }) =>
    useQuakeOriginSeconds({ enabled: true, isDmdss: true, apiKey: 'key', classifications: cls, quakes: [card], activeEEWs: NO_EEWS, replayOffsetMs: null }),
  { initialProps: { cls: classifications } })
}

describe('useQuakeOriginSeconds（DMDSS 版の過去の緊急地震速報）', () => {
  beforeEach(() => {
    h.fetchDmdataEewOrigins.mockReset()
    h.loadHypocenterIndex.mockReset().mockRejectedValue(new Error('テストでは読まない'))
  })
  afterEach(() => { localStorage.clear() })

  test('区分が決まるまでは取りに行かず、決まったら 1 回だけ取りに行く', async () => {
    h.fetchDmdataEewOrigins.mockResolvedValue({ finals: [], canceledIds: [], complete: true })
    const r = render(null)
    await flush()
    expect(h.fetchDmdataEewOrigins).not.toHaveBeenCalled()
    r.rerender({ cls: ['eew.forecast', 'telegram.earthquake'] })
    await flush()
    expect(h.fetchDmdataEewOrigins).toHaveBeenCalledTimes(1)
    const [, from, to, cls] = h.fetchDmdataEewOrigins.mock.calls[0]
    expect((to as Date).getTime() - (from as Date).getTime()).toBe(8 * 86_400_000)
    expect(cls).toEqual(['eew.forecast', 'telegram.earthquake'])
    // 同じ中身の区分を作り直しても取り直さない
    r.rerender({ cls: ['telegram.earthquake', 'eew.forecast'] })
    await flush()
    expect(h.fetchDmdataEewOrigins).toHaveBeenCalledTimes(1)
  })

  test('震源の決まった最終報の秒を地震カードへ使う', async () => {
    h.fetchDmdataEewOrigins.mockResolvedValue({ finals: [finalReport('')], canceledIds: [], complete: true })
    const r = render(['eew.forecast', 'telegram.earthquake'])
    await flush()
    expect(r.result.current.get(quakeEventKey(card))?.originMs).toBe(Date.parse('2026-10-03T13:26:01.400+09:00'))
  })

  test('最終報が仮定震源要素なら秒に使わない', async () => {
    h.fetchDmdataEewOrigins.mockResolvedValue({ finals: [finalReport('仮定震源要素')], canceledIds: [], complete: true })
    const r = render(['eew.forecast', 'telegram.earthquake'])
    await flush()
    expect(r.result.current.get(quakeEventKey(card))).toBeUndefined()
  })

  test('取りきれなかったら間を置いて取り直し、取りきれたらそれ以上取らない', async () => {
    vi.useFakeTimers()
    try {
      h.fetchDmdataEewOrigins
        .mockResolvedValueOnce({ finals: [], canceledIds: [], complete: false })
        .mockResolvedValue({ finals: [finalReport('')], canceledIds: [], complete: true })
      const r = render(['eew.forecast', 'telegram.earthquake'])
      await flush()
      expect(h.fetchDmdataEewOrigins).toHaveBeenCalledTimes(1)
      // 止める合図を渡している（取り直しの途中でも、要らなくなれば止められる）
      expect(h.fetchDmdataEewOrigins.mock.calls[0][4]).toBeInstanceOf(AbortSignal)
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(h.fetchDmdataEewOrigins).toHaveBeenCalledTimes(2)
      expect(r.result.current.get(quakeEventKey(card))?.originMs).toBe(Date.parse('2026-10-03T13:26:01.400+09:00'))
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
      expect(h.fetchDmdataEewOrigins).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('画面で取り消しを受けた地震は、あとから届いた取得結果で戻さない', async () => {
    let resolveFetch: (v: unknown) => void = () => {}
    h.fetchDmdataEewOrigins.mockReturnValue(new Promise((res) => { resolveFetch = res }))
    const canceledLive = new Map([['x', { ...finalReport(''), cancelled: true }]]) as ReadonlyMap<string, EEWAlert>
    const r = renderHook(({ eews }) =>
      useQuakeOriginSeconds({ enabled: true, isDmdss: true, apiKey: 'key', classifications: ['eew.forecast', 'telegram.earthquake'], quakes: [card], activeEEWs: eews, replayOffsetMs: null }),
    { initialProps: { eews: NO_EEWS } })
    await flush()
    // 取得の途中で、画面に取消が届く
    r.rerender({ eews: canceledLive })
    await flush()
    // 取得が取消前の最終報を持って返る（一覧はまだ取消を知らなかった）
    await act(async () => { resolveFetch({ finals: [finalReport('')], canceledIds: [], complete: true }); await Promise.resolve() })
    await flush()
    expect(r.result.current.get(quakeEventKey(card))).toBeUndefined()
  })

  test('取り消された地震は端末の記録からも除く', async () => {
    localStorage.clear()
    h.fetchDmdataEewOrigins.mockResolvedValue({ finals: [finalReport('')], canceledIds: ['20261003132605'], complete: true })
    const r = render(['eew.forecast', 'telegram.earthquake'])
    await flush()
    expect(r.result.current.get(quakeEventKey(card))).toBeUndefined()
  })
})
