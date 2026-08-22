import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
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

// resetModules ＋動的 import の再評価コストで既定タイムアウトを割ることがある（理由は prefectures.test.ts）。
describe('loadStationCoords', { timeout: 15_000 }, () => {
  it('取得に成功するとデータを返し、以降はキャッシュを使う（fetchは1回のみ）', async () => {
    const fetchMock = vi.fn(async () => okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadStationCoords, getStationCoordsCache } = await freshModule()

    expect(await loadStationCoords()).toEqual(SAMPLE)
    expect(await loadStationCoords()).toEqual(SAMPLE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getStationCoordsCache()).toEqual(SAMPLE)
  })

  // 区域の一覧を持たない旧形式でも地図の震度点は描けるので失敗にはしない。ただし観測点から
  // 一次細分区域が引けず、読み上げの地域名が都道府県粒度へ静かに戻るため記録に残す。
  it('区域の一覧が無い旧形式でも失敗させず、警告だけ出す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      stations: { '新潟県|長岡市幸町': [37.4, 138.8] },
      areas: { '新潟県|新潟県中越': [37.4, 138.8] },
    })))
    const { loadStationCoords, getStationCoordsCache } = await freshModule()

    await expect(loadStationCoords()).resolves.toBeTruthy()
    expect(getStationCoordsCache()).not.toBeNull()
    expect(warn.mock.calls.filter(call => call.some(arg => String(arg).includes('旧形式'))).length).toBe(1)

    warn.mockRestore()
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

// 読み上げの並べ替え（ttsText.ts）はこの索引に「気象庁の標準順」であることを託しているため、
// 索引の作り方だけでなく、元データがその前提を満たしているかも実データで確かめる。
describe('buildRegionOrderIndex', () => {
  it('区域名は自身の順位を、県名はその県の先頭区域の順位を返す', async () => {
    const { buildRegionOrderIndex } = await import('./stationCoords')
    const index = buildRegionOrderIndex({
      stations: {},
      areas: {
        '青森県|青森県津軽北部': [40.8, 140.5],
        '青森県|青森県三八上北': [40.5, 141.4],
        '岩手県|岩手県沿岸北部': [39.9, 141.8],
      },
      regionNames: [],
    })

    expect(index.areas.get('青森県津軽北部')).toBe(0)
    expect(index.areas.get('青森県三八上北')).toBe(1)
    expect(index.prefs.get('青森県')).toBe(0)
    expect(index.areas.get('岩手県沿岸北部')).toBe(2)
    expect(index.prefs.get('岩手県')).toBe(2)
    // 収録が無い地域名はどちらの索引でも引けない（呼び出し側が末尾へ回す）。
    expect(index.areas.get('色丹島')).toBeUndefined()
    expect(index.prefs.get('色丹島')).toBeUndefined()
  })

  it('実データでは同じ県の区域が連続し、県の順序が北海道から沖縄県まで通る', async () => {
    const { buildRegionOrderIndex } = await import('./stationCoords')
    const data = JSON.parse(readFileSync('public/data/station-coords.json', 'utf8')) as StationCoordsData
    const index = buildRegionOrderIndex(data)

    // 県ごとの区域が飛び飛びだと「県名の順位＝先頭区域の順位」では県のまとまりを作れない。
    const prefs = Object.keys(data.areas).map(key => key.slice(0, key.indexOf('|')))
    const firstSeen = new Map<string, number>()
    prefs.forEach((pref, i) => {
      if (!firstSeen.has(pref)) firstSeen.set(pref, i)
    })
    const discontinuous = prefs.filter((pref, i) => i > 0 && pref !== prefs[i - 1] && firstSeen.get(pref)! < i)
    expect(discontinuous).toEqual([])

    expect(firstSeen.size).toBe(47)
    const prefOrder = [...firstSeen.keys()]
    expect(prefOrder[0]).toBe('北海道')
    expect(prefOrder[prefOrder.length - 1]).toBe('沖縄県')
    expect(index.prefs.get('北海道')!).toBeLessThan(index.prefs.get('沖縄県')!)
    // 県内の並びも気象庁順（新潟県は緯度と逆に 上越 → 中越 → 下越）。
    expect(index.areas.get('新潟県上越')!).toBeLessThan(index.areas.get('新潟県中越')!)
    expect(index.areas.get('新潟県中越')!).toBeLessThan(index.areas.get('新潟県下越')!)
    // 奈良県は県内唯一の区域名が県名と同一。区域用と県用で索引を分けているため取り違えない。
    expect(index.areas.get('奈良県')).toBe(index.prefs.get('奈良県'))
  })
})

// 読み上げは電文が区域を持たないとき観測点から一次細分区域を逆引きして地域名を作る
// （→ docs/spec/audio-tts-spec.md §4）。引くのは地図の区域塗りと同じ `lookupStationRegion`。
describe('観測点 → 一次細分区域の逆引き（lookupStationRegion）', () => {
  it('都道府県付きで引くので、同名の観測点が別の県にあっても取り違えない', async () => {
    const { lookupStationRegion } = await import('./stationCoords')
    const data: StationCoordsData = {
      stations: {
        '新潟県|同名町': [37.4, 138.8, 0],
        '岩手県|同名町': [39.5, 141.0, 1],
        '新潟県|区域の無い観測点': [37.5, 138.9],
      },
      areas: {},
      regionNames: ['新潟県中越', '岩手県内陸南部'],
    }

    expect(lookupStationRegion(data, '新潟県', '同名町')).toBe('新潟県中越')
    expect(lookupStationRegion(data, '岩手県', '同名町')).toBe('岩手県内陸南部')
    // 県が違えば引けない。読み上げ側はこのとき都道府県名へ落とす。
    expect(lookupStationRegion(data, '富山県', '同名町')).toBeNull()
    // 区域を持たない観測点も引けない（元データが 2 要素）。
    expect(lookupStationRegion(data, '新潟県', '区域の無い観測点')).toBeNull()
  })

  // 読み上げの「上位階級で区域名を出した県はまとめない」判定は、名前が区域名の索引で引けるかどうかで
  // 区域名と（まとめた）県名を見分ける（ttsText.ts の prefsWithAreaShown）。多区域の県が県名と同じ
  // 表記の区域を持つと、まとめた県名を「区域名を出した」と誤って数え、以降その県のまとめが不必要に
  // 止まる。奈良県は県名と同名の区域を持つが単一区域なので、どちらに数えても出力は変わらない。
  it('多区域の県に、県名と同じ表記の区域は無い', async () => {
    const data = JSON.parse(readFileSync('public/data/station-coords.json', 'utf8')) as StationCoordsData
    const byPref = new Map<string, string[]>()
    for (const key of Object.keys(data.areas)) {
      const sep = key.indexOf('|')
      const pref = key.slice(0, sep)
      byPref.set(pref, [...(byPref.get(pref) ?? []), key.slice(sep + 1)])
    }
    const collides = [...byPref].filter(([pref, areas]) => areas.length > 1 && areas.includes(pref))
    expect(collides.map(([pref]) => pref)).toEqual([])

    // 単一区域で県名と同名のもの（現状は奈良県だけ）は無害だが、増減したら上の前提を見直す。
    const singles = [...byPref].filter(([pref, areas]) => areas.length === 1 && areas[0] === pref)
    expect(singles.map(([pref]) => pref)).toEqual(['奈良県'])
  })

  it('実データでは全観測点が区域を持ち、観測点名は都道府県を跨いで重複しない', async () => {
    const { lookupStationRegion } = await import('./stationCoords')
    const data = JSON.parse(readFileSync('public/data/station-coords.json', 'utf8')) as StationCoordsData
    const keys = Object.keys(data.stations)

    // 1 件でも区域を欠くと、読み上げの粒度がその点だけ都道府県に落ちて不揃いになる。
    const unresolved = keys.filter(key => {
      const sep = key.indexOf('|')
      return lookupStationRegion(data, key.slice(0, sep), key.slice(sep + 1)) == null
    })
    expect(unresolved).toEqual([])

    // 観測点名の重複が無いことは、都道府県を観測点名から逆引きする経路（`buildStationPrefIndex`
    // は初出優先）が正しい県を返す前提。崩れると読み上げも地図も隣県の区域を指しうる。
    const names = keys.map(key => key.slice(key.indexOf('|') + 1))
    expect(new Set(names).size).toBe(names.length)
  })
})
