// @vitest-environment jsdom
//
// 長期震源カタログの読み込みフックを固定する。
// 取得そのもの（`utils/hypocenterCatalog.ts`）はモックし、ここでは**分岐だけ**を見る。
// 背景は docs/spec/map-rendering-spec.md §16「長期震源カタログの点群」。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { HypocenterIndex, HypocenterYear } from '../utils/hypocenterCatalog'

vi.mock('../utils/hypocenterCatalog', async () => {
  const actual = await vi.importActual<typeof import('../utils/hypocenterCatalog')>(
    '../utils/hypocenterCatalog',
  )
  return {
    ...actual,
    loadHypocenterIndex: vi.fn(),
    loadHypocenterYear: vi.fn(),
  }
})

import { loadHypocenterIndex, loadHypocenterYear } from '../utils/hypocenterCatalog'
import { useHypocenterCatalog } from './useHypocenterCatalog'

const INDEX: HypocenterIndex = {
  source: 's',
  sourceUrl: 'u',
  license: 'l',
  minMagnitude: 2,
  coveredThroughMs: 0,
  completeness: [{ from: 1919, minMagnitude: 5 }],
  years: [2020, 2021, 2022],
  counts: {},
  quality: {},
  intensityYears: [],
}

/** 年ごとに**同じオブジェクトを返す**（実装のキャッシュと同じ性質。参照の安定を試すのに要る）。 */
const YEAR_CACHE = new Map<number, HypocenterYear>()
const makeYear = (year: number): HypocenterYear => {
  const hit = YEAR_CACHE.get(year)
  if (hit) return hit
  const y: HypocenterYear = {
    year,
    count: 0,
    coveredThroughMs: 0,
    quality: 'final',
    timeMs: new Float64Array(0),
    lat: new Float64Array(0),
    lng: new Float64Array(0),
    depth: new Float32Array(0),
    magnitude: new Float32Array(0),
    intensityIdx: new Int32Array(0),
    intensityCode: [],
  }
  YEAR_CACHE.set(year, y)
  return y
}

const mockIndex = vi.mocked(loadHypocenterIndex)
const mockYear = vi.mocked(loadHypocenterYear)

beforeEach(() => {
  YEAR_CACHE.clear()
  mockIndex.mockReset()
  mockYear.mockReset()
  mockIndex.mockResolvedValue(INDEX)
  mockYear.mockImplementation((y: number) => Promise.resolve(makeYear(y)))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useHypocenterCatalog', () => {
  // 対照: タブを開くまで何も取りに行かない（全期間で gzip 12.6MB あるため）。
  it('enabled が false の間は取りに行かない', async () => {
    renderHook(() => useHypocenterCatalog(2020, 2022, false))
    await new Promise((r) => setTimeout(r, 20))
    expect(mockIndex).not.toHaveBeenCalled()
    expect(mockYear).not.toHaveBeenCalled()
  })

  // 正: 範囲の年を読み、欠けは無い。
  it('範囲の年を読む', async () => {
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.years.length).toBe(3))
    expect(result.current.years.map((y) => y.year)).toEqual([2020, 2021, 2022])
    expect(result.current.missingYears).toEqual([])
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  // 正: **1 年失敗しても残りで描く。** `Promise.all` だと 1 本の不調で期間全体が消える。
  it('一部の年が失敗しても残りを返し、欠けた年を伝える', async () => {
    mockYear.mockImplementation((y: number) =>
      y === 2021 ? Promise.reject(new Error('boom')) : Promise.resolve(makeYear(y)),
    )
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.years.map((y) => y.year)).toEqual([2020, 2022])
    expect(result.current.missingYears).toEqual([2021])
  })

  // 対照: 全部失敗したら 1 件も返さない（前の期間のものを残さない）。
  // **`requestedYears` と `missingYears` が同数になること**が「まるごと取れなかった」の合図で、
  // 画面の文言はこれで「そのぶん少ない」と「1 件も出ていない」を言い分ける。
  it('全部失敗したら年は空', async () => {
    mockYear.mockImplementation(() => Promise.reject(new Error('boom')))
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.years).toEqual([])
    expect(result.current.missingYears).toEqual([2020, 2021, 2022])
    expect(result.current.requestedYears).toBe(3)
  })

  // 対照: 一部だけ欠けたときは同数にならない（上の合図が常に立たないこと）。
  it('一部だけ欠けたら requestedYears の方が多い', async () => {
    mockYear.mockImplementation((y: number) =>
      y === 2021 ? Promise.reject(new Error('boom')) : Promise.resolve(makeYear(y)),
    )
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.missingYears.length).toBeLessThan(result.current.requestedYears)
  })

  // 正: 索引の失敗は `error` として出す。
  it('索引の取得に失敗したら error が立つ', async () => {
    mockIndex.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.loading).toBe(false)
  })

  // **安全弁: タブを往復しても年の配列の参照が変わらない。**
  // ここが変わると、下流の点群の組み立てと GPU への転送がまるごと走り直す
  // （捨てていないのに詰め直すことになる）。
  it('タブを離れて戻っても年の配列の参照が変わらない', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useHypocenterCatalog(2020, 2022, enabled),
      { initialProps: { enabled: true } },
    )
    await waitFor(() => expect(result.current.years.length).toBe(3))
    const first = result.current.years
    rerender({ enabled: false })
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.years).toBe(first)
  })

  // 対照: 期間が変われば参照も変わる（上の安全弁が「常に同じ」になっていないこと）。
  it('期間を変えれば年の配列は差し替わる', async () => {
    const { result, rerender } = renderHook(
      ({ from }: { from: number }) => useHypocenterCatalog(from, 2022, true),
      { initialProps: { from: 2021 } },
    )
    await waitFor(() => expect(result.current.years.length).toBe(2))
    const first = result.current.years
    rerender({ from: 2020 })
    await waitFor(() => expect(result.current.years.length).toBe(3))
    expect(result.current.years).not.toBe(first)
  })

  // 正: 再試行で読み直す。索引は既にあるので取りに行かない。
  it('retry で年を読み直し、索引は取り直さない', async () => {
    mockYear.mockImplementation(() => Promise.reject(new Error('boom')))
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.missingYears.length).toBe(3))
    const indexCalls = mockIndex.mock.calls.length

    mockYear.mockImplementation((y: number) => Promise.resolve(makeYear(y)))
    result.current.retry()
    await waitFor(() => expect(result.current.years.length).toBe(3))
    expect(result.current.missingYears).toEqual([])
    expect(mockIndex.mock.calls.length).toBe(indexCalls)
  })

  // 安全弁: 索引に無い年は取りに行かない（存在しない年で 404 になる）。
  it('索引に無い年は取りに行かない', async () => {
    const { result } = renderHook(() => useHypocenterCatalog(1800, 1900, true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.years).toEqual([])
    expect(mockYear).not.toHaveBeenCalled()
  })
})
