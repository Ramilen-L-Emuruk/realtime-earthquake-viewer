// standard 版リプレイの取得ロジック。
//
// 見るのは「どの日を、何ページ引いて、どこで切るか」という取得の組み立て。電文そのものの
// 解釈（convertEvent）は本物を通す。ここを偽物にすると、時刻を読めない電文を弾く経路まで
// テスト側の都合で作った形になってしまい、実データとの食い違いを検出できなくなる。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchP2PReplayEvents, clearP2PReplayCache } from './p2pquakeReplay'
import { fetchJmaArchiveRaw } from './p2pquake'
import type { RawP2PEvent } from './p2pquake'

vi.mock('./p2pquake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./p2pquake')>()
  return { ...actual, fetchJmaArchiveRaw: vi.fn() }
})

vi.mock('../utils/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockFetch = vi.mocked(fetchJmaArchiveRaw)

/** P2PQuake の時刻表記（スラッシュ区切り・JST）でローカル時刻を書く。 */
function p2pTime(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.0`
}

function quake(id: string, at: Date): RawP2PEvent {
  return {
    code: 551,
    id,
    time: p2pTime(at),
    issue: { source: '気象庁', time: p2pTime(at), type: 'ScalePrompt' },
    earthquake: { time: p2pTime(at), hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: -1 }, maxScale: 30, domesticTsunami: 'None' },
    points: [],
  }
}

function tsunami(id: string, at: Date): RawP2PEvent {
  return {
    code: 552,
    id,
    time: p2pTime(at),
    cancelled: false,
    issue: { source: '気象庁', time: p2pTime(at), type: 'Focus' },
    areas: [],
  }
}

/** resource ごとに「ページ番号 → 返す配列」を割り当てる。 */
function respondWith(pages: { quake?: RawP2PEvent[][]; tsunami?: RawP2PEvent[][] }): void {
  mockFetch.mockImplementation(async (resource, query = {}) => {
    const page = Math.floor((query.offset ?? 0) / (query.limit ?? 100))
    return (pages[resource]?.[page] ?? [])
  })
}

const T = new Date(2024, 0, 1, 16, 10, 0)

beforeEach(() => {
  clearP2PReplayCache()
  mockFetch.mockReset()
})

describe('fetchP2PReplayEvents', () => {
  it('再生窓の内側だけを、時刻順に返す', async () => {
    const before = new Date(2024, 0, 1, 16, 0, 0)
    const inside = new Date(2024, 0, 1, 16, 30, 0)
    const later = new Date(2024, 0, 1, 16, 50, 0)
    const after = new Date(2024, 0, 1, 17, 30, 0)
    respondWith({ quake: [[quake('c', later), quake('a', before), quake('b', inside), quake('d', after)]] })

    const result = await fetchP2PReplayEvents(T, new Date(T.getTime() + 3600_000))

    expect(result.entries.map(e => e.replayTime.getTime())).toEqual([inside.getTime(), later.getTime()])
    expect(result.skipped).toBe(0)
    // アーカイブ単位の失敗は DMDSS 版に固有の概念で、この経路では常に空
    expect(result.failedArchiveUrls).toEqual([])
  })

  it('地震と津波の両方を取りに行く', async () => {
    const at = new Date(2024, 0, 1, 16, 20, 0)
    respondWith({ quake: [[quake('q', at)]], tsunami: [[tsunami('t', at)]] })

    const result = await fetchP2PReplayEvents(T, new Date(T.getTime() + 3600_000))

    const kinds = result.entries.map(e => e.payload.kind === 'event' ? e.payload.event.kind : e.payload.kind)
    expect(kinds.sort()).toEqual(['quake', 'tsunami'])
  })

  it('1 ページが埋まっていれば次のページを取りに行く', async () => {
    const at = new Date(2024, 0, 1, 16, 20, 0)
    const full = Array.from({ length: 100 }, (_, i) => quake(`q${i}`, at))
    respondWith({ quake: [full, [quake('last', at)]] })

    const result = await fetchP2PReplayEvents(T, new Date(T.getTime() + 3600_000))

    expect(result.entries).toHaveLength(101)
    const quakeOffsets = mockFetch.mock.calls.filter(c => c[0] === 'quake').map(c => c[1]?.offset)
    expect(quakeOffsets).toEqual([0, 100])
  })

  it('ページ上限を超えるほど電文が多い日は、黙って打ち切らず例外にする', async () => {
    const at = new Date(2024, 0, 1, 16, 20, 0)
    const full = Array.from({ length: 100 }, (_, i) => quake(`q${i}`, at))
    mockFetch.mockImplementation(async (resource) => (resource === 'quake' ? full : []))

    await expect(fetchP2PReplayEvents(T, new Date(T.getTime() + 3600_000))).rejects.toThrow(/多すぎ/)
  })

  it('日をまたぐ範囲では、またいだ日ぶんを取りに行く', async () => {
    respondWith({})
    const from = new Date(2024, 0, 1, 23, 30, 0)

    await fetchP2PReplayEvents(from, new Date(from.getTime() + 3600_000))

    const days = [...new Set(mockFetch.mock.calls.map(c => c[1]?.sinceDate))]
    expect(days).toEqual(['20240101', '20240102'])
  })

  it('終端がちょうど日付境界のときは、その先の日を取りに行かない', async () => {
    respondWith({})
    const from = new Date(2024, 0, 1, 23, 0, 0)

    await fetchP2PReplayEvents(from, new Date(2024, 0, 2, 0, 0, 0))

    const days = [...new Set(mockFetch.mock.calls.map(c => c[1]?.sinceDate))]
    expect(days).toEqual(['20240101'])
  })

  it('取得範囲が広すぎる場合は、通信する前に止める', async () => {
    respondWith({})
    const from = new Date(2024, 0, 1, 0, 0, 0)

    await expect(fetchP2PReplayEvents(from, new Date(2024, 0, 10, 0, 0, 0))).rejects.toThrow(/広すぎ/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('同じ日を二度読んでも通信は一度きり', async () => {
    const at = new Date(2024, 0, 1, 16, 20, 0)
    respondWith({ quake: [[quake('q', at)]] })

    await fetchP2PReplayEvents(T, new Date(T.getTime() + 3600_000))
    const callsAfterFirst = mockFetch.mock.calls.length
    // 本編のあとに初期状態を読む流れと同じく、同じ日を含む別の範囲を要求する
    await fetchP2PReplayEvents(new Date(T.getTime() - 3600_000), T)

    expect(mockFetch.mock.calls.length).toBe(callsAfterFirst)
  })

  it('時刻を読めない電文は捨てて、その数を取りこぼしとして返す', async () => {
    const at = new Date(2024, 0, 1, 16, 20, 0)
    const broken = { ...quake('broken', at), time: 'not-a-time' }
    respondWith({ quake: [[quake('ok', at), broken]] })

    const result = await fetchP2PReplayEvents(T, new Date(T.getTime() + 3600_000))

    expect(result.entries).toHaveLength(1)
    expect(result.skipped).toBe(1)
  })

  it('取りこぼしは日ごとに一度しか数えない', async () => {
    const at = new Date(2024, 0, 1, 16, 20, 0)
    const broken = { ...quake('broken', at), time: 'not-a-time' }
    respondWith({ quake: [[quake('ok', at), broken]] })

    const first = await fetchP2PReplayEvents(T, new Date(T.getTime() + 3600_000))
    // 同じ日を含む別の範囲。キャッシュから返るため実際には取得していない
    const second = await fetchP2PReplayEvents(new Date(T.getTime() - 3600_000), T)

    expect(first.skipped).toBe(1)
    expect(second.skipped).toBe(0)
  })

  it('取得に失敗した日はキャッシュに残さず、次の要求で取り直す', async () => {
    mockFetch.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([])

    await expect(fetchP2PReplayEvents(T, new Date(T.getTime() + 3600_000))).rejects.toThrow('boom')
    await expect(fetchP2PReplayEvents(T, new Date(T.getTime() + 3600_000))).resolves.toMatchObject({ entries: [] })
  })
})
