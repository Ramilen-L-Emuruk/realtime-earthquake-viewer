// 点の役割（一次細分区域の点 / 都道府県ロールアップ点）の見分け方。
// → docs/spec/quake-spec.md §4「points 構造」
//
// 見分けを名前だけ（`addr !== pref`）で済ませると、区域名が県名と同じ奈良県が
// 標準版（P2PQuake）で区域ごと落ちる。索引を渡す形と渡さない形の両方を固定する。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isAreaPoint, buildIntensityRows, type IntensityRowDeps } from './quakePoints'
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

// 震度一覧の行の組み立て。**都道府県の行に一次細分区域を畳んで持たせる。**
//
// かつては「県の点があれば区域を捨てる」作りで、実電文は県の `MaxInt` を必ず持つ（実測 66/66）
// ため区域の行が事実上どこにも出なかった。読み上げは元から区域が主なので、画面＝県／音声＝区域
// のずれになっていた。
describe('buildIntensityRows', () => {
  const s = (n: number) => n as IntensityScale
  const area = (addr: string, scale: number): EarthquakePoint => ({ pref: '', addr, isArea: true, scale: s(scale) })
  const prefPoint = (pref: string, scale: number): EarthquakePoint => ({ pref, addr: pref, isArea: true, scale: s(scale) })

  const deps = (over: Partial<IntensityRowDeps> = {}): IntensityRowDeps => ({
    // 索引は実データから作る（テスト専用の小さな索引では、区域名と県名の衝突を取り違えても気づけない）。
    prefOfArea: name => AREA_PREF_INDEX.get(name) ?? null,
    prefOfStation: () => null,
    regionOfStation: () => null,
    unreceivedPrefs: new Set<string>(),
    unreceivedAreas: new Set<string>(),
    rank: () => 0,
    ...over,
  })

  // 正: 県の点と区域の点が両方あるとき、**区域を捨てない**。
  it('県の行の下に、その県の一次細分区域を並べる', () => {
    const rows = buildIntensityRows([
      prefPoint('岩手県', 40),
      area('岩手県沿岸北部', 40),
      area('岩手県内陸北部', 30),
    ], deps())
    expect(rows).toHaveLength(1)
    expect(rows[0].pref).toBe('岩手県')
    expect(rows[0].scale).toBe(40)
    expect(rows[0].regions.map(r => r.name)).toEqual(['岩手県沿岸北部', '岩手県内陸北部'])
  })

  // 正: 区域の点を持たない電文（P2PQuake の詳細報）では観測点から逆引きする。
  it('区域の点が無ければ観測点の所属区域から作る', () => {
    const rows = buildIntensityRows(
      [{ pref: '岩手県', addr: '宮古市田老', isArea: false, scale: s(40) }],
      deps({ prefOfStation: () => '岩手県', regionOfStation: () => '岩手県沿岸北部' }),
    )
    expect(rows[0].regions.map(r => r.name)).toEqual(['岩手県沿岸北部'])
  })

  // 対照: 区域の点があるときは観測点から作らない。**電文が示した粒度を優先する。**
  it('区域の点があれば観測点からは作らない', () => {
    let called = 0
    const rows = buildIntensityRows([
      area('岩手県沿岸北部', 40),
      { pref: '岩手県', addr: '宮古市田老', isArea: false, scale: s(40) },
    ], deps({ regionOfStation: () => { called++; return '岩手県内陸北部' } }))
    expect(rows[0].regions.map(r => r.name)).toEqual(['岩手県沿岸北部'])
    expect(called).toBe(0)
  })

  // 安全弁 1: 県の点が無くても、区域だけが届いた県を落とさない。
  it('区域しか無い県も行にする（県の値は配下の最大）', () => {
    const rows = buildIntensityRows([
      area('岩手県沿岸北部', 30),
      area('岩手県内陸北部', 45),
    ], deps())
    expect(rows[0].pref).toBe('岩手県')
    expect(rows[0].scale).toBe(45)
  })

  // 安全弁 2: 「未入電あり」は**範囲に 1 点でもあれば**付く。行の最大が観測値でも消さない。
  it('最大が観測値でも、範囲に未入電があれば印を付ける', () => {
    const rows = buildIntensityRows([
      prefPoint('岩手県', 40),
      area('岩手県沿岸北部', 40),
    ], deps({
      unreceivedPrefs: new Set(['岩手県']),
      unreceivedAreas: new Set(['岩手県沿岸北部']),
    }))
    expect(rows[0].hasUnreceived).toBe(true)
    expect(rows[0].unreceived).toBe(false)
    expect(rows[0].regions[0].hasUnreceived).toBe(true)
    expect(rows[0].regions[0].unreceived).toBe(false)
  })

  // 安全弁 3: 並びは震度の降順、同じ震度は渡された順位（気象庁の標準順）。
  // **電文が点を並べた順に画面を委ねない。**
  it('震度の降順で並べ、同じ震度は標準順で並べる', () => {
    const order: Record<string, number> = { 岩手県沿岸北部: 1, 岩手県内陸北部: 2, 岩手県内陸南部: 3 }
    const rows = buildIntensityRows([
      area('岩手県内陸北部', 40),
      area('岩手県沿岸北部', 40),
      area('岩手県内陸南部', 45),
    ], deps({ rank: name => order[name] ?? 99 }))
    expect(rows[0].regions.map(r => r.name)).toEqual(['岩手県内陸南部', '岩手県沿岸北部', '岩手県内陸北部'])
  })

  // 安全弁 4: 震度を読めなかった点（-1）は行にしない。
  it('震度が読めなかった点は行にしない', () => {
    const rows = buildIntensityRows([prefPoint('岩手県', -1), area('岩手県沿岸北部', -1)], deps())
    expect(rows).toEqual([])
  })
})
