// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import type { HistoricalArchiveIndex } from '../types/historicalArchive'

vi.mock('../services/localArchiveReplay', () => ({ listHistoricalArchives: vi.fn() }))

import { listHistoricalArchives } from '../services/localArchiveReplay'
import { useHistoricalArchiveIndex } from './useHistoricalArchiveIndex'

const mockList = vi.mocked(listHistoricalArchives)

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
})

describe('useHistoricalArchiveIndex', () => {
  it('読み込み中は isLoading=true・archives=[] を返す（HIGH対策: 読み込み完了前に「確定」を押させない判定材料）', async () => {
    let resolveList!: (v: HistoricalArchiveIndex) => void
    mockList.mockReturnValue(new Promise((res) => { resolveList = res }))

    const { result } = renderHook(() => useHistoricalArchiveIndex())

    expect(result.current.isLoading).toBe(true)
    expect(result.current.archives).toEqual([])

    resolveList([])
    await waitFor(() => expect(result.current.isLoading).toBe(false))
  })

  it('読み込み完了後は isLoading=false・取得した一覧を返す', async () => {
    const archives: HistoricalArchiveIndex = [
      { id: '2011-tohoku', label: '2011年東北地方太平洋沖地震', description: 'test', from: '2011-03-11T05:45:00Z', to: '2011-03-11T06:00:00Z' },
    ]
    mockList.mockResolvedValue(archives)

    const { result } = renderHook(() => useHistoricalArchiveIndex())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.archives).toEqual(archives)
  })
})
