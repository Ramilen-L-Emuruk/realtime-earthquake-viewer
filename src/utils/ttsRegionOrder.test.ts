// 読み上げの地域名の並び順（気象庁の標準順＝北から南・県ごとにまとまる）のテスト。
//
// ttsText.ts の並べ替えは station-coords.json のキャッシュが埋まってはじめて効くため、
// 実配信データを fetch スタブ経由で読み込ませてから検証する（テスト専用の小さな
// フィクスチャでは、実データの県区切り・区域の並びを取り違えても気づけない）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { EarthquakePoint, IntensityScale, JMAQuake, JMALpgm } from '../types/earthquake'
import type { TtsRegionOptions } from './ttsText'

type TtsModule = typeof import('./ttsText')

let earthquakeToText: TtsModule['earthquakeToText']
let lpgmToText: TtsModule['lpgmToText']

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
  // 配信データ 3 本の parse と resetModules 後の再評価は、全テストファイルを並列実行すると
  // 既定の 10 秒を割ることがある（理由は prefectures.test.ts と同じ）。
}, 30_000)

afterAll(() => {
  vi.unstubAllGlobals()
})

function area(addr: string, scale: number): EarthquakePoint {
  // pref を空にして、区域名から県を逆引きする実運用の経路（DMDATA JSON 電文）を通す。
  return { pref: '', addr, isArea: true, scale: scale as IntensityScale }
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
