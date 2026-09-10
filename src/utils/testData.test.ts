import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isEewArrivedKindCode, isEewPlumKindCode } from './eewKind'
import {
  createTestEarthquake,
  createTestEarthquakeCount,
  createTestEarthquakeCountRetraction,
  createTestEEW,
  createTestEEWAssumed,
  createTestEEWDeep,
  createTestEEWForecast,
  createTestEEWWarning,
  createTestForeignQuakeHuge,
  createTestLpgm,
  createTestTsunami,
  createTestTsunamiGradeChange,
  createTestTsunamiWarning,
  createTestTsunamiWatch,
  toP2pPref,
} from './testData'
import { eewAreas, eewMaxScale, eewNoForecastReason } from './eew'
import { isObservationMissing } from './tsunami'

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
    ['createTestEEW（特別警報・三陸沖）', createTestEEW(true)],
    ['createTestEEWWarning（警報・日向灘）', createTestEEWWarning(true)],
    ['createTestEEWForecast（予報・宮城県沖）', createTestEEWForecast(true)],
    // 単独点処理は初報に区域を持たない（区域が付くのは震源が確定した続報から）
    ['createTestEEWAssumed（単独点処理の続報・日向灘）', createTestEEWAssumed(true, undefined, 2)],
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
    // **欠測の観測点も同じ表を引く**（`missingMarkers`）ので対象に含める。含めないと、
    // 欠測のテストデータだけ名前を間違えても気づけない。
    // 観測点はバリアントに依存しない（差は eventId・validDateTime のみ）ので DMDSS 版で見る。
    const targets = (createTestTsunami(true).observations ?? []).filter(
      (o) => (o.height || isObservationMissing(o)) && !KNOWN_COORDLESS_OBSERVATIONS.has(o.name),
    )
    const names = targets.map((o) => o.name)
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((name) => !obsCoordNames.has(name))).toEqual([])
  })
})

// 情報名（`Head/Title`）と観測時点（`Head/TargetDateTime`）は **DMDATA の XML でしか来ない**。
// P2PQuake の JSON はどちらも持たないので、standard 版のテストボタンでこれらが入ると
// 「実運用では絶対に出ない表示」を実機で見せることになる（同じ形の穴が緊急地震速報の
// テストデータに既にある。docs/pending-work.md「テストデータを実電文の形へ見直す」）。
describe('テスト津波のヘッダ部（バリアント差）', () => {
  // 正: DMDSS 版では入る。**入らなければ実機で確かめる手段が無い**ので、まずここを固定する。
  it('DMDSS 版は情報名と観測時点を持つ', () => {
    const t = createTestTsunami(true)
    expect(t.infoName).toBe('大津波警報・津波警報・津波注意報')
    expect(t.observationDateTime).toBeTruthy()
    expect(createTestTsunamiWarning(true).infoName).toBe('津波警報・津波注意報')
    expect(createTestTsunamiWatch(true).infoName).toBe('津波注意報')
  })

  // 対照: standard 版には入らない。
  it('standard 版は情報名も観測時点も持たない', () => {
    const t = createTestTsunami(false)
    expect(t.infoName).toBeUndefined()
    expect(t.observationDateTime).toBeUndefined()
    expect(createTestTsunamiWarning(false).infoName).toBeUndefined()
    expect(createTestTsunamiWatch(false).infoName).toBeUndefined()
  })

  // 安全弁: 観測時点は**発表時刻より前**であること。同じ分だと表示側が意図どおり出さない
  // （「発表時刻と同じ分なら出さない」判定があるため、実機で見えないまま通ってしまう）。
  it('観測時点は発表時刻より前になっている', () => {
    const t = createTestTsunami(true)
    expect(Date.parse(t.observationDateTime!)).toBeLessThan(Date.parse(t.time))
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

  // 「気象庁以外の観測点」の印は DMDSS 版（DMDATA 経路）だけが持つ事実。
  // **P2PQuake はこの区別を配信しない**ので、標準版のテストボタンで出すと
  // 実電文には無いバッジが画面に出る。
  it('気象庁以外の印は DMDSS 版だけが持つ', () => {
    expect(createTestEarthquake(true).points.some((p) => p.nonJma)).toBe(true)
    expect(createTestEarthquake(false).points.some((p) => p.nonJma)).toBe(false)
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

// 上限を定めない予想（電文の `To="over"`）をテストボタンでも再現していること。
//
// **テストボタンはパーサーを通らない**（内部型を直接組み立てる）ので、ここに無いものは
// 実機で一度も確かめられない。実際に「程度以上」の表示・読み上げを足したときテストデータが
// 追随しておらず、画面で確認する手段が無かった。
describe('テスト EEW の上限を定めない予想', () => {
  it('初報は震度も長周期も「程度以上」で来る', () => {
    const first = createTestEEW(true, undefined, 1)
    expect(first.forecastMaxLpgmClassOver).toBe(true)
    const strongest = eewAreas(first).find((a) => a.name === '宮城県北部')!
    expect(strongest.scaleToOrAbove).toBe(true)
    expect(strongest.lgIntToOver).toBe(true)
  })

  // 対照: 続報では確定し、値も上がる（言い直しと引き上げの経路を通す）
  it('続報では確定した値になる', () => {
    const next = createTestEEW(true, undefined, 2)
    expect(next.forecastMaxLpgmClassOver).toBeUndefined()
    expect(next.forecastMaxLpgmClass).toBe(4)
    const strongest = eewAreas(next).find((a) => a.name === '宮城県北部')!
    expect(strongest.scaleToOrAbove).toBeUndefined()
    expect(strongest.lgIntTo).toBe(4)
  })
})

// EEW の kindCode は気象庁コード表12（緊急地震速報種別）: 00/01/09 が予報、10/11/19 が警報。
// 警報は予想震度5弱（scaleTo 45）以上の区域に発表されるため、震度4以下の区域に警報コードが
// 付いていると「予報なのに警報表示」という実運用では起こらない状態になる。
describe('テスト EEW の kindCode と予想震度の整合', () => {
  const WARNING_CODES = new Set(['10', '11', '19'])
  const cases = [
    ['createTestEEW（特別警報・三陸沖）', createTestEEW(true)],
    ['createTestEEWWarning（警報・日向灘）', createTestEEWWarning(true)],
    ['createTestEEWForecast（予報・宮城県沖）', createTestEEWForecast(true)],
    // 単独点処理は初報に区域を持たない（区域が付くのは震源が確定した続報から）
    ['createTestEEWAssumed（単独点処理の続報・日向灘）', createTestEEWAssumed(true, undefined, 2)],
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
    const forecast = createTestEEWForecast(true)
    expect(forecast.severity).not.toBe('Warning')
    expect(eewAreas(forecast).some((a) => WARNING_CODES.has(a.kindCode))).toBe(false)
  })

  // 種別コードの下 1 桁が主要動の状況（コード表 12。→ `utils/eewKind.ts`）。
  // 01/11 ＝既に到達と推定。**到達予測時刻とは排他**で、時刻の代わりに区域の `Condition` が出る
  // （電文解説資料 Ⅱ.21 2-1-5-3-6・2-1-5-3-7）。読み取り後の値は `arrived`。
  //
  // **テストデータは DMDATA の形**（種別コードと `Condition` の両方を持つ）で作る。P2PQuake は
  // 種別コードしか配信しないが、その経路で到達済みと判定できることは `isEewAreaArrived` の
  // テスト（`eew.test.ts`）が担保する。
  it.each(cases)('%s: 既到達コードの区域は到達予想時刻を持たず、到達済みの印を持つ', (_label, eew) => {
    for (const area of eewAreas(eew)) {
      if (isEewArrivedKindCode(area.kindCode)) {
        expect(area.arrivalTime).toBeNull()
        expect(area.arrived).toBe(true)
      }
    }
  })

  // 09/19（PLUM 法）は**上と違って時刻を持つ**。ただし中身は到達の予測ではなく
  // 「その震度を初めて予測した時刻」（同 2-1-5-3-6）で、**過去の時刻**が入る。
  //
  // かつてここは 09/19 も「時刻を持たない」と固定していたが、実電文と食い違っていた
  // （`src/services/p2pquake.test.ts` の `REAL_EEW`＝2026-07-29 熊本は、震源が確定した報で
  // 2 区域とも種別コード 19 かつ到達予測時刻を持つ）。画面は時刻を出さず語で伝える。
  it.each(cases)('%s: PLUM 法の区域は到達済みにしない', (_label, eew) => {
    for (const area of eewAreas(eew)) {
      if (isEewPlumKindCode(area.kindCode)) {
        expect(area.arrived).toBeUndefined()
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
    const first = createTestEEWAssumed(true, 'evt', 1, base)
    expect(first.earthquake.condition).toBe('仮定震源要素')
    expect(eewAreas(first)).toEqual([])
    expect(eewMaxScale(first)).toBe(0)
    expect(eewNoForecastReason(first)).toBe('assumed')
  })

  it('単独点処理の続報は震源が確定し、警報へ格上げされる', () => {
    const second = createTestEEWAssumed(true, 'evt', 2, base)
    expect(second.earthquake.condition).not.toBe('仮定震源要素')
    expect(second.severity).toBe('Warning')
    expect(eewMaxScale(second)).toBe(50)
  })

  // 名前が変わって 50km 超動くと「震源を更新、〇〇で地震。」の経路に入り、確かめたい格上げの
  // 伝え方（「緊急地震速報に切り替わりました。」／警報としての言い直し）がどちらも出てこなくなる。
  // 震源更新は区分に触れず、割り込みもしないため（audio-tts-spec.md §6「予報から警報へ上がったとき」）。
  it('単独点処理は報をまたいで震源名を変えない', () => {
    expect(createTestEEWAssumed(true, 'evt', 2, base).earthquake.hypocenter.name)
      .toBe(createTestEEWAssumed(true, 'evt', 1, base).earthquake.hypocenter.name)
  })

  // 実運用の続報は震源時刻を変えない（発表時刻だけが進む）。
  it('単独点処理の続報は震源時刻を引き継ぐ', () => {
    expect(createTestEEWAssumed(true, 'evt', 2, base).earthquake.originTime)
      .toBe(createTestEEWAssumed(true, 'evt', 1, base).earthquake.originTime)
  })

  // 気象庁は深さ 150km を超える地震に緊急地震速報（警報）を発表しない。続報でも予報級のまま。
  it('深発地震は深さ 150km 超・区域なしで、どの報も予報級', () => {
    for (const serial of [1, 2, 3]) {
      const eew = createTestEEWDeep(true, 'evt', serial, base)
      expect(eew.earthquake.hypocenter.depth).toBeGreaterThan(150)
      expect(eewAreas(eew)).toEqual([])
      expect(eew.severity).toBe('Forecast')
      expect(eewNoForecastReason(eew)).toBe('deep')
    }
  })
})

// ── バリアント差: standard 版が P2PQuake 経路では作れない形を持たないこと ──
//
// **表示コンポーネントはバリアントを見ない**（`isDmdss` の参照が 0 件）。データに在るものは
// そのまま描かれるので、テストデータが実データより豊かだと「実機では決して起きない絵」が
// テストボタンからだけ出る。実測（実 P2PQuake データと `p2pquake.ts` のリテラル）で
// 突き合わせたところ、津波で 54 経路・EEW で 16 経路がその状態だった。

describe('テスト津波のバリアント差（P2PQuake 経路に無い項目）', () => {
  // 正: standard 版は P2PQuake の `parseTsunami` が作れる形に収まる。
  it('standard 版は観測点・沖合推定・原因地震・本文・付加文を持たない', () => {
    const t = createTestTsunami(false)
    expect(t.observations).toBeUndefined()
    expect(t.estimations).toBeUndefined()
    expect(t.sourceEarthquakes).toBeUndefined()
    expect(t.bodyText).toBeUndefined()
    expect(t.freeText).toBeUndefined()
    expect(t.warningComment).toBeUndefined()
    for (const a of t.areas) {
      expect(a.code).toBeUndefined()
      expect(a.stations).toBeUndefined()
      expect(a.forecastHeightImportant).toBeUndefined()
      expect(a.lastGrade).toBeUndefined()
    }
  })

  // 対照: DMDSS 版には入る。**入らなければ実機で確かめる手段が無い。**
  it('DMDSS 版は同じ項目を持つ', () => {
    const t = createTestTsunami(true)
    expect(t.observations?.length).toBeGreaterThan(0)
    expect(t.estimations?.length).toBeGreaterThan(0)
    expect(t.sourceEarthquakes?.length).toBeGreaterThan(0)
    expect(t.bodyText).toBeTruthy()
    expect(t.freeText).toBeTruthy()
    expect(t.warningComment).toBeTruthy()
    expect(t.areas.some(a => a.code)).toBe(true)
    expect(t.areas.some(a => (a.stations?.length ?? 0) > 0)).toBe(true)
    expect(t.areas.some(a => a.forecastHeightImportant)).toBe(true)
  })

  // 安全弁: **落としすぎていない**こと。P2PQuake も等級・区域名・到達予想・予想波高は配信する
  // ので、standard 版でもカードは中身のある形で出る。ここが空になると、削り過ぎに気づけない。
  it('standard 版でも区域の等級・名前・予想波高は残る', () => {
    const t = createTestTsunami(false)
    expect(t.areas.length).toBe(createTestTsunami(true).areas.length)
    expect(t.areas.every(a => a.grade && a.name)).toBe(true)
    expect(t.areas.some(a => a.maxHeight?.description)).toBe(true)
    expect(t.areas.some(a => a.firstHeight?.arrivalTime)).toBe(true)
    expect(t.areas.some(a => a.firstHeight?.condition)).toBe(true)
  })
})

describe('テスト EEW のバリアント差（P2PQuake / Yahoo 経路に無い項目）', () => {
  // standard 版の EEW は 2 経路の合成。Yahoo hypoInfo が土台で、P2PQuake code=556 が区域と
  // 震源要素を注ぎ足す（`useEarthquakes.ts` の `enrichEEW`）。どちらも運ばない欄がこれら。
  const standardFactories = [
    ['createTestEEW（特別警報）', createTestEEW(false, 'e', 2)],
    ['createTestEEWWarning（警報）', createTestEEWWarning(false, 'e', 2)],
    ['createTestEEWForecast（予報）', createTestEEWForecast(false, 'e', 1)],
    ['createTestEEWAssumed（単独点処理の続報）', createTestEEWAssumed(false, 'e', 2)],
    ['createTestEEWDeep（深発）', createTestEEWDeep(false, 'e', 1)],
  ] as const

  // 正: standard 版は DMDATA 限定の欄を持たない。
  it.each(standardFactories)('%s: 精度・内陸海域・短縮名・付加文・変化・長周期を持たない', (_label, eew) => {
    expect(eew.accuracy).toBeUndefined()
    expect(eew.landOrSea).toBeUndefined()
    expect(eew.reduceName).toBeUndefined()
    expect(eew.warningComment).toBeUndefined()
    expect(eew.forecastChange).toBeUndefined()
    expect(eew.forecastMaxLpgmClass).toBeUndefined()
    expect(eew.forecastMaxLpgmClassOver).toBeUndefined()
    for (const a of eewAreas(eew)) {
      expect(a.lgIntTo).toBeUndefined()
      expect(a.lgIntToOver).toBeUndefined()
      expect(a.arrived).toBeUndefined()
    }
  })

  // 対照: DMDSS 版には入る。
  it('DMDSS 版は精度・内陸海域・短縮名・付加文・変化・長周期を持つ', () => {
    const warn = createTestEEWWarning(true, 'e', 2)
    expect(warn.accuracy).toBeTruthy()
    expect(warn.landOrSea).toBeTruthy()
    expect(warn.reduceName).toBeTruthy()
    expect(warn.warningComment).toBeTruthy()
    expect(warn.forecastChange).toBeTruthy()
    expect(warn.forecastMaxLpgmClass).toBe(3)
    expect(eewAreas(warn).some(a => a.lgIntTo !== undefined)).toBe(true)
    expect(eewAreas(createTestEEW(true, 'e', 1)).some(a => a.arrived)).toBe(true)
  })

  // 安全弁: 落としすぎていないこと。P2PQuake は区域の予想震度・種別コード・到達予想を配信する。
  it('standard 版でも区域の予想震度・種別コード・到達予想は残る', () => {
    const eew = createTestEEW(false, 'e', 2)
    const areas = eewAreas(eew)
    expect(areas.length).toBe(eewAreas(createTestEEW(true, 'e', 2)).length)
    expect(areas.every(a => a.name && a.kindCode)).toBe(true)
    expect(areas.every(a => typeof a.scaleTo === 'number')).toBe(true)
    expect(areas.some(a => a.arrivalTime)).toBe(true)
  })

  // P2PQuake は県名を付けずに配信する（実データの `pref` は「茨城」「千葉」）。
  // この値は EEW カードの「対象」欄へそのまま出るので、揃えないと standard 版だけ画面が変わる。
  it('standard 版の区域の都道府県名には「県」が付かない', () => {
    for (const a of eewAreas(createTestEEW(false, 'e', 2))) {
      expect(a.pref).not.toMatch(/[都府県]$/)
    }
    // 対照: DMDSS 版のテストデータは県名付きの `pref` を最初から持たせてある
    // （実運用では `enrichEEWPref` が区域名から逆引きして補う欄で、電文自体は空で来る。
    //  そちらの逆引きはこのテストでは通らない —— 空でなければ補完の分岐に入らないため）
    expect(eewAreas(createTestEEW(true, 'e', 2)).every(a => /[都道府県]$/.test(a.pref))).toBe(true)
  })

  // 「道」を落とさないこと。**実データで確認できているのは「茨城」「千葉」の 2 例だけ**で、
  // 北海道の区域を含む報が標本に無い（→ `toP2pPref` のコメント）。推測で削らないと決めた判断を
  // ここで固定する —— フィクスチャに北海道の区域が無く、ファクトリ越しでは確かめられない。
  it('都府県だけを落とし、北海道の「道」は残す', () => {
    expect(toP2pPref('茨城県')).toBe('茨城')
    expect(toP2pPref('東京都')).toBe('東京')
    expect(toP2pPref('京都府')).toBe('京都')
    expect(toP2pPref('北海道')).toBe('北海道')
  })

  // standard 版の初報は Yahoo hypoInfo だけが届いた状態（区域は P2PQuake が後から注ぐ）。
  // **区域が無い報で予想震度を伝える経路はここでしか通らない** —— `eewMaxScale` は区域が
  // あればそちらを優先するため。
  it('standard 版の初報は区域を持たず、最大予測震度だけで伝える', () => {
    const first = createTestEEW(false, 'e', 1)
    expect(eewAreas(first)).toEqual([])
    expect(first.forecastMaxScale).toBe(60)
    expect(eewMaxScale(first)).toBe(60)
    // 対照: 続報では区域が付く（注入後の形）
    expect(eewAreas(createTestEEW(false, 'e', 2)).length).toBeGreaterThan(0)
  })

  // 「程度以上」を伝えられるのは DMDATA だけ。**P2PQuake は電文全体の最大予測震度そのものを
  // 配信せず**（区域ごとの `scaleTo: 99` は運ぶ）、Yahoo hypoInfo の `calcintensity` にも
  // 相当する表現が無い。standard 版で立てると実運用では出ない「6強程度以上」が画面に出る。
  it('電文全体の「程度以上」は DMDSS 版だけが持つ', () => {
    expect(createTestEEW(true, 'e', 1).forecastMaxScaleOrAbove).toBe(true)
    expect(createTestEEW(false, 'e', 1).forecastMaxScaleOrAbove).toBeUndefined()
    // 対照: 区域ごとの「程度以上」は P2PQuake も配信するので standard 版でも残る
    // （この報は区域を持たないので、確かめるのは続報の側）
    expect(createTestEEW(true, 'e', 1).forecastMaxScale).toBe(60)
    expect(createTestEEW(false, 'e', 1).forecastMaxScale).toBe(60)
  })

  // 遠地地震の「Ｍ８を超える巨大地震」は DMDATA 経路にしかない。P2PQuake は規模を数値でしか
  // 配信せず、「規模不明」と区別する手立てを持たない。
  it('standard 版の巨大地震テストは規模の説明を持たない', () => {
    expect(createTestForeignQuakeHuge(false).earthquake.hypocenter.magnitudeCondition).toBeUndefined()
    expect(createTestForeignQuakeHuge(true).earthquake.hypocenter.magnitudeCondition).toBe('Ｍ８を超える巨大地震')
  })
})

// 震源要素の補足情報（電文の `Condition`）の値域は「仮定震源要素」の 1 つだけで、該当しなければ
// 要素ごと出ない（電文解説資料 Ⅱ.21 1-2。実電文 26 通の実測でも `''` と「仮定震源要素」の 2 つ）。
// かつて `'以上'` という電文に存在しない値を入れていた。判定は `=== '仮定震源要素'` しか
// 見ていないため挙動には出ず、値域の突き合わせでしか見つからない。
describe('テスト EEW の震源要素の補足情報', () => {
  const ALLOWED = new Set(['', '仮定震源要素'])

  it.each([
    ['createTestEEW', createTestEEW(true, 'e', 1)],
    ['createTestEEWWarning', createTestEEWWarning(true, 'e', 1)],
    ['createTestEEWForecast', createTestEEWForecast(true, 'e', 1)],
    ['createTestEEWAssumed（初報）', createTestEEWAssumed(true, 'e', 1)],
    ['createTestEEWAssumed（続報）', createTestEEWAssumed(true, 'e', 2)],
    ['createTestEEWDeep', createTestEEWDeep(true, 'e', 1)],
  ] as const)('%s: 電文の値域に収まる', (_label, eew) => {
    expect(ALLOWED.has(eew.earthquake.condition ?? '')).toBe(true)
  })

  // 対照: 仮定震源要素の報だけがその語を持つ（空へ倒しすぎていないこと）。
  it('仮定震源要素の初報だけが語を持つ', () => {
    expect(createTestEEWAssumed(true, 'e', 1).earthquake.condition).toBe('仮定震源要素')
    expect(createTestEEWAssumed(true, 'e', 2).earthquake.condition).toBe('')
  })
})

// ── 実電文にあるのに、どのテストボタンにも無かった項目 ──
//
// **そこに無い形は実機で一度も画面に出ない。** 表示コードはあるのに確かめる手段が無い状態を
// 潰したもので、ここが崩れると同じ穴に戻る。

describe('実機で一度も出ていなかった項目', () => {
  it('訓練報は運用種別の印を持ち、通常のテストは持たない', () => {
    expect(createTestEarthquake(true, '訓練').operationStatus).toBe('訓練')
    expect(createTestEarthquake(true).operationStatus).toBeUndefined()
  })

  it('長周期の観測点に気象庁以外の印が 1 つある', () => {
    const points = createTestLpgm('20240101161000').points ?? []
    expect(points.filter(p => p.nonJma).length).toBe(1)
    // 安全弁: 全点に付けてしまっていないこと（印の意味が消える）
    expect(points.length).toBeGreaterThan(1)
  })

  it('第1波の到達時刻が読み取れない観測点がある（欠測とは別物）', () => {
    const obs = createTestTsunami(true).observations ?? []
    const unidentifiable = obs.filter(o => o.condition?.firstWaveUnidentifiable)
    expect(unidentifiable.length).toBe(1)
    // 到達そのものは確定しているので波高は持ち、時刻だけが無い
    expect(unidentifiable[0].height?.value).toBeGreaterThan(0)
    expect(unidentifiable[0].arrivalTime).toBeUndefined()
    // 対照: 欠測（値が取れない）とは別の状態
    expect(unidentifiable[0].condition?.firstHeightMissing).toBeUndefined()
  })

  it('地震回数の取消は回数の表を持たず、理由だけを運ぶ', () => {
    const base = createTestEarthquakeCount()
    const cancel = createTestEarthquakeCountRetraction(base)
    expect(cancel.cancelled).toBe(true)
    expect(cancel.cancelText).toBeTruthy()
    expect(cancel.items).toEqual([])
    // 照合は eventId（`applyEarthquakeCount`）。ずれると帯が消えない
    expect(cancel.eventId).toBe(base.eventId)
    // 対照: 発表報は表を持つ
    expect(base.items.length).toBeGreaterThan(0)
    expect(base.cancelText).toBeUndefined()
  })
})

describe('津波の続報で区域ごとに等級が動く報', () => {
  // 正: 動いた区域は前回の等級を持つ。
  it('降格・引き上げ・予報への降格の 4 通りが入る', () => {
    const base = createTestTsunami(true)
    const next = createTestTsunamiGradeChange(base)
    const by = (name: string) => next.areas.find(a => a.name === name)!
    expect(by('岩手県')).toMatchObject({ grade: 'Warning', lastGrade: 'MajorWarning' })
    expect(by('福島県')).toMatchObject({ grade: 'Warning', lastGrade: 'MajorWarning' })
    expect(by('青森県太平洋沿岸')).toMatchObject({ grade: 'Watch', lastGrade: 'Warning' })
    expect(by('茨城県')).toMatchObject({ grade: 'MajorWarning', lastGrade: 'Warning' })
    expect(by('北海道太平洋沿岸東部')).toMatchObject({ grade: 'Forecast', lastGrade: 'Watch' })
  })

  // 対照: 動いていない区域には印を付けない（付けると全区域に「切り替え」が出る）。
  it('据え置きの区域は前回の等級を持たない', () => {
    const next = createTestTsunamiGradeChange(createTestTsunami(true))
    const miyagi = next.areas.find(a => a.name === '宮城県')!
    expect(miyagi.grade).toBe('MajorWarning')
    expect(miyagi.lastGrade).toBeUndefined()
  })

  // 安全弁: 全体の最上位等級は動かない。**ここが動くとテストの意味が消える** —— 区域単位の
  // 変化を見る経路は「全体では変化なし」のときにしか必要にならない。
  it('全体の最上位等級は大津波警報のまま', () => {
    const next = createTestTsunamiGradeChange(createTestTsunami(true))
    expect(next.areas.some(a => a.grade === 'MajorWarning')).toBe(true)
    // 降格した区域の予想波高も下がっていること（等級と高さが食い違わない）
    expect(next.areas.find(a => a.name === '岩手県')!.maxHeight?.description).toBe('3m')
    expect(next.areas.find(a => a.name === '北海道太平洋沿岸東部')!.maxHeight).toBeUndefined()
  })

  // 続報なので同じ地震を指す（`eventId` が変わると別の津波として立つ）。
  it('続報は元の報と同じ eventId で、発表時刻だけが進む', () => {
    const base = createTestTsunami(true)
    const next = createTestTsunamiGradeChange(base)
    expect(next.eventId).toBe(base.eventId)
    expect(next.id).not.toBe(base.id)
    expect(new Date(next.time).getTime()).toBeGreaterThanOrEqual(new Date(base.time).getTime())
  })
})
