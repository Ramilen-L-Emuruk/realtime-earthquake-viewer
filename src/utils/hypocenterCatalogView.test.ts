// 長期震源カタログを点群へ変換するところを固定する。
// 描画そのものは WebGL なのでここでは触れない（ブラウザ確認の担当）。
import { describe, it, expect } from 'vitest'
import {
  sampleRamp,
  depthRampT,
  pointSizePx,
  catalogCompleteness,
  yearsInRange,
  buildCatalogPointCloud,
  effectiveMaxDepthKm,
  effectiveMinDepthKm,
  effectiveMaxMagnitude,
  magnitudeBoundLabel,
  effectiveLatRange,
  effectiveLngRange,
  latBoundLabel,
  lngBoundLabel,
  LATITUDE_FILTER_RANGE,
  LONGITUDE_FILTER_RANGE,
  depthBoundLabel,
  DEPTH_FILTER_MAX_KM,
  MAGNITUDE_FILTER_RANGE,
  oldestYearOf,
  withCompleteMagnitudeFloor,
  rangeLabel,
  formatMissingYears,
  DEPTH_RAMP_MAX_KM,
  MAGNITUDE_RAMP_RANGE,
  jstYearOf,
  jstYearStartMs,
  jstYearEndMs,
  toDateInputValue,
  fromDateInputValue,
  clampDayToRange,
  clampPeriodToRange,
  periodFromYearChange,
  periodFromDateChange,
  formatJstDate,
  periodDayCount,
  type CatalogFilter,
  type CatalogViewOptions,
} from './hypocenterCatalogView'
import type { HypocenterIndex, HypocenterYear } from './hypocenterCatalog'

/** 1 年ぶんの作り物。配列の長さをそろえるのが面倒なので、ここでまとめて作る。 */
const makeYear = (
  year: number,
  events: readonly { lng: number; lat: number; depth: number; mag: number; timeMs: number }[],
): HypocenterYear => ({
  year,
  count: events.length,
  coveredThroughMs: Date.UTC(year + 1, 0, 1),
  quality: 'final',
  // **時刻はその年の中へ置く。** 期間の絞り込みが日単位で効くので、生の小さな値のままだと
  // すべて 1970 年の地震になり、どのテストでも 1 件も残らない。
  timeMs: Float64Array.from(events.map((e) => jstYearStartMs(year) + e.timeMs)),
  lat: Float64Array.from(events.map((e) => e.lat)),
  lng: Float64Array.from(events.map((e) => e.lng)),
  depth: Float32Array.from(events.map((e) => e.depth)),
  magnitude: Float32Array.from(events.map((e) => e.mag)),
  intensityIdx: new Int32Array(0),
  intensityCode: [],
})

const FILTER: CatalogFilter = {
  fromMs: jstYearStartMs(2020),
  toMs: jstYearEndMs(2021),
  minMagnitude: 2,
  maxMagnitude: 9,
  minDepthKm: 0,
  maxDepthKm: DEPTH_FILTER_MAX_KM,
  minLat: 15,
  maxLat: 56,
  minLng: 110,
  maxLng: 165,
}
const VIEW: CatalogViewOptions = { colorBy: 'depth', sizeBy: 'fixed', sizePx: 3 }

const INDEX: HypocenterIndex = {
  source: 's',
  sourceUrl: 'u',
  license: 'l',
  minMagnitude: 2,
  coveredThroughMs: 0,
  completeness: [
    { from: 1919, minMagnitude: 5 },
    { from: 1961, minMagnitude: 4.5 },
    { from: 1983, minMagnitude: 3.5 },
    { from: 1997, minMagnitude: 2 },
  ],
  years: [1919, 1960, 1997, 2020, 2021, 2022],
  counts: {},
  quality: {},
  intensityYears: [],
}

describe('sampleRamp', () => {
  const ramp = [
    [0, 0, 0, 0],
    [0.5, 1, 0, 0],
    [1, 1, 1, 1],
  ] as const

  // 正: 段のちょうどの位置ではその段の色。
  it('段の位置ではその色', () => {
    expect(sampleRamp(ramp, 0)).toEqual([0, 0, 0])
    expect(sampleRamp(ramp, 0.5)).toEqual([1, 0, 0])
    expect(sampleRamp(ramp, 1)).toEqual([1, 1, 1])
  })

  // 正: 段の間は線形。
  it('段の間は線形に混ざる', () => {
    expect(sampleRamp(ramp, 0.25)).toEqual([0.5, 0, 0])
  })

  // 安全弁: 範囲外は端で止める（外挿すると色が 0〜1 を外れ、シェーダーで飽和して別色になる）。
  it('範囲外は端に丸める', () => {
    expect(sampleRamp(ramp, -5)).toEqual([0, 0, 0])
    expect(sampleRamp(ramp, 99)).toEqual([1, 1, 1])
  })

  // 安全弁: NaN でも色を返す（欠測が 1 件でも混ざると点群ごと壊れるのを避ける）。
  it('NaN でも端の色を返す', () => {
    expect(sampleRamp(ramp, Number.NaN).every((v) => Number.isFinite(v))).toBe(true)
  })
})

describe('depthRampT', () => {
  // 正: 深いほど大きい。
  it('深いほど大きい', () => {
    expect(depthRampT(10)).toBeLessThan(depthRampT(100))
    expect(depthRampT(100)).toBeLessThan(depthRampT(600))
  })

  // 正: 上限で 1 に届く。
  it('上限で 1', () => {
    expect(depthRampT(DEPTH_RAMP_MAX_KM)).toBeCloseTo(1, 12)
  })

  // 安全弁: 上限を超えても 1 を超えない。
  it('上限を超えても 1 で止まる', () => {
    expect(depthRampT(DEPTH_RAMP_MAX_KM * 3)).toBe(1)
  })

  // 安全弁: 負の深さ（データの異常）で NaN にしない。
  it('負の深さは 0 として扱う', () => {
    expect(depthRampT(-10)).toBe(0)
  })

  // 対照: 線形ではなく浅い側へ寄っている。線形へ戻すとここが落ちる。
  it('浅い側へ寄せてある（線形ではない）', () => {
    const linear = 100 / DEPTH_RAMP_MAX_KM
    expect(depthRampT(100)).toBeGreaterThan(linear)
  })
})

describe('pointSizePx', () => {
  // 対照: 固定なら M に依らない。
  it('固定はマグニチュードで変わらない', () => {
    expect(pointSizePx(4, 2, 'fixed')).toBe(4)
    expect(pointSizePx(4, 9, 'fixed')).toBe(4)
  })

  // 正: 連動なら大きいほど大きい。
  it('連動はマグニチュードが大きいほど大きい', () => {
    expect(pointSizePx(4, 3, 'magnitude')).toBeLessThan(pointSizePx(4, 6, 'magnitude'))
  })

  // 正: 効き方を数値で固定する。**傾きを動かすとここが落ちる。**
  it.each([
    [3, 0.435],
    [5, 0.914588],
    [7, 1.92292],
    [9, 4.04294],
  ])('M%s で基準の %s 倍', (m, ratio) => {
    expect(pointSizePx(10, m, 'magnitude')).toBeCloseTo(10 * ratio, 4)
  })

  // **正: 倍率は M が 1 増えるごとに一定倍。** 線形へ戻すとここが落ちる（上端ほど比が縮むため）。
  it.each([
    [2, 3],
    [5, 6],
    [8, 9],
  ])('M%s → M%s の比はどこでも同じ', (lo, hi) => {
    const ratio = pointSizePx(10, hi, 'magnitude') / pointSizePx(10, lo, 'magnitude')
    expect(ratio).toBeCloseTo(1.45, 6)
  })

  // **対照: 最大級どうしでも大きさが変わる。** M8 と M9 の差が読み取れることがこの設計の目的。
  it('M8 と M9 で目に見えて変わる', () => {
    expect(pointSizePx(10, 9, 'magnitude') / pointSizePx(10, 8, 'magnitude')).toBeCloseTo(1.45, 6)
  })

  // **安全弁: 収録の下限（M2.0）で 0 倍にしない。** 傾きだけで決めると、最も件数の多い
  // 地震が 1 つ残らず消える。
  it('M2.0 でも消えない', () => {
    expect(pointSizePx(10, 2, 'magnitude')).toBeCloseTo(10 * 0.3, 6)
  })

  // 安全弁: 収録の下限より小さい値が来ても、下限と同じ大きさで止める。
  it('収録の下限より小さい M は下限と同じ大きさ', () => {
    expect(pointSizePx(10, -5, 'magnitude')).toBeCloseTo(pointSizePx(10, 2, 'magnitude'), 6)
  })

  // 安全弁: 大小関係だけを保ち、極端な倍率にしない（エネルギー比で写すと M2 と M9 で 300 億倍になる）。
  it('倍率は 8 倍で頭打ち', () => {
    expect(pointSizePx(4, 20, 'magnitude')).toBe(4 * 8)
  })

  // **対照: 上限は M10 より先にある。** ここで頭打ちすると、起こりうる規模の範囲で
  // 大きさの差が消える。
  it('M10 までは頭打ちしない', () => {
    expect(pointSizePx(4, 10, 'magnitude')).toBeLessThan(4 * 8)
    expect(pointSizePx(4, 10, 'magnitude')).toBeGreaterThan(pointSizePx(4, 9.5, 'magnitude'))
  })

  // 安全弁: M が欠測でも数値を返す（NaN を渡すと点が消える）。
  it('マグニチュードが NaN でも有限', () => {
    expect(Number.isFinite(pointSizePx(4, Number.NaN, 'magnitude'))).toBe(true)
  })
})

describe('catalogCompleteness', () => {
  const f = (fromYear: number, toYear: number, minMagnitude: number): CatalogFilter =>
    ({ ...FILTER, fromMs: jstYearStartMs(fromYear), toMs: jstYearEndMs(toYear), minMagnitude })

  // 正: 1997 年以降なら M2.0 まで完全。
  it('1997 年からは M2.0 が完全', () => {
    expect(catalogCompleteness(INDEX, f(1997, 2022, 2))).toEqual({ completeMin: 2, belowComplete: false })
  })

  // 正: 古い期間を含めると下限が上がる。
  it('古い期間を含めると下限が上がる', () => {
    expect(catalogCompleteness(INDEX, f(1919, 2022, 2)).completeMin).toBe(5)
  })

  // 対照: 下限を割っていれば印が立つ。
  it('完全性を割ると belowComplete が立つ', () => {
    expect(catalogCompleteness(INDEX, f(1919, 2022, 2)).belowComplete).toBe(true)
    expect(catalogCompleteness(INDEX, f(1919, 2022, 5)).belowComplete).toBe(false)
  })

  // **安全弁: 開始と終了が逆でも、判定は期間の最も古い年で行う。**
  // ここが `fromYear` を直接見ていると、読んでいない年を基準に「網羅している」と答える。
  it('開始と終了が逆でも古い側を基準にする', () => {
    expect(catalogCompleteness(INDEX, f(2020, 1919, 2)).completeMin).toBe(5)
    expect(catalogCompleteness(INDEX, f(2020, 1919, 2)).belowComplete).toBe(true)
  })

  // 対照: 順方向でも同じ答えになる（逆順の扱いが特別な分岐になっていないこと）。
  it('順方向と逆方向で同じ', () => {
    expect(catalogCompleteness(INDEX, f(2020, 1919, 2))).toEqual(catalogCompleteness(INDEX, f(1919, 2020, 2)))
  })
})

describe('withCompleteMagnitudeFloor', () => {
  const f = (over: Partial<CatalogFilter>): CatalogFilter => ({ ...FILTER, ...over })
  /** 期間だけを動かす（下限には手を触れない）。実際の操作で起きる形。 */
  const movePeriod = (prev: CatalogFilter, fromYear: number, toYear: number) =>
    withCompleteMagnitudeFloor(INDEX, prev, {
      ...prev,
      fromMs: jstYearStartMs(fromYear),
      toMs: jstYearEndMs(toYear),
    })

  // 正: 期間の古い側に応じて下限が上がる。
  it('古い期間なら下限が上がる', () => {
    expect(movePeriod(f({}), 1919, 2022).minMagnitude).toBe(5)
  })

  // 対照: 上限に余裕があれば上限は触らない。
  it('上限に余裕があれば触らない', () => {
    expect(movePeriod(f({ maxMagnitude: 8 }), 1919, 2022).maxMagnitude).toBe(8)
  })

  // **安全弁: 下限が上限を追い越したら上限を外す。**
  // 追い越したままにすると 1 件も残らず、しかも「なぜ 0 件か」が画面のどこにも出ない
  // （完全性の注意書きは「下限が完全性を割っているか」しか見ないため黙る）。
  it('下限が上限を追い越したら上限を外す', () => {
    const r = movePeriod(f({ minMagnitude: 2, maxMagnitude: 3 }), 1919, 2022)
    expect(r.minMagnitude).toBe(5)
    expect(r.maxMagnitude).toBe(MAGNITUDE_FILTER_RANGE.max)
    expect(r.minMagnitude).toBeLessThanOrEqual(r.maxMagnitude)
  })

  // 安全弁: どの期間へ動かしても下限が上限を越えない。
  it.each([1919, 1960, 1997, 2020])('%i 年からでも下限は上限を越えない', (fromYear) => {
    const r = movePeriod(f({ minMagnitude: 2, maxMagnitude: 2.5 }), fromYear, 2022)
    expect(r.minMagnitude).toBeLessThanOrEqual(r.maxMagnitude)
  })

  // **正: 手で上げた下限は期間を動かしても残る。**
  // 大きい地震だけを見ている最中に期間のつまみを触っただけで M2.0 へ戻ると、絞り込みが
  // 無言で解ける（戻った値はちょうど完全性の下限なので注意書きも出ない）。
  it('手で上げた下限は期間を動かしても残る', () => {
    expect(movePeriod(f({ minMagnitude: 6 }), 1919, 2022).minMagnitude).toBe(6)
  })

  // 対照: 手で選んだ値でも、完全性を割るなら引き上げる（記録に無い地震を数えないため）。
  it('手で選んだ下限でも完全性を割るなら引き上げる', () => {
    expect(movePeriod(f({ minMagnitude: 3 }), 1919, 2022).minMagnitude).toBe(5)
  })

  // **安全弁: 合わせた値なら期間を戻したときに下がる（往復できる）。**
  // 引き上げたまま据え置くと「動かして戻しただけなのに件数が減ったまま」になる。
  it('合わせた値は期間を戻せば下がる', () => {
    const wide = f({ fromMs: jstYearStartMs(1919), toMs: jstYearEndMs(2022), minMagnitude: 5 })
    expect(movePeriod(wide, 2020, 2022).minMagnitude).toBe(2)
  })
})

describe('rangeLabel', () => {
  // 正: 両側に制限があれば並べる。
  it('両側に制限があれば並べる', () => {
    expect(rangeLabel('M 4.0 以上', 'M 7.0 以下')).toBe('M 4.0 以上 〜 M 7.0 以下')
  })

  // **正: 片側だけなら、その側だけを書く。**「M 4.0 以上 〜 制限なし」は読みにくい。
  it('片側だけなら片側だけ書く', () => {
    expect(rangeLabel('M 4.0 以上', '制限なし')).toBe('M 4.0 以上')
    expect(rangeLabel('制限なし', 'M 7.0 以下')).toBe('M 7.0 以下')
  })

  // 対照: 両側とも無ければ 1 つに畳む。
  it('両側とも無ければ畳む', () => {
    expect(rangeLabel('制限なし', '制限なし')).toBe('制限なし')
  })
})

describe('oldestYearOf', () => {
  it('小さいほうを返す', () => {
    expect(oldestYearOf({ fromMs: jstYearStartMs(2020), toMs: jstYearEndMs(1960) })).toBe(1960)
    expect(oldestYearOf({ fromMs: jstYearStartMs(1960), toMs: jstYearEndMs(2020) })).toBe(1960)
  })

  it('同じ年なら その年', () => {
    expect(oldestYearOf({ fromMs: jstYearStartMs(2000), toMs: jstYearEndMs(2000) })).toBe(2000)
  })

  // **安全弁: 年末ぎりぎりでも年を取り違えない。** 実行環境が UTC だと、日本時間の
  // 12 月 31 日 23:59 は UTC では 14:59 の同日で、素朴に読むと 1 年ずれる。
  it('年の境目でも日本時間で数える', () => {
    expect(oldestYearOf({ fromMs: jstYearEndMs(2000), toMs: jstYearEndMs(2000) })).toBe(2000)
    expect(oldestYearOf({ fromMs: jstYearStartMs(2001), toMs: jstYearStartMs(2001) })).toBe(2001)
  })
})

describe('formatMissingYears', () => {
  // 正: 連続した年は範囲に畳む。
  it('連続した年をまとめる', () => {
    expect(formatMissingYears([1990, 1991, 1992])).toBe('1990〜1992')
  })

  // 正: 飛んだところで切る。
  it('飛びは分けて書く', () => {
    expect(formatMissingYears([1990, 1991, 1995, 2001, 2002])).toBe('1990〜1991, 1995, 2001〜2002')
  })

  // 対照: 1 年だけなら範囲にしない。
  it('単独の年は範囲にしない', () => {
    expect(formatMissingYears([1995])).toBe('1995')
  })

  // 安全弁: 空なら空文字（呼び出し側は長さで出し分けるが、ここでも壊れないこと）。
  it('空なら空文字', () => {
    expect(formatMissingYears([])).toBe('')
  })
})

describe('絞り込みの範囲は色の範囲と別に持つ', () => {
  // **対照: 色の飽和範囲を借りていないこと。** 借りていると、色を調整したつもりで
  // 絞り込みの届く範囲まで一緒に動く。**同じ値になった瞬間に気づけなくなる**ので、
  // 別の定数であること自体をここで固定する。
  it('マグニチュードの絞り込みと色の飽和は別の値', () => {
    expect(MAGNITUDE_FILTER_RANGE.max).toBe(9)
    expect(MAGNITUDE_RAMP_RANGE.max).not.toBe(MAGNITUDE_FILTER_RANGE.max)
  })

  // 深さは絞り込みの端と色の飽和が**いまのところ同じ値**（どちらも 750km）。
  // **この検査は「別の定数として持っていること」を保証しない**——かつてのように
  // `DEPTH_FILTER_MAX_KM = DEPTH_RAMP_MAX_KM` と結合し直しても、両方 750 を返して通ってしまう。
  // 値でしか見られない以上ここが限界で、分離そのものはコードを読んで守る。
  it('深さの絞り込みの端と色の飽和はいまのところ同じ値', () => {
    expect(DEPTH_FILTER_MAX_KM).toBe(750)
    expect(DEPTH_RAMP_MAX_KM).toBe(750)
  })

  // 安全弁: 絞り込みの上端を超える地震も、下限の絞り込みでは残る（取りこぼしは起きない）。
  it('上端を超える地震も残る', () => {
    const huge = makeYear(2020, [{ lng: 139, lat: 35, depth: 20, mag: 9.5, timeMs: 1 }])
    const c = buildCatalogPointCloud([huge], { ...FILTER, minMagnitude: MAGNITUDE_FILTER_RANGE.max }, VIEW)
    expect(c.columns.count).toBe(1)
  })
})

describe('緯度・経度で切り出す', () => {
  const y = makeYear(2020, [
    { lng: 130, lat: 33, depth: 10, mag: 5, timeMs: 1 },  // 九州
    { lng: 140, lat: 36, depth: 10, mag: 5, timeMs: 2 },  // 関東
    { lng: 145, lat: 43, depth: 10, mag: 5, timeMs: 3 },  // 北海道沖
  ])

  // 正: 緯度で挟める。
  it('緯度で挟む', () => {
    const c = buildCatalogPointCloud([y], { ...FILTER, minLat: 35, maxLat: 40 }, VIEW)
    expect(Array.from(c.columns.lat)).toEqual([36])
  })

  // 正: 経度で挟める。
  it('経度で挟む', () => {
    const c = buildCatalogPointCloud([y], { ...FILTER, minLng: 142, maxLng: 150 }, VIEW)
    expect(Array.from(c.columns.lng)).toEqual([145])
  })

  // 正: **緯度・経度・深さを重ねて直方体になる。**
  it('緯度・経度・深さを重ねる', () => {
    const deep = makeYear(2020, [
      { lng: 140, lat: 36, depth: 10, mag: 5, timeMs: 1 },
      { lng: 140, lat: 36, depth: 300, mag: 5, timeMs: 2 },
    ])
    const c = buildCatalogPointCloud(
      [deep],
      { ...FILTER, minLat: 35, maxLat: 37, minLng: 139, maxLng: 141, minDepthKm: 100, maxDepthKm: 400 },
      VIEW,
    )
    expect(Array.from(c.columns.depthKm)).toEqual([300])
  })

  // 安全弁: 端は「制限なし」（収録の外にある地震も端なら残る）。
  it('端なら収録の外も残る', () => {
    const far = makeYear(2020, [{ lng: 200, lat: 70, depth: 10, mag: 5, timeMs: 1 }])
    const c = buildCatalogPointCloud([far], FILTER, VIEW)
    expect(c.columns.count).toBe(1)
  })

  it('端の読み替え', () => {
    expect(effectiveLatRange(LATITUDE_FILTER_RANGE.min, LATITUDE_FILTER_RANGE.max)).toEqual([-Infinity, Infinity])
    expect(effectiveLatRange(30, 40)).toEqual([30, 40])
    expect(effectiveLngRange(LONGITUDE_FILTER_RANGE.min, LONGITUDE_FILTER_RANGE.max)).toEqual([-Infinity, Infinity])
    expect(effectiveLngRange(130, 140)).toEqual([130, 140])
  })

  // 正: 向きの語は深さに揃える（以深／以浅 に対して 以北／以南・以東／以西）。
  it('見出しの向きの語', () => {
    expect(latBoundLabel(35, 'min')).toBe('北緯 35.0° 以北')
    expect(latBoundLabel(40, 'max')).toBe('北緯 40.0° 以南')
    expect(lngBoundLabel(135, 'min')).toBe('東経 135.0° 以東')
    expect(lngBoundLabel(145, 'max')).toBe('東経 145.0° 以西')
    expect(latBoundLabel(LATITUDE_FILTER_RANGE.min, 'min')).toBe('制限なし')
    expect(lngBoundLabel(LONGITUDE_FILTER_RANGE.max, 'max')).toBe('制限なし')
  })
})

describe('マグニチュードの上端も「制限なし」', () => {
  // 正: 端に置いたら上限を外す（深さと同じ扱い）。
  it('端なら Infinity', () => {
    expect(effectiveMaxMagnitude(MAGNITUDE_FILTER_RANGE.max)).toBe(Infinity)
  })

  // 対照: 端の手前ならその値で切る。
  it('端の手前はその値のまま', () => {
    expect(effectiveMaxMagnitude(6)).toBe(6)
  })

  // **安全弁: 端に置いたとき、収録の最大より大きい地震も残る。**
  it('端なら M9 より大きい地震も残る', () => {
    const huge = makeYear(2020, [{ lng: 139, lat: 35, depth: 20, mag: 9.5, timeMs: 1 }])
    const c = buildCatalogPointCloud([huge], { ...FILTER, maxMagnitude: MAGNITUDE_FILTER_RANGE.max }, VIEW)
    expect(c.columns.count).toBe(1)
  })

  // 対照: 端の手前なら落ちる。
  it('端の手前なら落ちる', () => {
    const huge = makeYear(2020, [{ lng: 139, lat: 35, depth: 20, mag: 9.5, timeMs: 1 }])
    const c = buildCatalogPointCloud([huge], { ...FILTER, maxMagnitude: 8 }, VIEW)
    expect(c.columns.count).toBe(0)
  })

  // 正: 上限で絞れる（下限だけだった頃には無かった経路）。
  it('範囲で挟める', () => {
    const y = makeYear(2020, [
      { lng: 139, lat: 35, depth: 10, mag: 3, timeMs: 1 },
      { lng: 140, lat: 36, depth: 10, mag: 5, timeMs: 2 },
      { lng: 141, lat: 37, depth: 10, mag: 7, timeMs: 3 },
    ])
    const c = buildCatalogPointCloud([y], { ...FILTER, minMagnitude: 4, maxMagnitude: 6 }, VIEW)
    expect(Array.from(c.magnitude)).toEqual([5])
  })

  // 正: 端は「制限なし」と書く。
  it('端の見出しは制限なし', () => {
    expect(magnitudeBoundLabel(MAGNITUDE_FILTER_RANGE.min, 'min')).toBe('制限なし')
    expect(magnitudeBoundLabel(MAGNITUDE_FILTER_RANGE.max, 'max')).toBe('制限なし')
    expect(magnitudeBoundLabel(4, 'min')).toBe('M 4.0 以上')
    expect(magnitudeBoundLabel(6, 'max')).toBe('M 6.0 以下')
  })
})

describe('深さの端は「制限なし」', () => {
  // 正: 端に置いたら上限を外す。**端の値で切ると、より深い地震が入ったとき黙って消える。**
  it('上限が端なら Infinity', () => {
    expect(effectiveMaxDepthKm(DEPTH_FILTER_MAX_KM)).toBe(Infinity)
    expect(effectiveMaxDepthKm(DEPTH_FILTER_MAX_KM + 100)).toBe(Infinity)
  })

  // **正: 下限も対称に読み替える。** 片方だけだと、「制限なし」と表示しながら
  // 深さが負の地震を外すことになる。
  it('下限が端なら -Infinity', () => {
    expect(effectiveMinDepthKm(0)).toBe(-Infinity)
    expect(effectiveMinDepthKm(-10)).toBe(-Infinity)
  })

  it('下限が端の先ならその値のまま', () => {
    expect(effectiveMinDepthKm(100)).toBe(100)
  })

  // **安全弁: 下限が端なら、深さが負の地震も残る。**
  it('下限が端なら負の深さも残る', () => {
    const odd = makeYear(2020, [{ lng: 139, lat: 35, depth: -2, mag: 5, timeMs: 1 }])
    const c = buildCatalogPointCloud([odd], { ...FILTER, minDepthKm: 0 }, VIEW)
    expect(c.columns.count).toBe(1)
  })

  // 対照: 端の手前ならその値で切る。
  it('端の手前はその値のまま', () => {
    expect(effectiveMaxDepthKm(300)).toBe(300)
  })

  // 正: 端は「制限なし」と書く（「700 km 以浅」だと、それより深いものは見られないと読める）。
  it('端の見出しは制限なし', () => {
    expect(depthBoundLabel(DEPTH_FILTER_MAX_KM, 'max')).toBe('制限なし')
    expect(depthBoundLabel(0, 'min')).toBe('制限なし')
  })

  // 対照: 端でなければ値を書く。
  it('端でなければ値を書く', () => {
    expect(depthBoundLabel(300, 'max')).toBe('300 km 以浅')
    expect(depthBoundLabel(100, 'min')).toBe('100 km 以深')
  })

  // **安全弁: 端に置いたとき、収録の上限より深い地震が落ちない。**
  it('端なら収録の最深より深い地震も残る', () => {
    const deep = makeYear(2020, [{ lng: 139, lat: 35, depth: 900, mag: 5, timeMs: 1 }])
    const c = buildCatalogPointCloud([deep], { ...FILTER, maxDepthKm: DEPTH_FILTER_MAX_KM }, VIEW)
    expect(c.columns.count).toBe(1)
  })

  // 対照: 端の手前なら落ちる。
  it('端の手前なら落ちる', () => {
    const deep = makeYear(2020, [{ lng: 139, lat: 35, depth: 900, mag: 5, timeMs: 1 }])
    const c = buildCatalogPointCloud([deep], { ...FILTER, maxDepthKm: DEPTH_FILTER_MAX_KM - 10 }, VIEW)
    expect(c.columns.count).toBe(0)
  })
})

describe('yearsInRange', () => {
  // 正: 範囲に入る年だけを昇順で返す。
  it('範囲の年を昇順で返す', () => {
    expect(yearsInRange(INDEX, 1997, 2021)).toEqual([1997, 2020, 2021])
  })

  // 安全弁: 索引に無い年は作らない。**範囲から素朴に並べると 404 を取りに行く。**
  it('索引に無い年は含めない', () => {
    expect(yearsInRange(INDEX, 1998, 2019)).toEqual([])
  })

  // 安全弁: 逆順で渡されても同じ。
  it('from と to が逆でも同じ', () => {
    expect(yearsInRange(INDEX, 2021, 1997)).toEqual(yearsInRange(INDEX, 1997, 2021))
  })
})

describe('buildCatalogPointCloud', () => {
  const y2020 = makeYear(2020, [
    { lng: 139, lat: 35, depth: 10, mag: 3, timeMs: 1_000 },
    { lng: 140, lat: 36, depth: 300, mag: 5, timeMs: 2_000 },
    { lng: 141, lat: 37, depth: 20, mag: 2.1, timeMs: 3_000 },
  ])
  const y2021 = makeYear(2021, [{ lng: 142, lat: 38, depth: 60, mag: 6, timeMs: 4_000 }])

  // 正: 絞り込みに残った点がすべて入る。
  it('条件に合う点をすべて入れる', () => {
    const c = buildCatalogPointCloud([y2020, y2021], FILTER, VIEW)
    expect(c.columns.count).toBe(4)
    expect(Array.from(c.columns.lng)).toEqual([139, 140, 141, 142])
  })

  // 対照: マグニチュードの下限で落ちる。
  it('マグニチュード下限で落とす', () => {
    const c = buildCatalogPointCloud([y2020, y2021], { ...FILTER, minMagnitude: 5 }, VIEW)
    expect(c.columns.count).toBe(2)
    expect(Array.from(c.magnitude)).toEqual([5, 6])
  })

  // 対照: 深さの範囲で落ちる（両端は含む）。
  it('深さの範囲で落とす（両端は含む）', () => {
    const c = buildCatalogPointCloud([y2020, y2021], { ...FILTER, minDepthKm: 20, maxDepthKm: 60 }, VIEW)
    expect(Array.from(c.columns.depthKm)).toEqual([20, 60])
  })

  // 正: **添字がそろっていること。** クリックされた点の説明はこの対応に乗っている。
  it('列どうしで添字がそろう', () => {
    const c = buildCatalogPointCloud([y2020, y2021], { ...FILTER, minMagnitude: 5 }, VIEW)
    for (let i = 0; i < c.columns.count; i++) {
      const src = [...[0, 1, 2].map((k) => ({ y: y2020, k })), { y: y2021, k: 0 }].find(
        ({ y, k }) => y.lng[k] === c.columns.lng[i],
      )
      expect(src).toBeDefined()
      expect(c.columns.lat[i]).toBe(src!.y.lat[src!.k])
      expect(c.columns.depthKm[i]).toBe(src!.y.depth[src!.k])
      expect(c.magnitude[i]).toBe(src!.y.magnitude[src!.k])
      expect(c.timeMs[i]).toBe(src!.y.timeMs[src!.k])
    }
  })

  // 正: 色の配列は 3 要素ずつ、サイズは 1 要素ずつ。
  it('色は 3 倍・サイズは等倍の長さ', () => {
    const c = buildCatalogPointCloud([y2020, y2021], FILTER, VIEW)
    expect(c.columns.color.length).toBe(c.columns.count * 3)
    expect(c.columns.sizePx.length).toBe(c.columns.count)
  })

  // 安全弁: 欠測（NaN）は落とす。**通すと点が原点や上空へ飛ぶ。**
  it('マグニチュードや深さが NaN の地震は落とす', () => {
    const bad = makeYear(2020, [
      { lng: 139, lat: 35, depth: 10, mag: Number.NaN, timeMs: 1 },
      { lng: 140, lat: 36, depth: Number.NaN, mag: 4, timeMs: 2 },
      { lng: 141, lat: 37, depth: 10, mag: 4, timeMs: 3 },
    ])
    const c = buildCatalogPointCloud([bad], FILTER, VIEW)
    expect(c.columns.count).toBe(1)
    expect(c.columns.lng[0]).toBe(141)
  })

  // 正: 発生年で色を付けるとき、**分母は絞り込みに残った点で測る**。
  // 年ファイルの端で測ると、絞った結果狭い範囲しか残っていないときに色が展開しない。
  it('発生年の色は残った点の範囲で正規化する', () => {
    const view: CatalogViewOptions = { ...VIEW, colorBy: 'time' }
    // M5 以上に絞ると 2 点だけ残る（timeMs 2000 と 4000）。両端の色が違えば展開している。
    const c = buildCatalogPointCloud([y2020, y2021], { ...FILTER, minMagnitude: 5 }, view)
    const first = Array.from(c.columns.color.subarray(0, 3))
    const last = Array.from(c.columns.color.subarray(3, 6))
    expect(first).not.toEqual(last)
  })

  // 安全弁: 1 点だけでも色を作れる（分母 0 での割り算を通さない）。
  it('残りが 1 点でも色が有限', () => {
    const view: CatalogViewOptions = { ...VIEW, colorBy: 'time' }
    const c = buildCatalogPointCloud([y2021], FILTER, view)
    expect(c.columns.count).toBe(1)
    expect(Array.from(c.columns.color).every((v) => Number.isFinite(v))).toBe(true)
  })

  // 安全弁: 空でも壊れない。
  it('1 点も残らなくても空の列を返す', () => {
    const c = buildCatalogPointCloud([y2020], { ...FILTER, minMagnitude: 9 }, VIEW)
    expect(c.columns.count).toBe(0)
    expect(c.columns.lng.length).toBe(0)
    expect(c.columns.color.length).toBe(0)
  })

  // 対照: 色の付け方を変えると色が変わる（分岐が死んでいないこと）。
  it('色の基準を変えると色が変わる', () => {
    const byDepth = buildCatalogPointCloud([y2020], FILTER, { ...VIEW, colorBy: 'depth' })
    const byMag = buildCatalogPointCloud([y2020], FILTER, { ...VIEW, colorBy: 'magnitude' })
    expect(Array.from(byDepth.columns.color)).not.toEqual(Array.from(byMag.columns.color))
  })

  // 安全弁: マグニチュードの色は飽和範囲の外でも 0〜1 に収まる。
  it('飽和範囲の外でも色は 0〜1', () => {
    const huge = makeYear(2020, [
      { lng: 139, lat: 35, depth: 10, mag: MAGNITUDE_RAMP_RANGE.max + 5, timeMs: 1 },
    ])
    const c = buildCatalogPointCloud([huge], FILTER, { ...VIEW, colorBy: 'magnitude' })
    expect(Array.from(c.columns.color).every((v) => v >= 0 && v <= 1)).toBe(true)
  })
})

describe('期間は日単位で絞る', () => {
  /** その年の何日目か（0 始まり）を時刻へ。 */
  const day = (year: number, index: number) => jstYearStartMs(year) + index * 24 * 60 * 60 * 1000
  const y2020 = makeYear(2020, [
    { lng: 139, lat: 35, depth: 10, mag: 5, timeMs: 0 },                        // 1 月 1 日 0 時
    { lng: 140, lat: 36, depth: 10, mag: 5, timeMs: day(2020, 100) - jstYearStartMs(2020) },
    { lng: 141, lat: 37, depth: 10, mag: 5, timeMs: jstYearEndMs(2020) - jstYearStartMs(2020) }, // 大晦日の終わり
  ])

  const period = (fromMs: number, toMs: number): CatalogFilter => ({ ...FILTER, fromMs, toMs })

  // 正: 期間に入る日だけ残る。
  it('期間の中の日だけ残る', () => {
    const c = buildCatalogPointCloud([y2020], period(day(2020, 50), day(2020, 150) - 1), VIEW)
    expect(Array.from(c.columns.lng)).toEqual([140])
  })

  // 対照: 年をまたがずに、同じ年の中で切れる。**年単位のままだとここが 3 件になる。**
  it('同じ年の中で切れる', () => {
    const whole = buildCatalogPointCloud([y2020], period(jstYearStartMs(2020), jstYearEndMs(2020)), VIEW)
    expect(whole.columns.count).toBe(3)
    const half = buildCatalogPointCloud([y2020], period(jstYearStartMs(2020), day(2020, 200)), VIEW)
    expect(half.columns.count).toBe(2)
  })

  // **安全弁: 両端を含む。** 年の頭ちょうどと大晦日の終わりに起きた地震が落ちないこと。
  it('両端の瞬間も含む', () => {
    const c = buildCatalogPointCloud([y2020], period(jstYearStartMs(2020), jstYearEndMs(2020)), VIEW)
    expect(c.columns.count).toBe(3)
  })

  // **安全弁: 開始と終了が逆でも同じ範囲。** 逆転した値で 0 件になると、原因が画面に出ない。
  it('開始と終了が逆でも同じ', () => {
    const forward = buildCatalogPointCloud([y2020], period(day(2020, 50), day(2020, 150) - 1), VIEW)
    const reverse = buildCatalogPointCloud([y2020], period(day(2020, 150) - 1, day(2020, 50)), VIEW)
    expect(Array.from(reverse.columns.lng)).toEqual(Array.from(forward.columns.lng))
  })
})

describe('日本時間の暦日', () => {
  // 正: 年の頭と終わりを日本時間で返す。**実行環境が UTC でもずれないこと。**
  it('年の両端は日本時間の 0 時と 23:59:59.999', () => {
    expect(new Date(jstYearStartMs(2020)).toISOString()).toBe('2019-12-31T15:00:00.000Z')
    expect(new Date(jstYearEndMs(2020)).toISOString()).toBe('2020-12-31T14:59:59.999Z')
  })

  // 対照: 年をまたぐ瞬間で年が切り替わる。
  it('年の境目で切り替わる', () => {
    expect(jstYearOf(jstYearEndMs(2020))).toBe(2020)
    expect(jstYearOf(jstYearEndMs(2020) + 1)).toBe(2021)
  })

  // 正: 日付ピッカーの値と往復できる。
  it('日付ピッカーの値と往復する', () => {
    const ms = fromDateInputValue('2020-03-14', 'start')
    expect(ms).not.toBeNull()
    expect(toDateInputValue(ms!)).toBe('2020-03-14')
    expect(formatJstDate(ms!)).toBe('2020年3月14日')
  })

  // 正: 終わり側はその日の最後の瞬間。
  it('終わり側はその日の最後の瞬間', () => {
    const end = fromDateInputValue('2020-03-14', 'end')
    expect(end).not.toBeNull()
    expect(toDateInputValue(end!)).toBe('2020-03-14')
    expect(end! - fromDateInputValue('2020-03-14', 'start')!).toBe(24 * 60 * 60 * 1000 - 1)
  })

  // **安全弁: 存在しない日を採らない。** `Date.UTC` は翌月へ繰り上げて別の日を黙って返す。
  it('存在しない日は null', () => {
    expect(fromDateInputValue('2021-02-30', 'start')).toBeNull()
    expect(fromDateInputValue('2020-13-01', 'start')).toBeNull()
  })

  // 安全弁: 打鍵の途中や空欄でも null（呼び出し側は今の値を保つ）。
  it('読めない値は null', () => {
    expect(fromDateInputValue('', 'start')).toBeNull()
    expect(fromDateInputValue('2020-3-1', 'start')).toBeNull()
    expect(fromDateInputValue('abc', 'start')).toBeNull()
  })

  // 正: 日数は両端を含む。
  it('日数は両端を含む', () => {
    const from = fromDateInputValue('2020-03-14', 'start')!
    const to = fromDateInputValue('2020-03-14', 'end')!
    expect(periodDayCount(from, to)).toBe(1)
    expect(periodDayCount(from, fromDateInputValue('2020-03-16', 'end')!)).toBe(3)
  })

  // 正: 1 年ぶんはうるう年で 366 日。
  it('うるう年は 366 日', () => {
    expect(periodDayCount(jstYearStartMs(2020), jstYearEndMs(2020))).toBe(366)
    expect(periodDayCount(jstYearStartMs(2021), jstYearEndMs(2021))).toBe(365)
  })
})

describe('色は上端・深い側でも分かれる', () => {
  /** その M・その深さの点 1 つを作って色を読む。 */
  const colorOf = (over: { mag?: number; depth?: number }, colorBy: 'magnitude' | 'depth') => {
    const y = makeYear(2020, [{ lng: 139, lat: 35, depth: over.depth ?? 10, mag: over.mag ?? 5, timeMs: 0 }])
    const c = buildCatalogPointCloud([y], FILTER, { ...VIEW, colorBy })
    expect(c.columns.count).toBe(1)
    return Array.from(c.columns.color)
  }

  /** 2 色の隔たり（RGB を 0〜1 の座標と見た距離）。 */
  const colorDistance = (x: number[], y: number[]) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])

  /**
   * 見分けが付くとみなす隔たりの下限。**実測から置いた値。**
   *
   * **「色が違う」だけでは足りない。** 飽和より手前の値どうしは、直す前も数値としては違って
   * いた——目で見分けられるかは別の話で、それを言うには量が要る。実際、直す前は深さの
   * 100km 刻み（300km 以深）が 0.094〜0.114 しかなく、M8→M9 は 0.000（完全に同色）だった。
   * いまは深さが 0.150〜0.196、マグニチュードが 0.191〜0.473。この値はその間に置いてある。
   */
  const DISTINCT = 0.13

  // **正: M8 と M9 が見分けられる。** 上端を M8 で飽和させていた頃はここが完全に同色だった。
  it('M8 と M9 は見分けが付く', () => {
    expect(colorDistance(colorOf({ mag: 8 }, 'magnitude'), colorOf({ mag: 9 }, 'magnitude')))
      .toBeGreaterThan(DISTINCT)
  })

  // 対照: 実用域（件数の 99% 以上）でも段階的に変わる。
  it.each([[2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8]])('M%s と M%s は見分けが付く', (lo, hi) => {
    expect(colorDistance(colorOf({ mag: lo }, 'magnitude'), colorOf({ mag: hi }, 'magnitude')))
      .toBeGreaterThan(DISTINCT)
  })

  // **安全弁: 飽和より上は同じ色。** 飽和させること自体は保つ（外挿すると 0〜1 を外れる）。
  it('飽和より上は同じ色', () => {
    expect(colorOf({ mag: MAGNITUDE_RAMP_RANGE.max }, 'magnitude'))
      .toEqual(colorOf({ mag: MAGNITUDE_RAMP_RANGE.max + 3 }, 'magnitude'))
  })

  // **正: 深い側も 100km 刻みで分かれる。** 深発地震の主体は 300〜450km で、
  // ここが潰れると日本のスラブが 1 色になる。
  it.each([[300, 400], [400, 500], [500, 600], [600, 700]])('深さ %s km と %s km は見分けが付く', (lo, hi) => {
    expect(colorDistance(colorOf({ depth: lo }, 'depth'), colorOf({ depth: hi }, 'depth')))
      .toBeGreaterThan(DISTINCT)
  })

  // 対照: 浅い側の分解能も残っている（大半の地震は 50km より浅い）。
  it.each([[0, 10], [10, 30], [30, 60], [60, 100], [100, 200], [200, 300]])(
    '深さ %s km と %s km は見分けが付く',
    (lo, hi) => {
      expect(colorDistance(colorOf({ depth: lo }, 'depth'), colorOf({ depth: hi }, 'depth')))
        .toBeGreaterThan(DISTINCT)
    },
  )

  // 安全弁: どの深さでも色は 0〜1 に収まる。
  it.each([0, 10, 100, 400, 700, 750, 900])('深さ %s km の色が 0〜1', (depth) => {
    expect(colorOf({ depth }, 'depth').every((v) => v >= 0 && v <= 1)).toBe(true)
  })
})

describe('clampDayToRange', () => {
  const min = jstYearStartMs(2020)
  const max = jstYearEndMs(2026)
  const DAY = 24 * 60 * 60 * 1000

  // 正: 範囲の中はそのまま、その日の始まりと終わりを返す。
  it('範囲の中はそのまま', () => {
    const r = clampDayToRange('2024-03-14', min, max)
    expect(r).not.toBeNull()
    expect(toDateInputValue(r![0])).toBe('2024-03-14')
    expect(toDateInputValue(r![1])).toBe('2024-03-14')
    expect(r![1] - r![0]).toBe(DAY - 1)
  })

  // 対照: 範囲の外は端の日へ寄せる。
  it('範囲より前は最初の日へ', () => {
    expect(toDateInputValue(clampDayToRange('1900-01-01', min, max)![0])).toBe('2020-01-01')
  })

  it('範囲より後は最後の日へ', () => {
    expect(toDateInputValue(clampDayToRange('2099-12-31', min, max)![0])).toBe('2026-12-31')
  })

  // **安全弁: 寄せた後も 1 日ぶんの幅が残る。**
  // 始まりと終わりを別々に時刻で丸めると、範囲より先の日で両方が範囲の終わり（その日の最後の
  // 瞬間）へ寄り、**幅が 1 ミリ秒へ潰れる**。そうなると 1 件も残らないのに、見出しは
  // 「1 日ぶん」ともっともらしく出るため原因に辿り着けない。
  it.each(['1900-01-01', '2099-12-31'])('%s へ寄せても 1 日ぶんの幅が残る', (value) => {
    const r = clampDayToRange(value, min, max)
    expect(r![1] - r![0]).toBe(DAY - 1)
    expect(periodDayCount(r![0], r![1])).toBe(1)
  })

  // 安全弁: 寄せた先が範囲からはみ出さない。
  it.each(['1900-01-01', '2099-12-31'])('%s へ寄せても範囲の中に収まる', (value) => {
    const r = clampDayToRange(value, min, max)
    expect(r![0]).toBeGreaterThanOrEqual(min)
    expect(r![1]).toBeLessThanOrEqual(max)
  })

  // 対照: 範囲の端ちょうどの日は寄せない。
  it('範囲の端ちょうどは寄せない', () => {
    expect(clampDayToRange('2020-01-01', min, max)![0]).toBe(min)
    expect(clampDayToRange('2026-12-31', min, max)![1]).toBe(max)
  })

  // 安全弁: 読めない値は null（呼び出し側は今の値を保つ）。
  it('読めない値は null', () => {
    expect(clampDayToRange('', min, max)).toBeNull()
    expect(clampDayToRange('2021-02-30', min, max)).toBeNull()
  })
})

describe('clampPeriodToRange', () => {
  const min = jstYearStartMs(1919)
  const max = jstYearEndMs(2025)
  const DAY = 24 * 60 * 60 * 1000

  // 正: 範囲の中はそのまま。
  it('範囲の中はそのまま', () => {
    const period = { fromMs: jstYearStartMs(2020), toMs: jstYearEndMs(2021) }
    expect(clampPeriodToRange(period, min, max)).toEqual(period)
  })

  // 対照: はみ出した側だけ寄る。
  it('片側だけはみ出したらその側だけ寄る', () => {
    const period = { fromMs: jstYearStartMs(2020), toMs: jstYearEndMs(2026) }
    const r = clampPeriodToRange(period, min, max)
    expect(r.fromMs).toBe(period.fromMs)
    expect(r.toMs).toBe(max)
  })

  // **安全弁: 期間が丸ごと範囲の外にあっても幅が消えない。**
  // 両端をそれぞれ時刻で丸めると同じ 1 点へ寄り、1 件も残らないのに見出しは「1 日ぶん」と出る。
  // 年が明けた直後、その年ぶんのカタログがまだ生成されていないときに起こりうる。
  it('期間が丸ごと後ろへ外れても 1 日ぶんの幅が残る', () => {
    const r = clampPeriodToRange({ fromMs: jstYearStartMs(2026), toMs: jstYearEndMs(2026) }, min, max)
    expect(r.toMs - r.fromMs).toBe(DAY - 1)
    expect(periodDayCount(r.fromMs, r.toMs)).toBe(1)
    expect(r.toMs).toBe(max)
  })

  it('期間が丸ごと前へ外れても 1 日ぶんの幅が残る', () => {
    const r = clampPeriodToRange({ fromMs: jstYearStartMs(1900), toMs: jstYearEndMs(1900) }, min, max)
    expect(r.toMs - r.fromMs).toBe(DAY - 1)
    expect(periodDayCount(r.fromMs, r.toMs)).toBe(1)
    expect(r.fromMs).toBe(min)
  })

  // **安全弁: 非有限な値が来ても例外を投げない。**
  // 日付を組み立てる側（`toDateInputValue`）は非有限で例外を投げるので、素通りさせると
  // 画面ごと落ちる（震源カタログタブは常時マウントされている）。
  it('非有限な期間でも例外を投げない', () => {
    expect(() => clampPeriodToRange({ fromMs: Number.NaN, toMs: Number.NaN }, min, max)).not.toThrow()
  })

  // 安全弁: 寄せた先が範囲からはみ出さない。
  it.each([
    [jstYearStartMs(2026), jstYearEndMs(2026)],
    [jstYearStartMs(1900), jstYearEndMs(1900)],
  ])('外れた期間を寄せても範囲の中に収まる', (fromMs, toMs) => {
    const r = clampPeriodToRange({ fromMs, toMs }, min, max)
    expect(r.fromMs).toBeGreaterThanOrEqual(min)
    expect(r.toMs).toBeLessThanOrEqual(max)
    expect(r.fromMs).toBeLessThan(r.toMs)
  })
})

describe('periodFromYearChange', () => {
  /** 2020 年 6 月 15 日 〜 2024 年 3 月 2 日。両端とも年の途中。 */
  const period = {
    fromMs: fromDateInputValue('2020-06-15', 'start')!,
    toMs: fromDateInputValue('2024-03-02', 'end')!,
  }

  // 正: 動かした側は年の境界へ。
  it('動かした側は年の頭・末へ', () => {
    const r = periodFromYearChange(period, 2018, 2024)
    expect(r.fromMs).toBe(jstYearStartMs(2018))
  })

  // **対照: 動かしていない側の日付は保つ。**
  // 両方を年へ丸め直すと、片方のつまみを触っただけでもう片方の日付指定が黙って消える。
  it('動かしていない側の日付は保つ', () => {
    expect(periodFromYearChange(period, 2018, 2024).toMs).toBe(period.toMs)
    expect(periodFromYearChange(period, 2020, 2026).fromMs).toBe(period.fromMs)
  })

  // 対照: 同じ年を指したままなら何も変わらない。
  it('同じ年のままなら変わらない', () => {
    expect(periodFromYearChange(period, 2020, 2024)).toEqual(period)
  })

  // **安全弁: どの動かし方でも逆転しない。**
  // つまみ側が `from <= to` を保証していても、片側の日付を保つとその関係が崩れうる。
  it.each([
    [2018, 2024], [2020, 2026], [2024, 2024], [2020, 2020], [2018, 2018], [2026, 2026],
  ])('%i〜%i へ動かしても開始が終了を越えない', (fromYear, toYear) => {
    const r = periodFromYearChange(period, fromYear, toYear)
    expect(r.fromMs).toBeLessThanOrEqual(r.toMs)
  })
})

describe('periodFromDateChange', () => {
  const min = jstYearStartMs(1919)
  const max = jstYearEndMs(2025)
  const period = {
    fromMs: fromDateInputValue('2020-06-15', 'start')!,
    toMs: fromDateInputValue('2024-03-02', 'end')!,
  }

  // 正: 変えた側だけが動く。
  it('変えた側だけが動く', () => {
    const r = periodFromDateChange(period, '2021-01-10', 'from', min, max)!
    expect(toDateInputValue(r.fromMs)).toBe('2021-01-10')
    expect(r.toMs).toBe(period.toMs)
  })

  // 対照: 相手を追い越したら押す。
  it('相手を追い越したら押す', () => {
    const r = periodFromDateChange(period, '2025-05-05', 'from', min, max)!
    expect(toDateInputValue(r.fromMs)).toBe('2025-05-05')
    expect(toDateInputValue(r.toMs)).toBe('2025-05-05')
  })

  // **安全弁: 押した先も日の境界に乗る。** 時刻で押すと終了が「その日の 0 時」になり幅が消える。
  it.each(['from', 'to'] as const)('%s 側で押しても 1 日ぶんの幅が残る', (edge) => {
    const value = edge === 'from' ? '2025-05-05' : '2019-01-01'
    const r = periodFromDateChange(period, value, edge, min, max)!
    expect(periodDayCount(r.fromMs, r.toMs)).toBe(1)
    expect(r.toMs - r.fromMs).toBe(24 * 60 * 60 * 1000 - 1)
  })

  // 安全弁: 収録の外を指す日は端の 1 日へ寄せる（打鍵では範囲外も入る）。
  it('範囲の外は端の日へ寄せる', () => {
    const r = periodFromDateChange(period, '2099-12-31', 'to', min, max)!
    expect(r.toMs).toBe(max)
    expect(r.fromMs).toBe(period.fromMs)
  })

  // 対照: 押した先の日付は from 側・to 側で同じ形になる（片側だけ緩い検査にしない）。
  it('to 側で押しても開始はその日の始まりへ', () => {
    const r = periodFromDateChange(period, '2019-01-01', 'to', min, max)!
    expect(toDateInputValue(r.fromMs)).toBe('2019-01-01')
    expect(toDateInputValue(r.toMs)).toBe('2019-01-01')
  })

  // 安全弁: 読めない値は null（呼び出し側は今の値を保つ）。
  it('読めない値は null', () => {
    expect(periodFromDateChange(period, '', 'from', min, max)).toBeNull()
    expect(periodFromDateChange(period, '2021-02-30', 'to', min, max)).toBeNull()
  })
})
