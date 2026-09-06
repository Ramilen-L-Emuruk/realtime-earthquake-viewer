import { describe, it, expect } from 'vitest'
import { isValidLpgmClass, getLpgmClassLabel, getLpgmClassColor, getLpgmClassRadius, lpgmCategoryNote } from './lpgm'
import { LPGM_ICON_BASE_RADIUS } from '../components/Map/gl/lpgmIcons'

describe('isValidLpgmClass', () => {
  it('階級 1〜4 を受け入れる', () => {
    for (const v of [1, 2, 3, 4]) expect(isValidLpgmClass(v)).toBe(true)
  })

  it('範囲外の値を弾く', () => {
    for (const v of [0, -1, 5, 99]) expect(isValidLpgmClass(v)).toBe(false)
  })

  it('非整数・特殊値を弾く', () => {
    for (const v of [1.5, NaN, Infinity, -Infinity]) expect(isValidLpgmClass(v)).toBe(false)
  })

  // 型検査が及ばない経路（実地震シナリオ JSON・as キャスト）を守るための関数なので、
  // 実行時に型どおりでない値が来ても誤って通さないことを固定する。
  it('型を迂回した文字列・null・undefined を弾く', () => {
    for (const v of ['1', 'toString', null, undefined]) {
      expect(isValidLpgmClass(v as unknown as number)).toBe(false)
    }
  })
})

describe('getLpgmClassLabel', () => {
  it('階級 1〜4 はそのままラベル化する', () => {
    expect(getLpgmClassLabel(1)).toBe('階級1')
    expect(getLpgmClassLabel(4)).toBe('階級4')
  })

  // 以前はフォールバックが無く、壊れた入力がそのまま「階級99」として地図ラベルに出ていた。
  it('範囲外の値は「階級不明」にフォールバックする', () => {
    for (const v of [0, 5, 99, NaN]) expect(getLpgmClassLabel(v)).toBe('階級不明')
  })
})

describe('getLpgmClassColor', () => {
  it('範囲外の値はグレーにフォールバックする', () => {
    expect(getLpgmClassColor(99)).toBe('#9ca3af')
  })
})

describe('getLpgmClassRadius', () => {
  // 階級が上がるほど大きく見せるための表。以前は階級によらず固定で、最も重い階級4 が
  // 階級1 と同じ大きさだった（map-rendering-spec.md §15）。
  it('階級が上がるほど大きくなる', () => {
    const radii = [1, 2, 3, 4].map(getLpgmClassRadius)
    expect(radii).toEqual([8, 10, 12, 14])
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeGreaterThan(radii[i - 1])
  })

  it('範囲外の値は最小半径にフォールバックする', () => {
    for (const v of [0, 5, 99, NaN, -1]) expect(getLpgmClassRadius(v)).toBe(8)
  })

  // アイコン画像は LPGM_ICON_BASE_RADIUS(=32) で焼いて icon-size で縮小して表示する。
  // 区域バッジは半径に +8 の下駄を履くため、その最大がベース半径を超えると等倍でも
  // 拡大＝文字のぼやけになる（倍率を上げたときの限界は map-rendering-spec.md §15 を参照）。
  it('区域バッジの最大半径が等倍でベース半径を超えない', () => {
    const maxRegionRadius = Math.max(...[1, 2, 3, 4].map(c => getLpgmClassRadius(c) + 8))
    expect(maxRegionRadius).toBeLessThanOrEqual(LPGM_ICON_BASE_RADIUS)
  })
})

// 長周期地震動に関する観測情報の種類（電文の `LgCategory`）。
// **分類番号そのものは利用者に出さない。** 値 2・4 が意味するのは「階級を観測した地域のうち
// 最大震度が4以下の地域がある」＝揺れは強くないのに高層階が大きく揺れた地域がある、という状況。
describe('長周期の観測情報の種類', () => {
  // 正: 2・4 のときだけ意味を出す
  it('2 と 4 では意味を出す', () => {
    expect(lpgmCategoryNote(2)).toBe('震度が小さくても高層階が大きく揺れた地域があります')
    expect(lpgmCategoryNote(4)).toBe('震度が小さくても高層階が大きく揺れた地域があります')
  })

  // 対照: 1・3 は階級を観測した地域がどこも震度5弱以上。震度の表示だけで状況が伝わるので何も足さない
  it('1 と 3 では何も出さない', () => {
    expect(lpgmCategoryNote(1)).toBe('')
    expect(lpgmCategoryNote(3)).toBe('')
  })

  // 安全弁: 種類を持たない電文・値域の外では何も出さない（分類番号を画面に漏らさない）
  it('無い値・値域の外では何も出さない', () => {
    expect(lpgmCategoryNote(undefined)).toBe('')
    expect(lpgmCategoryNote(0)).toBe('')
    expect(lpgmCategoryNote(9)).toBe('')
  })
})
