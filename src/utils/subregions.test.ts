import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SubRegion } from './subregions'
import { DATA_FETCH_TIMEOUT_MS } from './fetchJson'

// subregions.ts はモジュールスコープに cache / inflight / 購読者を持つため、
// テストごとに resetModules して新しいインスタンスを読み直す。
async function freshModule() {
  vi.resetModules()
  return await import('./subregions')
}

const SAMPLE: SubRegion[] = [
  { name: '石川県能登', label: [37.3, 136.9], dir: 'up', rings: [[[37.0, 136.5], [37.5, 137.2], [37.2, 136.6]]] },
]

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

/** signal が abort されるまで解決しない fetch（応答が返らない回線の再現）。 */
function hangingFetch(init?: { signal?: AbortSignal }) {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('loadSubRegions', () => {
  it('取得に成功するとデータを返し、以降はキャッシュを使う（fetchは1回のみ）', async () => {
    const fetchMock = vi.fn(async () => okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadSubRegions, getSubRegionsCache } = await freshModule()

    expect(await loadSubRegions()).toEqual(SAMPLE)
    expect(await loadSubRegions()).toEqual(SAMPLE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getSubRegionsCache()).toEqual(SAMPLE)
  })

  it('HTTPエラーのときは例外になり、キャッシュは空のまま', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response))
    const { loadSubRegions, getSubRegionsCache } = await freshModule()

    await expect(loadSubRegions()).rejects.toThrow(/404/)
    expect(getSubRegionsCache()).toBeNull()
  })

  it('200で空配列が返っても失敗として扱う（配信破損を成功と誤認しない）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([])))
    const { loadSubRegions, getSubRegionsCache } = await freshModule()

    await expect(loadSubRegions()).rejects.toThrow(/no data/)
    expect(getSubRegionsCache()).toBeNull()
  })

  it('200で配列以外が返っても失敗として扱う', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ oops: true })))
    const { loadSubRegions } = await freshModule()

    await expect(loadSubRegions()).rejects.toThrow(/no data/)
  })

  it('応答が返らないときはタイムアウトで失敗確定し、次の要求で再取得できる', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => hangingFetch(init))
      .mockResolvedValueOnce(okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadSubRegions, getSubRegionsCache } = await freshModule()

    // 待ち続けず、タイムアウトで reject する（＝呼び出し側のフォールバックが動ける）
    const assertion = expect(loadSubRegions()).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(DATA_FETCH_TIMEOUT_MS)
    await assertion
    expect(getSubRegionsCache()).toBeNull()

    expect(await loadSubRegions()).toEqual(SAMPLE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('失敗後に呼び直すと再取得する（inflightを破棄してリトライ可能にする）', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadSubRegions } = await freshModule()

    await expect(loadSubRegions()).rejects.toThrow('network down')
    expect(await loadSubRegions()).toEqual(SAMPLE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('onSubRegionsLoaded', () => {
  it('取得成功時に購読者へデータが届く', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(SAMPLE)))
    const { loadSubRegions, onSubRegionsLoaded } = await freshModule()
    const seen: SubRegion[][] = []

    onSubRegionsLoaded((d) => seen.push(d))
    await loadSubRegions()

    expect(seen).toEqual([SAMPLE])
  })

  it('取得済みなら登録した時点で即座に呼ばれる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(SAMPLE)))
    const { loadSubRegions, onSubRegionsLoaded } = await freshModule()
    await loadSubRegions()

    const seen: SubRegion[][] = []
    onSubRegionsLoaded((d) => seen.push(d))

    expect(seen).toEqual([SAMPLE])
  })

  it('自分の取得が失敗しても、別の呼び出し元の再取得が成功すれば通知される', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadSubRegions, onSubRegionsLoaded } = await freshModule()
    const seen: SubRegion[][] = []

    // 先に要求した側（震度の派生データ相当）が失敗し、購読だけ残る
    onSubRegionsLoaded((d) => seen.push(d))
    await expect(loadSubRegions()).rejects.toThrow('network down')
    expect(seen).toEqual([])

    // 後から要求した側（ベースマップ相当）が成功すると、失敗を見た側にも届く
    await loadSubRegions()

    expect(seen).toEqual([SAMPLE])
  })

  it('購読を解除すると通知されない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(SAMPLE)))
    const { loadSubRegions, onSubRegionsLoaded } = await freshModule()
    const seen: SubRegion[][] = []

    const unsubscribe = onSubRegionsLoaded((d) => seen.push(d))
    unsubscribe()
    await loadSubRegions()

    expect(seen).toEqual([])
  })
})
