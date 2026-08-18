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

    const assertion = expect(fetchJsonWithTimeout('/data/x.json', 'x', { timeoutMs: 5000 })).rejects.toThrow(
      'x fetch timed out after 5000ms',
    )
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('ヘッダだけ返って body が来ないときもタイムアウトで失敗する', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', headerOnlyFetch())

    const assertion = expect(fetchJsonWithTimeout('/data/x.json', 'x', { timeoutMs: 5000 })).rejects.toThrow(
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

    const p = fetchJsonWithTimeout('/data/x.json', 'x', { timeoutMs: 5000 })
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

    const assertion = expect(fetchJsonWithTimeout('/data/x.json', 'x', { timeoutMs: 5000 })).rejects.toThrow(
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

// resetModules ＋動的 import の再評価コストで既定タイムアウトを割ることがある（理由は prefectures.test.ts）。
describe('取得状況の集約', { timeout: 15_000 }, () => {
  // 取得状況はモジュールスコープに溜まるため、テストごとに読み直して独立させる
  async function freshModule() {
    vi.resetModules()
    return await import('./fetchJson')
  }

  /** 呼び出し側から解決・棄却を制御できる fetch。 */
  function controllableFetch() {
    let settle!: (value: Response | PromiseLike<Response>) => void
    let fail!: (reason: unknown) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve, reject) => {
          settle = resolve
          fail = reject
        }),
    )
    return { fetchMock, resolve: (r: Response) => settle(r), reject: (e: unknown) => fail(e) }
  }

  it('取得中は pending に数え、完了したら戻す', async () => {
    const { fetchMock, resolve } = controllableFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()

    const p = fetchJsonWithTimeout('/data/x.json', 'x')
    expect(getDataLoadStatus()).toEqual({ pending: 1, failed: 0 })

    resolve(okResponse({ ok: 1 }))
    await p

    expect(getDataLoadStatus()).toEqual({ pending: 0, failed: 0 })
  })

  it('失敗を failed に数え、取り直しに成功したら消す', async () => {
    const { fetchMock, reject } = controllableFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()

    const failing = fetchJsonWithTimeout('/data/x.json', 'x')
    reject(new Error('network down'))
    await expect(failing).rejects.toThrow('network down')
    expect(getDataLoadStatus()).toEqual({ pending: 0, failed: 1 })

    // 同じ label を取り直して成功させる（フォールバックからの復帰）
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ok: 1 })))
    await fetchJsonWithTimeout('/data/x.json', 'x')

    expect(getDataLoadStatus()).toEqual({ pending: 0, failed: 0 })
  })

  it('状態が変わったときだけ購読者に通知する', async () => {
    const { fetchMock, resolve } = controllableFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { fetchJsonWithTimeout, subscribeDataLoadStatus } = await freshModule()

    let notified = 0
    const unsubscribe = subscribeDataLoadStatus(() => { notified += 1 })

    const p = fetchJsonWithTimeout('/data/x.json', 'x')
    expect(notified).toBe(1)  // pending 0 → 1

    resolve(okResponse({ ok: 1 }))
    await p
    expect(notified).toBe(2)  // pending 1 → 0

    unsubscribe()
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ok: 1 })))
    await fetchJsonWithTimeout('/data/y.json', 'y')
    expect(notified).toBe(2)  // 解除後は届かない
  })

  it('同じ label の取得が重なったら本数で数える（1 本終わっただけで解除しない）', async () => {
    // 実地震テストシナリオの連続再生のように、同じ label で複数の取得が並行しうる
    const settlers: Array<(r: Response) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => { settlers.push(resolve) })),
    )
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()

    const first = fetchJsonWithTimeout('/data/a.json', 'scenario')
    const second = fetchJsonWithTimeout('/data/b.json', 'scenario')
    expect(getDataLoadStatus()).toEqual({ pending: 1, failed: 0 })

    settlers[0](okResponse({ ok: 1 }))
    await first
    expect(getDataLoadStatus()).toEqual({ pending: 1, failed: 0 })  // 2 本目が残っている

    settlers[1](okResponse({ ok: 2 }))
    await second
    expect(getDataLoadStatus()).toEqual({ pending: 0, failed: 0 })
  })

  it('trackStatus: false のデータは数えない（地図と無関係な失敗を地図上に出さない）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response))
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()

    await expect(
      fetchJsonWithTimeout('/data/x.json', 'tts-phrase-break-dict', { trackStatus: false }),
    ).rejects.toThrow(/404/)

    expect(getDataLoadStatus()).toEqual({ pending: 0, failed: 0 })
  })

  it('状態が同じ間は同じ参照を返す（useSyncExternalStore の再レンダリング要件）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ok: 1 })))
    const { fetchJsonWithTimeout, getDataLoadStatus } = await freshModule()

    const before = getDataLoadStatus()
    expect(getDataLoadStatus()).toBe(before)

    await fetchJsonWithTimeout('/data/x.json', 'x')

    // pending が 0 → 1 → 0 と戻るので、値としては初期状態と等しい
    expect(getDataLoadStatus()).toEqual(before)
  })
})
