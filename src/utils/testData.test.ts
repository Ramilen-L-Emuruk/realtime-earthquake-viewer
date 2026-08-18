import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  createTestEEW,
  createTestEEWForecast,
  createTestEEWWarning,
  createTestTsunami,
} from './testData'
import { eewAreas } from './eew'

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
    const targets = (createTestTsunami().observations ?? []).filter(
      (o) => o.height && !KNOWN_COORDLESS_OBSERVATIONS.has(o.name),
    )
    const names = targets.map((o) => o.name)
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((name) => !obsCoordNames.has(name))).toEqual([])
  })
})
