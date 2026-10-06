// 張り直したときの取り戻し（`fetchHistorySince`）。
//
// 重点は「切れていた間の分を取り切ること」と「それより古い分まで辿らないこと」。
// `/history` は配信元が受け取った時刻（`time`）の新しい順に返る。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchHistorySince } from './p2pquake'
import { parseJstTimeMs } from '../utils/quakeOriginSeconds'

/** 551 の最小形（`convertEvent` が通る）。`time` は配信元が受け取った時刻（日本時間の表記）。 */
function quake(id: string, time: string) {
  return {
    code: 551,
    id,
    time,
    issue: { type: 'ScalePrompt', correct: 'None' },
    earthquake: { time, hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: -1 }, maxScale: 30, domesticTsunami: 'Checking' },
    points: [],
  }
}

/** `n` 件を 1 分おきに、`start` から古い向きへ並べる。 */
function minutesBack(prefix: string, start: Date, n: number) {
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(start.getTime() - i * 60_000 + 9 * 3600_000) // 日本時間の表記へ
    const p = (v: number) => String(v).padStart(2, '0')
    const s = `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00.000`
    return quake(`${prefix}${i}`, s)
  })
}

describe('fetchHistorySince', () => {
  let pages: unknown[][]
  let urls: string[]
  let inits: (RequestInit | undefined)[]
  beforeEach(() => {
    pages = []
    urls = []
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    inits = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url)
      inits.push(init)
      const body = pages.shift() ?? []
      return new Response(JSON.stringify(body), { status: 200 })
    }))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const start = new Date('2026-10-06T09:00:00Z')

  // 正: 1 ページで起点より古い報に届いたら、そこで止めて起点以降だけを返す。
  it('起点より古い報に届いたページで止め、起点以降だけを返す', async () => {
    pages = [minutesBack('a', start, 100)]
    const since = start.getTime() - 10 * 60_000 // 10 分前まで
    const result = await fetchHistorySince([551, 552], since, null)
    expect(result.truncated).toBe(false)
    expect(result.events).toHaveLength(11) // 0〜10 分前
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('codes=551')
    expect(urls[0]).toContain('codes=552')
    expect(urls[0]).toContain('limit=100')
    // 安全弁: Service Worker の控えを通さない（通信に失敗したとき古い控えが「取れた」に化けないように）
    expect(inits[0]?.cache).toBe('no-store')
  })

  // 正: 配信元が返した件数と、読み取れた件数を分けて返す（捨てた分を数えられるように）。
  it('起点以降に配信元が返した件数を、読み取れなかった報も含めて返す', async () => {
    const page = minutesBack('e', start, 3)
    pages = [[...page, { code: 551, time: page[0].time }]] // id の無い壊れた報
    const result = await fetchHistorySince([551, 552], start.getTime() - 10 * 60_000, null)
    expect(result.rawCount).toBe(4)
    expect(result.events).toHaveLength(3)
  })

  // 正: 1 ページに収まらなければ offset で次を引き、届いたところで止める。
  it('起点まで届かなければ次のページを引く', async () => {
    const all = minutesBack('b', start, 250)
    pages = [all.slice(0, 100), all.slice(100, 200), all.slice(200)]
    const since = start.getTime() - 150 * 60_000
    const promise = fetchHistorySince([551, 552], since, null)
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result.truncated).toBe(false)
    expect(result.events).toHaveLength(151)
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('offset=100')
  })

  // 安全弁: 上限（5 ページ）で打ち切り、打ち切ったことを返す（黙って「何も無かった」にしない）。
  it('ページの上限で打ち切ったら truncated を返す', async () => {
    const all = minutesBack('c', start, 600)
    pages = [0, 1, 2, 3, 4, 5].map(i => all.slice(i * 100, (i + 1) * 100))
    const promise = fetchHistorySince([551, 552], start.getTime() - 24 * 3600_000, null)
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result.truncated).toBe(true)
    expect(result.events).toHaveLength(500)
    expect(urls).toHaveLength(5)
  })

  // 安全弁: ページの合間で止められたら、次のページを引かずに中断として投げる（呼び出し側が黙って捨てる）。
  it('ページの合間で止められたら次を引かずに AbortError で終える', async () => {
    const all = minutesBack('f', start, 250)
    pages = [all.slice(0, 100), all.slice(100, 200), all.slice(200)]
    const controller = new AbortController()
    const promise = fetchHistorySince([551, 552], start.getTime() - 24 * 3600_000, controller.signal)
    const settled = promise.then(() => null, (e: unknown) => e)
    await vi.advanceTimersByTimeAsync(0) // 1 ページ目を受け取り、合間の待ちへ入る
    controller.abort()
    await vi.runAllTimersAsync()
    const err = await settled
    expect((err as DOMException | null)?.name).toBe('AbortError')
    expect(urls).toHaveLength(1)
  })

  // 対照: 満たないページ（在庫の終わり）は、起点に届いていなくてもそこで終える。
  it('100 件に満たないページで終える', async () => {
    pages = [minutesBack('d', start, 30)]
    const result = await fetchHistorySince([551, 552], start.getTime() - 24 * 3600_000, null)
    expect(result.truncated).toBe(false)
    expect(result.events).toHaveLength(30)
    expect(urls).toHaveLength(1)
  })

  // 安全弁: 時刻は日本時間として読む（端末の時間帯に左右されない）。
  it('時刻を日本時間の表記として読む', () => {
    expect(parseJstTimeMs('2026/10/06 18:00:00.000')).toBe(start.getTime())
  })
})
