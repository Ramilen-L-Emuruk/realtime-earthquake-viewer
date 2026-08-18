import { describe, it, expect, afterEach, vi } from 'vitest'
import type { TsunamiZones } from './tsunamiZones'

// tsunamiZones.ts はモジュールスコープに cache / inflight を持つため、
// テストごとに resetModules して新しいインスタンスを読み直す。
async function freshModule() {
  vi.resetModules()
  return await import('./tsunamiZones')
}

const SAMPLE: TsunamiZones = {
  石川県能登: [[[37.4, 137.0], [37.3, 136.8]]],
}

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// resetModules ＋動的 import の再評価コストで既定タイムアウトを割ることがある（理由は prefectures.test.ts）。
describe('loadTsunamiZones', { timeout: 15_000 }, () => {
  it('取得に成功するとデータを返し、以降はキャッシュを使う（fetchは1回のみ）', async () => {
    const fetchMock = vi.fn(async () => okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadTsunamiZones } = await freshModule()

    expect(await loadTsunamiZones()).toEqual(SAMPLE)
    expect(await loadTsunamiZones()).toEqual(SAMPLE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('HTTPエラーのときは例外になる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))
    const { loadTsunamiZones } = await freshModule()

    await expect(loadTsunamiZones()).rejects.toThrow(/500/)
  })

  it('200でも予報区が空なら失敗として扱う（配信破損を成功と誤認しない）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({})))
    const { loadTsunamiZones } = await freshModule()

    await expect(loadTsunamiZones()).rejects.toThrow(/no data/)
  })

  it('失敗後に呼び直すと再取得する（inflightを破棄してリトライ可能にする）', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadTsunamiZones } = await freshModule()

    await expect(loadTsunamiZones()).rejects.toThrow('network down')
    expect(await loadTsunamiZones()).toEqual(SAMPLE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
