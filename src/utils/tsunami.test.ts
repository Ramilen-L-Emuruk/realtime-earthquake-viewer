import { describe, it, expect } from 'vitest'
import {
  tsunamiMaxGrade,
  tsunamiOverallGrade,
  isTsunamiNewFire,
  isTsunamiGradeUpgrade,
  matchesArea,
  groupAreasForCardDisplay,
  sortAreasForCardDisplay,
  compareObservedHeightDesc,
  overSuffixedHeight,
} from './tsunami'
import type { JMATsunami, TsunamiArea, TsunamiObservation } from '../types/earthquake'

function makeArea(overrides: Partial<TsunamiArea> = {}): TsunamiArea {
  return {
    code: '100',
    name: 'テスト予報区',
    grade: 'Watch',
    immediate: false,
    ...overrides,
  }
}

function makeTsunami(overrides: Partial<JMATsunami> = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: 'test-tsunami',
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: [makeArea()],
    ...overrides,
  }
}

describe('tsunamiMaxGrade', () => {
  it('areas 内の最高グレードを返す', () => {
    const t = makeTsunami({
      areas: [
        makeArea({ grade: 'Watch' }),
        makeArea({ grade: 'MajorWarning' }),
        makeArea({ grade: 'Warning' }),
      ],
    })
    expect(tsunamiMaxGrade(t)).toBe('MajorWarning')
  })

  it('areas が空なら Unknown', () => {
    const t = makeTsunami({ areas: [] })
    expect(tsunamiMaxGrade(t)).toBe('Unknown')
  })
})

describe('tsunamiOverallGrade', () => {
  it('cancelled/cancelledAt は除外する', () => {
    const t1 = makeTsunami({ areas: [makeArea({ grade: 'MajorWarning' })], cancelled: true })
    const t2 = makeTsunami({ areas: [makeArea({ grade: 'Warning' })] })
    expect(tsunamiOverallGrade([t1, t2])).toBe('Warning')
  })

  it('Forecast/Unknown は除外し MajorWarning>Warning>Watch の順で最大を返す', () => {
    const t = makeTsunami({ areas: [makeArea({ grade: 'Forecast' }), makeArea({ grade: 'Watch' })] })
    expect(tsunamiOverallGrade([t])).toBe('Watch')
  })

  it('候補が無ければ null', () => {
    const t = makeTsunami({ areas: [makeArea({ grade: 'Forecast' })] })
    expect(tsunamiOverallGrade([t])).toBeNull()
  })
})

describe('isTsunamiNewFire', () => {
  it('current 無しは true（新規）', () => {
    const next = makeTsunami({ eventId: 'A' })
    expect(isTsunamiNewFire(next, undefined)).toBe(true)
  })

  it('current が cancelled は true（新規）', () => {
    const current = makeTsunami({ eventId: 'A', cancelled: true })
    const next = makeTsunami({ eventId: 'A' })
    expect(isTsunamiNewFire(next, current)).toBe(true)
  })

  it('current が cancelledAt（10秒表示中の解除）は true（新規）', () => {
    const current = makeTsunami({ eventId: 'A', cancelledAt: new Date() })
    const next = makeTsunami({ eventId: 'A' })
    expect(isTsunamiNewFire(next, current)).toBe(true)
  })

  it('eventId が異なれば true（別地震）', () => {
    const current = makeTsunami({ eventId: 'A' })
    const next = makeTsunami({ eventId: 'B' })
    expect(isTsunamiNewFire(next, current)).toBe(true)
  })

  it('eventId が同じは false（続報）', () => {
    const current = makeTsunami({ eventId: 'A' })
    const next = makeTsunami({ eventId: 'A' })
    expect(isTsunamiNewFire(next, current)).toBe(false)
  })

  it('eventId が両方 undefined でも sourceEarthquake.originTime が異なれば true（P2PQuake 経路のフォールバック）', () => {
    const current = makeTsunami({ sourceEarthquake: { hypocenterName: 'A', originTime: '2026-01-01T00:00:00Z' } })
    const next = makeTsunami({ sourceEarthquake: { hypocenterName: 'B', originTime: '2026-01-02T00:00:00Z' } })
    expect(isTsunamiNewFire(next, current)).toBe(true)
  })

  it('eventId が両方 undefined で originTime が同じは false（同一地震の続報）', () => {
    const current = makeTsunami({ sourceEarthquake: { hypocenterName: 'A', originTime: '2026-01-01T00:00:00Z' } })
    const next = makeTsunami({ sourceEarthquake: { hypocenterName: 'A', originTime: '2026-01-01T00:00:00Z' } })
    expect(isTsunamiNewFire(next, current)).toBe(false)
  })

  it('eventId も originTime も無い場合は false（保守的に続報扱い）', () => {
    const current = makeTsunami({})
    const next = makeTsunami({})
    expect(isTsunamiNewFire(next, current)).toBe(false)
  })
})

describe('isTsunamiGradeUpgrade', () => {
  it('current 無しは false（新規は isTsunamiNewFire 側で拾う）', () => {
    const next = makeTsunami({ areas: [makeArea({ grade: 'MajorWarning' })] })
    expect(isTsunamiGradeUpgrade(next, undefined)).toBe(false)
  })

  it('current が cancelled は false', () => {
    const current = makeTsunami({ areas: [makeArea({ grade: 'Watch' })], cancelled: true })
    const next = makeTsunami({ areas: [makeArea({ grade: 'MajorWarning' })] })
    expect(isTsunamiGradeUpgrade(next, current)).toBe(false)
  })

  it('grade 格上げは true（Watch → Warning）', () => {
    const current = makeTsunami({ areas: [makeArea({ grade: 'Watch' })] })
    const next = makeTsunami({ areas: [makeArea({ grade: 'Warning' })] })
    expect(isTsunamiGradeUpgrade(next, current)).toBe(true)
  })

  it('grade 格上げは true（Warning → MajorWarning）', () => {
    const current = makeTsunami({ areas: [makeArea({ grade: 'Warning' })] })
    const next = makeTsunami({ areas: [makeArea({ grade: 'MajorWarning' })] })
    expect(isTsunamiGradeUpgrade(next, current)).toBe(true)
  })

  it('同一 grade は false（続報）', () => {
    const current = makeTsunami({ areas: [makeArea({ grade: 'Warning' })] })
    const next = makeTsunami({ areas: [makeArea({ grade: 'Warning' })] })
    expect(isTsunamiGradeUpgrade(next, current)).toBe(false)
  })

  it('grade 格下げは false（Warning → Watch）', () => {
    const current = makeTsunami({ areas: [makeArea({ grade: 'Warning' })] })
    const next = makeTsunami({ areas: [makeArea({ grade: 'Watch' })] })
    expect(isTsunamiGradeUpgrade(next, current)).toBe(false)
  })
})

// カードの表示順は読み上げの区域列挙とも共有する（docs/spec/audio-tts-spec.md §4）。
// 片方だけ変えると、読み上げに追従するスクロールが上下へ往復する。
describe('matchesArea', () => {
  const obs = (o: Partial<TsunamiObservation>): TsunamiObservation => ({ name: '観測点', ...o })

  it('双方に code があれば code で照合する（名前が違っても一致する）', () => {
    expect(matchesArea(
      obs({ districtCode: '040', districtName: '別名' }),
      makeArea({ code: '040', name: '宮城県' }),
    )).toBe(true)
  })

  it('code が一致しなければ名前が同じでも一致しない', () => {
    expect(matchesArea(
      obs({ districtCode: '040', districtName: '宮城県' }),
      makeArea({ code: '050', name: '宮城県' }),
    )).toBe(false)
  })

  it('片方に code が無ければ名前で照合する', () => {
    expect(matchesArea(
      obs({ districtName: '宮城県' }),
      makeArea({ code: '040', name: '宮城県' }),
    )).toBe(true)
    expect(matchesArea(
      obs({ districtCode: '040', districtName: '宮城県' }),
      makeArea({ code: undefined, name: '宮城県' }),
    )).toBe(true)
  })

  it('名前も code も無い観測は一致しない', () => {
    expect(matchesArea(obs({}), makeArea({ code: undefined, name: '宮城県' }))).toBe(false)
  })
})

describe('groupAreasForCardDisplay / sortAreasForCardDisplay', () => {
  const area = (name: string, code: string, height?: string): TsunamiArea =>
    makeArea({ name, code, grade: 'MajorWarning', maxHeight: height ? { description: height, value: 0 } : undefined })
  const height = (name: string, code: string, value: number, over = false): TsunamiObservation =>
    ({ name, districtCode: code, districtName: name, height: { value, description: `${value}m`, over } })

  it('予想波高が連続して一致する区域だけをまとめる（離れた同じ波高は別グループ）', () => {
    const groups = groupAreasForCardDisplay([
      area('岩手県', '030', '3m'),
      area('宮城県', '040', '6m'),
      area('福島県', '050', '3m'),
    ], [])
    expect(groups.map(g => [g.heightLabel, g.areas.map(a => a.name)]))
      .toEqual([['3m', ['岩手県']], ['6m', ['宮城県']], ['3m', ['福島県']]])
  })

  it('観測が無ければ電文順を維持する', () => {
    const areas = [area('岩手県', '030', '3m'), area('宮城県', '040', '3m')]
    expect(sortAreasForCardDisplay(areas, []).map(a => a.name)).toEqual(['岩手県', '宮城県'])
  })

  it('グループ内は実測波高の降順に並べ、実測が無い区域は後ろへ回す', () => {
    const areas = [area('岩手県', '030', '3m'), area('宮城県', '040', '3m'), area('福島県', '050', '3m')]
    const sorted = sortAreasForCardDisplay(areas, [height('福島県', '050', 1.2), height('宮城県', '040', 2.4)])
    expect(sorted.map(a => a.name)).toEqual(['宮城県', '福島県', '岩手県'])
  })

  it('実測が同値なら「以上」を優先し、それも同じなら電文順を保つ', () => {
    const areas = [area('岩手県', '030', '3m'), area('宮城県', '040', '3m')]
    expect(sortAreasForCardDisplay(areas, [
      height('岩手県', '030', 2.0),
      height('宮城県', '040', 2.0, true),
    ]).map(a => a.name)).toEqual(['宮城県', '岩手県'])
    expect(sortAreasForCardDisplay(areas, [
      height('岩手県', '030', 2.0),
      height('宮城県', '040', 2.0),
    ]).map(a => a.name)).toEqual(['岩手県', '宮城県'])
  })

  // 正: 「以上」は真の波高の下限しか示さない（上限が無い）ため、値が下でも確定値より上に置く
  it('「以上」は値が確定値より低くても上に並ぶ', () => {
    const areas = [area('岩手県', '030', '3m'), area('宮城県', '040', '3m')]
    expect(sortAreasForCardDisplay(areas, [
      height('岩手県', '030', 9.0),
      height('宮城県', '040', 8.5, true),
    ]).map(a => a.name)).toEqual(['宮城県', '岩手県'])
  })

  // 対照: 「以上」を優先するのは確定値との比較だけ。「以上」どうしは値の大小で並ぶ
  it('「以上」どうしは値の降順に並ぶ', () => {
    const areas = [area('岩手県', '030', '3m'), area('宮城県', '040', '3m')]
    expect(sortAreasForCardDisplay(areas, [
      height('岩手県', '030', 1.5, true),
      height('宮城県', '040', 8.5, true),
    ]).map(a => a.name)).toEqual(['宮城県', '岩手県'])
  })

  // 安全弁: 「以上」優先が「実測が無い区域を後ろへ回す」という上位の規則を追い越さない
  it('「以上」があっても実測の無い区域は後ろのまま', () => {
    const areas = [area('岩手県', '030', '3m'), area('宮城県', '040', '3m')]
    expect(sortAreasForCardDisplay(areas, [
      height('宮城県', '040', 1.5, true),
    ]).map(a => a.name)).toEqual(['宮城県', '岩手県'])
  })

  it('波高を持たない区域は独立したグループになる', () => {
    const groups = groupAreasForCardDisplay([area('岩手県', '030'), area('宮城県', '040')], [])
    expect(groups.map(g => g.heightLabel)).toEqual([null, null])
  })
})

describe('compareObservedHeightDesc', () => {
  // 正: over が値の大小より先に効く
  it('over が立つ方を上に置く（値の大小より先）', () => {
    expect(compareObservedHeightDesc({ value: 8.5, over: true }, { value: 9.0 })).toBeLessThan(0)
    expect(compareObservedHeightDesc({ value: 9.0 }, { value: 8.5, over: true })).toBeGreaterThan(0)
  })

  // 対照: over 区分が同じなら値の降順
  it('over の有無が同じなら値の降順', () => {
    expect(compareObservedHeightDesc({ value: 9.0 }, { value: 8.5})).toBeLessThan(0)
    expect(compareObservedHeightDesc({ value: 1.5, over: true }, { value: 8.5, over: true })).toBeGreaterThan(0)
  })

  // 安全弁: 同値・同区分は 0（呼び出し側の安定ソートで電文順を保つため、符号を付けてはいけない）
  it('同値・同区分は 0 を返す', () => {
    expect(compareObservedHeightDesc({ value: 2.0 }, { value: 2.0 })).toBe(0)
    expect(compareObservedHeightDesc({ value: 2.0, over: true }, { value: 2.0, over: true })).toBe(0)
  })

  // 安全弁: over は undefined と false を同じ扱いにする（パーサは `over || undefined` で落とす）
  it('over の undefined と false を同じ扱いにする', () => {
    expect(compareObservedHeightDesc({ value: 2.0, over: false }, { value: 2.0 })).toBe(0)
    expect(compareObservedHeightDesc({ value: 2.0, over: undefined }, { value: 2.0, over: false })).toBe(0)
  })
})

// 観測波高の「以上」表記。→ docs/spec/tsunami-spec.md §6「観測波高の「以上」」
describe('overSuffixedHeight', () => {
  // 正: description が「以上」を落としている形（condition 経路）では補う
  it('over で「以上」を含まない数値表記には補う', () => {
    expect(overSuffixedHeight({ description: '8.5m', over: true })).toBe('8.5m以上')
  })

  // 対照: 既に「以上」を含むなら足さない（`>8.5m以上` のような二重表記を作らない）
  it('既に「以上」を含むならそのまま', () => {
    expect(overSuffixedHeight({ description: '8.5m以上', over: true })).toBe('8.5m以上')
  })

  // 対照: over が立っていなければ触らない
  it('over が無ければそのまま', () => {
    expect(overSuffixedHeight({ description: '7.2m' })).toBe('7.2m')
    expect(overSuffixedHeight({ description: '7.2m', over: false })).toBe('7.2m')
  })

  // 安全弁: 全角表記でも補う（XML 履歴経路は全角で来る。ASCII だけ見ると黙って落ちる）
  it('全角数字の description にも補う', () => {
    expect(overSuffixedHeight({ description: '８．５ｍ', over: true })).toBe('８．５ｍ以上')
  })

  // 安全弁: 数値化されない condition（「巨大」「高い」）に繋いで「巨大以上」を作らない
  it('数字を含まない description には補わない', () => {
    expect(overSuffixedHeight({ description: '巨大', over: true })).toBe('巨大')
    expect(overSuffixedHeight({ description: '高い', over: true })).toBe('高い')
  })
})
