// 点の役割（一次細分区域の点 / 都道府県ロールアップ点）の見分け方。
// → docs/spec/quake-spec.md §4「points 構造」
//
// 見分けを名前だけ（`addr !== pref`）で済ませると、区域名が県名と同じ奈良県が
// 標準版（P2PQuake）で区域ごと落ちる。索引を渡す形と渡さない形の両方を固定する。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isAreaPoint } from './quakePoints'
import { buildAreaPrefIndex, type StationCoordsData } from './stationCoords'
import type { EarthquakePoint, IntensityScale } from '../types/earthquake'

// テスト専用の小さな索引では、県名と衝突する区域名が実在することを取り違えても気づけない。
const AREA_PREF_INDEX = buildAreaPrefIndex(
  JSON.parse(readFileSync('public/data/station-coords.json', 'utf8')) as StationCoordsData,
)

function pt(pref: string, addr: string, isArea: boolean): EarthquakePoint {
  return { pref, addr, isArea, scale: 40 as IntensityScale }
}

describe('区域の点かロールアップ点か（索引あり）', () => {
  // 正: P2PQuake は区域の点にも pref を積むため、奈良県は addr === pref になる。
  // 名前だけで判断すると落ちるが、奈良県は一次細分区域として実在する。
  it('区域名が県名と同じ奈良県は、pref 付きでも区域の点', () => {
    expect(isAreaPoint(pt('奈良県', '奈良県', true), AREA_PREF_INDEX)).toBe(true)
  })

  // 対照: 同じ形（addr === pref）でも、区域として実在しない県名はロールアップ点。
  it('区域として実在しない県名のロールアップ点は区域の点ではない', () => {
    expect(isAreaPoint(pt('東京都', '東京都', true), AREA_PREF_INDEX)).toBe(false)
    expect(isAreaPoint(pt('大阪府', '大阪府', true), AREA_PREF_INDEX)).toBe(false)
  })

  it('ふつうの区域の点と観測点は従来どおり', () => {
    expect(isAreaPoint(pt('', '大阪府南部', true), AREA_PREF_INDEX)).toBe(true)
    expect(isAreaPoint(pt('大阪府', '大阪府南部', true), AREA_PREF_INDEX)).toBe(true)
    expect(isAreaPoint(pt('奈良県', '奈良市', false), AREA_PREF_INDEX)).toBe(false)
  })

  // 安全弁: 名前が衝突していない限り索引は要らない。索引を引くのは addr === pref のときだけ。
  it('索引に無い名前でも、addr と pref が違えば区域の点として扱う', () => {
    expect(isAreaPoint(pt('', 'まだ座標表に無い区域', true), AREA_PREF_INDEX)).toBe(true)
  })
})

describe('区域の点かロールアップ点か（索引なし）', () => {
  // 座標テーブルが未読み込み・取得失敗のときの縮退を固定する。呼び出し側は索引を必須で
  // 受け取るが、その中身が null になることはある（→ stationCoords.ts の
  // getAreaPrefIndexCache）。そのとき奈良県を取りこぼすのは承知の上。
  it('奈良県は取りこぼす', () => {
    expect(isAreaPoint(pt('奈良県', '奈良県', true), null)).toBe(false)
  })

  it('それ以外の見分けは索引ありと変わらない', () => {
    expect(isAreaPoint(pt('東京都', '東京都', true), null)).toBe(false)
    expect(isAreaPoint(pt('', '大阪府南部', true), null)).toBe(true)
    expect(isAreaPoint(pt('大阪府', '大阪府南部', true), null)).toBe(true)
    expect(isAreaPoint(pt('奈良県', '奈良市', false), null)).toBe(false)
  })
})
