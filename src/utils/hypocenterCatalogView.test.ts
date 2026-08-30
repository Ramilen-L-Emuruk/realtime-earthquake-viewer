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
  timeMs: Float64Array.from(events.map((e) => e.timeMs)),
  lat: Float64Array.from(events.map((e) => e.lat)),
  lng: Float64Array.from(events.map((e) => e.lng)),
  depth: Float32Array.from(events.map((e) => e.depth)),
  magnitude: Float32Array.from(events.map((e) => e.mag)),
  intensityIdx: new Int32Array(0),
  intensityCode: [],
})

const FILTER: CatalogFilter = {
  fromYear: 2020,
  toYear: 2021,
  minMagnitude: 2,
  maxMagnitude: 9,
  minDepthKm: 0,
  maxDepthKm: 700,
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
    [3, 0.6],
    [5, 1.8],
    [7, 3.0],
    [9, 4.2],
  ])('M%s で基準の %s 倍', (m, ratio) => {
    expect(pointSizePx(10, m, 'magnitude')).toBeCloseTo(10 * ratio, 6)
  })

  // **安全弁: 収録の下限（M2.0）で 0 倍にしない。** 傾きだけで決めると、最も件数の多い
  // 地震が 1 つ残らず消える。
  it('M2.0 でも消えない', () => {
    expect(pointSizePx(10, 2, 'magnitude')).toBe(10 * 0.35)
  })

  // 安全弁: 大小関係だけを保ち、極端な倍率にしない（エネルギー比で写すと M2 と M9 で 300 億倍になる）。
  it('倍率は 5 倍で頭打ち', () => {
    expect(pointSizePx(4, 20, 'magnitude')).toBe(4 * 5)
  })

  // 安全弁: M が欠測でも数値を返す（NaN を渡すと点が消える）。
  it('マグニチュードが NaN でも有限', () => {
    expect(Number.isFinite(pointSizePx(4, Number.NaN, 'magnitude'))).toBe(true)
  })
})

describe('catalogCompleteness', () => {
  const f = (fromYear: number, toYear: number, minMagnitude: number): CatalogFilter =>
    ({ ...FILTER, fromYear, toYear, minMagnitude })

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
    withCompleteMagnitudeFloor(INDEX, prev, { ...prev, fromYear, toYear })

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
    const wide = f({ fromYear: 1919, toYear: 2022, minMagnitude: 5 })
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
    expect(oldestYearOf({ fromYear: 2020, toYear: 1960 })).toBe(1960)
    expect(oldestYearOf({ fromYear: 1960, toYear: 2020 })).toBe(1960)
  })

  it('同じ年なら その年', () => {
    expect(oldestYearOf({ fromYear: 2000, toYear: 2000 })).toBe(2000)
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
  it('マグニチュードの絞り込みは収録の最大まで届く', () => {
    expect(MAGNITUDE_FILTER_RANGE.max).toBe(9)
    expect(MAGNITUDE_FILTER_RANGE.max).toBeGreaterThan(MAGNITUDE_RAMP_RANGE.max)
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
  it('端なら 700km より深い地震も残る', () => {
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
