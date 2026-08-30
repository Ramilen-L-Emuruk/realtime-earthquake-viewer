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
  oldestYearOf,
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
  minDepthKm: 0,
  maxDepthKm: 700,
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

  // 安全弁: 大小関係だけを保ち、極端な倍率にしない（エネルギー比で写すと M2 と M9 で 300 億倍になる）。
  it('倍率は 3.5 倍で頭打ち', () => {
    expect(pointSizePx(4, 20, 'magnitude')).toBe(4 * 3.5)
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
