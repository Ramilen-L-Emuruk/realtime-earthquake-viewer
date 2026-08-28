// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup, act } from '@testing-library/react'
import type { HistoricalArchiveIndex, HistoricalArchiveMeta } from '../types/historicalArchive'
import type { EventResult } from '../utils/knet/kyoshinEventMerge'

vi.mock('../services/localArchiveReplay', () => ({ findCoveringArchiveSync: vi.fn() }))
vi.mock('../utils/knet/buildEventResultFromZip', () => ({
  buildEventResultFromZip: vi.fn(),
  parseJstTimestamp: vi.fn(),
  WINDOW_SEC_DEFAULT: 20,
  STEP_SEC_DEFAULT: 1,
}))
vi.mock('../utils/kyoshinImportDb', () => ({
  countImportedEvents: vi.fn(),
  deleteImportedEvents: vi.fn(),
  saveImportedEvent: vi.fn(),
  onImportsChanged: vi.fn(() => () => {}),
  hasImportStorageError: vi.fn(() => false),
}))

import { findCoveringArchiveSync } from '../services/localArchiveReplay'
import { buildEventResultFromZip, parseJstTimestamp } from '../utils/knet/buildEventResultFromZip'
import { countImportedEvents, deleteImportedEvents, saveImportedEvent, hasImportStorageError } from '../utils/kyoshinImportDb'
import { useKyoshinImport } from './useKyoshinImport'

const mockFindCovering = vi.mocked(findCoveringArchiveSync)
const mockBuildEvent = vi.mocked(buildEventResultFromZip)
const mockParseJst = vi.mocked(parseJstTimestamp)
const mockCount = vi.mocked(countImportedEvents)
const mockDelete = vi.mocked(deleteImportedEvents)
const mockSave = vi.mocked(saveImportedEvent)
const mockHasStorageError = vi.mocked(hasImportStorageError)

const archives: HistoricalArchiveIndex = [
  { id: '2018-osaka', label: '2018年大阪府北部地震', description: 'test', from: '2018-06-17T15:00:00Z', to: '2018-06-19T15:00:00Z', firstEventTime: '2018-06-17T22:58:00Z' },
]

function makeEvent(originTimeJst: string): EventResult {
  return { originTimeJst, stationSeries: [{ stationCode: 'AAA', latitude: 1, longitude: 1, points: [] }], peakIntensity: 5.0 }
}

/** Array.from(files)で回せれば十分なため、実際のFileListは作らずFile配列で代用する。 */
function fakeFileList(files: File[]): FileList {
  return files as unknown as FileList
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  mockCount.mockResolvedValue(0)
  mockHasStorageError.mockReturnValue(false)
})

describe('useKyoshinImport', () => {
  it('正: 対応するアーカイブが見つかれば保存し、errorsは空になる', async () => {
    mockBuildEvent.mockReturnValue(makeEvent('20180618075834'))
    mockParseJst.mockReturnValue(new Date('2018-06-18T07:58:34+09:00'))
    mockFindCovering.mockReturnValue(archives[0] as HistoricalArchiveMeta)
    mockSave.mockResolvedValue(true)

    const { result } = renderHook(() => useKyoshinImport(archives))
    await act(async () => {
      await result.current.importFiles(fakeFileList([new File([new Uint8Array([1, 2, 3])], 'osaka.zip')]))
    })

    expect(result.current.errors).toEqual([])
    expect(mockSave).toHaveBeenCalledWith('2018-osaka', expect.objectContaining({ originTimeJst: '20180618075834' }))
  })

  it('対照: 対応するアーカイブが見つからなければ、そのファイルだけerrorsに積まれる', async () => {
    mockBuildEvent.mockReturnValue(makeEvent('19990101000000'))
    mockParseJst.mockReturnValue(new Date('1999-01-01T00:00:00+09:00'))
    mockFindCovering.mockReturnValue(null)

    const { result } = renderHook(() => useKyoshinImport(archives))
    await act(async () => {
      await result.current.importFiles(fakeFileList([new File([new Uint8Array([1])], 'unknown.zip')]))
    })

    expect(result.current.errors).toHaveLength(1)
    expect(result.current.errors[0].fileName).toBe('unknown.zip')
    expect(result.current.errors[0].message).toMatch(/対応するデータが見つかりません/)
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('安全弁: 複数ファイル中の1件が失敗しても、他のファイルは正常に処理される', async () => {
    mockParseJst.mockReturnValue(new Date('2018-06-18T07:58:34+09:00'))
    mockBuildEvent.mockImplementation((zip) => {
      const marker = new Uint8Array(zip)[0]
      if (marker === 0) throw new Error('パースに失敗しました')
      return makeEvent('20180618075834')
    })
    mockFindCovering.mockReturnValue(archives[0] as HistoricalArchiveMeta)
    mockSave.mockResolvedValue(true)

    const { result } = renderHook(() => useKyoshinImport(archives))
    await act(async () => {
      await result.current.importFiles(fakeFileList([
        new File([new Uint8Array([0])], 'broken.zip'),
        new File([new Uint8Array([1])], 'ok.zip'),
      ]))
    })

    expect(result.current.errors).toHaveLength(1)
    expect(result.current.errors[0].fileName).toBe('broken.zip')
    expect(mockSave).toHaveBeenCalledTimes(1)
  })

  it('正: deleteArchiveが成功すればdeleteErrorはnullのまま', async () => {
    mockDelete.mockResolvedValue(true)
    const { result } = renderHook(() => useKyoshinImport(archives))
    await act(async () => {
      await result.current.deleteArchive('2018-osaka')
    })
    expect(result.current.deleteError).toBeNull()
  })

  it('安全弁: deleteArchiveが失敗したらdeleteErrorにメッセージが入る', async () => {
    mockDelete.mockResolvedValue(false)
    const { result } = renderHook(() => useKyoshinImport(archives))
    await act(async () => {
      await result.current.deleteArchive('2018-osaka')
    })
    expect(result.current.deleteError).not.toBeNull()
  })

  it('安全弁: 保存先の読み取りに問題があれば、summariesが0件でもstorageErrorで見分けられる', async () => {
    mockCount.mockResolvedValue(0)
    mockHasStorageError.mockReturnValue(true)
    const { result } = renderHook(() => useKyoshinImport(archives))
    await waitFor(() => expect(result.current.storageError).toBe(true))
    expect(result.current.summaries).toEqual([])
  })
})
