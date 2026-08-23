// standard 版リプレイの取得ロジック。
//
// 見るのは「どの日を、何ページ引いて、どこで切るか」という取得の組み立て。電文そのものの
// 解釈（convertEvent）は本物を通す。ここを偽物にすると、時刻を読めない電文を弾く経路まで
// テスト側の都合で作った形になってしまい、実データとの食い違いを検出できなくなる。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchP2PReplayEvents, fetchP2PQuakeHistory, clearP2PReplayCache } from './p2pquakeReplay'
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

// 地震カードの履歴取得。再生窓の取得と違い件数基準で、1 リクエストに収める
// （`/jma` のレート制限は 10 リクエスト/分）。
describe('fetchP2PQuakeHistory', () => {
  it('指定時刻の日付までを、新しい順に 1 リクエストで引く', async () => {
    respondWith({ quake: [[quake('a', new Date(2024, 0, 1, 10, 0, 0))]] })

    const result = await fetchP2PQuakeHistory(T, 50)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [resource, query] = mockFetch.mock.calls[0]
    expect(resource).toBe('quake')
    expect(query?.untilDate).toBe('20240101')
    expect(query?.order).toBe(-1)
    expect(result.quakes).toHaveLength(1)
  })

  // until_date は日単位なので、同じ日の「まだ発表されていない」電文が必ず混ざる。
  // 落とさないと、再生開始前の一覧に未来の地震が並ぶ。
  it('指定時刻より後に発表された電文は採らない', async () => {
    respondWith({
      quake: [[
        quake('past', new Date(2024, 0, 1, 15, 0, 0)),
        quake('future', new Date(2024, 0, 1, 17, 0, 0)),
      ]],
    })

    const result = await fetchP2PQuakeHistory(T, 50)

    expect(result.quakes.map(q => q.id)).toEqual(['past'])
  })

  it('種別を読めない電文は取りこぼしとして数える', async () => {
    respondWith({ quake: [[{ id: 'broken' } as unknown as RawP2PEvent]] })

    const result = await fetchP2PQuakeHistory(T, 50)

    expect(result.quakes).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  // 取得は 1 リクエストで完結するため、途中まで読めた状態が無い。
  // 部分的な成功を装わず、そのまま呼び出し元へ投げる。
  it('取得に失敗したら例外をそのまま返す', async () => {
    mockFetch.mockRejectedValue(new Error('P2PQuake の取得制限に達しました（jma/quake）'))

    await expect(fetchP2PQuakeHistory(T, 50)).rejects.toThrow(/取得制限/)
  })
})

// 打ち切りが無いと、API のページング単位（電文 100 件）がそのまま一覧の厚みになり、
// 地震の多い期間ほどカードが増えて DMDSS 版と枚数が食い違う。
describe('fetchP2PQuakeHistory の打ち切り', () => {
  it('目標のイベント数に達したら、それより古い地震は採らない', async () => {
    respondWith({
      quake: [[
        quake('a', new Date(2024, 0, 1, 11, 0, 0)),
        quake('b', new Date(2024, 0, 1, 10, 0, 0)),
        quake('c', new Date(2024, 0, 1, 9, 0, 0)),
      ]],
    })

    const result = await fetchP2PQuakeHistory(T, 2)

    expect(result.quakes.map(q => q.id)).toEqual(['a', 'b'])
  })

  // 続報を別イベントとして数えると目標に早く達し、しかも打ち切りで前の報だけが落ちて
  // 「震度速報のまま止まったカード」が最古に残る。
  it('同じ地震の続報は目標に数えず、打ち切りの後でも採る', async () => {
    const first = new Date(2024, 0, 1, 11, 0, 0)
    respondWith({
      quake: [[
        quake('a-2', first),                             // 新しい報
        quake('b', new Date(2024, 0, 1, 10, 0, 0)),      // 別の地震（ここで目標 2 件に到達）
        quake('a-1', first),                             // a と同じ地震の前の報
        quake('c', new Date(2024, 0, 1, 9, 0, 0)),       // 3 件目の地震 → 採らない
      ]],
    })

    const result = await fetchP2PQuakeHistory(T, 2)

    // 返す順は発表時刻の降順（取得側で並べ直すため、応答の並びとは一致しない）。
    // カードの並びは呼び出し先の mergeQuakeHistory が決めるので、ここでは採否だけが意味を持つ。
    expect(result.quakes.map(q => q.id)).toEqual(['a-2', 'a-1', 'b'])
  })
})

// 打ち切りは「どこで切るか」の判断なので、応答の並びに委ねない。
// order=-1 を渡していても、並びが崩れれば古い地震で目標に達して新しい地震を落としうる。
describe('fetchP2PQuakeHistory は応答の並び順に依存しない', () => {
  it('応答が新しい順でなくても、新しい地震から目標件数を採る', async () => {
    respondWith({
      quake: [[
        quake('old', new Date(2024, 0, 1, 9, 0, 0)),
        quake('newest', new Date(2024, 0, 1, 11, 0, 0)),
        quake('middle', new Date(2024, 0, 1, 10, 0, 0)),
      ]],
    })

    const result = await fetchP2PQuakeHistory(T, 2)

    expect(result.quakes.map(q => q.id)).toEqual(['newest', 'middle'])
  })
})
