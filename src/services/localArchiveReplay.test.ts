import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HistoricalArchiveIndex, HistoricalArchiveMeta } from '../types/historicalArchive'

vi.mock('../utils/fetchJson', () => ({ fetchJsonWithTimeout: vi.fn() }))
vi.mock('../utils/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { fetchJsonWithTimeout } from '../utils/fetchJson'
import {
  findCoveringArchiveSync,
  findArchiveJustEndedSync,
  fetchLocalArchiveEvents,
  fetchLocalArchiveQuakeHistory,
  listHistoricalArchives,
  clearLocalArchiveCache,
} from './localArchiveReplay'

const mockFetchJson = vi.mocked(fetchJsonWithTimeout)

const meta: HistoricalArchiveMeta = {
  id: '2011-tohoku',
  label: '2011年東北地方太平洋沖地震',
  description: 'test',
  from: '2011-03-11T05:45:00Z',
  to: '2011-03-11T06:00:00Z',
  firstEventTime: '2011-03-11T05:46:00Z',
}

// スキーマ検証（historicalArchiveSchema.ts）を通す最小限の妥当な event。
// quake は earthquake.maxScale、tsunami は areas がそれぞれ必須フィールドのため、
// 素の { kind: 'quake' } 等はここでは skip されてしまう（CRITICAL対策の値域検証）。
const validEew = (extra: Record<string, unknown> = {}) => ({ kind: 'eew', ...extra })
const validQuake = (extra: Record<string, unknown> = {}) => ({ kind: 'quake', earthquake: { maxScale: 70 }, ...extra })
const validTsunami = (extra: Record<string, unknown> = {}) => ({ kind: 'tsunami', areas: [], ...extra })

describe('findCoveringArchiveSync', () => {
  const index: HistoricalArchiveIndex = [meta]
  const ONE_HOUR_MS = 3600_000
  const PRE_WINDOW_MS = 24 * ONE_HOUR_MS
  /** 「本編」の1点を軽く指定するための、幅1msの範囲。 */
  const at = (iso: string): [Date, Date] => {
    const d = new Date(iso)
    return [d, new Date(d.getTime() + 1)]
  }

  it('範囲内の時刻はカバーするアーカイブを返す', () => {
    expect(findCoveringArchiveSync(index, ...at('2011-03-11T05:50:00Z'))?.id).toBe('2011-tohoku')
  })

  it('開始時刻ちょうどは含む（[from, to)）', () => {
    expect(findCoveringArchiveSync(index, ...at(meta.from))?.id).toBe('2011-tohoku')
  })

  it('終了時刻ちょうどは含まない（[from, to)）', () => {
    expect(findCoveringArchiveSync(index, ...at(meta.to))).toBeNull()
  })

  it('範囲外の時刻は null（DMDATA/P2PQuakeへフォールバックする合図）', () => {
    expect(findCoveringArchiveSync(index, ...at('2020-01-01T00:00:00Z'))).toBeNull()
  })

  it('空配列は常に null', () => {
    expect(findCoveringArchiveSync([], ...at('2011-03-11T05:50:00Z'))).toBeNull()
  })

  it('「本編」の問い合わせ範囲（対象時刻〜+1時間）が重なれば返す', () => {
    const target = new Date('2011-03-11T05:47:00Z')
    expect(findCoveringArchiveSync(index, target, new Date(target.getTime() + ONE_HOUR_MS))?.id).toBe('2011-tohoku')
  })

  it('「初期状態」の問い合わせ範囲（対象時刻から遡る24時間）は、対象時刻自体が収録範囲内なら重なりとして拾う', () => {
    // 実際のバグ再現: 24時間前は収録範囲(from)より大幅に前だが、範囲としては target まで
    // 伸びているため重なる。ここを「fromTime が収録範囲内か」だけで判定すると見逃し、
    // DMDATA/P2PQuake（データが存在しない時代）へ問い合わせて再生全体が止まっていた。
    const target = new Date('2011-03-11T05:47:00Z')
    const preFrom = new Date(target.getTime() - PRE_WINDOW_MS)
    expect(findCoveringArchiveSync(index, preFrom, target)?.id).toBe('2011-tohoku')
  })

  it('収録範囲より後（先読みが収録終端を過ぎた場合）は null', () => {
    const afterEnd = new Date(meta.to)
    expect(findCoveringArchiveSync(index, afterEnd, new Date(afterEnd.getTime() + ONE_HOUR_MS))).toBeNull()
  })
})

describe('findArchiveJustEndedSync', () => {
  const index: HistoricalArchiveIndex = [meta]
  const WINDOW_MS = 3600_000

  it('収録終端ちょうど〜windowMs以内は「ついさっき終わった」として返す', () => {
    const to = new Date(meta.to)
    expect(findArchiveJustEndedSync(index, to, WINDOW_MS)?.id).toBe('2011-tohoku')
    expect(findArchiveJustEndedSync(index, new Date(to.getTime() + WINDOW_MS - 1), WINDOW_MS)?.id).toBe('2011-tohoku')
  })

  it('windowMsを超えて過ぎていれば null（DMDATA/P2PQuakeへ黙ってフォールバックしてよい）', () => {
    const to = new Date(meta.to)
    expect(findArchiveJustEndedSync(index, new Date(to.getTime() + WINDOW_MS), WINDOW_MS)).toBeNull()
  })

  it('収録範囲内（まだ終わっていない）は null', () => {
    expect(findArchiveJustEndedSync(index, new Date(meta.from), WINDOW_MS)).toBeNull()
  })
})

describe('listHistoricalArchives', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearLocalArchiveCache()
  })

  it('正常な空配列（収録0件）は成功として扱い、以後は再取得しない', async () => {
    mockFetchJson.mockResolvedValue([])

    await listHistoricalArchives()
    await listHistoricalArchives()

    expect(mockFetchJson).toHaveBeenCalledTimes(1)
  })

  it('取得失敗は恒久キャッシュせず、次回呼び出しで再取得を試みる（HIGH対策）', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('network error'))
    mockFetchJson.mockResolvedValueOnce([meta])

    const first = await listHistoricalArchives()
    const second = await listHistoricalArchives()

    expect(first).toEqual([])
    expect(second).toEqual([meta])
    expect(mockFetchJson).toHaveBeenCalledTimes(2)
  })

  it('トップレベルが配列でない配信破損も恒久キャッシュせず、次回に再取得を試みる（HIGH対策）', async () => {
    mockFetchJson.mockResolvedValueOnce({ not: 'an array' })
    mockFetchJson.mockResolvedValueOnce([meta])

    const first = await listHistoricalArchives()
    const second = await listHistoricalArchives()

    expect(first).toEqual([])
    expect(second).toEqual([meta])
    expect(mockFetchJson).toHaveBeenCalledTimes(2)
  })
})

describe('fetchLocalArchiveEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearLocalArchiveCache()
  })

  it('指定範囲 [fromTime, toTime) の entries だけを ReplayEntry として返す', async () => {
    mockFetchJson.mockResolvedValueOnce({
      ...meta,
      entries: [
        { time: '2011-03-11T05:46:00Z', payload: { kind: 'event', event: validEew() } },
        { time: '2011-03-11T05:49:00Z', payload: { kind: 'event', event: validTsunami() } },
        { time: '2011-03-11T05:55:00Z', payload: { kind: 'event', event: validQuake() } },
      ],
    })

    const result = await fetchLocalArchiveEvents(meta, new Date('2011-03-11T05:47:00Z'), new Date('2011-03-11T05:50:00Z'))

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].replayTime.toISOString()).toBe('2011-03-11T05:49:00.000Z')
    expect(result.skipped).toBe(0)
    expect(result.failedArchiveUrls).toEqual([])
  })

  it('本体の取得・検証に失敗したら失敗アーカイブとして扱う（DMDATA側の「全滅」と同じ粒度）', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('network error'))

    const result = await fetchLocalArchiveEvents(meta, new Date(meta.from), new Date(meta.to))

    expect(result.entries).toEqual([])
    expect(result.failedArchiveUrls).toHaveLength(1)
  })

  it('検証に失敗した本体（配列でない等）も失敗として扱う', async () => {
    mockFetchJson.mockResolvedValueOnce({ not: 'a valid archive file' })

    const result = await fetchLocalArchiveEvents(meta, new Date(meta.from), new Date(meta.to))

    expect(result.entries).toEqual([])
    expect(result.failedArchiveUrls).toHaveLength(1)
  })

  it('同じ id への呼び出しは、成功時に本体取得を1回だけキャッシュする', async () => {
    mockFetchJson.mockResolvedValue({ ...meta, entries: [] })

    await fetchLocalArchiveEvents(meta, new Date(meta.from), new Date(meta.to))
    await fetchLocalArchiveEvents(meta, new Date(meta.from), new Date(meta.to))

    const bodyCalls = mockFetchJson.mock.calls.filter(([, label]) => label === `historical-archive ${meta.id}`)
    expect(bodyCalls).toHaveLength(1)
  })

  it('本体取得の失敗は恒久キャッシュせず、次回呼び出しで再取得を試みる（HIGH対策）', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('network error'))
    mockFetchJson.mockResolvedValueOnce({ ...meta, entries: [{ time: '2011-03-11T05:46:00Z', payload: { kind: 'event', event: validEew() } }] })

    const first = await fetchLocalArchiveEvents(meta, new Date(meta.from), new Date(meta.to))
    const second = await fetchLocalArchiveEvents(meta, new Date(meta.from), new Date(meta.to))

    expect(first.failedArchiveUrls).toHaveLength(1)
    expect(second.entries).toHaveLength(1)
    const bodyCalls = mockFetchJson.mock.calls.filter(([, label]) => label === `historical-archive ${meta.id}`)
    expect(bodyCalls).toHaveLength(2)
  })
})

describe('fetchLocalArchiveQuakeHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearLocalArchiveCache()
  })

  it('before より前の地震（event.kind === quake）だけを新しい順に返す', async () => {
    mockFetchJson.mockResolvedValueOnce({
      ...meta,
      entries: [
        { time: '2011-03-11T05:46:27Z', payload: { kind: 'event', event: validEew() } }, // quake以外は除外
        { time: '2011-03-11T05:46:00Z', payload: { kind: 'event', event: validQuake({ id: 'q1' }) } },
        { time: '2011-03-11T05:49:00Z', payload: { kind: 'event', event: validQuake({ id: 'q2' }) } },
        { time: '2011-03-11T05:55:00Z', payload: { kind: 'event', event: validQuake({ id: 'q3' }) } }, // before以降は除外
      ],
    })

    const result = await fetchLocalArchiveQuakeHistory(meta, new Date('2011-03-11T05:50:00Z'), 10)

    expect(result.quakes.map(q => q.id)).toEqual(['q2', 'q1']) // 新しい順
    expect(result.skipped).toBe(0)
    expect(result.failedArchiveUrls).toEqual([])
  })

  it('targetEvents 件で打ち切る', async () => {
    mockFetchJson.mockResolvedValueOnce({
      ...meta,
      entries: [
        { time: '2011-03-11T05:46:00Z', payload: { kind: 'event', event: validQuake({ id: 'q1' }) } },
        { time: '2011-03-11T05:47:00Z', payload: { kind: 'event', event: validQuake({ id: 'q2' }) } },
      ],
    })

    const result = await fetchLocalArchiveQuakeHistory(meta, new Date('2011-03-11T06:00:00Z'), 1)

    expect(result.quakes).toHaveLength(1)
    expect(result.quakes[0].id).toBe('q2')
  })

  it('本体が読めなければ失敗アーカイブとして扱う', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('network error'))

    const result = await fetchLocalArchiveQuakeHistory(meta, new Date(meta.to), 10)

    expect(result.quakes).toEqual([])
    expect(result.failedArchiveUrls).toHaveLength(1)
  })
})
