import { describe, it, expect } from 'vitest'
import { isValidLpgmClass, getLpgmClassLabel, getLpgmClassColor, getLpgmClassRadius, lpgmCategoryNote, lpgmPeriodLabel, buildLpgmRows, type LpgmRowDeps } from './lpgm'
import type { LpgmPoint, LpgmRegion } from '../types/earthquake'
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

describe('lpgmPeriodLabel', () => {
  // 電文の `PeriodicBand` は 1〜7 で、気象庁は 1.5〜2.5 秒台を第 1 帯とし
  // 1 秒刻みで 7.5〜8.5 秒台の第 7 帯まで置く（電文解説資料 Ⅱ.37）。
  it('帯の番号を中心周期で書く（番号のままでは意味が伝わらない）', () => {
    expect(lpgmPeriodLabel(1)).toBe('2秒')
    expect(lpgmPeriodLabel(7)).toBe('8秒')
  })

  it('値域の外は「周期不明」に倒す（型検査が及ばない経路から来る）', () => {
    expect(lpgmPeriodLabel(0)).toBe('周期不明')
    expect(lpgmPeriodLabel(8)).toBe('周期不明')
    expect(lpgmPeriodLabel(1.5)).toBe('周期不明')
    expect(lpgmPeriodLabel(NaN)).toBe('周期不明')
  })
})

describe('buildLpgmRows', () => {
  // 座標表からの逆引きは「電文が県を書いていない区域」の代理なので、既定では引けない状態で試す。
  const deps: LpgmRowDeps = { prefOfArea: () => null, rank: () => 0 }
  const region = (name: string, maxLgInt: number, extra: Partial<LpgmRegion> = {}): LpgmRegion =>
    ({ code: '', name, maxLgInt, ...extra })
  const station = (name: string, lgInt: number, extra: Partial<LpgmPoint> = {}): LpgmPoint =>
    ({ code: '', name, pref: '', lgInt, ...extra })

  // 正: 県内の階級がばらついていても県 1 行にまとめる。以前は「全区域が揃って同一階級」の
  // ときだけまとめており、実電文ではほとんどの県が個別区域として平らに並んでいた。
  it('正: 県内の階級がばらついていても県 1 行にまとめ、配下へ区域を入れる', () => {
    const rows = buildLpgmRows(
      [region('石川県能登', 4, { pref: '石川県' }), region('石川県加賀', 3, { pref: '石川県' })],
      [], [], deps,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('石川県')
    expect(rows[0].areas.map(a => a.name)).toEqual(['石川県能登', '石川県加賀'])
  })

  // 対照: 県を引けない区域は最上段に残す（区域名のまま並び、開いても県は現れない）。
  // **種別を持たせる** —— 区域名と県名は一致しうるので、画面の鍵を名前だけで作れない。
  it('対照: 都道府県を引けない区域は最上段の葉のまま残す', () => {
    expect(buildLpgmRows([region('どこかの区域', 2)], [], [], deps)).toEqual([
      { kind: 'area', name: 'どこかの区域', maxLgInt: 2, areas: [], stations: [] },
    ])
  })

  // 安全弁: 配下が 1 つも立たなくても、電文が県の階級を書いていれば行にする。
  // 区域の階級がどれも読めず観測点も無い電文で、気象庁が報告している県が消えないこと
  // （震度側の `buildIntensityRows` も都道府県ロールアップ点をループ対象に含めている）。
  it('安全弁: 区域も観測点も無くても、電文が県の階級を書いていれば行にする', () => {
    const rows = buildLpgmRows([], [], [{ code: '17', name: '石川県', maxLgInt: 4, maxInt: 70 }], deps)
    expect(rows).toEqual([
      { kind: 'pref', name: '石川県', maxLgInt: 4, maxInt: 70, areas: [], stations: [] },
    ])
  })

  it('電文が県を書いていない区域は座標表から逆引きする', () => {
    const rows = buildLpgmRows([region('石川県能登', 4)], [], [], {
      prefOfArea: n => (n === '石川県能登' ? '石川県' : null),
      rank: () => 0,
    })
    expect(rows[0].name).toBe('石川県')
  })

  it('観測点は電文の区域名（Area/Name）で区域の下へ入れる', () => {
    const rows = buildLpgmRows(
      [region('石川県能登', 4, { pref: '石川県' })],
      [station('七尾市本府中町', 4, { pref: '石川県', area: '石川県能登', int: 55 })],
      [], deps,
    )
    expect(rows[0].areas[0].stations).toEqual([{ name: '七尾市本府中町', lgInt: 4, int: 55 }])
  })

  it('区域が分からない観測点は県の直下へ置く', () => {
    const rows = buildLpgmRows(
      [region('石川県能登', 4, { pref: '石川県' })],
      [station('七尾市本府中町', 4, { pref: '石川県' })],
      [], deps,
    )
    expect(rows[0].areas[0].stations).toEqual([])
    expect(rows[0].stations.map(s => s.name)).toEqual(['七尾市本府中町'])
  })

  it('県も区域も分からない観測点は置き場が無いので落とす', () => {
    const rows = buildLpgmRows([region('石川県能登', 4, { pref: '石川県' })], [station('どこか', 4)], [], deps)
    expect(rows[0].stations).toEqual([])
    expect(rows[0].areas[0].stations).toEqual([])
  })

  // 安全弁: 県・区域の値は電文が書いているものを優先し、配下から積み上げ直さない。
  // 積み上げに寄せると、区域や観測点を 1 つ読み落としたときに静かに低く出る。
  it('安全弁: 県の階級・震度は電文（prefs）を優先し、配下から積み上げない', () => {
    const rows = buildLpgmRows(
      [region('石川県能登', 4, { pref: '石川県', maxInt: 70 })],
      [],
      [{ code: '17', name: '石川県', maxLgInt: 3, maxInt: 50 }],
      deps,
    )
    expect(rows[0].maxLgInt).toBe(3)
    expect(rows[0].maxInt).toBe(50)
  })

  it('電文が県の値を持たなければ配下から積み上げる', () => {
    const rows = buildLpgmRows(
      [
        region('石川県能登', 4, { pref: '石川県', maxInt: 70 }),
        region('石川県加賀', 3, { pref: '石川県', maxInt: 50 }),
      ],
      [], [], deps,
    )
    expect(rows[0].maxLgInt).toBe(4)
    expect(rows[0].maxInt).toBe(70)
  })

  // 区域の読み取り失敗は「その電文の区域が全滅したとき」しか記録されないので、
  // 配下から立てないと市町村を持たない長周期でも観測点ごと画面から消える。
  it('区域自身の階級が読めなくても、観測点があれば区域の行を立てる', () => {
    const rows = buildLpgmRows(
      [],
      [station('七尾市本府中町', 4, { pref: '石川県', area: '石川県能登', int: 55 })],
      [], deps,
    )
    expect(rows[0].name).toBe('石川県')
    expect(rows[0].areas[0]).toMatchObject({ name: '石川県能登', maxLgInt: 4, maxInt: 55 })
  })

  it('階級を観測していない区域・観測点は行にしない', () => {
    const rows = buildLpgmRows(
      [region('石川県能登', 0, { pref: '石川県' })],
      [station('七尾市本府中町', 0, { pref: '石川県', area: '石川県能登' })],
      [], deps,
    )
    expect(rows).toEqual([])
  })

  it('並びは階級の降順、同じ階級どうしは気象庁の標準順', () => {
    const ranks: Record<string, number> = { 青森県: 1, 岩手県: 2, 青森県津軽北部: 1, 岩手県内陸南部: 2 }
    const rows = buildLpgmRows(
      [
        region('岩手県内陸南部', 2, { pref: '岩手県' }),
        region('青森県津軽北部', 2, { pref: '青森県' }),
        region('石川県能登', 4, { pref: '石川県' }),
      ],
      [], [], { prefOfArea: () => null, rank: n => ranks[n] ?? 99 },
    )
    expect(rows.map(r => r.name)).toEqual(['石川県', '青森県', '岩手県'])
  })

  it('観測点の並びも階級の降順', () => {
    const rows = buildLpgmRows(
      [region('石川県能登', 4, { pref: '石川県' })],
      [
        station('弱いほう', 2, { pref: '石川県', area: '石川県能登' }),
        station('強いほう', 4, { pref: '石川県', area: '石川県能登' }),
      ],
      [], deps,
    )
    expect(rows[0].areas[0].stations.map(s => s.name)).toEqual(['強いほう', '弱いほう'])
  })
})
