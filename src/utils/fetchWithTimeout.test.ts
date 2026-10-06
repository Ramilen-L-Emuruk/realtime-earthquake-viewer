import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchWithTimeout, fetchJsonOutcome, outcomeJson, FetchTimeoutError, isAbortedByCaller, KYOSHIN_FRAME_FETCH_TIMEOUT_MS,
} from './fetchWithTimeout'
import { STALLED_AFTER_MS } from '../services/kyoshinSource'

/** signal が止められるまで決着しない fetch（黙った回線の代役）。 */
function silentFetch() {
  return vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  }))
}

/** 見出しはすぐ返り、中身が流れてこない応答。 */
function headersOnlyFetch() {
  return vi.fn((_url: string, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
      },
    })
    return Promise.resolve(new Response(body, { status: 200 }))
  })
}

describe('fetchWithTimeout', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // 正: 黙った取得は上限で例外になる（呼び出し側の .catch が動く）。
  it('応答が返らない取得は上限で FetchTimeoutError になる', async () => {
    vi.stubGlobal('fetch', silentFetch())
    const p = fetchWithTimeout('https://example.test/a', { timeoutMs: 1000, signal: null }, res => res.text())
    const settled = expect(p).rejects.toBeInstanceOf(FetchTimeoutError)
    await vi.advanceTimersByTimeAsync(1000)
    await settled
  })

  // 正: 中身を読む間も上限が掛かっている（fetch が解決した時点で外すと穴が残る）。
  it('見出しだけ返って中身が流れてこない取得も上限で打ち切る', async () => {
    vi.stubGlobal('fetch', headersOnlyFetch())
    const p = fetchWithTimeout('https://example.test/a', { timeoutMs: 1000, signal: null }, res => res.text())
    const settled = expect(p).rejects.toBeInstanceOf(FetchTimeoutError)
    await vi.advanceTimersByTimeAsync(1000)
    await settled
  })

  // 対照: 上限の手前で返った取得は打ち切らない。
  it('上限の手前で返った取得はそのまま返す', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => {
      setTimeout(() => resolve(new Response('ok')), 999)
    })))
    const p = fetchWithTimeout('https://example.test/a', { timeoutMs: 1000, signal: null }, res => res.text())
    await vi.advanceTimersByTimeAsync(999)
    await expect(p).resolves.toBe('ok')
  })

  // 対照: 返った後は上限が外れている（後から打ち切りが走らない）。
  it('返った後に上限の時刻が来ても何も起きない', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false)
      return Promise.resolve(new Response('ok'))
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchWithTimeout('https://example.test/a', { timeoutMs: 1000, signal: null }, res => res.text())).resolves.toBe('ok')
    const signal = fetchMock.mock.calls[0][1]?.signal
    await vi.advanceTimersByTimeAsync(5000)
    expect(signal?.aborted).toBe(false)
  })

  // 正: 呼び出し元が止めたら、上限を待たずに打ち切る。時間切れとは見分けられる。
  it('呼び出し元が止めたら AbortError で打ち切る（時間切れとは別）', async () => {
    vi.stubGlobal('fetch', silentFetch())
    const caller = new AbortController()
    const p = fetchWithTimeout('https://example.test/a', { timeoutMs: 60_000, signal: caller.signal }, res => res.text())
    caller.abort()
    const err = await p.catch((e: unknown) => e)
    expect(isAbortedByCaller(err)).toBe(true)
    expect(err).not.toBeInstanceOf(FetchTimeoutError)
  })

  // 安全弁: 止めた後に呼ばれたら、fetch を投げずに打ち切る。
  it('既に止められた合図で呼ばれたら通信を出さない', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()
    caller.abort()
    const err = await fetchWithTimeout('https://example.test/a', { timeoutMs: 1000, signal: caller.signal }, res => res.text())
      .catch((e: unknown) => e)
    expect(isAbortedByCaller(err)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // 安全弁: 上限とも止めたこととも関係ない失敗は、そのまま投げる（時間切れに化けない）。
  it('通信の失敗はそのまま投げる', async () => {
    const boom = new TypeError('Failed to fetch')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(boom)))
    await expect(fetchWithTimeout('https://example.test/a', { timeoutMs: 1000, signal: null }, res => res.text())).rejects.toBe(boom)
  })

  // 正: 読むと決めた応答は、状態番号と JSON を持って返る。
  it('fetchJsonOutcome は読むと決めた応答の JSON を返す', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"a":1}', { status: 200 }))))
    const res = await fetchJsonOutcome('https://example.test/a', { timeoutMs: 1000, signal: null }, r => r.ok)
    expect(res.status).toBe(200)
    expect(outcomeJson(res)).toEqual({ a: 1 })
  })

  // 対照: 読まないと決めた応答は本文に触らない（失敗の本文が JSON でなくても投げない）。
  it('fetchJsonOutcome は読まないと決めた応答の本文に触らない', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<html>', { status: 500 }))))
    const res = await fetchJsonOutcome('https://example.test/a', { timeoutMs: 1000, signal: null }, r => r.ok)
    expect(res.ok).toBe(false)
    expect(res.body).toBeNull()
  })

  // 安全弁: 届いたが JSON として読めないものは、通信の失敗（例外）と分けて返す。
  it('fetchJsonOutcome は読めない JSON を例外にせず error として返す', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('not json', { status: 200 }))))
    const res = await fetchJsonOutcome('https://example.test/a', { timeoutMs: 1000, signal: null }, () => true)
    expect(res.body).not.toBeNull()
    expect(() => outcomeJson(res)).toThrow()
  })

  // 正: 中身が流れてこない応答も、返す前に上限で打ち切る（「読めない JSON」に化けない）。
  it('fetchJsonOutcome も中身を読み切るまで上限を掛ける', async () => {
    vi.stubGlobal('fetch', headersOnlyFetch())
    const p = fetchJsonOutcome('https://example.test/a', { timeoutMs: 1000, signal: null }, () => true)
    const settled = expect(p).rejects.toBeInstanceOf(FetchTimeoutError)
    await vi.advanceTimersByTimeAsync(1000)
    await settled
  })

  // 安全弁: 強震モニタの 1 フレームは局を 2 つ順に試すので、局ごとの上限の 2 倍が「更新停止」の
  // 判定と同じ長さ。上限だけ伸ばすと、黙った回線で更新停止の表示がそのぶん遅れる。
  it('強震モニタの秒ファイルの上限は 2 局ぶんで STALLED_AFTER_MS と揃っている', () => {
    expect(KYOSHIN_FRAME_FETCH_TIMEOUT_MS * 2).toBe(STALLED_AFTER_MS)
  })

  // 安全弁: 時間切れは「呼び出し元が止めた」と取り違えない（失敗として数えられる）。
  it('時間切れは isAbortedByCaller に当たらない', () => {
    expect(isAbortedByCaller(new FetchTimeoutError('https://example.test/a', 1000))).toBe(false)
  })
})
