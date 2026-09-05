// 読み上げの地域名を「どの粒度で挙げるか」と「どの順に並べるか」のテスト。
// 並び順は気象庁の標準順（北から南・県ごとにまとまる）。粒度は一次細分区域で、電文が区域を
// 持たない経路では観測点から逆引きする。
//
// ttsText.ts の並べ替えは station-coords.json のキャッシュが埋まってはじめて効くため、
// 実配信データを fetch スタブ経由で読み込ませてから検証する（テスト専用の小さな
// フィクスチャでは、実データの県区切り・区域の並びを取り違えても気づけない）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { EarthquakePoint, IntensityScale, JMAQuake, JMALpgm } from '../types/earthquake'
import type { TtsRegionOptions } from './ttsText'
import { joinSegments } from './ttsFollow'

type TtsModule = typeof import('./ttsText')

let earthquakeToText: TtsModule['earthquakeToText']
let lpgmToText: TtsModule['lpgmToText']
let earthquakeToSegments: TtsModule['earthquakeToSegments']
let createQuakeSpokenState: TtsModule['createQuakeSpokenState']
let applySpokenRefs: TtsModule['applySpokenRefs']

const OPTS: TtsRegionOptions = { intensityLevels: 0, maxRegions: 0, alwaysReadScale: -1, regionTolerance: 0 }

/** 実配信データを読む。境界リングは読み上げに使わないので落として軽くする。 */
function readData(file: string): unknown {
  return JSON.parse(readFileSync(`public/data/${file}`, 'utf8'))
}

beforeAll(async () => {
  const stationData = readData('station-coords.json')
  // 区域・県の代表点（label）は震源距離での選抜に使うため、実運用と同じく読み込ませる。
  // rings は読み上げに関与しないので空にして、テストのメモリと時間を抑える。
  const subData = (readData('subregions.json') as { rings: unknown }[]).map(r => ({ ...r, rings: [] }))
  const prefData = Object.fromEntries(
    Object.entries(readData('prefectures.json') as Record<string, { rings: unknown }>)
      .map(([name, shape]) => [name, { ...shape, rings: [] }]),
  )
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const target = String(url)
    const body =
      target.includes('station-coords.json') ? stationData
      : target.includes('subregions.json') ? subData
      : target.includes('prefectures.json') ? prefData
      : null
    if (!body) throw new Error(`unexpected fetch: ${target}`)
    return { ok: true, json: async () => body } as unknown as Response
  }))
  // 各データモジュール → ttsText の順に同じモジュール世代を読み込む（ttsText が参照する
  // キャッシュと、ここで埋めるキャッシュを同一インスタンスにするため）。
  vi.resetModules()
  const stationCoords = await import('./stationCoords')
  const subregions = await import('./subregions')
  const prefectures = await import('./prefectures')
  await Promise.all([
    stationCoords.loadStationCoords(),
    subregions.loadSubRegions(),
    prefectures.loadPrefectures(),
  ])
  const ttsText = await import('./ttsText')
  earthquakeToText = ttsText.earthquakeToText
  lpgmToText = ttsText.lpgmToText
  earthquakeToSegments = ttsText.earthquakeToSegments
  createQuakeSpokenState = ttsText.createQuakeSpokenState
  applySpokenRefs = ttsText.applySpokenRefs
  // 配信データ 3 本の parse と resetModules 後の再評価は、全テストファイルを並列実行すると
  // 既定の 10 秒を割ることがある（理由は prefectures.test.ts と同じ）。
}, 30_000)

afterAll(() => {
  vi.unstubAllGlobals()
})

function area(addr: string, scale: number): EarthquakePoint {
  // pref を空にして、区域名から県を逆引きする実運用の経路（DMDATA の電文）を通す。
  return { pref: '', addr, isArea: true, scale: scale as IntensityScale }
}

/**
 * 観測点の点。pref は経路によって入り方が違う（P2PQuake は非空・DMDATA は空）ため引数で受ける。
 * → docs/spec/quake-spec.md §4
 */
function station(pref: string, addr: string, scale: number): EarthquakePoint {
  return { pref, addr, isArea: false, scale: scale as IntensityScale }
}

/** 都道府県ロールアップ点（DMDATA 経路の Pref 直下の MaxInt 由来）。→ docs/spec/quake-spec.md §4 */
function prefRollup(pref: string, scale: number): EarthquakePoint {
  return { pref, addr: pref, isArea: true, scale: scale as IntensityScale }
}

/**
 * 標準版（P2PQuake）の区域の点。区域にも pref を積むのが DMDATA 経路との違い。
 * → docs/spec/quake-spec.md §4
 */
function p2pArea(pref: string, addr: string, scale: number): EarthquakePoint {
  return { pref, addr, isArea: true, scale: scale as IntensityScale }
}

/** 震源を指定した震度速報を作る。 */
function makeQuake(points: EarthquakePoint[], hypo: { lat: number; lon: number }): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20260820120000-1',
    time: '2026-08-20T12:01:00+09:00',
    issue: { source: '気象庁', time: '2026-08-20T12:01:00+09:00', type: '震度速報', correct: 'なし' },
    earthquake: {
      time: '2026-08-20T12:00:00+09:00',
      hypocenter: { name: '紀伊半島沖', latitude: hypo.lat, longitude: hypo.lon, depth: 30, magnitude: 6.5 },
      maxScale: 40 as IntensityScale,
      domesticTsunami: 'なし',
    },
    points,
  }
}

// 震源は南（紀伊半島沖）。震源距離順に並べると福島 → 宮城 → 岩手と南から北へ並ぶため、
// 地理順（北から）に直っているかを距離順と区別して判定できる。
const SOUTH_HYPO = { lat: 33.0, lon: 135.0 }
// 震源が北にある場合（北海道南西沖あたり）。県内の区域順の検証に使う。
const NORTH_HYPO = { lat: 42.0, lon: 140.0 }

// 以降のテストは実データの区域構成（新潟県が 4 区域・埼玉県が 3 区域）に依存した期待値を持つ。
// 気象庁の区域再編で構成が変わると、実装が正しくても期待値が外れる。どちらが原因かを失敗
// メッセージだけで切り分けられるよう、前提そのものを先に検証しておく。
describe('テストが前提にしている実データの区域構成', () => {
  function areaNamesOf(pref: string): string[] {
    const data = JSON.parse(readFileSync('public/data/station-coords.json', 'utf8')) as {
      areas: Record<string, unknown>
    }
    return Object.keys(data.areas)
      .filter(key => key.startsWith(`${pref}|`))
      .map(key => key.slice(key.indexOf('|') + 1))
  }

  it('新潟県は 4 区域（3 区域だけ使えば県名への集約は起きない）', () => {
    expect(areaNamesOf('新潟県')).toEqual(['新潟県上越', '新潟県中越', '新潟県下越', '新潟県佐渡'])
  })

  it('埼玉県は 3 区域（全部揃えると県名へ集約される）', () => {
    expect(areaNamesOf('埼玉県')).toEqual(['埼玉県北部', '埼玉県南部', '埼玉県秩父'])
  })
})

describe('震度の地域列挙: 気象庁の標準順に並べる', () => {
  it('震源が南にあっても北の県から読む', () => {
    const quake = makeQuake(
      [area('福島県中通り', 40), area('宮城県北部', 40), area('岩手県内陸南部', 40)],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を岩手県内陸南部、宮城県北部、福島県中通りで観測しました。')
  })

  it('同じ県の区域が他県を挟まずに並ぶ', () => {
    const quake = makeQuake(
      [area('埼玉県南部', 40), area('岩手県内陸南部', 40), area('埼玉県北部', 40)],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を岩手県内陸南部、埼玉県北部、埼玉県南部で観測しました。')
  })

  it('県内は気象庁の区域順で読む（緯度の北からではない）', () => {
    // 新潟県の気象庁順は 上越 → 中越 → 下越 で、緯度は逆に上越が最も南。震源を北に置けば
    // 震源距離順・緯度順はどちらも 下越 → 中越 → 上越 になるため、期待どおり
    // 上越 → 中越 → 下越 と読めば気象庁順を採っていると確定できる。
    // （新潟県は 佐渡 を含む 4 区域。3 区域だけなので県名への集約は起きない）
    const quake = makeQuake(
      [area('新潟県下越', 40), area('新潟県中越', 40), area('新潟県上越', 40)],
      NORTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を新潟県上越、新潟県中越、新潟県下越で観測しました。')
  })

  it('県内全区域が揃って県名に集約されても、他県との並びは標準順を保つ', () => {
    // 埼玉県は 北部・南部・秩父 の 3 区域で全域。集約されて「埼玉県」1 件になる。
    const quake = makeQuake(
      [area('埼玉県北部', 40), area('埼玉県南部', 40), area('埼玉県秩父', 40), area('岩手県内陸南部', 40)],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を岩手県内陸南部、埼玉県で観測しました。')
  })

  it('順位を引けない地域名は末尾へ回す', () => {
    // 色丹島は震度観測点を持たないため座標テーブルに載らない。
    const quake = makeQuake(
      [area('色丹島', 40), area('宮城県北部', 40), area('岩手県内陸南部', 40)],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を岩手県内陸南部、宮城県北部、色丹島で観測しました。')
  })
})

describe('震度の地域列挙: 上限で切るときの選抜', () => {
  it('残す地域は震源に近い順で選び、読む順は地理順にする', () => {
    // 震源は南。近い順は 福島 → 宮城 → 岩手 なので、上限 2 で残るのは福島と宮城。
    // 読み上げはそれを北から並べ直した「宮城県北部、福島県中通り」になる。
    const quake = makeQuake(
      [area('岩手県内陸南部', 40), area('宮城県北部', 40), area('福島県中通り', 40)],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, { ...OPTS, maxRegions: 2 }, true)
    expect(text).toContain('最大震度4を宮城県北部、福島県中通り、ほか1地域で観測しました。')
  })
})

describe('震度の地域列挙: 震源が無い電文（震度速報）', () => {
  // 震度速報は震源を持たず、緯度経度に -200（位置不明センチネル）が入る。地球上に無い点なので
  // 距離での選抜はできない。地理順に整えてから切り、「北から上限まで」を残す。
  const NO_HYPO = { lat: -200, lon: -200 }

  it('距離で選ばず、北から上限までを残す', () => {
    const quake = makeQuake(
      [area('福島県中通り', 40), area('岩手県内陸南部', 40), area('宮城県北部', 40)],
      NO_HYPO,
    )
    const text = earthquakeToText(quake, { ...OPTS, maxRegions: 2 }, true)
    expect(text).toContain('最大震度4を岩手県内陸南部、宮城県北部、ほか1地域で観測しました。')
  })
})

describe('長周期地震動の地域列挙', () => {
  function makeLpgm(names: string[]): JMALpgm {
    return {
      id: 'dmdata-lpgm-20260820120000',
      eventId: '20260820120000',
      time: '2026-08-20T12:03:00+09:00',
      originTime: '2026-08-20T12:00:00+09:00',
      maxClass: 3,
      cancelled: false,
      regions: names.map((name, i) => ({ code: String(100 + i), name, maxLgInt: 3 })),
    }
  }

  it('震度側と同じ標準順で読む', () => {
    const text = lpgmToText(makeLpgm(['神奈川県東部', '東京都２３区', '岩手県内陸南部']), OPTS, true)
    expect(text).toContain('階級3を岩手県内陸南部、東京都２３区、神奈川県東部で観測しました。')
  })
})

// P2PQuake の詳細報は区域の点を持たず観測点だけで届く（→ docs/spec/quake-spec.md §4）。
// 観測点の所属区域を座標テーブルから逆引きし、区域粒度で読む。
describe('震度の地域列挙: 観測点しか持たない電文（P2PQuake の詳細報）', () => {
  // 期待値は実データの観測点の帰属に依存する。観測点の改廃で帰属が変わると実装が正しくても
  // 期待値が外れるため、前提そのものを先に検証しておく（上の「実データの区域構成」と同じ趣旨）。
  it('前提: テストで使う観測点の所属区域', () => {
    const data = JSON.parse(readFileSync('public/data/station-coords.json', 'utf8')) as {
      stations: Record<string, [number, number, number?]>
      regionNames: string[]
    }
    const regionOf = (key: string) => {
      const idx = data.stations[key]?.[2]
      return idx == null ? null : data.regionNames[idx]
    }
    expect(regionOf('新潟県|糸魚川市一の宮')).toBe('新潟県上越')
    expect(regionOf('新潟県|長岡市幸町')).toBe('新潟県中越')
    expect(regionOf('埼玉県|熊谷市桜町')).toBe('埼玉県北部')
    expect(regionOf('埼玉県|さいたま北区宮原')).toBe('埼玉県南部')
    expect(regionOf('埼玉県|秩父市上町')).toBe('埼玉県秩父')
    expect(regionOf('新潟県|存在しない観測点')).toBeNull()
  })

  it('観測点の所属区域を読む（都道府県名で潰さない）', () => {
    // 新潟県は 4 区域なので、2 区域だけでは県名への集約は起きない。
    const quake = makeQuake(
      [station('新潟県', '糸魚川市一の宮', 40), station('新潟県', '長岡市幸町', 40)],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を新潟県上越、新潟県中越で観測しました。')
  })

  it('県内全区域に観測点があれば県名にまとめる', () => {
    const quake = makeQuake(
      [
        station('埼玉県', '熊谷市桜町', 40),
        station('埼玉県', 'さいたま北区宮原', 40),
        station('埼玉県', '秩父市上町', 40),
      ],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を埼玉県で観測しました。')
  })

  // ---- 未入電は地点名で読む ----
  //
  // 未入電は観測点 1 つ 1 つに付く事実。区域名へ丸めると、同じ区域に観測値がある電文で
  // 「最大震度7を〜で観測しました。〜では…未入電です。」と矛盾して聞こえる。

  // 正: 未入電の観測点があれば、区域名ではなく地点名で読む
  it('未入電の地点は地点名で読む', () => {
    const quake = makeQuake(
      [
        station('石川県', '輪島市河井町', 40),
        { ...station('石川県', '輪島市舳倉島', 45), unreceived: true },
      ],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('輪島市舳倉島では、震度5弱以上と推定されますが、未入電です。')
  })

  // 安全弁: 同じ区域に観測値があっても矛盾しない（区域名で丸めていないこと）
  it('同じ区域に観測値があっても区域名で未入電を語らない', () => {
    const quake = makeQuake(
      [
        station('石川県', '輪島市河井町', 40),
        { ...station('石川県', '輪島市舳倉島', 45), unreceived: true },
      ],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    // 区域名（石川県能登）を主語にした未入電の文は作らない
    expect(text).not.toMatch(/石川県能登では、震度5弱以上と推定されます/)
  })

  // 対照: 地点を持たない電文（震度速報は区域しか持たない）は従来どおり区域名で読む
  it('地点を持たない電文では区域名で読む', () => {
    const quake = makeQuake([{ ...area('石川県能登', 45), unreceived: true }], SOUTH_HYPO)
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('石川県能登では、震度5弱以上と推定されますが、未入電です。')
  })

  // 正: 未入電を含む県は、全区域が揃っていても県名へまとめない（カードと同じ規則。
  // → docs/spec/quake-spec.md §4）。まとめると、画面が区域別に並べている同じ電文を
  // 音声だけ県名 1 つに畳んで伝えることになる。対照は 1 つ上のテスト（観測値ならまとめる）。
  //
  // **区域点で書くこと。** 観測点で書くと地点名を読む経路へ入り、県名へまとめる処理を
  // 一度も通らない —— 地点名は「埼玉県」を含まないのでアサーションが常に真になり、
  // 何も検証しないテストになる。
  it('未入電を含む県は全区域が揃っても県名へまとめない', () => {
    const unreceived = (addr: string): EarthquakePoint => ({ ...area(addr, 45), unreceived: true })
    const quake = makeQuake(
      [unreceived('埼玉県北部'), unreceived('埼玉県南部'), unreceived('埼玉県秩父')],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('では、震度5弱以上と推定されますが、未入電です。')
    // 「埼玉県」単独では出ない（埼玉県北部・南部・秩父に続く形だけ許す）。
    expect(text).not.toMatch(/埼玉県(?![北南秩])/)
  })

  // ---- 地点と区域の未入電が同じ電文に混在したとき ----
  //
  // 電文全体で「地点があるか」を 1 つのフラグにして倒すと、区域単位でしか未入電を伝えて
  // こない県が読み上げから丸ごと消える。しかも痕跡が残らない。

  // 正: 地点で覆えない区域の未入電も落とさない
  it('地点と区域の未入電が混在しても、どちらも落とさない', () => {
    const quake = makeQuake(
      [
        { ...station('石川県', '輪島市舳倉島', 45), unreceived: true },
        { ...area('埼玉県北部', 45), unreceived: true },
      ],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('輪島市舳倉島')
    expect(text).toContain('埼玉県北部')
  })

  // 対照: 地点が覆う区域は二重に言わない（区域の最大震度は配下の最大なので同じ形で届く）
  it('未入電の地点が属する区域は重ねて読まない', () => {
    const quake = makeQuake(
      [
        { ...station('石川県', '輪島市舳倉島', 45), unreceived: true },
        { ...area('石川県能登', 45), unreceived: true },
      ],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('輪島市舳倉島')
    expect(text).not.toContain('石川県能登')
  })

  // 安全弁: 混在時の省略は単位を断定しない（「ほかN地点」とも「ほかN地域」とも言えない）
  it('混在して上限を超えたら「ほかN件」で省略を伝える', () => {
    const quake = makeQuake(
      [
        { ...station('石川県', '輪島市舳倉島', 45), unreceived: true },
        { ...area('埼玉県北部', 45), unreceived: true },
      ],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, { ...OPTS, maxRegions: 1 }, true)
    expect(text).toContain('ほか1件では、震度5弱以上と推定されますが、未入電です。')
  })

  it('pref が空の観測点でも区域を引ける（DMDATA の XML 経路）', () => {
    const quake = makeQuake(
      [station('', '糸魚川市一の宮', 40), station('', '長岡市幸町', 40)],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を新潟県上越、新潟県中越で観測しました。')
  })

  it('区域の点がある電文では観測点から逆引きしない', () => {
    // 区域と観測点が両方来る経路（DMDATA の詳細報）。区域は電文自身が示した粒度なので、
    // 観測点からの逆引きより優先する。ここで両方を混ぜると同じ県が二重に並ぶ。
    const quake = makeQuake(
      [area('新潟県上越', 40), station('新潟県', '長岡市幸町', 40)],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を新潟県上越で観測しました。')
  })

  it('座標テーブルに無い観測点は都道府県名で読む', () => {
    const quake = makeQuake([station('新潟県', '存在しない観測点', 40)], SOUTH_HYPO)
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を新潟県で観測しました。')
  })

  // 安全弁: 都道府県が判っているときは県付きの鍵だけで引き、観測点名単独の鍵へは落とさない。
  // 落とすと別の県の同名観測点にヒットして、地図が塗る区域と読み上げが食い違う。
  it('都道府県が判っているとき、その県に無い観測点は他県の区域に解決しない', () => {
    // 「糸魚川市一の宮」は新潟県の観測点。岩手県として届けば県付きの鍵は引けないので、
    // 単独の鍵へ落ちれば「新潟県上越」、落ちなければ県名の「岩手県」になる。
    const quake = makeQuake([station('岩手県', '糸魚川市一の宮', 40)], SOUTH_HYPO)
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を岩手県で観測しました。')
    expect(text).not.toContain('上越')
  })

  it('同じ県に区域を引けた点と引けない点が混ざっても県名を重ねない', () => {
    const quake = makeQuake(
      [station('新潟県', '糸魚川市一の宮', 40), station('新潟県', '存在しない観測点', 40)],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を新潟県上越で観測しました。')
  })

  // 安全弁: 観測点が取れた時点で打ち切ると、観測点を持たない県が黙って消える。
  // DMDATA の電文は区域・観測点・都道府県ロールアップ点の 3 種が同時に届く。
  it('観測点を持たない県は都道府県ロールアップ点から拾う', () => {
    const quake = makeQuake(
      [station('新潟県', '糸魚川市一の宮', 40), prefRollup('岩手県', 40)],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を岩手県、新潟県上越で観測しました。')
  })

  it('観測点で区域が取れた県のロールアップ点は重ねない', () => {
    const quake = makeQuake(
      [station('新潟県', '糸魚川市一の宮', 40), prefRollup('新潟県', 40)],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を新潟県上越で観測しました。')
  })

  // 正: 標準版は区域の点にも pref を積むため、区域名が県名と同じ奈良県は addr === pref になる。
  // ロールアップ点かどうかを名前だけで決めると、この区域が読み上げから静かに落ちる。
  // 奈良県は県内の一次細分区域が 1 つだけで、その名前が県名と同じ唯一の県
  // （stationCoords.test.ts が固定）。
  it('標準版の区域の点は、区域名が県名と同じ奈良県でも読み上げに残る', () => {
    const quake = makeQuake(
      [p2pArea('奈良県', '奈良県', 40), p2pArea('大阪府', '大阪府南部', 40)],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を大阪府南部、奈良県で観測しました。')
  })

  // 対照: 同じ形（addr === pref）でも、区域として実在しない県名は区域にしない。
  // これを緩めると、県名が区域名と並んで粒度が崩れる。
  it('区域の点と一緒に届いた都道府県ロールアップ点は区域として読まない', () => {
    const quake = makeQuake(
      [area('大阪府南部', 40), prefRollup('大阪府', 40)],
      SOUTH_HYPO,
    )
    const text = earthquakeToText(quake, OPTS, true)
    expect(text).toContain('最大震度4を大阪府南部で観測しました。')
  })
})

// 県名へのまとめ判定は階級ごとに独立して走る。上の階級で区域名を出した県を下の階級で丸ごと
// まとめると、県の震度を過小に伝える。能登半島地震の本震の実データがこの形をそのまま含む。
describe('震度の地域列挙: 階級をまたぐ県名まとめ', () => {
  const notoPoints = (
    JSON.parse(readFileSync('src/data/noto-honshin-2024-points.json', 'utf8')) as EarthquakePoint[]
  ).filter(p => !p.isArea)

  /** 全階級を読ませる（上限なし）。まとめ判定そのものを見たいので選抜と打ち切りは効かせない。 */
  const ALL: TtsRegionOptions = { intensityLevels: 8, maxRegions: 0, alwaysReadScale: -1, regionTolerance: 0 }
  /** 本震の最大震度は 7。共有ヘルパーは 4 固定なので上書きする（ここから下の階級を辿るため）。 */
  function notoQuake(): JMAQuake {
    const base = makeQuake(notoPoints, { lat: 37.5, lon: 137.2 })
    return { ...base, earthquake: { ...base.earthquake, maxScale: 70 as IntensityScale } }
  }

  // 期待値は実データの震度分布に依存する。観測点の改廃や区域再編で崩れたとき、実装の誤りと
  // 取り違えないよう前提を先に検証しておく。
  it('前提: 福井県は 2 区域。5強は嶺北のみ・4 で嶺北と嶺南が揃う', () => {
    const data = JSON.parse(readFileSync('public/data/station-coords.json', 'utf8')) as {
      stations: Record<string, [number, number, number?]>
      areas: Record<string, unknown>
      regionNames: string[]
    }
    const fukuiAreas = Object.keys(data.areas)
      .filter(k => k.startsWith('福井県|')).map(k => k.slice(k.indexOf('|') + 1))
    expect(fukuiAreas).toEqual(['福井県嶺北', '福井県嶺南'])

    const regionsAt = (scale: number) => new Set(
      notoPoints.filter(p => p.pref === '福井県' && p.scale === scale)
        .map(p => data.regionNames[data.stations[`福井県|${p.addr}`]![2]!]))
    expect([...regionsAt(50)]).toEqual(['福井県嶺北'])
    expect([...regionsAt(40)].sort()).toEqual(['福井県嶺北', '福井県嶺南'])
  })

  it('正: 上位階級で区域名を出した県は、下位階級でも県名にまとめない', () => {
    const text = earthquakeToText(notoQuake(), ALL, true)
    expect(text).toContain('福井県嶺北')
    // 「福井県」単独では出ない（嶺北・嶺南に続く形だけ許す）。
    expect(text).not.toMatch(/福井県(?!嶺)/)
  })

  it('対照: 上位階級に区域名が出ていない県は従来どおりまとめる', () => {
    const text = earthquakeToText(notoQuake(), ALL, true)
    // 宮城県・秋田県は震度3 で全区域が揃い、それより上の階級には現れない。
    expect(text).toMatch(/震度3を[^。]*宮城県[、で]/)
    expect(text).toMatch(/震度3を[^。]*秋田県[、で]/)
  })

  it('安全弁: 同じ階級の中のまとめは従来どおり働く', () => {
    const text = earthquakeToText(notoQuake(), ALL, true)
    // 富山県は 5強 で東部・西部が揃い、それより上の階級には出ない。1 件にまとまる。
    expect(text).toMatch(/震度5強を[^。]*富山県[、で]/)
    expect(text).not.toContain('富山県東部')
  })
})

describe('長周期地震動の地域列挙: 階級をまたぐ県名まとめ', () => {
  /** 階級ごとに区域を指定して電文を作る。 */
  function makeLpgmByClass(byClass: Record<number, string[]>): JMALpgm {
    const regions = Object.entries(byClass).flatMap(([cls, names]) =>
      names.map((name, i) => ({ code: `${cls}${i}`, name, maxLgInt: Number(cls) })))
    return {
      id: 'dmdata-lpgm-20260820120000',
      eventId: '20260820120000',
      time: '2026-08-20T12:03:00+09:00',
      originTime: '2026-08-20T12:00:00+09:00',
      maxClass: Math.max(...Object.keys(byClass).map(Number)),
      cancelled: false,
      regions,
    }
  }
  const ALL: TtsRegionOptions = { intensityLevels: 8, maxRegions: 0, alwaysReadScale: -1, regionTolerance: 0 }

  it('正: 上位階級で区域名を出した県は、下位階級でも県名にまとめない', () => {
    // 福井県は嶺北・嶺南の 2 区域。階級3 で嶺北だけ、階級2 で両方が揃う形。
    const text = lpgmToText(makeLpgmByClass({ 3: ['福井県嶺北'], 2: ['福井県嶺北', '福井県嶺南'] }), ALL, true)
    expect(text).toContain('福井県嶺北')
    expect(text).not.toMatch(/福井県(?!嶺)/)
  })

  // このテストは「同じ階級の中で全区域が揃えばまとめる」という元々の規則（震度側では安全弁として
  // 独立させているもの）も同時に守っている。片方だけ壊れても落ちるので 1 本で兼ねる。
  it('対照: 上位階級に区域名が出ていない県は従来どおりまとめる', () => {
    const text = lpgmToText(makeLpgmByClass({ 3: ['石川県能登'], 2: ['福井県嶺北', '福井県嶺南'] }), ALL, true)
    expect(text).toMatch(/階級2を[^。]*福井県[、で]/)
    expect(text).not.toContain('福井県嶺北')
  })
})

// 続報（差分読み上げ）とまとめ抑止の相互作用。**上位階級の区域を数えるのは差分で落とす前**で
// なければならない。落とした後で数えると、既出の区域が「今回は声にならない」ために県の全区域が
// 揃って見え、県名へまとめてしまう ＝ このコミットが直したはずの過小伝達が続報でだけ復活する。
describe('震度の地域列挙: 続報でも階級をまたぐまとめを抑える', () => {
  const OPTS_ALL: TtsRegionOptions = { intensityLevels: 8, maxRegions: 0, alwaysReadScale: -1, regionTolerance: 0 }
  const FUKUI_HYPO = { lat: 36.0, lon: 136.2 }

  function quakeOf(points: EarthquakePoint[], maxScale: number): JMAQuake {
    const base = makeQuake(points, FUKUI_HYPO)
    return {
      ...base,
      issue: { ...base.issue, type: '各地の震度情報' },
      earthquake: { ...base.earthquake, maxScale: maxScale as IntensityScale },
    }
  }

  it('正: 既出の区域が差分で落ちても、その県を県名へまとめない', () => {
    const state = createQuakeSpokenState()

    // 初報: 嶺北だけが 5強。
    const first = earthquakeToSegments(
      quakeOf([station('福井県', '福井市豊島', 50)], 50), OPTS_ALL, true, state)
    applySpokenRefs(state, first.flatMap(s => s.refs))
    expect(joinSegments(first)).toContain('福井県嶺北')

    // 続報: 嶺北は据え置き（差分で落ちる）、嶺北の別点と嶺南が 4 で加わり県内 2 区域が揃う。
    const second = earthquakeToSegments(
      quakeOf([
        station('福井県', '福井市豊島', 50),
        station('福井県', '福井市蒲生町', 40),
        station('福井県', '敦賀市松栄町', 40),
      ], 50), OPTS_ALL, false, state)

    const text = joinSegments(second)
    expect(text).toContain('福井県嶺南')
    // 「福井県」単独では出ない（嶺北・嶺南に続く形だけ許す）。
    expect(text).not.toMatch(/福井県(?!嶺)/)
  })
})
