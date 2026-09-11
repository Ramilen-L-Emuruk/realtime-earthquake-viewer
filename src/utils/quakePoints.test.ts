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
    ], [], deps())
    expect(rows).toHaveLength(1)
    expect(rows[0].pref).toBe('岩手県')
    expect(rows[0].scale).toBe(40)
    expect(rows[0].regions.map(r => r.name)).toEqual(['岩手県沿岸北部', '岩手県内陸北部'])
  })

  // 正: 区域の点を持たない電文（P2PQuake の詳細報）では観測点から逆引きする。
  it('区域の点が無ければ観測点の所属区域から作る', () => {
    const rows = buildIntensityRows(
      [{ pref: '岩手県', addr: '宮古市田老', isArea: false, scale: s(40) }],
      [],
      deps({ prefOfStation: () => '岩手県', regionOfStation: () => '岩手県沿岸北部' }),
    )
    expect(rows[0].regions.map(r => r.name)).toEqual(['岩手県沿岸北部'])
  })

  // 対照: 区域の点があるときは、**区域の行を観測点から作らない**（電文が示した粒度を優先する）。
  // 観測点は行の材料にはならないが、その区域の下へはぶら下がる。
  it('区域の点があれば、区域の行は観測点から作らない', () => {
    const rows = buildIntensityRows([
      area('岩手県沿岸北部', 40),
      { pref: '岩手県', addr: '宮古市田老', isArea: false, scale: s(40) },
    ], [], deps({ regionOfStation: () => '岩手県沿岸北部' }))
    // 観測点の所属区域が別の名前でも、行は電文の区域点だけから作る。
    expect(rows[0].regions.map(r => r.name)).toEqual(['岩手県沿岸北部'])
    // その観測点は、所属区域の下にぶら下がる。
    expect(rows[0].regions[0].stations.map(x => x.name)).toEqual(['宮古市田老'])
  })

  // 正: 市町村を持つ電文（DMDATA）では、区域 → 市町村 → 観測点の 3 段になる。
  // 観測点は所属する区域と市町村の両方を名乗る（パーサーが電文の並びから両方を付ける）。
  it('市町村を区域の下に、観測点を市町村の下に置く', () => {
    const rows = buildIntensityRows([
      area('岩手県沿岸北部', 40),
      { pref: '', addr: '普代村銅屋', isArea: false, scale: s(30), city: '普代村', area: '岩手県沿岸北部' },
    ], [
      { name: '普代村', area: '岩手県沿岸北部', pref: '岩手県', scale: s(30) },
    ], deps())
    const region = rows[0].regions[0]
    expect(region.cities.map(c => c.name)).toEqual(['普代村'])
    expect(region.cities[0].stations.map(x => x.name)).toEqual(['普代村銅屋'])
    // 市町村へ紐付いた観測点は、区域直下には出さない（二重に並べない）。
    expect(region.stations).toEqual([])
  })

  // 安全弁: 市町村を持たない経路（P2PQuake）では、観測点が区域の直下に入る。
  it('市町村を持たない観測点は区域の直下に置く', () => {
    const rows = buildIntensityRows([
      area('岩手県沿岸北部', 40),
      { pref: '岩手県', addr: '宮古市田老', isArea: false, scale: s(40) },
    ], [], deps({ regionOfStation: () => '岩手県沿岸北部' }))
    expect(rows[0].regions[0].cities).toEqual([])
    expect(rows[0].regions[0].stations.map(x => x.name)).toEqual(['宮古市田老'])
  })

  // 安全弁 1: 県の点が無くても、区域だけが届いた県を落とさない。
  it('区域しか無い県も行にする（県の値は配下の最大）', () => {
    const rows = buildIntensityRows([
      area('岩手県沿岸北部', 30),
      area('岩手県内陸北部', 45),
    ], [], deps())
    expect(rows[0].pref).toBe('岩手県')
    expect(rows[0].scale).toBe(45)
  })

  // 安全弁 2: 「未入電あり」は**範囲に 1 点でもあれば**付く。行の最大が観測値でも消さない。
  it('最大が観測値でも、範囲に未入電があれば印を付ける', () => {
    const rows = buildIntensityRows([
      prefPoint('岩手県', 40),
      area('岩手県沿岸北部', 40),
    ], [], deps({
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
    ], [], deps({ rank: name => order[name] ?? 99 }))
    expect(rows[0].regions.map(r => r.name)).toEqual(['岩手県内陸南部', '岩手県沿岸北部', '岩手県内陸北部'])
  })

  // 安全弁 4: 震度を読めなかった点（-1）は行にしない。
  it('震度が読めなかった点は行にしない', () => {
    const rows = buildIntensityRows([prefPoint('岩手県', -1), area('岩手県沿岸北部', -1)], [], deps())
    expect(rows).toEqual([])
  })

  // 正: **同名の市町村を取り違えない。** 市町村名は全国で一意ではない（府中市＝東京都・広島県）。
  // 名前だけで観測点を束ねていたときは、両方が載った電文でどちらの行にも他県の観測点が並んだ。
  it('同名の市町村があっても、観測点をそれぞれの県の側へ入れる', () => {
    const rows = buildIntensityRows([
      area('東京都２３区', 30),
      area('広島県南西部', 30),
      { pref: '', addr: '府中市宮西町', isArea: false, scale: s(30), city: '府中市', area: '東京都２３区' },
      { pref: '', addr: '府中市府川町', isArea: false, scale: s(30), city: '府中市', area: '広島県南西部' },
    ], [
      { name: '府中市', area: '東京都２３区', pref: '東京都', scale: s(30) },
      { name: '府中市', area: '広島県南西部', pref: '広島県', scale: s(30) },
    ], deps())
    const cityOf = (pref: string) =>
      rows.find(r => r.pref === pref)!.regions[0].cities[0]
    expect(cityOf('東京都').stations.map(x => x.name)).toEqual(['府中市宮西町'])
    expect(cityOf('広島県').stations.map(x => x.name)).toEqual(['府中市府川町'])
  })

  // 対照: 同名でない市町村は、当然そのまま自分の観測点だけを持つ（上の鍵の変更で
  // ふつうの電文が壊れていないこと）。
  it('同名でない市町村は従来どおり自分の観測点だけを持つ', () => {
    const rows = buildIntensityRows([
      area('岩手県沿岸北部', 40),
      { pref: '', addr: '普代村銅屋', isArea: false, scale: s(30), city: '普代村', area: '岩手県沿岸北部' },
      { pref: '', addr: '野田村野田', isArea: false, scale: s(30), city: '野田村', area: '岩手県沿岸北部' },
    ], [
      { name: '普代村', area: '岩手県沿岸北部', pref: '岩手県', scale: s(30) },
      { name: '野田村', area: '岩手県沿岸北部', pref: '岩手県', scale: s(30) },
    ], deps())
    const cities = rows[0].regions[0].cities
    expect(cities.find(c => c.name === '普代村')!.stations.map(x => x.name)).toEqual(['普代村銅屋'])
    expect(cities.find(c => c.name === '野田村')!.stations.map(x => x.name)).toEqual(['野田村野田'])
  })

  // 安全弁 5: **市町村の行を作れなくても観測点は捨てない。** 市町村の震度が読めなかった電文では
  // `cities` にその市町村が入らない。行き先が無いままにすると、読めていた観測点まで消える。
  it('市町村の行が無い観測点は、その区域の直下へ落とす', () => {
    const rows = buildIntensityRows([
      area('岩手県沿岸北部', 40),
      { pref: '', addr: '普代村銅屋', isArea: false, scale: s(30), city: '普代村', area: '岩手県沿岸北部' },
    ], [], deps())
    const region = rows[0].regions[0]
    expect(region.cities).toEqual([])
    expect(region.stations.map(x => x.name)).toEqual(['普代村銅屋'])
  })

  // 安全弁 6: **区域自身の震度が読めなくても、配下は出す。** この形の脱落は記録にも残らない
  // （区域の読み取り失敗は「その電文の区域が全滅したとき」しか記録しない）。
  it('区域の点が無くても、市町村と観測点があれば区域の行を立てる', () => {
    const rows = buildIntensityRows([
      prefPoint('岩手県', 40),
      { pref: '', addr: '普代村銅屋', isArea: false, scale: s(30), city: '普代村', area: '岩手県沿岸北部' },
    ], [
      { name: '普代村', area: '岩手県沿岸北部', pref: '岩手県', scale: s(30) },
    ], deps())
    const region = rows[0].regions[0]
    expect(region.name).toBe('岩手県沿岸北部')
    // 区域の値は配下の最大で代用する。
    expect(region.scale).toBe(30)
    expect(region.cities[0].stations.map(x => x.name)).toEqual(['普代村銅屋'])
  })

  // 正: **観測点の区域は、電文が言っているものが座標表より強い。** 逆引きは座標表の命名や
  // 収録状況に左右されるが、電文はその観測点をその区域の下に置いた事実そのもの。
  // 印（「未入電あり」）の側と優先順位を手で揃えていた頃は、ここがずれても誰も気づけなかった。
  it('観測点の区域は、座標表の逆引きより電文の区域を優先する', () => {
    const rows = buildIntensityRows([
      area('岩手県沿岸北部', 40),
      area('岩手県内陸北部', 30),
      { pref: '', addr: '宮古市田老', isArea: false, scale: s(40), area: '岩手県沿岸北部' },
    ], [], deps({
      // 座標表はわざと別の区域を返す。電文の側が勝つこと。
      prefOfStation: () => '岩手県',
      regionOfStation: () => '岩手県内陸北部',
    }))
    const regions = rows[0].regions
    expect(regions.find(r => r.name === '岩手県沿岸北部')!.stations.map(x => x.name)).toEqual(['宮古市田老'])
    expect(regions.find(r => r.name === '岩手県内陸北部')!.stations).toEqual([])
  })

  // 正: **区域から県への引き当ては、まず電文自身に訊く。** `City` は所属する区域と都道府県の
  // 両方を名乗る。座標表の読み込み前・取得失敗でも区域から下が消えないこと。
  it('座標表を引けなくても、電文の市町村から区域の所属県を決める', () => {
    const rows = buildIntensityRows([
      area('岩手県沿岸北部', 40),
    ], [
      { name: '普代村', area: '岩手県沿岸北部', pref: '岩手県', scale: s(30) },
    ], deps({ prefOfArea: () => null }))
    expect(rows.map(r => r.pref)).toEqual(['岩手県'])
    expect(rows[0].regions.map(r => r.name)).toEqual(['岩手県沿岸北部'])
  })

  // 市町村の未入電は 2 つの形がある（→ docs/spec/quake-spec.md §5）。実電文ではほとんど
  // 出ないためテストボタンのデータには入っていない。ロジックだけはここで固定する。
  it('市町村の未入電を 2 つの形のまま行へ移す', () => {
    const rows = buildIntensityRows([
      area('石川県能登', 45),
    ], [
      // 値なし＋未入電＝市町村の値そのものが入電なし
      { name: '珠洲市', area: '石川県能登', pref: '石川県', scale: s(45), unreceived: true },
      // 値あり＋配下に未入電＝観測できた震度は 4、ただし配下に届いていない地点がある
      { name: '能登町', area: '石川県能登', pref: '石川県', scale: s(40), hasUnreceived: true },
    ], deps())
    const cities = rows[0].regions[0].cities
    expect(cities.find(c => c.name === '珠洲市')).toMatchObject({ scale: 45, unreceived: true, hasUnreceived: false })
    expect(cities.find(c => c.name === '能登町')).toMatchObject({ scale: 40, unreceived: false, hasUnreceived: true })
  })
})
