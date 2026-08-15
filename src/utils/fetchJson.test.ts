import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchJsonWithTimeout, DATA_FETCH_TIMEOUT_MS } from './fetchJson'

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

/**
 * signal が abort されるまで解決しない fetch。
 * 「接続は張れたが応答が返らない」状態（TCP は繋がっているのにヘッダが来ない）の再現。
 */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      }),
  )
}

/**
 * ヘッダは返すが body が流れてこない fetch。
 * res.json() 側で止まるケースの再現（fetch() の解決だけでは検知できない）。
 */
function headerOnlyFetch() {
  return vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
    return {
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }),
    } as unknown as Response
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('fetchJsonWithTimeout', () => {
  it('取得に成功すると JSON を返す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ok: 1 })))

    expect(await fetchJsonWithTimeout('/data/x.json', 'x')).toEqual({ ok: 1 })
  })

  it('HTTP エラーはステータス付きの例外にする', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response))

    await expect(fetchJsonWithTimeout('/data/x.json', 'x')).rejects.toThrow('x fetch failed: 404')
  })

  it('応答が返らないときはタイムアウトで失敗する（永久に pending にしない）', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())

    const assertion = expect(fetchJsonWithTimeout('/data/x.json', 'x', 5000)).rejects.toThrow(
      'x fetch timed out after 5000ms',
    )
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('ヘッダだけ返って body が来ないときもタイムアウトで失敗する', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', headerOnlyFetch())

    const assertion = expect(fetchJsonWithTimeout('/data/x.json', 'x', 5000)).rejects.toThrow(
      'x fetch timed out after 5000ms',
    )
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('タイムアウト前に届いた応答は切らない', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string) =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(okResponse({ ok: 1 })), 4000)
          }),
      ),
    )

    const p = fetchJsonWithTimeout('/data/x.json', 'x', 5000)
    await vi.advanceTimersByTimeAsync(4000)

    expect(await p).toEqual({ ok: 1 })
  })

  it('成功しても失敗してもタイムアウト用タイマーを片付ける（後から誤発火させない）', async () => {
    vi.useFakeTimers()

    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ok: 1 })))
    await fetchJsonWithTimeout('/data/x.json', 'x')
    expect(vi.getTimerCount()).toBe(0)

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))
    await expect(fetchJsonWithTimeout('/data/x.json', 'x')).rejects.toThrow(/500/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('時間切れの直後に届いた別種の例外はタイムアウトに化けさせない（本当の原因を残す）', async () => {
    vi.useFakeTimers()
    // 配信データが壊れていて、abort が届いた時点で JSON のパースが失敗するケース
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        return {
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new SyntaxError('Unexpected token < in JSON at position 0'))
              })
            }),
        } as unknown as Response
      }),
    )

    const assertion = expect(fetchJsonWithTimeout('/data/x.json', 'x', 5000)).rejects.toThrow(
      'Unexpected token <',
    )
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('通信エラーはタイムアウトに化けさせず、そのまま伝える', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    await expect(fetchJsonWithTimeout('/data/x.json', 'x')).rejects.toThrow('network down')
  })

  it('既定のタイムアウトは 60 秒', () => {
    expect(DATA_FETCH_TIMEOUT_MS).toBe(60_000)
  })
})
