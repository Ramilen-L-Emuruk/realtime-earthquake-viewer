// 長期震源カタログのローダのテスト。
//
// 生成データのローダに共通する骨格（cache / inflight / 失敗時に inflight を捨てる）は
// `prefectures.test.ts` が代表として検証している。ここで固めるのは**このローダ固有の変換**
// —— 列で届いた整数を TypedArray へ移し、格納単位を実数へ戻すところ。
// 単位の掛け違いや列のずれは型でも実行時エラーでも捕まらず、静かに嘘の座標を返す。

import { describe, it, expect, afterEach, vi } from 'vitest'

async function freshModule() {
  vi.resetModules()
  return await import('./hypocenterCatalog')
}

/** その年の 1 月 1 日 00:00 JST（UTC epoch ミリ秒）。生成側が書き出す値と同じ作り方。 */
const START_2023 = Date.UTC(2023, 0, 1) - 9 * 60 * 60 * 1000

const YEAR_2023 = {
  year: 2023,
  startMs: START_2023,
  coordScale: 10000,
  depthScale: 10,
  magScale: 10,
  count: 2,
  // 1 件目: 元日 00:00:00 JST / 35.6765N 140.6545E / 深さ 50.0km / M4.5
  // 2 件目: その 1 時間後 / 38.1035N 142.8610E / 深さ 23.7km / M9.0
  t: [0, 3600],
  lat: [356765, 381035],
  lng: [1406545, 1428610],
  dep: [500, 237],
  mag: [45, 90],
}

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadHypocenterYear', () => {
  it('列の整数を実数へ戻して TypedArray に載せる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(YEAR_2023)))
    const { loadHypocenterYear } = await freshModule()
    const y = await loadHypocenterYear(2023)

    expect(y.count).toBe(2)
    expect(y.lat[0]).toBeCloseTo(35.6765, 4)
    expect(y.lng[0]).toBeCloseTo(140.6545, 4)
    expect(y.depth[0]).toBeCloseTo(50, 3)
    expect(y.magnitude[0]).toBeCloseTo(4.5, 3)
    expect(y.magnitude[1]).toBeCloseTo(9.0, 3)
  })

  it('時刻は年の起点からの経過秒として復元する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(YEAR_2023)))
    const { loadHypocenterYear } = await freshModule()
    const y = await loadHypocenterYear(2023)

    // 2023-01-01 00:00:00 JST = 2022-12-31 15:00:00 UTC
    expect(new Date(y.timeMs[0]).toISOString()).toBe('2022-12-31T15:00:00.000Z')
    // 1 時間後
    expect(y.timeMs[1] - y.timeMs[0]).toBe(3600 * 1000)
  })

  // 単位は年ファイル自身が持っている値を使う。索引側の値を当てにすると、片方を変えたときに
  // 桁が 1 万倍ずれた座標を黙って返す。
  it('格納単位はファイルが持つ値に従う', async () => {
    const scaled = { ...YEAR_2023, coordScale: 1000, lat: [35677, 38104], lng: [140655, 142861] }
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(scaled)))
    const { loadHypocenterYear } = await freshModule()
    const y = await loadHypocenterYear(2023)
    expect(y.lat[0]).toBeCloseTo(35.677, 3)
  })

  it('二度目はキャッシュから返し、取得し直さない', async () => {
    const fetchMock = vi.fn(async () => okResponse(YEAR_2023))
    vi.stubGlobal('fetch', fetchMock)
    const { loadHypocenterYear } = await freshModule()
    await loadHypocenterYear(2023)
    await loadHypocenterYear(2023)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('壊れたファイルを受け取ったとき', () => {
  // **列の長さが揃っていないと添字がずれる。** 1 本でも短ければ、そこから先は別の地震の
  // 座標と M を組み合わせた値になる。200 で返ってくるので通信としては成功扱いになり、
  // 検分しなければ気づけない。
  it('列の長さが count と合わなければ失敗する', async () => {
    const broken = { ...YEAR_2023, mag: [45] }
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(broken)))
    const { loadHypocenterYear } = await freshModule()
    await expect(loadHypocenterYear(2023)).rejects.toThrow(/mag/)
  })

  // **格納単位が欠けると `数値 / undefined` が NaN になる。** 例外を投げないので「取得成功」として
  // 通り、その年の座標・深さ・M が全件 NaN で埋まったまま統計へ流れる。
  it.each(['coordScale', 'depthScale', 'magScale'])('%s が無ければ失敗する', async (key) => {
    const broken: Record<string, unknown> = { ...YEAR_2023 }
    delete broken[key]
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(broken)))
    const { loadHypocenterYear } = await freshModule()
    await expect(loadHypocenterYear(2023)).rejects.toThrow(new RegExp(key))
  })

  it('格納単位が 0 なら失敗する（0 除算で Infinity になる）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ...YEAR_2023, coordScale: 0 })))
    const { loadHypocenterYear } = await freshModule()
    await expect(loadHypocenterYear(2023)).rejects.toThrow(/coordScale/)
  })

  it('起点時刻が無ければ失敗する', async () => {
    const { startMs: _drop, ...noStart } = YEAR_2023
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(noStart)))
    const { loadHypocenterYear } = await freshModule()
    await expect(loadHypocenterYear(2023)).rejects.toThrow(/startMs/)
  })

  it('索引の収録年が空なら失敗する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ years: [], counts: {} })))
    const { loadHypocenterIndex } = await freshModule()
    await expect(loadHypocenterIndex()).rejects.toThrow(/収録年/)
  })
})

describe('loadHypocenterYears', () => {
  it('渡した順に返す', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const year = Number(String(url).match(/(\d{4})\.json$/)?.[1])
      return okResponse({ ...YEAR_2023, year, startMs: Date.UTC(year, 0, 1) - 9 * 60 * 60 * 1000 })
    }))
    const { loadHypocenterYears } = await freshModule()
    const list = await loadHypocenterYears([2022, 2023])
    expect(list.map((y) => y.year)).toEqual([2022, 2023])
  })

  // 統計は期間が欠けると意味が変わる。「取れた年だけで計算する」を既定にすると、
  // 欠けたことに気づかないまま誤った値を出す。
  it('1 年でも失敗したら全体を失敗させる', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('2022.json')) return { ok: false, status: 404 } as unknown as Response
      return okResponse(YEAR_2023)
    }))
    const { loadHypocenterYears } = await freshModule()
    await expect(loadHypocenterYears([2022, 2023])).rejects.toThrow()
  })
})
