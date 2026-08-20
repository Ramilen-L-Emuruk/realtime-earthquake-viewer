import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  createTestEarthquake,
  createTestEEW,
  createTestEEWAssumed,
  createTestEEWDeep,
  createTestEEWForecast,
  createTestEEWWarning,
  createTestTsunami,
} from './testData'
import { eewAreas, eewMaxScale, eewNoForecastReason } from './eew'

// テストデータが「名前で」外部データと突き合わせている箇所を固定する。
//
// 予想区域名（EEW）も観測点名（津波）も、受け側は名前が引けなければ黙ってその要素を捨てる
// （`useEewLayerData` は `subregionByName` で引けなければ区域を塗らず、`useTsunamiLayerData` は
// `tsunamiObsCoords[o.name]` で引けなければ `continue` して観測棒を作らない）。
// 警告もエラーも出ないため、1 文字違うだけで「そこだけ表示されない」状態が目視では気づけないまま残る。
// 実際に次の 2 件が長く放置されていた:
//   - EEW 警報テストの「宮崎県南部」（正しくは「宮崎県南部平野部」）→ 3 区域のつもりが 2 区域しか塗られず
//   - 津波テストの「八戸」（正しくは「八戸港」）→ 観測棒が 1 本出ていなかった

const readJson = (relPath: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf8'))

const subregionNames = new Set((readJson('public/data/subregions.json') as { name: string }[]).map((sr) => sr.name))
const obsCoordNames = new Set(Object.keys(readJson('public/data/tsunami-obs-coords.json') as Record<string, unknown>))

describe('テスト EEW の予想区域名', () => {
  // 区域を持つテスト EEW を網羅する。新しいテスト EEW を足したらここにも追加すること。
  const cases = [
    ['createTestEEW（特別警報・三陸沖）', createTestEEW()],
    ['createTestEEWWarning（警報・日向灘）', createTestEEWWarning()],
    ['createTestEEWForecast（予報・宮城県沖）', createTestEEWForecast()],
    // 単独点処理は初報に区域を持たない（区域が付くのは震源が確定した続報から）
    ['createTestEEWAssumed（単独点処理の続報・日向灘）', createTestEEWAssumed(undefined, 2)],
  ] as const

  it('区域データが読めている（前提の確認）', () => {
    expect(subregionNames.size).toBeGreaterThan(0)
  })

  for (const [label, eew] of cases) {
    it(`${label} の区域名がすべて実在する`, () => {
      const names = eewAreas(eew).map((area) => area.name)
      expect(names.length).toBeGreaterThan(0)
      expect(names.filter((name) => !subregionNames.has(name))).toEqual([])
    })
  }
})

// 座標を持たせていない既知の観測点。地図に棒を出すことを意図していないものだけを挙げる。
//
// `沖合40km` は、予報区に紐づかない観測が「沖合観測」カードへフォールバックする経路
// （導入コミット 1baefde）を確かめるための架空の観測点。実在の沖合観測点（「岩手宮古沖」等）は
// 座標テーブルに載っているため、ここに足すのは「実在しない名前をあえて置いている」場合に限る。
const KNOWN_COORDLESS_OBSERVATIONS = new Set(['沖合40km'])

describe('テスト津波の観測点名', () => {
  it('観測点座標テーブルが読めている（前提の確認）', () => {
    expect(obsCoordNames.size).toBeGreaterThan(0)
  })

  it('観測点の名前がすべて実在する（座標を持たせていない既知の例外を除く）', () => {
    // 絞り込みは実装のゲート条件に合わせる。`useTsunamiLayerData` の observationBars は
    // 「`height` があり、名前から座標が引ける」観測点にだけ棒を作り、予報区への紐づけ
    // （`districtCode`）は見ない。ここで `districtCode` の有無で絞ると、予報区に紐づかない
    // 観測点の名前の誤りを取りこぼす。
    // 観測点はバリアントに依存しない（差は eventId・validDateTime のみ）ので DMDSS 版で見る。
    const targets = (createTestTsunami(true).observations ?? []).filter(
      (o) => o.height && !KNOWN_COORDLESS_OBSERVATIONS.has(o.name),
    )
    const names = targets.map((o) => o.name)
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((name) => !obsCoordNames.has(name))).toEqual([])
  })
})

// 地震情報テストの points 形状。バリアントで実電文の形が違う（quake-spec.md §4 の識別規則）。
// 元データは P2PQuake 形状（観測点に pref が入る）なので、DMDSS でそのまま流すと
// 実電文では起こり得ない組み合わせになり、都道府県別表示の分岐がテストで一度も通らない。
describe('地震情報テストの points 形状', () => {
  it('DMDSS 版は観測点・区域を pref 空で積み、都道府県ロールアップを別に持つ', () => {
    const quake = createTestEarthquake(true)

    const stations = quake.points.filter((p) => !p.isArea)
    expect(stations.length).toBeGreaterThan(0)
    expect(stations.every((p) => p.pref === '')).toBe(true)

    // 一次細分区域は pref 空のまま残る
    expect(quake.points.some((p) => p.isArea && p.pref === '')).toBe(true)

    // 都道府県は pref に名前が入ったロールアップ点として別に立つ
    const rollups = quake.points.filter((p) => p.isArea && p.pref !== '')
    expect(rollups.length).toBeGreaterThan(0)
    expect(rollups.every((p) => p.pref === p.addr)).toBe(true)

    expect(quake.issue.type).toBe('震源・震度情報')
  })

  it('standard 版は P2PQuake 形状（観測点自体に pref が入り、区域点は混ざらない）', () => {
    const quake = createTestEarthquake(false)
    expect(quake.points.some((p) => !p.isArea && p.pref !== '')).toBe(true)
    // DetailScale（各地の震度情報）に区域点は混ざらない（→ quake-spec.md §4）
    expect(quake.points.some((p) => p.isArea)).toBe(false)
    expect(quake.issue.type).toBe('各地の震度情報')
  })

  it('都道府県ロールアップの震度は、その県の観測点の最大震度と一致する（震度不明は数えない）', () => {
    const expected = new Map<string, number>()
    for (const p of createTestEarthquake(false).points) {
      if (p.isArea || !p.pref || p.scale < 0) continue
      const cur = expected.get(p.pref)
      if (cur === undefined || p.scale > cur) expected.set(p.pref, p.scale)
    }
    // ロールアップは震度不明（-1）を持たない
    expect(createTestEarthquake(true).points.every((p) => !(p.isArea && p.pref !== '') || p.scale >= 0)).toBe(true)

    const rollups = createTestEarthquake(true).points.filter((p) => p.isArea && p.pref !== '')
    expect(rollups.length).toBe(expected.size)
    for (const r of rollups) expect(r.scale).toBe(expected.get(r.pref))
  })
})

// EEW の kindCode は気象庁コード表12（緊急地震速報種別）: 00/01/09 が予報、10/11/19 が警報。
// 警報は予想震度5弱（scaleTo 45）以上の区域に発表されるため、震度4以下の区域に警報コードが
// 付いていると「予報なのに警報表示」という実運用では起こらない状態になる。
describe('テスト EEW の kindCode と予想震度の整合', () => {
  const WARNING_CODES = new Set(['10', '11', '19'])
  const cases = [
    ['createTestEEW（特別警報・三陸沖）', createTestEEW()],
    ['createTestEEWWarning（警報・日向灘）', createTestEEWWarning()],
    ['createTestEEWForecast（予報・宮城県沖）', createTestEEWForecast()],
    // 単独点処理は初報に区域を持たない（区域が付くのは震源が確定した続報から）
    ['createTestEEWAssumed（単独点処理の続報・日向灘）', createTestEEWAssumed(undefined, 2)],
  ] as const

  it.each(cases)('%s: 警報コードの区域は予想震度5弱以上', (_label, eew) => {
    for (const area of eewAreas(eew)) {
      if (WARNING_CODES.has(area.kindCode)) expect(area.scaleTo).toBeGreaterThanOrEqual(45)
    }
  })

  it.each(cases)('%s: 区域はすべてコード表12 の値', (_label, eew) => {
    for (const area of eewAreas(eew)) {
      expect(['00', '01', '09', '10', '11', '19']).toContain(area.kindCode)
    }
  })

  // 実運用の電文に区域が載る条件は「最大予測震度4以上または最大予測長周期地震動階級3以上」
  // （eew-information スキーマ）。震度3以下の区域はそもそも電文に現れない。
  it.each(cases)('%s: 区域は予想震度4以上（電文に載る条件）', (_label, eew) => {
    for (const area of eewAreas(eew)) {
      expect(area.scaleTo).toBeGreaterThanOrEqual(40)
    }
  })

  it('予報の電文は警報コードの区域を含まない', () => {
    const forecast = createTestEEWForecast()
    expect(forecast.severity).not.toBe('Warning')
    expect(eewAreas(forecast).some((a) => WARNING_CODES.has(a.kindCode))).toBe(false)
  })

  // kindCode 11/19 は「主要動が既に到達（または到達予想なし）」。到達予想時刻とは両立しない。
  it.each(cases)('%s: 既到達コードの区域は到達予想時刻を持たない', (_label, eew) => {
    for (const area of eewAreas(eew)) {
      if (area.kindCode === '01' || area.kindCode === '11' || area.kindCode === '09' || area.kindCode === '19') {
        expect(area.arrivalTime).toBeNull()
      }
    }
  })
})

// 予想震度が付かないテスト EEW（単独点処理・深発地震）。読み上げが「〜のため、予想震度なし。」を
// 待たずに読む経路（docs/spec/audio-tts-spec.md §6）を実機で確かめるためのデータで、
// 判定に使われる condition・depth・区域の有無が崩れると、そのボタンが目的を果たさなくなる。
describe('予想震度が付かないテスト EEW', () => {
  const base = new Date('2026-01-01T12:00:00Z')

  it('単独点処理の初報は仮定震源要素で、区域を持たない', () => {
    const first = createTestEEWAssumed('evt', 1, base)
    expect(first.earthquake.condition).toBe('仮定震源要素')
    expect(eewAreas(first)).toEqual([])
    expect(eewMaxScale(first)).toBe(0)
    expect(eewNoForecastReason(first)).toBe('assumed')
  })

  it('単独点処理の続報は震源が確定し、警報へ格上げされる', () => {
    const second = createTestEEWAssumed('evt', 2, base)
    expect(second.earthquake.condition).not.toBe('仮定震源要素')
    expect(second.severity).toBe('Warning')
    expect(eewMaxScale(second)).toBe(50)
  })

  // 名前が変わって 50km 超動くと「震源を更新、〇〇で地震。」の経路に入り、確かめたい格上げの
  // 言い方（「緊急地震速報に切り替わりました。」）が出てこなくなる。
  it('単独点処理は報をまたいで震源名を変えない', () => {
    expect(createTestEEWAssumed('evt', 2, base).earthquake.hypocenter.name)
      .toBe(createTestEEWAssumed('evt', 1, base).earthquake.hypocenter.name)
  })

  // 実運用の続報は震源時刻を変えない（発表時刻だけが進む）。
  it('単独点処理の続報は震源時刻を引き継ぐ', () => {
    expect(createTestEEWAssumed('evt', 2, base).earthquake.originTime)
      .toBe(createTestEEWAssumed('evt', 1, base).earthquake.originTime)
  })

  // 気象庁は深さ 150km を超える地震に緊急地震速報（警報）を発表しない。続報でも予報級のまま。
  it('深発地震は深さ 150km 超・区域なしで、どの報も予報級', () => {
    for (const serial of [1, 2, 3]) {
      const eew = createTestEEWDeep('evt', serial, base)
      expect(eew.earthquake.hypocenter.depth).toBeGreaterThan(150)
      expect(eewAreas(eew)).toEqual([])
      expect(eew.severity).toBe('Forecast')
      expect(eewNoForecastReason(eew)).toBe('deep')
    }
  })
})
