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
    // **主題で数える。** 「旧形式」で数えると、同じ語を使う別の警告（現行の一覧に無い観測点が
    // 無い形）が足された瞬間に、この検査が何を見ているのか分からなくなる。
    expect(warn.mock.calls.filter(call => call.some(arg => String(arg).includes('区域の一覧が無い'))).length).toBe(1)

    warn.mockRestore()
  })

  // 現行の一覧に無い観測点を持たない配信（更新前のデータを掴んでいる間）も、黙って劣化させない。
  // **区域の一覧と対称に扱う** —— 警告が無いと、過去の電文を再生したときに当時あって今は無い
  // 観測点が地図から消えても、画面にもコンソールにも理由が残らない。
  it('現行の一覧に無い観測点を持たない旧形式でも失敗させず、警告だけ出す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      stations: { '石川県|輪島市鳳至町': [37.39, 136.9, 0] },
      areas: { '石川県|石川県能登': [37.3, 136.9] },
      regionNames: ['石川県能登'],
    })))
    const { loadStationCoords, getStationCoordsCache } = await freshModule()

    await expect(loadStationCoords()).resolves.toBeTruthy()
    expect(getStationCoordsCache()).not.toBeNull()
    const hit = (s: string) => warn.mock.calls.filter(call => call.some(arg => String(arg).includes(s))).length
    expect(hit('現行の一覧に無い観測点を持たない')).toBe(1)
    // 区域の一覧は持っているので、そちらの警告は出ない（2 つの警告が連動していないこと）。
    expect(hit('区域の一覧が無い')).toBe(0)

    warn.mockRestore()
  })

  it('現行の一覧に無い観測点を持っていれば警告しない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      stations: { '石川県|輪島市鳳至町': [37.39, 136.9, 0] },
      unlisted: { '大阪府|豊中市役所': [34.78, 135.47, 0] },
      areas: { '石川県|石川県能登': [37.3, 136.9] },
      regionNames: ['石川県能登'],
    })))
    const { loadStationCoords } = await freshModule()

    await expect(loadStationCoords()).resolves.toBeTruthy()
    expect(warn.mock.calls.filter(call => call.some(arg => String(arg).includes('現行の一覧に無い観測点を持たない'))).length).toBe(0)

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

  // 文字列は Object.keys が添字の配列（'abc' → ['0','1','2']）を返すため、非空チェックだけでは
  // すり抜ける。stations 側にも typeof を掛けていないと通ってしまう。
  it.each([
    ['stations', { stations: 'あいう', areas: SAMPLE.areas }],
    ['areas', { stations: SAMPLE.stations, areas: 'あいう' }],
  ])('200でも %s が文字列なら失敗として扱う（非空チェックのすり抜けを塞ぐ）', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(body)))
    const { loadStationCoords, getStationCoordsCache } = await freshModule()

    await expect(loadStationCoords()).rejects.toThrow(/no data/)
    expect(getStationCoordsCache()).toBeNull()
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

// 点の役割の判定（`quakePoints.ts` の `isAreaPoint`）へ渡す索引のキャッシュ層。
// 地震の統合経路から毎回呼ばれるため、同じ座標テーブルでは作り直さないことが要る。
//
// `cache` は成功時に一度だけ入り、以後 `loadStationCoords` は即座に返す。つまり
// 「別のデータへ差し替わる」経路は無く、作り直しが起きるのは **null からの復帰**
// （取得失敗 → 再取得で成功）だけ。最後のテストがその経路を通す。
describe('getAreaPrefIndexCache', { timeout: 15_000 }, () => {
  it('座標テーブルが未読み込みなら null', async () => {
    const m = await freshModule()
    expect(m.getAreaPrefIndexCache()).toBeNull()
  })

  it('読み込み後は区域名から都道府県を引ける', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(SAMPLE)))
    const m = await freshModule()
    await m.loadStationCoords()
    expect(m.getAreaPrefIndexCache()?.get('石川県能登')).toBe('石川県')
  })

  it('繰り返し呼んでも索引を作り直さない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(SAMPLE)))
    const m = await freshModule()
    await m.loadStationCoords()
    expect(m.getAreaPrefIndexCache()).toBe(m.getAreaPrefIndexCache())
  })

  it('取得失敗のあと成功すれば索引ができる（null のまま固定されない）', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const m = await freshModule()
    await expect(m.loadStationCoords()).rejects.toThrow()
    expect(m.getAreaPrefIndexCache()).toBeNull()
    await m.loadStationCoords()
    expect(m.getAreaPrefIndexCache()?.get('石川県能登')).toBe('石川県')
  })
})

// 気象庁の標準順で並べる索引。読み上げ（ttsText）と地震カードの行順が**同じ索引**を使う。
// カード側はもともと震度だけで並べており、同震度の行は Map の挿入順＝電文が点を並べた順が
// 残っていた。電文の並びは種別で違うため、書式が変わるだけで画面の並びが黙って動く。
describe('regionOrderRank / sortByRegionOrder', () => {
  const order = {
    areas: new Map([['石川県能登', 10], ['宮城県北部', 3], ['奈良県', 20]]),
    prefs: new Map([['石川県', 10], ['宮城県', 3], ['奈良県', 99]]),
  }

  // 正: 索引の順位で並ぶ（北から南）。
  it('索引の順位で並べる', async () => {
    const { sortByRegionOrder } = await freshModule()
    expect(sortByRegionOrder(['石川県能登', '宮城県北部'], order)).toEqual(['宮城県北部', '石川県能登'])
  })

  // 安全弁: 区域名を県名より先に引く。現行データの「奈良県」は県内唯一の区域名で、
  // 両方の Map に別の順位で載る。取り違えると県名の順位で並んでしまう。
  it('区域名を県名より先に引く', async () => {
    const { regionOrderRank } = await freshModule()
    expect(regionOrderRank('奈良県', order)).toBe(20)
  })

  // 安全弁: 索引に無い名前（震度観測点を持たない区域など）は末尾へ回す。
  // 気象庁の標準順でもこれらは末尾に置かれるので、末尾送りは標準順と矛盾しない。
  it('索引に無い名前は末尾へ回す', async () => {
    const { sortByRegionOrder } = await freshModule()
    expect(sortByRegionOrder(['未知の区域', '宮城県北部'], order)).toEqual(['宮城県北部', '未知の区域'])
  })

  // 対照: 索引そのものが無い（座標テーブル未読み込み）ときは並べ替えない。
  // ここで勝手に並べると、読み込み前後で順序が変わって見える。
  it('索引が無ければ並べ替えない', async () => {
    const { sortByRegionOrder } = await freshModule()
    expect(sortByRegionOrder(['石川県能登', '宮城県北部'], null)).toEqual(['石川県能登', '宮城県北部'])
  })

  // 安全弁: 索引の有無にかかわらず入力を書き換えない。索引が無いときだけ引数を
  // そのまま返す実装にすると、戻り値を詰め替える呼び出し元が元データを壊す。
  it('索引が無くても入力の配列を書き換えない', async () => {
    const { sortByRegionOrder } = await freshModule()
    const input = ['石川県能登', '宮城県北部']
    const result = sortByRegionOrder(input, null)
    expect(result).not.toBe(input)
    result.reverse()
    expect(input).toEqual(['石川県能登', '宮城県北部'])
  })
})

describe('byValueDescThenRegion', () => {
  const order = {
    areas: new Map([['石川県能登', 10], ['宮城県北部', 3], ['奈良県', 20]]),
    prefs: new Map([['石川県', 10], ['宮城県', 3], ['奈良県', 99]]),
  }
  const rows = [
    { name: '石川県能登', value: 3 },
    { name: '奈良県', value: 5 },
    { name: '宮城県北部', value: 3 },
  ]
  const sorted = async (o: typeof order | null) => {
    const { byValueDescThenRegion } = await freshModule()
    return [...rows].sort(byValueDescThenRegion(r => r.value, r => r.name, o)).map(r => r.name)
  }

  // 正: 値の降順が第一。同値になったところで初めて標準順が効く。
  it('値の降順で並べ、同値は気象庁の標準順で決める', async () => {
    expect(await sorted(order)).toEqual(['奈良県', '宮城県北部', '石川県能登'])
  })

  // 対照: 索引が無ければ同値の決着は付かず、元の並び（＝電文の順）が残る。
  // ここが「並べ替えを足す前の挙動」で、座標テーブル未読み込み時のフォールバックにあたる。
  it('索引が無ければ同値は元の並びのまま', async () => {
    expect(await sorted(null)).toEqual(['奈良県', '石川県能登', '宮城県北部'])
  })

  // 安全弁: 値の比較が標準順に負けない。順位の若い（北の）区域でも、値が小さければ後ろ。
  // 2 つの鍵の優先順位を取り違えると、震度の低い地域が上に並ぶ。
  it('標準順が値の降順を追い越さない', async () => {
    const { byValueDescThenRegion } = await freshModule()
    const north = { name: '宮城県北部', value: 1 }
    const south = { name: '奈良県', value: 7 }
    expect([north, south].sort(byValueDescThenRegion(r => r.value, r => r.name, order))).toEqual([
      south,
      north,
    ])
  })
})

// 観測点の統廃合は毎年続くので、過去の電文を再生すると当時あって今は無い観測点が混ざる。
// `unlisted` はその落とし先（→ `scripts/build-station-coords.mjs`）。
describe('現行の一覧に無い観測点（unlisted）', () => {
  const DATA: StationCoordsData = {
    stations: { '石川県|輪島市鳳至町': [37.39, 136.9, 0] },
    unlisted: {
      '大阪府|豊中市役所': [34.78, 135.47, 1],
      // 現行と同じ観測点名を別の県に置く。実データには無い形だが、上流が入れ替わっても
      // 現行が勝つことを固定しておく。
      '富山県|輪島市鳳至町': [36.7, 137.2, 1],
    },
    areas: { '石川県|石川県能登': [37.3, 136.9] },
    regionNames: ['石川県能登', '大阪府北部'],
  }

  // 正: 現行に無い観測点でも、座標・区域・都道府県が引ける。ここが引けないと、
  // 過去の電文を再生したときその観測点が地図から丸ごと消える。
  it('現行に無い観測点でも座標・区域・都道府県を引ける', async () => {
    const { lookupPointCoords, lookupStationRegion, buildStationPrefIndex } = await freshModule()
    expect(lookupPointCoords(DATA, '大阪府', '豊中市役所', false)).toEqual([34.78, 135.47])
    expect(lookupStationRegion(DATA, '大阪府', '豊中市役所')).toBe('大阪府北部')
    expect(buildStationPrefIndex(DATA).get('豊中市役所')).toBe('大阪府')
  })

  // 対照: どちらにも無い名前は従来どおり引けない。落とし先を足したことで、
  // 存在しない観測点にまで座標が付くようになってはいけない。
  it('どちらにも無い観測点は引けないまま', async () => {
    const { lookupPointCoords, lookupStationRegion, buildStationPrefIndex } = await freshModule()
    expect(lookupPointCoords(DATA, '東京都', '実在しない観測点', false)).toBeNull()
    expect(lookupStationRegion(DATA, '東京都', '実在しない観測点')).toBeNull()
    expect(buildStationPrefIndex(DATA).get('実在しない観測点')).toBeUndefined()
  })

  // 安全弁: 同じ名前が両方にあれば現行が勝つ。負けると、いま動いている観測点の座標が
  // 過去の値へ置き換わる（しかも画面には有効な座標として出るので気づけない）。
  it('同じ観測点名が両方にあれば現行を採る', async () => {
    const { lookupPointCoords, buildStationPrefIndex } = await freshModule()
    expect(buildStationPrefIndex(DATA).get('輪島市鳳至町')).toBe('石川県')
    expect(lookupPointCoords(DATA, '石川県', '輪島市鳳至町', false)).toEqual([37.39, 136.9])
  })

  // 安全弁: 区域の代表点は現行の観測点だけで作る。混ぜると代表点が動き、震度速報の描画・
  // カメラの寄り先・読み上げの距離選抜がまとめてずれる。
  //
  // **件数の一致では見ない。** `areas` と `regionNames` の件数が同じなのは、現行の一覧に無い
  // 観測点がたまたま全部現行の区域に収まっているからで、不変条件ではない。代わりに
  // 「区域の代表点が現行の観測点だけから作られているか」を直接見る。
  it('区域の代表点は現行の観測点だけから作る', async () => {
    const data = JSON.parse(readFileSync('public/data/station-coords.json', 'utf8')) as StationCoordsData
    const names = data.regionNames ?? []
    const fromListed = new Set<string>()
    for (const [key, entry] of Object.entries(data.stations)) {
      const region = entry[2] != null ? names[entry[2]] : null
      if (region) fromListed.add(`${key.slice(0, key.indexOf('|'))}|${region}`)
    }
    expect([...Object.keys(data.areas)].filter(key => !fromListed.has(key))).toEqual([])
  })

  // 安全弁: 現行の一覧に無い観測点が、現行のどの観測点も属さない区域を持ち込まないこと。
  // 持ち込むと、その区域は `areas`（＝区域塗りのポリゴンを引く鍵）に無いまま
  // `lookupStationRegion` だけが名前を返すようになり、**寄った画には点が出るのに
  // 引いた画の区域塗りからは黙って外れる**。実データが崩れたらここで止めて人が見る。
  it('現行の一覧に無い観測点は、新しい区域名を持ち込まない', async () => {
    const data = JSON.parse(readFileSync('public/data/station-coords.json', 'utf8')) as StationCoordsData
    const listedRegions = new Set(Object.values(data.stations).map(e => e[2]).filter(i => i != null))
    const introduced = Object.entries(data.unlisted ?? {})
      .filter(([, e]) => e[2] != null && !listedRegions.has(e[2]))
      .map(([key, e]) => `${key}（${(data.regionNames ?? [])[e[2] as number]}）`)
    expect(introduced).toEqual([])
  })

  // `unlisted` を持たない旧形式（配信更新の直後に PWA が古いデータを掴んでいる間）でも
  // 例外にせず、従来どおりの範囲で引けること。
  it('unlisted を持たない旧形式でも引ける', async () => {
    const { lookupPointCoords, buildStationPrefIndex } = await freshModule()
    const old: StationCoordsData = { stations: DATA.stations, areas: DATA.areas, regionNames: DATA.regionNames }
    expect(lookupPointCoords(old, '石川県', '輪島市鳳至町', false)).toEqual([37.39, 136.9])
    expect(lookupPointCoords(old, '大阪府', '豊中市役所', false)).toBeNull()
    expect(buildStationPrefIndex(old).get('豊中市役所')).toBeUndefined()
  })

  it('実データでは現行と重ならず、全件が区域を持つ', async () => {
    const { lookupStationRegion } = await import('./stationCoords')
    const data = JSON.parse(readFileSync('public/data/station-coords.json', 'utf8')) as StationCoordsData
    const unlisted = data.unlisted ?? {}
    const keys = Object.keys(unlisted)
    expect(keys.length).toBeGreaterThan(0)

    // 生成側も重複を禁じている（重なれば生成が止まる）。両側で見るのは、
    // 生成を通さずに手で書き足された場合にここで気づけるようにするため。
    expect(keys.filter(key => key in data.stations)).toEqual([])

    // 観測点名の逆引き（`buildStationPrefIndex` は初出優先）が正しい県を返す前提。
    // 現行と名前が衝突すると、その名前は現行の県でしか引けなくなる。
    const currentNames = new Set(Object.keys(data.stations).map(key => key.slice(key.indexOf('|') + 1)))
    expect(keys.map(key => key.slice(key.indexOf('|') + 1)).filter(name => currentNames.has(name))).toEqual([])

    // 区域を欠くと、その観測点だけ読み上げの粒度が都道府県へ落ちる（現行と同じ規律）。
    // **上流に区域を持たない観測点が混ざったらここで落ちる。** 実装の不具合ではなく
    // 取得元の形が変わった印なので、落ちたら値ではなく上流を見ること。
    const unresolved = keys.filter(key => {
      const sep = key.indexOf('|')
      return lookupStationRegion(data, key.slice(0, sep), key.slice(sep + 1)) == null
    })
    expect(unresolved).toEqual([])
  })
})
