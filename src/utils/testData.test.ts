import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { isEewArrivedKindCode, isEewPlumKindCode } from './eewKind'
import { mergeQuakeInto, mergeQuakeHistory } from './quakeMerge'
import type { JMAQuake } from '../types/earthquake'
import { reportsText } from '../test-utils/quakeReports'
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
  createTestQuakeAmendment,
  createTestQuakeReportSequence,
  createTestTsunami,
  createTestTsunamiForecast,
  createTestTsunamiGradeChange,
  createTestTsunamiWarning,
  createTestTsunamiWatch,
  createTestUnreceivedQuake,
  toEventIdTimestamp,
  toP2pPref,
} from './testData'
import notoHonshinQuake from '../data/noto-honshin-2024-quake.json'
import { extractQuakeEventId } from './quakeMerge'
import { eewAreas, eewMaxScale, eewNoForecastReason, isEewAreaArrived } from './eew'
import { extractQuakeEventIdFromId } from './quakeMerge'
import { isObservationMissing, matchesArea } from './tsunami'

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
// **下の 2 つの検査が共有する。** 観測情報（`observations`）と予想区域の中（`areas[].stations`）の
// どちらへ架空値を足す場合もここへ書く。片方だけが例外を持つ形にすると、足した側で理由の分からない
// 失敗が出る。
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

  // **予想区域の中の観測点も実在する名前にする。** こちらは満潮時刻・津波到達予想時刻を出す行。
  // 観測情報の側だけを見ていたため、ここに実在しない名前（「気仙沼」「小名浜」「八戸」
  // 「むつ関根浜」）が長く残っていた。
  //
  // **理由は「電文に現れる名前を再現する」こと自体**で、座標表を引く機能があるからではない。
  // この行が押せるのは観測情報の側に同名のエントリがあってマージされたときだけで（→
  // docs/spec/tsunami-spec.md §9「観測点の行・区域名をクリックしたときの寄り先」）、一致しない行は
  // 予測だけを出す非クリック行になる。それでも座標表と突き合わせるのは、**実在しない名前を
  // 機械的に弾ける物差しがこれしか無い**ため（コードは座標表が持たないので照合できない）。
  //
  // **DMDSS 版だけを見るのは、standard 版がこの欄を持たないから**（`toP2pTsunamiArea` が
  // `stations` を引き継がない）。観測情報の側の「バリアントに依存しない」とは理由が違う。
  it('予想区域の観測点の名前がすべて実在する（座標を持たせていない既知の例外を除く）', () => {
    const names = (createTestTsunami(true).areas ?? [])
      .flatMap((a) => (a.stations ?? []).map((st) => st.name))
      .filter((name) => !KNOWN_COORDLESS_OBSERVATIONS.has(name))
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((name) => !obsCoordNames.has(name))).toEqual([])
  })
})

// 情報名（`Head/Title`）と観測時点（`Head/TargetDateTime`）は **DMDATA の XML でしか来ない**。
// P2PQuake の JSON はどちらも持たないので、standard 版のテストボタンでこれらが入ると
// 「実運用では絶対に出ない表示」を実機で見せることになる（同じ形の穴が緊急地震速報の
// テストデータにもあり、そちらも同じときに塞いだ）。
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
  // **P2PQuake はこの区別を配信しない**ので、標準版のテストボタンで残すと
  // 表示側（`withNonJmaMark`）が実電文には無い `＊` を観測点名へ付ける。
  it('気象庁以外の印は DMDSS 版だけが持つ', () => {
    expect(createTestEarthquake(true).points.some((p) => p.nonJma)).toBe(true)
    expect(createTestEarthquake(false).points.some((p) => p.nonJma)).toBe(false)
  })

  // 固定付加文（その他）。`＊` の説明はカードに枠付きで出るが、渡さないと実機で一度も出ない。
  // 正・対照・安全弁の 3 種で固定する（→ CLAUDE.md「検証」）。
  it('固定付加文（その他）は DMDSS 版だけが `＊` の説明を持つ', () => {
    expect(createTestEarthquake(true).varCommentText).toContain('＊印は気象庁以外の震度観測点')
    expect(createTestEarthquake(false).varCommentText).toBeUndefined()
  })

  // 元にした実電文（報番号 2）は「震源要素を訂正します。」（コード 0256）も持っている。
  // **落とさないこと** —— 気象庁はこの一文を `InfoType` が「訂正」の報ではなく発表報に付けており、
  // `issue.correct` は `'なし'` のまま（実電文の形。→ testData.ts の `NOTO_HONSHIN_VAR_COMMENT_TEXT`）。
  it('固定付加文（その他）は実電文どおり 2 文とも持つ（訂正の印は付かない）', () => {
    const quake = createTestEarthquake(true)
    expect(quake.varCommentText).toContain('震源要素を訂正します。')
    expect(quake.issue.correct).toBe('なし')
  })

  // 安全弁: 元データが 2 文とも持っていることまで確かめないと、上のテストは
  // 「たまたま同じ一文を別の場所で足していた」場合も通ってしまう。
  it('元データは 2 文とも持っている', () => {
    expect(notoHonshinQuake.varCommentText).toContain('震源要素を訂正します。')
    expect(notoHonshinQuake.varCommentText).toContain('＊印は気象庁以外の震度観測点')
  })

  /** バリアントごとに同じ検査を当てるための組。 */
  const QUAKE_VARIANTS = [
    { useDmdataShape: true, label: 'DMDSS' },
    { useDmdataShape: false, label: 'standard' },
  ] as const

  // 種別遷移テスト。**受け取った種別を並べた見出しを実機で確かめられる唯一の入口**なので、
  // 実電文の形（震度速報は震源を持たない・報番号は震源・震度情報だけ・鍵は報ごとに違う）を
  // 固定する（→ docs/spec/quake-spec.md §8「見出しには受け取った種別を並べる」）。
  describe('種別遷移テスト', () => {
    // 正: 能登の前震と同じ順序で 4 通を返す。
    it('震度速報 → 震源情報 → 震度速報 → 震源・震度情報 の順に 4 通を返す', () => {
      expect(createTestQuakeReportSequence(true).map(q => q.issue.type))
        .toEqual(['震度速報', '震源情報', '震度速報', '震源・震度情報'])
      // standard 版は同じ内容の種別名が違う（P2PQuake の DetailScale）。
      expect(createTestQuakeReportSequence(false).map(q => q.issue.type))
        .toEqual(['震度速報', '震源情報', '震度速報', '各地の震度情報'])
    })

    // 正: 見出しが「震度速報#2/震源情報」→「震源・震度情報」と動くこと。**この関数の目的そのもの**。
    it('統合すると見出しが「震度速報#2/震源情報」を経て「震源・震度情報」になる', () => {
      const reports = createTestQuakeReportSequence(true)
      const headlineAfter = (count: number): string => {
        let card: JMAQuake | undefined
        for (const report of reports.slice(0, count)) card = mergeQuakeInto(card, report)
        return reportsText(card!.reports, card!.issue.type)
      }
      expect(headlineAfter(1)).toBe('震度速報')
      expect(headlineAfter(2)).toBe('震度速報/震源情報')
      expect(headlineAfter(3)).toBe('震度速報#2/震源情報')
      expect(headlineAfter(4)).toBe('震源・震度情報')
    })

    // 安全弁: 鍵が報ごとに違うこと。**`id` は 4 通とも同じ**（`Head/Serial` が空の種別があるため）
    // なので、鍵を持たせないと 2 通目の震度速報が「同じ電文の再送」と見なされて数えられない。
    it('一意鍵は報ごとに違い、id は 4 通とも同じ（実電文の形）', () => {
      const reports = createTestQuakeReportSequence(true)
      expect(new Set(reports.map(q => q.telegramKey)).size).toBe(4)
      expect(new Set(reports.map(q => q.id)).size).toBe(1)
      expect(reports[0].id.endsWith('-1')).toBe(true)
    })

    // 安全弁: 報番号を持つのは震源・震度情報だけ（実電文で連番を振るのはこの種別に限る）。
    it('報番号を持つのは震源・震度情報だけ', () => {
      expect(createTestQuakeReportSequence(true).map(q => q.reportSerial))
        .toEqual([undefined, undefined, undefined, 1])
    })

    // 対照: 震度速報は震源を持たず、震源情報は震度を持たない（種別ごとに構造が違う）。
    //
    // **両バリアントで見る。** 震度速報が持つ区域の点は `createTestEarthquake` の結果からは
    // 採れない（standard 版は区域速報と観測点を別電文で送るため落としてある）。DMDSS 版だけを
    // 見ていると、standard 版が震度ゼロの震度速報を作っていても気づけない。
    it.each(QUAKE_VARIANTS)('震度速報は震源を持たず、震源情報は震度を持たない（$label 版）', ({ useDmdataShape }) => {
      const [prompt1, destination, prompt2, detail] = createTestQuakeReportSequence(useDmdataShape)
      for (const prompt of [prompt1, prompt2]) {
        expect(prompt.earthquake.hypocenter.name).toBe('')
        expect(prompt.earthquake.hypocenter.latitude).toBe(-200)
        expect(Number.isNaN(prompt.earthquake.hypocenter.magnitude)).toBe(true)
        // 震度速報が持つのは区域と都道府県の点だけ。**空にならないこと**が肝心。
        expect(prompt.points.every(p => p.isArea)).toBe(true)
        expect(prompt.points.length).toBeGreaterThan(0)
        // 点があるなら最大震度も立つ（震度不明のまま「震度速報」を名乗らせない）。
        expect(prompt.earthquake.maxScale).toBeGreaterThan(0)
      }
      expect(destination.earthquake.hypocenter.name).not.toBe('')
      expect(destination.earthquake.maxScale).toBe(-1)
      expect(destination.points).toEqual([])
      // 対の確認: 観測点が届くのは震源・震度情報から。
      expect(detail.points.some(p => !p.isArea)).toBe(true)
    })

    // 安全弁: 続報で区域が増えること（実電文の形）。同じ内容を 2 度流すだけでは速報の続報にならない。
    it.each(QUAKE_VARIANTS)('2 通目の震度速報で区域が増える（$label 版）', ({ useDmdataShape }) => {
      const [prompt1, , prompt2] = createTestQuakeReportSequence(useDmdataShape)
      expect(prompt2.points.length).toBeGreaterThan(prompt1.points.length)
    })

    // 正・対照: 区域の点の都道府県名はバリアントで形が違う（→ docs/spec/quake-spec.md §4）。
    //
    // standard 版（P2PQuake）はどの点も `pref` を非空で配信するが、DMDSS 版（DMDATA）の区域の点は
    // `pref` が空で届く。**元の資材は DMDATA 形状のまま**なので、standard 版だけ埋め直している。
    it('区域の点は standard 版だけ都道府県名を持つ', () => {
      const [standardPrompt] = createTestQuakeReportSequence(false)
      expect(standardPrompt.points.length).toBeGreaterThan(0)
      expect(standardPrompt.points.every(p => p.pref !== '')).toBe(true)
      // 対照: DMDSS 版の区域の点は空のまま（実電文どおり）。都道府県の点だけが `pref` を持つ。
      const [dmdssPrompt] = createTestQuakeReportSequence(true)
      expect(dmdssPrompt.points.some(p => p.pref === '')).toBe(true)
      expect(dmdssPrompt.points.some(p => p.pref !== '')).toBe(true)
    })

    // 安全弁: 受信経路を通しても 1 枚のカードへ合流すること。
    //
    // **`mergeQuakeInto` を直接呼ぶだけでは足りない。** あちらは既存カードを渡す前提で、
    // 「どのカードへ届くか」の判定（`sameQuakeEntry`）を通らない。**standard 版は識別情報を
    // 持たない**ので、震源名が空の震度速報を同じ地震と見なせるかはそちらの経路でしか分からない。
    // 合流しなければ実機でカードが 4 枚並ぶ。
    it.each(QUAKE_VARIANTS)('受信経路を通すと 4 通が 1 枚のカードへ合流する（$label 版）', ({ useDmdataShape }) => {
      const merged = mergeQuakeHistory(createTestQuakeReportSequence(useDmdataShape), [], [], null)
      expect(merged).toHaveLength(1)
      expect(reportsText(merged[0].reports, merged[0].issue.type))
        .toBe(useDmdataShape ? '震源・震度情報' : '各地の震度情報')
      // 対の確認: 観測点まで届いている（震源・震度情報の中身が採られている）。
      expect(merged[0].points.some(p => !p.isArea)).toBe(true)
    })

    // 安全弁: 同じ地震として扱われること。地震の時刻と識別情報を動かすと別カードが立つ。
    it('4 通が同じ地震を指し、地震の時刻は動かない', () => {
      const reports = createTestQuakeReportSequence(true)
      const eventIds = reports.map(q => extractQuakeEventIdFromId(q.id))
      expect(new Set(eventIds).size).toBe(1)
      expect(eventIds[0]).not.toBeNull()
      expect(new Set(reports.map(q => q.earthquake.time)).size).toBe(1)
      // 発表時刻は進む（進めないと据え置き判定が続報を捨てる）。
      expect(reports.map(q => q.time)).toEqual([...reports.map(q => q.time)].sort())
    })
  })

  // 訂正報テスト。**「訂正」の印が出る形を作れる唯一の入口**なので、印・訂正の中身・
  // 同じカードへ届くことの 3 つを固定する（→ docs/spec/settings-pwa-spec.md §7）。
  describe('訂正報テスト', () => {
    // 正: 訂正報は印を持ち、DMDSS 版では気象庁の一文も並ぶ。
    it('訂正報は「震源を訂正」の印を持ち、初報は持たない', () => {
      const { initial, amended } = createTestQuakeAmendment(true)
      expect(amended.issue.correct).toBe('震源を訂正')
      expect(initial.issue.correct).toBe('なし')
    })

    // 対照: 初報には訂正の一文が無い（訂正はまだ起きていない）。印と原文が並ぶのは訂正報だけ。
    it('訂正の一文が入るのは訂正報だけ', () => {
      const { initial, amended } = createTestQuakeAmendment(true)
      expect(amended.varCommentText).toContain('震源要素を訂正します。')
      expect(initial.varCommentText).not.toContain('震源要素を訂正します。')
      // 安全弁: `＊` の説明は両方に入る（落とす対象を取り違えていないこと）
      expect(initial.varCommentText).toContain('＊印は気象庁以外の震度観測点')
    })

    // 正: 何が訂正されたのかが値として見えること。値は実電文（能登本震の報番号 1 と 2）に合わせる。
    it('規模が訂正される（M7.4 → M7.6）', () => {
      const { initial, amended } = createTestQuakeAmendment(true)
      expect(initial.earthquake.hypocenter.magnitude).toBe(7.4)
      expect(amended.earthquake.hypocenter.magnitude).toBe(7.6)
    })

    // 安全弁: 同じ地震として扱われること。`eventId` が変わると別カードが立ち、
    // 「訂正された」ように見えない（印だけが 2 枚目のカードに付く）。
    it('2 通が同じ地震を指し、地震の時刻は動かない', () => {
      const { initial, amended } = createTestQuakeAmendment(true)
      expect(extractQuakeEventIdFromId(amended.id)).toBe(extractQuakeEventIdFromId(initial.id))
      expect(extractQuakeEventIdFromId(initial.id)).not.toBeNull()
      expect(amended.earthquake.time).toBe(initial.earthquake.time)
    })

    // 安全弁: 報番号と発表時刻は進める（→ §7「実電文の形に合わせる」）。
    // 進めないと、続報の据え置き判定（`mergeQuakeInto`）が訂正報を古い報として捨てる。
    it('報番号と発表時刻は進む', () => {
      const { initial, amended } = createTestQuakeAmendment(true)
      expect(initial.id.endsWith('-1')).toBe(true)
      expect(amended.id.endsWith('-2')).toBe(true)
      expect(amended.time > initial.time).toBe(true)
      expect(amended.issue.time).toBe(amended.time)
    })

    // standard 版は付加文を配信しないが、訂正の印そのものは P2PQuake も配信する
    // （`DestinationOnly`）。印だけが出る形を確かめられること。
    it('standard 版は印だけを持ち、付加文は持たない', () => {
      const { initial, amended } = createTestQuakeAmendment(false)
      expect(amended.issue.correct).toBe('震源を訂正')
      expect(amended.varCommentText).toBeUndefined()
      expect(initial.varCommentText).toBeUndefined()
    })
  })

  // 電文の `EventID` も DMDATA だけが配信する（→ 型定義の `JMAQuake.eventId`）。
  // **`id` に埋め込むだけでは足りない** —— `TsunamiTab` の原因地震リンクはフィールドを直接見る。
  it('識別子のフィールドは DMDSS 版だけが持ち、id に埋め込んだ値と一致する', () => {
    const dmdss = createTestEarthquake(true)
    expect(dmdss.eventId).toBe(extractQuakeEventId(dmdss))
    expect(dmdss.eventId).toMatch(/^\d{14}$/)
    expect(createTestEarthquake(false).eventId).toBeUndefined()
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

// 市町村の未入電（`City/Condition`）を実機で出すためのテストデータ（→ quake-spec.md §5「市町村の震度」）。
//
// **「地震テスト」では出ない形**なので、そちらとの対照も併せて固定する。片方だけを書くと、
// 元データを差し替えたときに「どちらにも無い」状態が黙って通る。
describe('未入電テスト（日向灘 2022-01-22）', () => {
  it('市町村の未入電を 2 通りとも持つ', () => {
    const cities = createTestUnreceivedQuake().cities ?? []
    // 震度を観測できたうえで配下に未入電がある
    expect(cities.filter((c) => c.hasUnreceived).length).toBeGreaterThan(0)
    // 市町村の値そのものが未入電
    expect(cities.filter((c) => c.unreceived).length).toBeGreaterThan(0)
  })

  it('「地震テスト」（能登本震）には市町村の未入電が無い', () => {
    const cities = createTestEarthquake(true).cities ?? []
    expect(cities.some((c) => c.hasUnreceived || c.unreceived)).toBe(false)
  })

  // 2 つを 1 つのフラグへ畳むと、観測できた震度が下限のように見える（→ quake-spec.md §5）。
  it('値そのものが未入電の市町村は下限の5弱へ寄せ、観測できた市町村と混ざらない', () => {
    for (const c of createTestUnreceivedQuake().cities ?? []) {
      if (c.unreceived) {
        expect(c.scale).toBe(45)
        expect(c.hasUnreceived).toBeUndefined()
      }
      if (c.hasUnreceived) expect(c.unreceived).toBeUndefined()
    }
  })

  it('観測点の未入電も持ち、市町村へ紐付いている（震度一覧の 4 段目が出る）', () => {
    const points = createTestUnreceivedQuake().points
    const unreceived = points.filter((p) => p.unreceived)
    expect(unreceived.length).toBeGreaterThan(0)
    expect(points.some((p) => !p.isArea && p.city)).toBe(true)
  })

  // 識別子は 2 通りで読まれる —— 長周期地震動の紐付けは `id` から抜き（`extractQuakeEventId`）、
  // `TsunamiTab` の原因地震リンクは `eventId` フィールドを直接見る。**片方だけでは足りない。**
  it('id からも eventId フィールドからも識別子が取れ、両者が一致する', () => {
    const quake = createTestUnreceivedQuake()
    expect(extractQuakeEventId(quake)).toMatch(/^\d{14}$/)
    expect(quake.eventId).toBe(extractQuakeEventId(quake))
  })
})

// 津波電文の識別子は**原因地震のもの**で、津波電文はその地震のあとに発表される
// （→ tsunami-spec.md §4）。押した時刻から作ると、実電文には無い並び（地震と津波警報が
// 同じ瞬間・地震より前に第一波が到達）になり、**同じ秒に押した地震テストと識別子が一致する**。
// 一致すると `TsunamiTab` の原因地震リンクが無関係な地震カードを指す。
describe('津波テストの識別子は原因地震の発現時刻から作る', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-09-12T12:34:56Z').getTime() }) })
  afterEach(() => { vi.useRealTimers() })

  it('識別子が原因地震の発現時刻と一致する（発表時刻ではない）', () => {
    const tsunami = createTestTsunami(true)
    const origin = tsunami.sourceEarthquakes?.[0]?.arrivalTime
    expect(origin).toBeTruthy()
    expect(tsunami.eventId).toBe(toEventIdTimestamp(new Date(origin!)))
    // 発表時刻そのものからは作らない（この 2 つが同じなら上の一致は偶然）
    expect(tsunami.eventId).not.toBe(toEventIdTimestamp(new Date(tsunami.time)))
  })

  // 本命の回帰。同じ瞬間に作っても、別々の事象なので識別子は分かれる。
  it('同じ瞬間に作った地震テストと識別子が衝突しない', () => {
    expect(createTestTsunami(true).eventId).not.toBe(createTestEarthquake(true).eventId)
    expect(createTestTsunami(true).eventId).not.toBe(createTestUnreceivedQuake().eventId)
    for (const make of [createTestTsunamiWarning, createTestTsunamiWatch, createTestTsunamiForecast]) {
      expect(make(true).eventId).not.toBe(createTestEarthquake(true).eventId)
    }
  })

  // 実測（`observations`）は「観測状況を確定した時刻」（`Head/TargetDateTime`）までの観測を
  // まとめたもの。**その時刻より後の実測はありえない** —— 最大波の観測時刻が発表より後だと、
  // まだ来ていない波を観測したことになる。
  it('観測点の実測は観測状況を確定した時刻より後にならない', () => {
    const tsunami = createTestTsunami(true)
    const settled = Date.parse(tsunami.observationDateTime!)
    expect(settled).toBeLessThan(Date.parse(tsunami.time))
    for (const o of tsunami.observations ?? []) {
      if (o.arrivalTime) expect(Date.parse(o.arrivalTime)).toBeLessThanOrEqual(settled)
      if (o.maxHeightDateTime) expect(Date.parse(o.maxHeightDateTime)).toBeLessThanOrEqual(settled)
    }
  })

  // 沿岸への推定（VTSE52 の `Estimation`）は沖合の観測から沿岸を推定したもので、**実測ではない**。
  // 推定した沿岸にはこれから到達するので、到達予想は発表より後になる。
  it('沿岸への推定の到達予想は発表より後', () => {
    const tsunami = createTestTsunami(true)
    const times = (tsunami.estimations ?? [])
      .map((e) => e.arrivalTime)
      .filter((v): v is string => !!v)
    expect(times.length).toBeGreaterThan(0)
    for (const v of times) expect(Date.parse(v)).toBeGreaterThan(Date.parse(tsunami.time))
  })

  // 対照: 実測が無い地点の到達予想は**未来のまま**。ここまで過去へ寄せると、
  // 「これから津波が来る地点」の表示を実機で確かめられなくなる。
  it('実測が無い地点の到達予想は発表より後に残っている', () => {
    const tsunami = createTestTsunami(true)
    const measured = new Set((tsunami.observations ?? []).map((o) => o.name))
    const future = (tsunami.areas ?? []).flatMap((a) => a.stations ?? [])
      .filter((st) => !measured.has(st.name) && st.arrivalTime)
      .filter((st) => Date.parse(st.arrivalTime!) > Date.parse(tsunami.time))
    expect(future.length).toBeGreaterThan(0)
  })

  // 欠測の地点（実測の到達時刻を出せていない）にも、予報側の到達予想が残っていること。
  // その値は観測点の行に「到達予想 ○○」として出る（→ tsunami-spec.md §9）。実配信でこの形が
  // 出るのは欠測の地点だけなので、テストデータから落とすと実機で一度も確かめられない。
  it('欠測の地点にも予報側の到達予想が残っている', () => {
    const tsunami = createTestTsunami(true)
    const stations = (tsunami.areas ?? []).flatMap((a) => a.stations ?? [])
    const withForecast = (tsunami.observations ?? [])
      .filter((o) => !o.arrivalTime && isObservationMissing(o))
      .filter((o) => stations.some((st) => st.name === o.name && st.arrivalTime))
    expect(withForecast.length).toBeGreaterThan(0)
  })

  // 安全弁: 原因地震は第一波の到達より前。ここが逆転すると「地震より前に津波が来た」形になる。
  it('原因地震は区域の第一波到達より前に起きている', () => {
    const tsunami = createTestTsunami(true)
    const origin = new Date(tsunami.sourceEarthquakes![0].arrivalTime!).getTime()
    const arrivals = (tsunami.areas ?? [])
      .map((a) => a.firstHeight?.arrivalTime)
      .filter((v): v is string => !!v)
      .map((v) => new Date(v).getTime())
    expect(arrivals.length).toBeGreaterThan(0)
    for (const at of arrivals) expect(origin).toBeLessThan(at)
    // 原因地震が複数あるときは、どれも到達より前
    for (const eq of tsunami.sourceEarthquakes ?? []) {
      expect(new Date(eq.arrivalTime!).getTime()).toBeLessThan(Math.min(...arrivals))
    }
  })
})

// 区域の到達状況（`firstHeight`）と実測の組み合わせは、実配信では 4 つの形しか取らない
// （→ docs/spec/tsunami-spec.md §9「区域の到達状況」）。そこから外れたテストデータは、
// **実運用では決して起きない絵**を見ながら表示を確かめることになる。
//
// 以前は「ただちに津波来襲と予測」の区域が到達予想を過去に持ち、しかもその区域に波高の実測が
// あった。どちらも実配信の標本（全期間 634 通・区域延べ 19,906）で 0 件の形。
describe('津波テストの区域は実配信の形に従う', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-09-12T12:34:56Z').getTime() }) })
  afterEach(() => { vi.useRealTimers() })

  /** 到達済みを表す 2 値。どちらも到達予想時刻を持たない。 */
  const ARRIVED = ['津波到達中と推測', '第１波の到達を確認']

  it('「ただちに津波来襲と予測」の区域は未来の到達予想を持つ', () => {
    const tsunami = createTestTsunami(true)
    const areas = (tsunami.areas ?? []).filter((a) => a.firstHeight?.condition === 'ただちに津波来襲と予測')
    expect(areas.length).toBeGreaterThan(0)
    for (const a of areas) {
      expect(a.firstHeight?.arrivalTime, a.name).toBeTruthy()
      expect(Date.parse(a.firstHeight!.arrivalTime!)).toBeGreaterThan(Date.parse(tsunami.time))
    }
  })

  // 対照: 到達済みの 2 値では時刻が消える。予想する対象がもう無いため
  it('到達済みの区域は到達予想時刻を持たない', () => {
    const tsunami = createTestTsunami(true)
    const areas = (tsunami.areas ?? []).filter((a) => ARRIVED.includes(a.firstHeight?.condition ?? ''))
    expect(areas.length).toBeGreaterThan(0)
    for (const a of areas) expect(a.firstHeight?.arrivalTime, a.name).toBeFalsy()
  })

  // **津波予報の区域にも実測は届く。** `FirstHeight` を持たないのは「到達を語らない」だけで、
  // 観測していないという意味ではない。ここを「実測があれば必ず第１波の到達を確認」と書くと、
  // 実配信で 1 割強を占める組み合わせを弾く実装を後から呼び込む
  it('波高の実測がある区域は、津波予報か「第１波の到達を確認」のどちらか', () => {
    const tsunami = createTestTsunami(true)
    const measured = (tsunami.areas ?? []).filter((a) =>
      (tsunami.observations ?? []).some((o) => o.height?.description && matchesArea(o, a)))
    expect(measured.length).toBeGreaterThan(0)
    // 両方の形がテストデータに載っていること自体を先に固定する
    expect(measured.some((a) => a.grade === 'Forecast')).toBe(true)
    expect(measured.some((a) => a.grade !== 'Forecast')).toBe(true)
    for (const a of measured) {
      if (a.grade === 'Forecast') expect(a.firstHeight, a.name).toBeUndefined()
      else expect(a.firstHeight?.condition, a.name).toBe('第１波の到達を確認')
    }
  })

  // 本命の回帰。バッジは実測がある区域では出ない（`TsunamiAreaRow` の `badgeSuppressed`）ので、
  // 実測を持たない区域が無いと **3 値が 1 つも画面に出ない**。実際にその状態だった
  it('到達状況の 3 値それぞれに、実測を持たない区域がある', () => {
    const tsunami = createTestTsunami(true)
    for (const condition of ['ただちに津波来襲と予測', ...ARRIVED]) {
      const withBadge = (tsunami.areas ?? []).filter((a) => a.firstHeight?.condition === condition
        && !(tsunami.observations ?? []).some((o) => matchesArea(o, a)))
      expect(withBadge.length, condition).toBeGreaterThan(0)
    }
  })

  // 安全弁: `FirstHeight` を持たないのは津波予報（若干の海面変動）と解除だけ。注意報以上は
  // 必ず持つ。standard 版でも落ちないことを併せて見る
  it('注意報以上の区域は到達状況を必ず持つ', () => {
    for (const withDmdssFields of [true, false]) {
      const areas = createTestTsunami(withDmdssFields).areas ?? []
      const graded = areas.filter((a) => a.grade !== 'Forecast')
      expect(graded.length).toBeGreaterThan(0)
      for (const a of graded) {
        expect(a.firstHeight, `${a.name}(${withDmdssFields ? 'DMDSS' : 'standard'})`).toBeTruthy()
      }
      // 予想波高は等級を問わず付く（津波予報の区域も持つ）
      for (const a of areas) {
        expect(a.maxHeight, `${a.name}(${withDmdssFields ? 'DMDSS' : 'standard'})`).toBeTruthy()
      }
    }
  })

  // 安全弁: 地点の到達予想は、波高か到達時刻が届いた地点からは消える（満潮時刻だけが残る）。
  // **残る地点のうち、まだ何も届いていない地点は未来・欠測の地点は過去。** 後者は予想した
  // 時刻を過ぎても到達を観測できていない形で、気象庁には予想を取り下げる理由が無い。
  // カードはこの値を観測点の行へ「到達予想」として添えるので実機にも届く
  // （→ docs/spec/tsunami-spec.md §9「実測の到達時刻が無い行に添える到達予想」）。
  it('地点の到達予想は、値が届いた地点からは消え、欠測の地点だけ過去に残る', () => {
    const tsunami = createTestTsunami(true)
    const received = new Set((tsunami.observations ?? [])
      .filter((o) => o.height?.description || o.arrivalTime)
      .map((o) => o.name))
    const missing = new Set((tsunami.observations ?? [])
      .filter((o) => isObservationMissing(o))
      .map((o) => o.name))
    const stations = (tsunami.areas ?? []).flatMap((a) => a.stations ?? [])
    expect(stations.length).toBeGreaterThan(0)
    let future = 0
    let missingPast = 0
    for (const st of stations) {
      if (received.has(st.name)) {
        expect(st.arrivalTime, st.name).toBeFalsy()
        continue
      }
      if (!st.arrivalTime) continue
      if (missing.has(st.name)) {
        expect(Date.parse(st.arrivalTime), st.name).toBeLessThan(Date.parse(tsunami.time))
        missingPast++
        continue
      }
      expect(Date.parse(st.arrivalTime), st.name).toBeGreaterThan(Date.parse(tsunami.time))
      future++
    }
    expect(future).toBeGreaterThan(0)
    expect(missingPast).toBeGreaterThan(0)
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

  // **区域に載る予測震度に下限は無い**（→ docs/spec/eew-spec.md §4）。下限が無いこと自体は
  // テストデータでは守れないので、代わりに次の 2 つを固定する。
  //
  // 正: 弱い区域を実機で確かめられる状態を保つ。これが無いと、区域を「震度 4 以上だけ」に
  // 戻したときに気づけない（区域一覧・区域塗り・到達の欄の見え方はテストボタンにしか入口が無い）。
  it.each([
    ['createTestEEW（特別警報・三陸沖）', createTestEEW(true)],
    ['createTestEEWWarning（警報・日向灘）', createTestEEWWarning(true)],
  ] as const)('%s: 震度 4 未満の区域を持つ', (_label, eew) => {
    expect(eewAreas(eew).some((a) => a.scaleTo < 40)).toBe(true)
  })

  // 対照: 区域の列挙が始まる境目のほうは緩めていない。実電文では、区域を持たない 3,772 通は
  // 電文全体の予想の下限が震度 1〜3 で、区域を持つ 765 通は震度 4 以上だった（例外 1 通は §4）。
  //
  // **区域を持たない報はここだけで足す。** 共有の `cases` へ混ぜると、区域を回す他のテストが
  // その報に対して 0 周で素通りし、検証していない件数だけが増える。
  it.each([
    ...cases,
    ['createTestEEWAssumed（単独点処理の初報・日向灘）', createTestEEWAssumed(true, undefined, 1)],
  ] as const)('%s: 区域を持つなら電文全体の予想も震度 4 以上', (_label, eew) => {
    if (eewAreas(eew).length === 0) return
    expect(eew.forecastMaxScale).toBeGreaterThanOrEqual(40)
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

  // 震源時刻を固定した版。時刻の前後（未来か過去か）を確かめるには基準が要る。
  const BASE = new Date('2026-01-01T12:00:00Z')
  const basedCases = [
    ['createTestEEW（特別警報・三陸沖）', createTestEEW(true, 'evt', 1, BASE)],
    ['createTestEEWWarning（警報・日向灘）', createTestEEWWarning(true, 'evt', 1, BASE)],
    ['createTestEEWForecast（予報・宮城県沖）', createTestEEWForecast(true, 'evt', 1, BASE)],
    ['createTestEEWAssumed（単独点処理の続報・日向灘）', createTestEEWAssumed(true, 'evt', 2, BASE)],
  ] as const

  // 正: 未到達コード（00/10）の区域は**必ず**到達予測時刻を持ち、その値は震源時刻より後。
  //
  // **実電文にこの形しかない。** 走査した 753 区域のうち、時刻も `Condition` も持たない区域は
  // 1 件も無かった（内訳は `testData.ts` の種別コードの説明）。
  //
  // かつてこの 3 ボタンはその「無い形」で、区域の全件が時刻も印も持っていなかった。すると
  // 「主要動の到達（予測）」の欄は表示条件（時刻があるか到達済みか）を満たさず、ボタンから
  // 1 度も画面に出てこない（→ CLAUDE.md「テストボタンは実機確認の唯一の入口」）。
  it.each(basedCases)('%s: 未到達コードの区域は震源時刻より後の到達予測時刻を持つ', (_label, eew) => {
    const targets = eewAreas(eew).filter(
      (a) => !isEewArrivedKindCode(a.kindCode) && !isEewPlumKindCode(a.kindCode),
    )
    expect(targets.length).toBeGreaterThan(0)
    for (const area of targets) {
      expect(area.arrivalTime).not.toBeNull()
      expect(Date.parse(area.arrivalTime!)).toBeGreaterThan(BASE.getTime())
    }
  })

  // 対照: PLUM 法（09/19）の時刻は**震源時刻より前**。到達の予測ではなく「その震度を初めて
  // 予測した時刻」なので、未来に置くと欄が「これから来る」ものとして読ませてしまう。
  //
  // **全ケースに掛ける不変条件**なので、PLUM 区域を持たないケースでは 0 周で通る。
  // 「持っているはずのものが消えた」ことは次のテストが受け持つ ―― こちらだけだと、
  // PLUM 区域を全部消しても 4 ケースとも通ってしまう。
  it.each(basedCases)('%s: PLUM 法の区域の時刻は震源時刻より前', (_label, eew) => {
    for (const area of eewAreas(eew)) {
      if (!isEewPlumKindCode(area.kindCode)) continue
      expect(area.arrivalTime).not.toBeNull()
      expect(Date.parse(area.arrivalTime!)).toBeLessThan(BASE.getTime())
    }
  })

  // 安全弁: PLUM 区域を受け持つボタンは、それを**1 件以上**持ち続ける。
  // 実電文では区域 753 件のうち 78 件（約 1 割）がこの形で、画面では「時刻不明」として
  // 並びの末尾に回る。消すとその見え方を実機で確かめる入口が無くなる。
  it.each([
    ['createTestEEW（特別警報・三陸沖）', createTestEEW(true, 'evt', 1, BASE)],
    ['createTestEEWWarning（警報・日向灘）', createTestEEWWarning(true, 'evt', 1, BASE)],
  ] as const)('%s: PLUM 法の区域を持つ', (_label, eew) => {
    expect(eewAreas(eew).filter((a) => isEewPlumKindCode(a.kindCode)).length).toBeGreaterThan(0)
  })

  // 安全弁: 区域を持つテスト EEW は「主要動の到達（予測）」の欄に出る区域を必ず持つ。
  // **判定は `RealtimeTab` の絞り込みと同じ述語**（時刻があるか到達済みか）で書く ——
  // 上の 2 つを満たしても、区域そのものが消えれば欄は出ない。
  it.each(basedCases)('%s: 到達の欄に出る区域を持つ', (_label, eew) => {
    expect(eewAreas(eew).filter((a) => a.arrivalTime || isEewAreaArrived(a)).length).toBeGreaterThan(0)
  })

  // 3 通り（到達済み・未到達・PLUM 法）が 1 枚のカードに揃うのは特別警報テストの受け持ち。
  // **1 通りだけでは並び（到達済み → 未到達 → PLUM）を実機で確かめられない。**
  it('特別警報テストは到達の 3 通りをすべて持つ', () => {
    const areas = eewAreas(createTestEEW(true, 'evt', 1, BASE))
    expect(areas.some((a) => isEewArrivedKindCode(a.kindCode))).toBe(true)
    expect(areas.some((a) => isEewPlumKindCode(a.kindCode))).toBe(true)
    expect(areas.some((a) => !isEewArrivedKindCode(a.kindCode) && !isEewPlumKindCode(a.kindCode))).toBe(true)
  })

  // 件数。実電文では最大予想震度が高い報ほど区域が多い（件数の実測は `testData.ts` の
  // 種別コードの説明）。到達の欄は件数が増えて初めて列に折り返すため、**強い地震のテストが
  // 少ないままだとその見え方に入口が無い**。下限だけを固定するのは、実電文の中央値そのものを
  // 書くと走査をやり直すたびにテストを直すことになるため。
  it('強い地震のテストは区域を実電文なみの件数だけ持つ', () => {
    expect(eewAreas(createTestEEW(true, 'evt', 1, BASE)).length).toBeGreaterThanOrEqual(20)
    expect(eewAreas(createTestEEWWarning(true, 'evt', 1, BASE)).length).toBeGreaterThanOrEqual(20)
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

  // 固定付加文は警報級の報にしか入らない（実電文で予報級 7,615 通は 0 件。
  // → docs/spec/eew-spec.md §3「固定付加文」）。このボタンは予報級 → 警報級へ上がる形なので、
  // **格上げで初めて付加文が現れる**ところまで再現していること。
  it('単独点処理は予報級の初報に付加文を持たず、警報へ上がった続報で持つ', () => {
    expect(createTestEEWAssumed(true, 'evt', 1, base).warningComment).toBeUndefined()
    expect(createTestEEWAssumed(true, 'evt', 2, base).warningComment).toBeTruthy()
  })

  // standard 版（P2PQuake / Yahoo hypoInfo）は固定付加文を配信しないので、警報級でも持たない。
  it('standard 版では警報へ上がっても付加文を持たない', () => {
    expect(createTestEEWAssumed(false, 'evt', 2, base).warningComment).toBeUndefined()
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
    expect(t.warningComments).toBeUndefined()
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
    expect(t.warningComments?.length).toBeGreaterThan(0)
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

  // 正: 解除された区域は `areas` から外れて `cancelledAreas` へ移る。**実機で解除の読み上げと
  // カードの「解除」の枠を確かめられる唯一の入口**（→ docs/spec/tsunami-spec.md §10）。
  it('解除された区域は cancelledAreas へ移り、areas からは消える', () => {
    const next = createTestTsunamiGradeChange(createTestTsunami(true))
    expect(next.areas.map(a => a.name)).not.toContain('青森県日本海沿岸')
    expect(next.cancelledAreas).toHaveLength(1)
    expect(next.cancelledAreas![0]).toMatchObject({
      name: '青森県日本海沿岸', code: '200', grade: 'Unknown', lastGrade: 'Watch',
    })
    // 実電文の解除された区域は `Area` と `Category` しか持たない
    expect(next.cancelledAreas![0].maxHeight).toBeUndefined()
    expect(next.cancelledAreas![0].stations).toBeUndefined()
  })

  // 対照: 発表報の時点では通常の区域として出ている（解除の前後が実機で見える）。
  it('発表報では解除される区域も通常の区域として出ている', () => {
    const base = createTestTsunami(true)
    expect(base.cancelledAreas).toBeUndefined()
    expect(base.areas.find(a => a.name === '青森県日本海沿岸')).toMatchObject({ grade: 'Watch' })
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

  // 正: 津波警報等（VTSE41）の形になっていること。**この形でないと続報のマージが一度も通らず、
  // 引き継ぎが効いているかを実機で確かめられない**（テストボタンは実機確認の唯一の入口）。
  it('津波警報等の形をしている（観測点も観測情報も持たない）', () => {
    const next = createTestTsunamiGradeChange(createTestTsunami(true))
    expect(next.carriesForecastStations).toBe(false)
    expect(next.areas.every(a => a.stations === undefined)).toBe(true)
    expect(next.observations).toBeUndefined()
    expect(next.observationDateTime).toBeUndefined()
    expect(next.estimations).toBeUndefined()
    // 固定付加文は等級の呼びかけ 1 件だけ（満潮・観測・沖合の注記は前報から継がれる）
    expect(next.warningComments!.map(c => c.key)).toEqual(['VTSE41'])
  })

  // 対照: 元の報の側はそれらを持っていること。**両方が空だと、継いでいるのか
  // もともと無いのかが画面から見分けられない。**
  it('元の報は観測点・観測情報・4 主題の付加文を持つ', () => {
    const base = createTestTsunami(true)
    expect(base.areas.some(a => (a.stations?.length ?? 0) > 0)).toBe(true)
    expect(base.observations?.length).toBeGreaterThan(0)
    expect(base.warningComments!.length).toBe(4)
  })
})

describe('テスト EEW の最大予測値の変化は実電文の形をしている', () => {
  // 電文は変化を 1 通しか言わない。第 1 報は `Appendix` を持たず、変化を立てた次の報は
  // 値を 0 に戻してくる（2026-06-01〜09-06 の実電文 334 イベントで確認）。
  //
  // **毎報「大きくなった」を立てる形に戻すと、テストボタンで帯が出続ける。** 表示の寿命
  // （`RealtimeTab` の `useHeldForecastChange`）はそこでしか実機確認できないので、
  // 出続ける形にすると「保持が効いているのか、電文が毎報言っているだけなのか」を
  // 画面から見分けられなくなる。
  const changeOf = (serial: number) => createTestEEWWarning(true, 'e', serial).forecastChange

  // 正: 2 報目で変化を立てる。
  it('2 報目で「大きくなった」を立てる', () => {
    expect(changeOf(2)).toEqual({ maxInt: 1, maxLgInt: 0, reason: 2 })
  })

  // 対照: 3 報目以降は値が 0 に戻る。**毎報立てる形に戻したらここが落ちる。**
  it('3 報目以降は変化なしへ戻る', () => {
    expect(changeOf(3)).toEqual({ maxInt: 0, maxLgInt: 0, reason: 0 })
    expect(changeOf(9)).toEqual({ maxInt: 0, maxLgInt: 0, reason: 0 })
  })

  // 安全弁: 第 1 報は要素ごと持たない（実電文では `Appendix` が出現しない）。
  it('第 1 報は変化の要素ごと持たない', () => {
    expect(changeOf(1)).toBeUndefined()
  })
})
