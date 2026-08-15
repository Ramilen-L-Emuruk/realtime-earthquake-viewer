import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Prefectures } from './prefectures'
import { DATA_FETCH_TIMEOUT_MS } from './fetchJson'

// 生成データのローダは 8 本あり、いずれも「cache / inflight / 失敗時に inflight を捨てる」
// という同じ骨格を持つ。全部にテストを置くと同じ内容が 8 回並ぶため、区域データ固有の
// 検証を持つ subregions.ts に加えて、素の骨格そのものである本ファイルを代表として検証する
// （骨格が壊れれば、どちらかは必ず落ちる）。

async function freshModule() {
  vi.resetModules()
  return await import('./prefectures')
}

const SAMPLE: Prefectures = {
  石川県: { label: [36.6, 136.6], dir: 'up', rings: [[[36.5, 136.5], [36.7, 136.8], [36.6, 136.6]]] },
}

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

describe('loadPrefectures', () => {
  it('取得に成功するとデータを返し、以降はキャッシュを使う（fetchは1回のみ）', async () => {
    const fetchMock = vi.fn(async () => okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadPrefectures, getPrefecturesCache } = await freshModule()

    expect(await loadPrefectures()).toEqual(SAMPLE)
    expect(await loadPrefectures()).toEqual(SAMPLE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getPrefecturesCache()).toEqual(SAMPLE)
  })

  it('HTTPエラーのときは例外になり、キャッシュは空のまま', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response))
    const { loadPrefectures, getPrefecturesCache } = await freshModule()

    await expect(loadPrefectures()).rejects.toThrow(/404/)
    expect(getPrefecturesCache()).toBeNull()
  })

  it('応答が返らないときはタイムアウトで失敗確定し、次の要求で再取得できる', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => hangingFetch(init))
      .mockResolvedValueOnce(okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadPrefectures, getPrefecturesCache } = await freshModule()

    const assertion = expect(loadPrefectures()).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(DATA_FETCH_TIMEOUT_MS)
    await assertion
    expect(getPrefecturesCache()).toBeNull()

    expect(await loadPrefectures()).toEqual(SAMPLE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
