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
  // 通年ぶんある年の終端は翌年の頭。
  coveredThroughMs: Date.UTC(2024, 0, 1) - 9 * 60 * 60 * 1000,
  quality: 'final' as const,
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
  // 震度は疎に持つ。2 件目（M9.0）だけが震度 7。
  intIdx: [1],
  intCode: ['7'],
}

/** 索引の最小形。**終端と完全性は必須**なので、素の years / counts だけでは通らない。 */
const INDEX = {
  source: '気象庁',
  sourceUrl: 'https://example.invalid/',
  license: '公共データ利用規約',
  minMagnitude: 2,
  coveredThroughMs: Date.UTC(2026, 7, 23) - 9 * 60 * 60 * 1000,
  completeness: [
    { from: 1919, minMagnitude: 5 },
    { from: 1961, minMagnitude: 4.5 },
    { from: 1983, minMagnitude: 3.5 },
    { from: 1997, minMagnitude: 2 },
  ],
  years: [2023],
  counts: { 2023: 2 },
  quality: { 2023: 'final' as const },
  intensityYears: [2023],
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

// ---------------------------------------------------------------------------
// カタログが持つ「自分の限界」（収録範囲を 1919 年まで広げたときに足したもの）
// ---------------------------------------------------------------------------

describe('データの終端と確からしさ', () => {
  it('年ごとの終端と確からしさを読む', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(YEAR_2023)))
    const { loadHypocenterYear } = await freshModule()
    const y = await loadHypocenterYear(2023)
    expect(y.coveredThroughMs).toBe(Date.UTC(2024, 0, 1) - 9 * 60 * 60 * 1000)
    expect(y.quality).toBe('final')
  })

  // **終端が無いまま通すと、消費側は「未取得」と「地震が無かった」を区別できない。**
  // 格子の濃淡はその区別を持たないので、欠けていることに気づけるのは検分の時点だけ。
  it('年ファイルに終端が無ければ失敗する', async () => {
    const { coveredThroughMs: _drop, ...broken } = YEAR_2023
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(broken)))
    const { loadHypocenterYear } = await freshModule()
    await expect(loadHypocenterYear(2023)).rejects.toThrow(/coveredThroughMs/)
  })

  // **既定値を置かない。** 欠けたときに 'final' へ倒すと、速報値を確定値として扱う
  it('確からしさが無ければ失敗する（final へ倒さない）', async () => {
    const { quality: _drop, ...broken } = YEAR_2023
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(broken)))
    const { loadHypocenterYear } = await freshModule()
    await expect(loadHypocenterYear(2023)).rejects.toThrow(/quality/)
  })

  it('速報値の年をそのまま速報値として返す', async () => {
    const preliminary = { ...YEAR_2023, quality: 'preliminary' as const, intIdx: [], intCode: [] }
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(preliminary)))
    const { loadHypocenterYear } = await freshModule()
    expect((await loadHypocenterYear(2023)).quality).toBe('preliminary')
  })

  it('索引の終端と完全性を読む', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(INDEX)))
    const { loadHypocenterIndex } = await freshModule()
    const idx = await loadHypocenterIndex()
    expect(idx.coveredThroughMs).toBe(INDEX.coveredThroughMs)
    expect(idx.completeness).toHaveLength(4)
  })

  it.each(['coveredThroughMs', 'completeness'])('索引に %s が無ければ失敗する', async (key) => {
    const broken: Record<string, unknown> = { ...INDEX }
    delete broken[key]
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(broken)))
    const { loadHypocenterIndex } = await freshModule()
    await expect(loadHypocenterIndex()).rejects.toThrow(new RegExp(key))
  })
})

describe('最大震度（疎な 2 列）', () => {
  it('添字とコードを読む', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(YEAR_2023)))
    const { loadHypocenterYear } = await freshModule()
    const y = await loadHypocenterYear(2023)
    expect([...y.intensityIdx]).toEqual([1])
    expect(y.intensityCode).toEqual(['7'])
    // 有感かどうかは添字に含まれるかで判る（2 件目だけが有感）
    expect(y.intensityIdx.includes(0)).toBe(false)
    expect(y.intensityIdx.includes(1)).toBe(true)
  })

  it('震度欄が無い年（速報値）は空', async () => {
    const { intIdx: _a, intCode: _b, ...noInt } = YEAR_2023
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(noInt)))
    const { loadHypocenterYear } = await freshModule()
    const y = await loadHypocenterYear(2023)
    expect(y.intensityIdx).toHaveLength(0)
    expect(y.intensityCode).toHaveLength(0)
  })

  // 座標の列ずれと同じ性質の事故。長さが違えば別の地震の震度を返す
  it('添字とコードの長さが合わなければ失敗する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ...YEAR_2023, intCode: ['7', '5'] })))
    const { loadHypocenterYear } = await freshModule()
    await expect(loadHypocenterYear(2023)).rejects.toThrow(/intIdx/)
  })

  it('片方だけ欠けても失敗する', async () => {
    const { intCode: _drop, ...half } = YEAR_2023
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(half)))
    const { loadHypocenterYear } = await freshModule()
    await expect(loadHypocenterYear(2023)).rejects.toThrow(/intIdx/)
  })
})

describe('completeMinMagnitude', () => {
  // 正: 古い期間ほど閾値が上がる。**これを通さないと「昔は地震が少なかった」という嘘になる**
  it('期間の古さに応じて閾値を上げる', async () => {
    const { completeMinMagnitude } = await freshModule()
    const idx = INDEX as unknown as Parameters<typeof completeMinMagnitude>[0]
    expect(completeMinMagnitude(idx, 1919)).toBe(5)
    expect(completeMinMagnitude(idx, 1950)).toBe(5)
    expect(completeMinMagnitude(idx, 1961)).toBe(4.5)
    expect(completeMinMagnitude(idx, 1982)).toBe(4.5)
    expect(completeMinMagnitude(idx, 1983)).toBe(3.5)
    expect(completeMinMagnitude(idx, 1996)).toBe(3.5)
  })

  // 対照: 完全な期間では収録の下限そのまま（無用に切り上げない）
  it('1997 年以降は収録の下限そのまま', async () => {
    const { completeMinMagnitude } = await freshModule()
    const idx = INDEX as unknown as Parameters<typeof completeMinMagnitude>[0]
    expect(completeMinMagnitude(idx, 1997)).toBe(2)
    expect(completeMinMagnitude(idx, 2026)).toBe(2)
  })

  // 安全弁: 収録していない地震を数えようとしない
  it('収録の下限より下は返さない', async () => {
    const { completeMinMagnitude } = await freshModule()
    const idx = { ...INDEX, minMagnitude: 3 } as unknown as Parameters<typeof completeMinMagnitude>[0]
    expect(completeMinMagnitude(idx, 2026)).toBe(3)
    // 古い期間の閾値（5.0）は下限より上なのでそのまま効く
    expect(completeMinMagnitude(idx, 1919)).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// 敵対的レビューで指摘された穴（いずれも「例外にならず嘘の値になる」型の事故）
// ---------------------------------------------------------------------------

describe('嘘の値が紛れ込む経路を塞ぐ', () => {
  // **`null / 10000` は例外にも NaN にもならず 0 になる。** 北緯 0 度・東経 0 度という
  // 「もっともらしい嘘」が地図に現れる。NaN なら下流で崩れて気づけるが、0 は気づけない。
  it.each(['t', 'lat', 'lng', 'dep', 'mag'])('%s に null が混ざれば失敗する', async (key) => {
    const broken = { ...YEAR_2023, [key]: [null, 0] }
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(broken)))
    const { loadHypocenterYear } = await freshModule()
    await expect(loadHypocenterYear(2023)).rejects.toThrow(new RegExp(key))
  })

  it('列に文字列が混ざれば失敗する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ...YEAR_2023, lat: ['356765', 381035] })))
    const { loadHypocenterYear } = await freshModule()
    await expect(loadHypocenterYear(2023)).rejects.toThrow(/lat/)
  })

  // 対照: まともな列は通ること（検分を厳しくして正常系を壊していないこと）
  it('まともな列は通る', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(YEAR_2023)))
    const { loadHypocenterYear } = await freshModule()
    expect((await loadHypocenterYear(2023)).count).toBe(2)
  })

  // 列の長さずれと同じ性質の事故。範囲外の添字は消費側が別の地震の震度を引く
  it.each([[-1], [2], [1.5]])('intIdx に範囲外の添字 %s があれば失敗する', async (bad) => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ...YEAR_2023, intIdx: [bad], intCode: ['7'] })))
    const { loadHypocenterYear } = await freshModule()
    await expect(loadHypocenterYear(2023)).rejects.toThrow(/intIdx/)
  })
})

describe('completeMinMagnitude は並び順に依存しない', () => {
  // 正: 並びを崩しても同じ結果になること。**昇順を前提にすると、生成側の定数が並べ替えられた
  // 日に逆の閾値を黙って返す**（観測網の歴史が地震活動の急減として表示される）
  it('completeness が降順でも同じ閾値を返す', async () => {
    const { completeMinMagnitude } = await freshModule()
    type Idx = Parameters<typeof completeMinMagnitude>[0]
    const asc = INDEX as unknown as Idx
    const desc = { ...INDEX, completeness: [...INDEX.completeness].reverse() } as unknown as Idx
    for (const year of [1919, 1950, 1961, 1982, 1983, 1996, 1997, 2026]) {
      expect(completeMinMagnitude(desc, year)).toBe(completeMinMagnitude(asc, year))
    }
  })

  it('completeness が無作為な順でも同じ閾値を返す', async () => {
    const { completeMinMagnitude } = await freshModule()
    type Idx = Parameters<typeof completeMinMagnitude>[0]
    const shuffled = {
      ...INDEX,
      completeness: [
        { from: 1983, minMagnitude: 3.5 },
        { from: 1919, minMagnitude: 5 },
        { from: 1997, minMagnitude: 2 },
        { from: 1961, minMagnitude: 4.5 },
      ],
    } as unknown as Idx
    expect(completeMinMagnitude(shuffled, 1950)).toBe(5)
    expect(completeMinMagnitude(shuffled, 1970)).toBe(4.5)
    expect(completeMinMagnitude(shuffled, 1990)).toBe(3.5)
    expect(completeMinMagnitude(shuffled, 2020)).toBe(2)
  })

  // 安全弁: 呼び出し側の取り違えを黙って通さない。戻り値は統計の母集団を決めるので、
  // 誤った値を返すと歪んだグラフが出るまで誰も気づけない
  it.each([NaN, Infinity, undefined])('fromYear が数値でなければ例外（%s）', async (bad) => {
    const { completeMinMagnitude } = await freshModule()
    const idx = INDEX as unknown as Parameters<typeof completeMinMagnitude>[0]
    expect(() => completeMinMagnitude(idx, bad as unknown as number)).toThrow(/fromYear/)
  })
})
