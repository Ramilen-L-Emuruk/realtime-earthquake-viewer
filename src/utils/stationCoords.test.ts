import { describe, it, expect, afterEach, vi } from 'vitest'
import type { StationCoordsData } from './stationCoords'

// stationCoords.ts はモジュールスコープに cache / inflight / 購読者を持つため、
// テストごとに resetModules して新しいインスタンスを読み直す。
async function freshModule() {
  vi.resetModules()
  return await import('./stationCoords')
}

const SAMPLE: StationCoordsData = {
  stations: { '石川県|輪島市鳳至町': [37.39, 136.9, 0] },
  areas: { '石川県|石川県能登': [37.3, 136.9] },
  regionNames: ['石川県能登'],
}

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadStationCoords', () => {
  it('取得に成功するとデータを返し、以降はキャッシュを使う（fetchは1回のみ）', async () => {
    const fetchMock = vi.fn(async () => okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadStationCoords, getStationCoordsCache } = await freshModule()

    expect(await loadStationCoords()).toEqual(SAMPLE)
    expect(await loadStationCoords()).toEqual(SAMPLE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getStationCoordsCache()).toEqual(SAMPLE)
  })

  it('HTTPエラーのときは例外になり、キャッシュは空のまま', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response))
    const { loadStationCoords, getStationCoordsCache } = await freshModule()

    await expect(loadStationCoords()).rejects.toThrow(/404/)
    expect(getStationCoordsCache()).toBeNull()
  })

  it('200でも観測点が空なら失敗として扱う（配信破損を成功と誤認しない）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ stations: {}, areas: {} })))
    const { loadStationCoords, getStationCoordsCache } = await freshModule()

    await expect(loadStationCoords()).rejects.toThrow(/no data/)
    expect(getStationCoordsCache()).toBeNull()
  })

  it('200でも stations を持たない形なら失敗として扱う', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ oops: true })))
    const { loadStationCoords } = await freshModule()

    await expect(loadStationCoords()).rejects.toThrow(/no data/)
  })

  it('200でも areas を持たない形なら失敗として扱う（区域の逆引きが TypeError になるのを防ぐ）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ stations: SAMPLE.stations })))
    const { loadStationCoords } = await freshModule()

    await expect(loadStationCoords()).rejects.toThrow(/no data/)
  })

  it('200でも areas が空なら失敗として扱う（区域名→都道府県の逆引きが黙って効かなくなるのを防ぐ）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ stations: SAMPLE.stations, areas: {} })))
    const { loadStationCoords } = await freshModule()

    await expect(loadStationCoords()).rejects.toThrow(/no data/)
  })

  it('失敗後に呼び直すと再取得する（inflightを破棄してリトライ可能にする）', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadStationCoords } = await freshModule()

    await expect(loadStationCoords()).rejects.toThrow('network down')
    expect(await loadStationCoords()).toEqual(SAMPLE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('onStationCoordsLoaded', () => {
  it('取得成功時に購読者へデータが届く', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(SAMPLE)))
    const { loadStationCoords, onStationCoordsLoaded } = await freshModule()
    const seen: StationCoordsData[] = []

    onStationCoordsLoaded((d) => seen.push(d))
    await loadStationCoords()

    expect(seen).toEqual([SAMPLE])
  })

  it('取得済みなら登録した時点で即座に呼ばれる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(SAMPLE)))
    const { loadStationCoords, onStationCoordsLoaded } = await freshModule()
    await loadStationCoords()

    const seen: StationCoordsData[] = []
    onStationCoordsLoaded((d) => seen.push(d))

    expect(seen).toEqual([SAMPLE])
  })

  it('自分の取得が失敗しても、別の呼び出し元の再取得が成功すれば通知される', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadStationCoords, onStationCoordsLoaded } = await freshModule()
    const seen: StationCoordsData[] = []

    // 先に要求した側（地図の震度点相当）が失敗し、購読だけ残る
    onStationCoordsLoaded((d) => seen.push(d))
    await expect(loadStationCoords()).rejects.toThrow('network down')
    expect(seen).toEqual([])

    // 後から要求した側（地震カード・EEW の都道府県補完相当）が成功すると、失敗を見た側にも届く
    await loadStationCoords()

    expect(seen).toEqual([SAMPLE])
  })

  it('購読を解除すると通知されない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(SAMPLE)))
    const { loadStationCoords, onStationCoordsLoaded } = await freshModule()
    const seen: StationCoordsData[] = []

    const unsubscribe = onStationCoordsLoaded((d) => seen.push(d))
    unsubscribe()
    await loadStationCoords()

    expect(seen).toEqual([])
  })
})
