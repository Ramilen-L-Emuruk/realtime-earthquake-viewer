import { describe, expect, test } from 'vitest'
import {
  CATALOG_MAX_DISTANCE_KM,
  catalogYearsFor,
  findCatalogOriginMs,
  findJmaEventId,
  parseJstTimeMs,
  resolveOriginSeconds,
  usableEewOrigin,
  withinQuakeMinute,
  type CatalogColumns,
  type JmaQuakeListEntry,
} from './quakeOriginSeconds'

/** 地震情報の発生時刻（分まで）。 */
const QUAKE_MS = Date.parse('2026-10-03T13:26:00+09:00')
const EEW_MS = Date.parse('2026-10-03T13:26:01+09:00')
const CATALOG_MS = Date.parse('2026-10-03T13:26:00.85+09:00')

describe('withinQuakeMinute', () => {
  // 正・対照・安全弁: 分の頭の 30 秒前〜65 秒後だけを同じ地震の発生時刻として認める。
  // 前を 30 秒取るのは、カードの時刻が発生ではなく地震発現（最初に揺れを捉えた時刻）の分だから。
  test('分の頭の 30 秒前〜65 秒後なら入る（両端を含む）', () => {
    expect(withinQuakeMinute(QUAKE_MS, QUAKE_MS - 30_000)).toBe(true)
    expect(withinQuakeMinute(QUAKE_MS, QUAKE_MS + 65_000)).toBe(true)
  })

  test('その外は入らない', () => {
    expect(withinQuakeMinute(QUAKE_MS, QUAKE_MS - 30_001)).toBe(false)
    expect(withinQuakeMinute(QUAKE_MS, QUAKE_MS + 65_001)).toBe(false)
  })

  test('地震情報の時刻に秒が残っていても分の頭で測る', () => {
    expect(withinQuakeMinute(QUAKE_MS + 30_000, QUAKE_MS - 4_000)).toBe(true)
  })

  test('有限でない値は入らない', () => {
    expect(withinQuakeMinute(Number.NaN, EEW_MS)).toBe(false)
    expect(withinQuakeMinute(QUAKE_MS, Number.NaN)).toBe(false)
  })
})

describe('usableEewOrigin', () => {
  test('震源の決まった報・見分けられない報の発生時刻は使う', () => {
    expect(usableEewOrigin(QUAKE_MS, { originMs: EEW_MS, assumed: false })).toBe(EEW_MS)
    expect(usableEewOrigin(QUAKE_MS, { originMs: EEW_MS, assumed: null })).toBe(EEW_MS)
  })

  // 2026-10-15 ユーザー承認「仮定震源の報は使わない」。
  test('仮定震源要素の報の発生時刻は使わない', () => {
    expect(usableEewOrigin(QUAKE_MS, { originMs: EEW_MS, assumed: true })).toBeNull()
  })

  // 電文解説資料の出現例４: 同じ地震 ID の中身が別の地震で食い違うことがある。
  test('地震情報の分に入らない緊急地震速報は結ばない', () => {
    expect(usableEewOrigin(QUAKE_MS, { originMs: QUAKE_MS + 120_000, assumed: false })).toBeNull()
  })

  test('記録が無ければ null', () => {
    expect(usableEewOrigin(QUAKE_MS, undefined)).toBeNull()
  })
})

describe('resolveOriginSeconds', () => {
  test('緊急地震速報の発生時刻があればそれを採る（カタログより先）', () => {
    expect(resolveOriginSeconds({
      quakeTimeMs: QUAKE_MS, eew: { originMs: EEW_MS, assumed: false }, catalogOriginMs: CATALOG_MS,
    })).toEqual({ originMs: EEW_MS, source: 'eew' })
  })

  test('使えない緊急地震速報ならカタログを採る', () => {
    expect(resolveOriginSeconds({
      quakeTimeMs: QUAKE_MS, eew: { originMs: EEW_MS, assumed: true }, catalogOriginMs: CATALOG_MS,
    })).toEqual({ originMs: CATALOG_MS, source: 'catalog' })
  })

  // 2026-10-15 ユーザー承認「カタログが届くまで線を引かない」。地震 ID の時刻へは落とさない。
  test('どちらも無ければ秒は無い', () => {
    expect(resolveOriginSeconds({ quakeTimeMs: QUAKE_MS, eew: undefined, catalogOriginMs: null })).toBeNull()
    expect(resolveOriginSeconds({
      quakeTimeMs: QUAKE_MS, eew: { originMs: EEW_MS, assumed: true }, catalogOriginMs: null,
    })).toBeNull()
  })

  test('有限でないカタログの値は採らない', () => {
    expect(resolveOriginSeconds({ quakeTimeMs: QUAKE_MS, eew: undefined, catalogOriginMs: Number.NaN })).toBeNull()
  })
})

/** カタログの 1 年ぶんを組む（時刻の昇順で渡す）。 */
function catalog(rows: readonly { t: number; lat: number; lng: number; m: number }[]): CatalogColumns {
  return {
    timeMs: rows.map((r) => r.t),
    lat: rows.map((r) => r.lat),
    lng: rows.map((r) => r.lng),
    magnitude: rows.map((r) => r.m),
  }
}

describe('findCatalogOriginMs', () => {
  // 熊本県天草・芦北地方あたりの震央。
  const quake = { timeMs: QUAKE_MS, latitude: 32.5, longitude: 130.5, magnitude: 3.5 }
  const covered = QUAKE_MS + 10 * 24 * 3600_000

  test('分・震央・規模が合う地震がちょうど 1 つならその発生時刻', () => {
    const y = catalog([
      { t: QUAKE_MS - 600_000, lat: 32.5, lng: 130.5, m: 3.5 },
      { t: CATALOG_MS, lat: 32.52, lng: 130.48, m: 3.6 },
    ])
    expect(findCatalogOriginMs(quake, [y], covered)).toBe(CATALOG_MS)
  })

  // 群発の最中は同じ分・同じ場所で複数の地震が起きる。取り違えるより線を引かない。
  test('2 つ以上合えば採らない', () => {
    const y = catalog([
      { t: CATALOG_MS, lat: 32.5, lng: 130.5, m: 3.5 },
      { t: CATALOG_MS + 20_000, lat: 32.51, lng: 130.5, m: 3.4 },
    ])
    expect(findCatalogOriginMs(quake, [y], covered)).toBeNull()
  })

  test('震央が離れている・規模が違う地震は数えない', () => {
    const far = 32.5 + (CATALOG_MAX_DISTANCE_KM + 5) / 111
    const y = catalog([
      { t: CATALOG_MS, lat: 32.5, lng: 130.5, m: 3.5 },
      { t: CATALOG_MS + 1_000, lat: far, lng: 130.5, m: 3.5 },
      { t: CATALOG_MS + 2_000, lat: 32.5, lng: 130.5, m: 2.9 },
    ])
    expect(findCatalogOriginMs(quake, [y], covered)).toBe(CATALOG_MS)
  })

  // 安全弁: 規模は Float32 で持つので、ちょうど 0.3 違う地震が丸めで外れない。
  test('規模の差がちょうど 0.3 なら数える（Float32 の丸めで外さない）', () => {
    const y = catalog([{ t: CATALOG_MS, lat: 32.5, lng: 130.5, m: Math.fround(3.8) }])
    expect(findCatalogOriginMs(quake, [y], covered)).toBe(CATALOG_MS)
  })

  test('分の外の地震は数えない', () => {
    const y = catalog([{ t: QUAKE_MS + 70_000, lat: 32.5, lng: 130.5, m: 3.5 }])
    expect(findCatalogOriginMs(quake, [y], covered)).toBeNull()
  })

  // 安全弁: まだ載っていない期間で「1 つに決まった」と言わない。
  test('分の幅がカタログの終端を越えるなら引かない', () => {
    const y = catalog([{ t: CATALOG_MS, lat: 32.5, lng: 130.5, m: 3.5 }])
    expect(findCatalogOriginMs(quake, [y], QUAKE_MS + 30_000)).toBeNull()
  })

  test('震央か規模が判らない地震では引かない', () => {
    const y = catalog([{ t: CATALOG_MS, lat: 32.5, lng: 130.5, m: 3.5 }])
    expect(findCatalogOriginMs({ ...quake, latitude: -200, longitude: -200 }, [y], covered)).toBeNull()
    expect(findCatalogOriginMs({ ...quake, magnitude: Number.NaN }, [y], covered)).toBeNull()
  })

  test('年をまたぐ地震は両方の年から探す', () => {
    const newYear = Date.parse('2026-01-01T00:00:00+09:00')
    const q = { ...quake, timeMs: Date.parse('2025-12-31T23:59:00+09:00') }
    const y2025 = catalog([])
    const y2026 = catalog([{ t: newYear + 3_000, lat: 32.5, lng: 130.5, m: 3.5 }])
    expect(findCatalogOriginMs(q, [y2025, y2026], newYear + 86400_000)).toBe(newYear + 3_000)
  })
})

describe('catalogYearsFor', () => {
  test('日本時間の暦年で数える（UTC では前年）', () => {
    expect(catalogYearsFor(Date.parse('2026-01-01T03:00:00+09:00'))).toEqual([2026])
  })

  test('分の幅が年をまたぐなら両方', () => {
    expect(catalogYearsFor(Date.parse('2025-12-31T23:59:00+09:00'))).toEqual([2025, 2026])
    expect(catalogYearsFor(Date.parse('2026-01-01T00:00:00+09:00'))).toEqual([2025, 2026])
  })
})

describe('findJmaEventId', () => {
  // 実際の一覧（2026-10-04 取得）から取った 2 件。同じ震央地名で 73 秒違い。
  const entries: JmaQuakeListEntry[] = [
    { eid: '20261003132605', at: '2026-10-03T13:26:00+09:00', anm: '熊本県天草・芦北地方', mag: '3.5' },
    { eid: '20261003132605', at: '2026-10-03T13:26:00+09:00', anm: '熊本県天草・芦北地方', mag: '3.5' },
    { eid: '20261003132452', at: '2026-10-03T13:24:00+09:00', anm: '熊本県天草・芦北地方', mag: '3.0' },
  ]
  const quake = (time: string, epicenter: string, magnitude: number | null) => ({
    timeMs: Date.parse(time), epicenter, magnitude,
  })

  test('分と震央地名が一致する地震 ID を返す（同じ地震の行が複数あっても 1 つに数える）', () => {
    expect(findJmaEventId(quake('2026-10-03T13:26:00+09:00', '熊本県天草・芦北地方', 3.5), entries))
      .toBe('20261003132605')
  })

  test('分が違えば別の地震として扱う', () => {
    expect(findJmaEventId(quake('2026-10-03T13:24:00+09:00', '熊本県天草・芦北地方', 3.0), entries))
      .toBe('20261003132452')
  })

  test('震央地名が違えば引かない', () => {
    expect(findJmaEventId(quake('2026-10-03T13:26:00+09:00', '熊本県熊本地方', 3.5), entries)).toBeNull()
  })

  test('同じ分・同じ震央地名の別の地震は規模で絞る', () => {
    const twin: JmaQuakeListEntry[] = [
      { eid: 'A0000000000001', at: '2026-10-03T13:26:00+09:00', anm: '茨城県南部', mag: '3.1' },
      { eid: 'A0000000000002', at: '2026-10-03T13:26:00+09:00', anm: '茨城県南部', mag: '4.2' },
    ]
    expect(findJmaEventId(quake('2026-10-03T13:26:00+09:00', '茨城県南部', 4.2), twin)).toBe('A0000000000002')
  })

  // 安全弁: 取り違えると別の地震の秒で線を引く。決められなければ引かない。
  test('規模でも決まらなければ null', () => {
    const twin: JmaQuakeListEntry[] = [
      { eid: 'A0000000000001', at: '2026-10-03T13:26:00+09:00', anm: '茨城県南部', mag: '3.1' },
      { eid: 'A0000000000002', at: '2026-10-03T13:26:00+09:00', anm: '茨城県南部', mag: '3.1' },
    ]
    expect(findJmaEventId(quake('2026-10-03T13:26:00+09:00', '茨城県南部', 3.1), twin)).toBeNull()
    expect(findJmaEventId(quake('2026-10-03T13:26:00+09:00', '茨城県南部', null), twin)).toBeNull()
  })

  test('時刻が読めない地震カードは引かない', () => {
    expect(findJmaEventId({ timeMs: Number.NaN, epicenter: '熊本県天草・芦北地方', magnitude: 3.5 }, entries))
      .toBeNull()
  })
})

describe('parseJstTimeMs', () => {
  // **端末の時間帯に依らないことを固定する。** テストは日本時間で走るので `new Date()` と比べても
  // 違いは出ない。時間帯つきの絶対時刻と突き合わせる。
  test('P2PQuake の時計表記を日本時間として読む', () => {
    expect(parseJstTimeMs('2026/10/03 13:26:00')).toBe(Date.parse('2026-10-03T13:26:00+09:00'))
  })

  test('小数秒つき・秒なしも読む', () => {
    expect(parseJstTimeMs('2026/10/03 13:26:05.500')).toBe(Date.parse('2026-10-03T13:26:05+09:00'))
    expect(parseJstTimeMs('2026/10/03 13:26')).toBe(Date.parse('2026-10-03T13:26:00+09:00'))
  })

  test('時間帯を持つ表記（DMDATA の ISO 形式）はそのまま読む', () => {
    expect(parseJstTimeMs('2026-10-03T04:26:00Z')).toBe(Date.parse('2026-10-03T13:26:00+09:00'))
    expect(parseJstTimeMs('2026-10-03T13:26:00+09:00')).toBe(Date.parse('2026-10-03T13:26:00+09:00'))
  })

  test('存在しない日時・読めない文字列は NaN', () => {
    expect(parseJstTimeMs('2026/02/30 12:00:00')).toBeNaN()
    expect(parseJstTimeMs('こわれた時刻')).toBeNaN()
  })
})
