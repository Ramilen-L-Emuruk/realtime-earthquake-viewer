import { describe, it, expect } from 'vitest'
import {
  tsunamiMaxGrade,
  tsunamiOverallGrade,
  isTsunamiNewFire,
  isTsunamiGradeUpgrade,
  isCancelForCurrentTsunami,
  isTsunamiContinuation,
  matchesArea,
  groupAreasForCardDisplay,
  sortAreasForCardDisplay,
  sortAreasAcrossGradesForCardDisplay,
  sortObservationsForCardDisplay,
  GRADES_IN_CARD_ORDER,
  compareObservedHeightDesc,
  overSuffixedHeight,
  latestValidDateTime,
  withInheritedValidDateTime,
  tsunamiAreaGradeChanges,
  selectUnspokenAreaGradeChanges,
  rememberAreaGrades,
  parseTsunamiObservationCondition,
  isObservationMissing,
  observationBadges,
  observationHeightText,
  observationArrivalFallbackText,
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

// 津波は 1 件スロットで持つため、別イベントの遅延到達した解除で進行中の津波を消してはいけない。
// カードの状態更新（`useEarthquakes`）と、読み上げ・画面の記憶を落とす判断（`useLiveEventHandler`）
// の両方がこの関数を使う。
describe('isCancelForCurrentTsunami', () => {
  it('表示中の津波が無ければ受け入れる', () => {
    expect(isCancelForCurrentTsunami(makeTsunami({ cancelled: true }), undefined)).toBe(true)
  })

  it('eventId が一致すれば受け入れる', () => {
    const current = makeTsunami({ eventId: 'evt-1' })
    const cancel = makeTsunami({ eventId: 'evt-1', cancelled: true, time: '2026-01-01T12:30:00Z' })
    expect(isCancelForCurrentTsunami(cancel, current)).toBe(true)
  })

  it('eventId が違えば別イベントの解除として弾く', () => {
    const current = makeTsunami({ eventId: 'evt-2' })
    const cancel = makeTsunami({ eventId: 'evt-1', cancelled: true, time: '2026-01-01T12:30:00Z' })
    expect(isCancelForCurrentTsunami(cancel, current)).toBe(false)
  })

  // eventId を持たない経路（P2PQuake の 552）は同一イベントか判定できないので時刻で見る。
  it('eventId が無いときは、表示中より古い解除を弾く', () => {
    const current = makeTsunami({ time: '2026-01-01T12:10:00Z' })
    const cancel = makeTsunami({ cancelled: true, time: '2026-01-01T12:00:00Z' })
    expect(isCancelForCurrentTsunami(cancel, current)).toBe(false)
  })

  it('eventId が無くても、表示中より新しい解除は受け入れる', () => {
    const current = makeTsunami({ time: '2026-01-01T12:00:00Z' })
    const cancel = makeTsunami({ cancelled: true, time: '2026-01-01T12:10:00Z' })
    expect(isCancelForCurrentTsunami(cancel, current)).toBe(true)
  })

  // 安全弁。判定できないときは受け入れる（解除を落とす方が害が大きい）。
  it('時刻が読めないときは受け入れる', () => {
    const current = makeTsunami({ time: 'invalid' })
    const cancel = makeTsunami({ cancelled: true, time: 'invalid' })
    expect(isCancelForCurrentTsunami(cancel, current)).toBe(true)
  })

  // 片側にしか eventId が無い場合も「判定できない」側に落ちる（時刻で見る）。
  it('片側にしか eventId が無ければ時刻で判断する', () => {
    const current = makeTsunami({ eventId: 'evt-1', time: '2026-01-01T12:10:00Z' })
    const cancel = makeTsunami({ cancelled: true, time: '2026-01-01T12:00:00Z' })
    expect(isCancelForCurrentTsunami(cancel, current)).toBe(false)
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


// 「表示中の津波の続報として前報の値を引き継ぐか」の判定。カードの状態更新と、
// カード順の基準（`tsunamiCardOrderBasis`）が、同じ述語を共有する。
describe('isTsunamiContinuation', () => {
  const t = (over: Partial<JMATsunami> = {}): JMATsunami => makeTsunami({ eventId: 'E1', ...over })

  // 正: 同じ eventId・解除表示に入っていなければ引き継ぐ
  it('同じ eventId の続報は引き継ぐ', () => {
    expect(isTsunamiContinuation(t(), t({ id: 'next' }))).toBe(true)
  })

  // 対照: 別の地震の津波からは引き継がない（カードも新しい電文だけを描く）
  it('eventId が違えば引き継がない', () => {
    expect(isTsunamiContinuation(t({ eventId: 'E1' }), t({ eventId: 'E2' }))).toBe(false)
  })

  // 対照: eventId を持たない経路（P2PQuake の 552）は同一性を判定できない
  it('どちらかが eventId を持たなければ引き継がない', () => {
    expect(isTsunamiContinuation(t({ eventId: undefined }), t())).toBe(false)
    expect(isTsunamiContinuation(t(), t({ eventId: undefined }))).toBe(false)
  })

  // 安全弁: 解除表示中のカードは 10 秒で消える。その値を新しい津波へ持ち込まない
  it('表示中が解除表示に入っていれば引き継がない', () => {
    expect(isTsunamiContinuation(t({ cancelledAt: new Date() }), t())).toBe(false)
  })

  it('表示中の津波が無ければ引き継がない', () => {
    expect(isTsunamiContinuation(undefined, t())).toBe(false)
  })
})


// 等級カードをまたいだ区域の通し順。カードから上位いくつかだけを採る用途
// （ブラウザ通知の本文・受信時スクロールの送り先）は、この並びを使う。
describe('sortAreasAcrossGradesForCardDisplay', () => {
  const area = (name: string, code: string, grade: TsunamiArea['grade'], height?: string): TsunamiArea =>
    makeArea({ name, code, grade, maxHeight: height ? { description: height, value: 0 } : undefined })
  const height = (name: string, code: string, value: number): TsunamiObservation =>
    ({ name, districtCode: code, districtName: name, height: { value, description: `${value}m` } })

  // 正: 予想波高が同じでも、重い等級の区域が先に来る
  it('重い等級の区域を先に置く', () => {
    const areas = [area('北海道太平洋沿岸東部', '080', 'Watch', '1m'), area('岩手県', '030', 'Warning', '1m')]
    expect(sortAreasAcrossGradesForCardDisplay(areas, []).map(a => a.name))
      .toEqual(['岩手県', '北海道太平洋沿岸東部'])
  })

  // 対照: 等級を分けない `sortAreasForCardDisplay` は波高で束ねるため、この並びにならない。
  // 等級混じりの一覧をそちらへ渡すと、注意報の区域が警報より上に出る
  it('等級を分けない並べ替えとは結果が違う', () => {
    const areas = [area('北海道太平洋沿岸東部', '080', 'Watch', '1m'), area('岩手県', '030', 'Warning', '1m')]
    expect(sortAreasForCardDisplay(areas, []).map(a => a.name))
      .toEqual(['北海道太平洋沿岸東部', '岩手県'])
  })

  // 安全弁: 等級の中では従来どおり実測波高の深刻な順。等級で分けたことが、
  // 区域どうしの並べ替えを止めてしまっていないこと
  it('同じ等級の中は実測波高の深刻な順を保つ', () => {
    const areas = [
      area('岩手県', '030', 'Warning', '3m'),
      area('宮城県', '040', 'Warning', '3m'),
      area('北海道太平洋沿岸東部', '080', 'Watch', '1m'),
    ]
    expect(sortAreasAcrossGradesForCardDisplay(areas, [height('宮城県', '040', 2.4)]).map(a => a.name))
      .toEqual(['宮城県', '岩手県', '北海道太平洋沿岸東部'])
  })

  // 安全弁: 等級が 1 つも欠けない（`GRADES_IN_CARD_ORDER` の網羅性に依存している）
  it('どの等級の区域も落とさない', () => {
    const areas = [
      area('A', '010', 'Unknown'),
      area('B', '020', 'Forecast'),
      area('C', '030', 'Watch'),
      area('D', '040', 'Warning'),
      area('E', '050', 'MajorWarning'),
    ]
    expect(sortAreasAcrossGradesForCardDisplay(areas, []).map(a => a.name))
      .toEqual(['E', 'D', 'C', 'B', 'A'])
  })
})


// 観測点の読み上げ順をカードに揃えるための単一情報源（→ docs/spec/tsunami-spec.md §9）。
// カードの入れ子（等級 → 予想波高の見出し → 区域 → 区域内は電文順 → 沖合観測）をそのまま辿る。
describe('sortObservationsForCardDisplay', () => {
  const area = (name: string, code: string, grade: TsunamiArea['grade'], height?: string): TsunamiArea =>
    makeArea({ name, code, grade, maxHeight: height ? { description: height, value: 0 } : undefined })
  const obs = (name: string, districtName: string, code: string, value?: number): TsunamiObservation =>
    ({ name, districtCode: code, districtName, height: value === undefined ? undefined : { value, description: `${value}m` } })

  it('等級カードの順に並べる（重い等級が先）', () => {
    const areas = [area('青森県太平洋沿岸', '060', 'Watch'), area('岩手県', '030', 'MajorWarning')]
    const items = [obs('八戸', '青森県太平洋沿岸', '060', 0.4), obs('宮古', '岩手県', '030', 1.2)]
    expect(sortObservationsForCardDisplay(items, areas).map(o => o.name)).toEqual(['宮古', '八戸'])
  })

  // 区域の並べ替え（実測の深刻な順）がそのまま観測点の順にも効く
  it('同じ等級では区域の表示順に従う', () => {
    const areas = [area('岩手県', '030', 'Warning', '3m'), area('宮城県', '040', 'Warning', '3m')]
    const items = [obs('宮古', '岩手県', '030', 1.2), obs('鮎川', '宮城県', '040', 2.4)]
    // 実測が深刻な宮城県の区域が上に来るので、観測点も鮎川が先
    expect(sortObservationsForCardDisplay(items, areas).map(o => o.name)).toEqual(['鮎川', '宮古'])
  })

  it('同じ区域の中は電文の並びを保つ', () => {
    const areas = [area('岩手県', '030', 'Warning')]
    const items = [obs('宮古', '岩手県', '030', 1.2), obs('大船渡', '岩手県', '030', 3.0)]
    expect(sortObservationsForCardDisplay(items, areas).map(o => o.name)).toEqual(['宮古', '大船渡'])
  })

  // 安全弁: 区域に紐づかない観測点はカードでも最後（「沖合観測」）。落としてはいけない
  it('区域に紐づかない観測点は最後に置き、取り落とさない', () => {
    const areas = [area('岩手県', '030', 'Warning')]
    const items = [obs('沖合A', '沖合', '999', 0.5), obs('宮古', '岩手県', '030', 1.2)]
    expect(sortObservationsForCardDisplay(items, areas).map(o => o.name)).toEqual(['宮古', '沖合A'])
  })

  it('区域が空でも全件を 電文順で返す', () => {
    const items = [obs('宮古', '岩手県', '030', 1.2), obs('大船渡', '岩手県', '030', 3.0)]
    expect(sortObservationsForCardDisplay(items, []).map(o => o.name)).toEqual(['宮古', '大船渡'])
  })

  it('等級の並びはカードと共有する定数から作る', () => {
    expect(GRADES_IN_CARD_ORDER).toEqual(['MajorWarning', 'Warning', 'Watch', 'Forecast', 'Unknown'])
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

describe('latestValidDateTime', () => {
  // 気象庁は有効期限を 1 通だけで伝え、以後の続報には載せない（実データ: 2024 年能登半島地震は
  // 01/02 10:00 の VTSE41 が 01/02 17:00 を伝え、3 分後の VTSE51 は持たない）。
  it('期限を伝えた報が途中にあり、その後の報が持たなくても期限を返す', () => {
    const reports = [
      makeTsunami({ id: 'a', time: '2024-01-02T10:00:00+09:00', validDateTime: '2024-01-02T17:00:00+09:00' }),
      makeTsunami({ id: 'b', time: '2024-01-02T10:03:00+09:00' }),
    ]
    expect(latestValidDateTime(reports)).toBe('2024-01-02T17:00:00+09:00')
  })

  it('順序がばらばらでも発表時刻が最も新しい期限を返す（延長・短縮に従う）', () => {
    const reports = [
      makeTsunami({ id: 'b', time: '2024-01-02T13:00:00+09:00', validDateTime: '2024-01-03T09:00:00+09:00' }),
      makeTsunami({ id: 'a', time: '2024-01-02T10:00:00+09:00', validDateTime: '2024-01-02T17:00:00+09:00' }),
    ]
    expect(latestValidDateTime(reports)).toBe('2024-01-03T09:00:00+09:00')
  })

  it('期限を伝えた報が 1 通も無ければ undefined（standard 版は構造的に持たない）', () => {
    expect(latestValidDateTime([makeTsunami({ time: '2024-01-01T16:12:00+09:00' })])).toBeUndefined()
  })

  it('発表時刻が読めない報の期限は採らない（新旧を判定できない）', () => {
    const reports = [
      makeTsunami({ id: 'a', time: '2024-01-02T10:00:00+09:00', validDateTime: '2024-01-02T17:00:00+09:00' }),
      makeTsunami({ id: 'b', time: '壊れた時刻', validDateTime: '2024-01-01T00:00:00+09:00' }),
    ]
    expect(latestValidDateTime(reports)).toBe('2024-01-02T17:00:00+09:00')
  })
})

describe('withInheritedValidDateTime', () => {
  it('最新報が期限を持たなければ同一イベントの過去報から引き継ぐ', () => {
    const older = makeTsunami({ id: 'a', eventId: 'E1', time: '2024-01-02T10:00:00+09:00', validDateTime: '2024-01-02T17:00:00+09:00' })
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T10:03:00+09:00' })
    expect(withInheritedValidDateTime(latest, [latest, older]).validDateTime).toBe('2024-01-02T17:00:00+09:00')
  })

  it('最新報が期限を持つならそれを使う', () => {
    const older = makeTsunami({ id: 'a', eventId: 'E1', time: '2024-01-02T10:00:00+09:00', validDateTime: '2024-01-02T17:00:00+09:00' })
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T13:00:00+09:00', validDateTime: '2024-01-03T09:00:00+09:00' })
    expect(withInheritedValidDateTime(latest, [latest, older]).validDateTime).toBe('2024-01-03T09:00:00+09:00')
  })

  it('別イベントの報からは引き継がない', () => {
    const other = makeTsunami({ id: 'x', eventId: 'E2', time: '2024-01-02T10:00:00+09:00', validDateTime: '2024-01-02T17:00:00+09:00' })
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T10:03:00+09:00' })
    expect(withInheritedValidDateTime(latest, [latest, other]).validDateTime).toBeUndefined()
  })

  it('日時として読めない期限は落とす（残すと以後の比較がすべて偽へ倒れる）', () => {
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T10:03:00+09:00', validDateTime: '壊れた期限' })
    expect(withInheritedValidDateTime(latest, [latest]).validDateTime).toBeUndefined()
  })

  it('自分の期限が読めなければ、同一イベントの過去報から引き継ぐ', () => {
    const older = makeTsunami({ id: 'a', eventId: 'E1', time: '2024-01-02T10:00:00+09:00', validDateTime: '2024-01-02T17:00:00+09:00' })
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T10:03:00+09:00', validDateTime: '壊れた期限' })
    expect(withInheritedValidDateTime(latest, [latest, older]).validDateTime).toBe('2024-01-02T17:00:00+09:00')
  })

  it('eventId が無い経路（P2PQuake）では id が一致する報だけを見る', () => {
    const other = makeTsunami({ id: 'x', time: '2024-01-02T10:00:00+09:00', validDateTime: '2024-01-02T17:00:00+09:00' })
    const latest = makeTsunami({ id: 'b', time: '2024-01-02T10:03:00+09:00' })
    expect(withInheritedValidDateTime(latest, [latest, other]).validDateTime).toBeUndefined()
  })
})

// 2024 年能登半島地震 01/02 02:30 の「津波注意報を一部解除しました」に相当する形。
// 気象庁は解除された区域を電文から消さず、津波予報への降格（Kind=72 / LastKind=62）として載せる。
function makePartialLift(): JMATsunami {
  return makeTsunami({
    areas: [
      makeArea({ code: '360', name: '石川県能登', grade: 'Watch', lastGrade: 'Watch' }),
      makeArea({ code: '711', name: '福岡県日本海沿岸', grade: 'Forecast', lastGrade: 'Watch' }),
      makeArea({ code: '720', name: '佐賀県北部', grade: 'Forecast', lastGrade: 'Watch' }),
    ],
  })
}

describe('tsunamiAreaGradeChanges（区域単位の等級変化）', () => {
  it('正: 注意報から予報へ落ちた区域を 1 組にまとめる（最上位が動かない報でも検出できる）', () => {
    const changes = tsunamiAreaGradeChanges(makePartialLift())
    expect(changes).toHaveLength(1)
    expect(changes[0].from).toBe('Watch')
    expect(changes[0].to).toBe('Forecast')
    expect(changes[0].raised).toBe(false)
    expect(changes[0].areas.map(a => a.name)).toEqual(['福岡県日本海沿岸', '佐賀県北部'])
    // この報の最上位等級は動いていない（他の区域に注意報が残る）ことを併せて固定する
    expect(tsunamiMaxGrade(makePartialLift())).toBe('Watch')
  })

  it('対照: 等級が動いていない区域は組に入らない', () => {
    const changes = tsunamiAreaGradeChanges(makePartialLift())
    expect(changes.flatMap(c => c.areas).map(a => a.name)).not.toContain('石川県能登')
  })

  it('対照: lastGrade を持たない区域（P2PQuake 経路）は数えない', () => {
    const tsunami = makeTsunami({
      areas: [makeArea({ code: '711', name: '福岡県日本海沿岸', grade: 'Forecast' })],
    })
    expect(tsunamiAreaGradeChanges(tsunami)).toEqual([])
  })

  it('安全弁: 遷移先が Unknown の組は返さない（等級の名前が付かず文にできない）', () => {
    const tsunami = makeTsunami({
      areas: [makeArea({ code: '711', name: '福岡県日本海沿岸', grade: 'Unknown', lastGrade: 'Watch' })],
    })
    expect(tsunamiAreaGradeChanges(tsunami)).toEqual([])
  })

  it('引き上げの組を引き下げより先に置く', () => {
    const tsunami = makeTsunami({
      areas: [
        makeArea({ code: '711', name: '福岡県日本海沿岸', grade: 'Forecast', lastGrade: 'Watch' }),
        makeArea({ code: '500', name: '京都府', grade: 'Warning', lastGrade: 'Watch' }),
      ],
    })
    const changes = tsunamiAreaGradeChanges(tsunami)
    expect(changes.map(c => [c.from, c.to, c.raised])).toEqual([
      ['Watch', 'Warning', true],
      ['Watch', 'Forecast', false],
    ])
  })

  it('同じ向き・同じ遷移先なら遷移元の重い順に置く', () => {
    const tsunami = makeTsunami({
      areas: [
        makeArea({ code: '340', name: '新潟県上中下越', grade: 'Watch', lastGrade: 'Warning' }),
        makeArea({ code: '360', name: '石川県能登', grade: 'Watch', lastGrade: 'MajorWarning' }),
      ],
    })
    expect(tsunamiAreaGradeChanges(tsunami).map(c => c.from)).toEqual(['MajorWarning', 'Warning'])
  })
})

describe('selectUnspokenAreaGradeChanges / rememberAreaGrades（等級変化の既読）', () => {
  it('正: 何も読んでいなければそのまま残る', () => {
    const changes = tsunamiAreaGradeChanges(makePartialLift())
    expect(selectUnspokenAreaGradeChanges(changes, new Map())).toEqual(changes)
  })

  it('対照: 声にした等級と同じ区域は落ちる（続報が同じ LastKind を載せ続けても二度読みしない）', () => {
    const spoken = new Map<string, TsunamiArea['grade']>()
    rememberAreaGrades(tsunamiAreaGradeChanges(makePartialLift()), spoken)
    // 02:31・02:33 の続報は 02:30 と同じ「予報 / 前回は注意報」を載せてくる
    expect(selectUnspokenAreaGradeChanges(tsunamiAreaGradeChanges(makePartialLift()), spoken)).toEqual([])
  })

  it('安全弁: 等級がさらに動けばもう一度読む（既読は「最後に声にした等級」で持つ）', () => {
    const spoken = new Map<string, TsunamiArea['grade']>()
    rememberAreaGrades(tsunamiAreaGradeChanges(makePartialLift()), spoken)
    const reRaised = makeTsunami({
      areas: [makeArea({ code: '711', name: '福岡県日本海沿岸', grade: 'Watch', lastGrade: 'Forecast' })],
    })
    const changes = selectUnspokenAreaGradeChanges(tsunamiAreaGradeChanges(reRaised), spoken)
    expect(changes).toHaveLength(1)
    expect(changes[0].to).toBe('Watch')
  })

  it('一部の区域だけ既読なら、残りの区域で組を残す', () => {
    const spoken = new Map<string, TsunamiArea['grade']>([['711', 'Forecast']])
    const changes = selectUnspokenAreaGradeChanges(tsunamiAreaGradeChanges(makePartialLift()), spoken)
    expect(changes).toHaveLength(1)
    expect(changes[0].areas.map(a => a.name)).toEqual(['佐賀県北部'])
  })
})

// ============================================================
// 観測状態（電文の Condition）
// ============================================================
describe('parseTsunamiObservationCondition', () => {
  it('正: MaxHeight/Condition の「欠測」を読む', () => {
    expect(parseTsunamiObservationCondition({ maxHeight: '欠測' })).toEqual({ maxHeightMissing: true })
  })

  it('正: 全角スペースで併記された「重要 欠測」を両方立てる', () => {
    // 電文解説資料 Ⅱ.12 事例 6 の形。完全一致で照合していると片方も読めない
    expect(parseTsunamiObservationCondition({ maxHeight: '重要　欠測' }))
      .toEqual({ important: true, maxHeightMissing: true })
  })

  it('正: 「微弱 欠測」「観測中 欠測」も併記として読む（同 事例 7・8）', () => {
    expect(parseTsunamiObservationCondition({ maxHeight: '微弱　欠測' }))
      .toEqual({ weak: true, maxHeightMissing: true })
    expect(parseTsunamiObservationCondition({ maxHeight: '観測中　欠測' }))
      .toEqual({ observing: true, maxHeightMissing: true })
  })

  it('正: 第1波と最大波の欠測を別のフラグへ写す', () => {
    // 「到達は確認できたが波高の観測が落ちた」と「到達したかも判らない」は別の状態
    expect(parseTsunamiObservationCondition({ firstHeight: '欠測', maxHeight: '欠測' }))
      .toEqual({ firstHeightMissing: true, maxHeightMissing: true })
    expect(parseTsunamiObservationCondition({ maxHeight: '欠測' }))
      .toEqual({ maxHeightMissing: true })
  })

  it('正: 空白で併記された 2 つの状態を両方読める', () => {
    // 電文の `Condition` は複数の状態を全角スペースで並べる（「重要 欠測」等）。
    // 完全一致で照合すると、併記された時点でどちらも読めなくなる
    // （→ docs/spec/tsunami-spec.md §6「観測状態」）。
    expect(parseTsunamiObservationCondition({ maxHeight: '重要 欠測' }))
      .toEqual({ important: true, maxHeightMissing: true })
    // 片方が空でも空白だけのトークンを拾わない
    expect(parseTsunamiObservationCondition({ maxHeight: ' 欠測' })).toEqual({ maxHeightMissing: true })
    expect(parseTsunamiObservationCondition({ maxHeight: '重要 ' })).toEqual({ important: true })
  })

  it('正: 第１波識別不能は全角・半角のどちらの「1」でも読む', () => {
    expect(parseTsunamiObservationCondition({ firstHeight: '第１波識別不能' }))
      .toEqual({ firstWaveUnidentifiable: true })
    expect(parseTsunamiObservationCondition({ firstHeight: '第1波識別不能' }))
      .toEqual({ firstWaveUnidentifiable: true })
  })

  it('対照: 状態が何も無ければ undefined（大多数の観測点に欄を作らない）', () => {
    expect(parseTsunamiObservationCondition({})).toBeUndefined()
    expect(parseTsunamiObservationCondition({ firstHeight: '', maxHeight: '', heightCondition: '' })).toBeUndefined()
    expect(parseTsunamiObservationCondition({ maxHeight: '   ' })).toBeUndefined()
  })

  it('対照: 欄をまたいだ取り違えをしない（欠測は書かれた側だけに立つ）', () => {
    // MaxHeight 側の語を FirstHeight 側から読んでしまうと、到達の断定に化ける
    expect(parseTsunamiObservationCondition({ firstHeight: '微弱' })).toBeUndefined()
    expect(parseTsunamiObservationCondition({ maxHeight: '第１波識別不能' })).toBeUndefined()
  })

  it('安全弁: 知らない語は無視して他の語を落とさない', () => {
    // 気象庁が語を増やしても、併記された既知の語は読めること
    expect(parseTsunamiObservationCondition({ maxHeight: '欠測　新しい語' }))
      .toEqual({ maxHeightMissing: true })
  })
})

describe('isObservationMissing', () => {
  const obs = (condition?: TsunamiObservation['condition']): TsunamiObservation => ({ name: '宮古', condition })

  it('正: 第1波・最大波のどちらの欠測でも真', () => {
    expect(isObservationMissing(obs({ maxHeightMissing: true }))).toBe(true)
    expect(isObservationMissing(obs({ firstHeightMissing: true }))).toBe(true)
  })

  it('対照: 「観測中」は欠測ではない（まだ値が出ていないだけ）', () => {
    expect(isObservationMissing(obs({ observing: true }))).toBe(false)
    expect(isObservationMissing(obs())).toBe(false)
  })
})

describe('observationBadges / observationHeightText', () => {
  const obs = (o: Partial<TsunamiObservation>): TsunamiObservation => ({ name: '宮古', ...o })

  it('正: 欠測と数値が同時に来たら両方見せる（値はバッジに潰されない）', () => {
    const o = obs({
      height: { value: 3.2, description: '3.2m以上', over: true },
      condition: { maxHeightMissing: true, important: true },
    })
    expect(observationBadges(o)).toEqual(['実測', '欠測', '大津波警報の基準超'])
    expect(observationHeightText(o)).toBe('3.2m以上')
  })

  it('正: 到達だけ確認できている欠測は「到達確認」と「欠測」を併記する', () => {
    const o = obs({ arrivalTime: '2026-09-03T10:00:00+09:00', condition: { maxHeightMissing: true } })
    expect(observationBadges(o)).toEqual(['到達確認', '欠測'])
    // バッジが欠測を言っているので値の欄は空（同じ語を 1 行に 2 回出さない）
    expect(observationHeightText(o)).toBe('')
  })

  it('正: 到達も欠測なら「到達確認」を付けない（到達を断定しない）', () => {
    const o = obs({ condition: { firstHeightMissing: true, maxHeightMissing: true } })
    expect(observationBadges(o)).toEqual(['欠測'])
    expect(observationHeightText(o)).toBe('')
  })

  it('正: 「微弱」は波高の欄に出す（欠測と併記されても波高側の語はこちら）', () => {
    expect(observationHeightText(obs({ condition: { weak: true } }))).toBe('微弱')
    expect(observationHeightText(obs({ condition: { weak: true, maxHeightMissing: true } }))).toBe('微弱')
  })

  it('対照: 欠測でない波高未確定は従来どおり「到達確認 / 観測中」', () => {
    const o = obs({ arrivalTime: '2026-09-03T10:00:00+09:00' })
    expect(observationBadges(o)).toEqual(['到達確認'])
    expect(observationHeightText(o)).toBe('観測中')
  })

  it('安全弁: 欠測の観測点に「観測中」を出さない（値が出る見込みだと読める）', () => {
    const o = obs({ condition: { observing: true, maxHeightMissing: true } })
    expect(observationHeightText(o)).not.toBe('観測中')
  })
})

describe('observationBadges: 上昇中 / observationArrivalFallbackText', () => {
  const obs = (o: Partial<TsunamiObservation>): TsunamiObservation => ({ name: '大洗', ...o })

  it('正: 上昇中はバッジに出す（いま見えている波高が最大とは限らない）', () => {
    const o = obs({ height: { value: 2.1, description: '2.1m' }, condition: { rising: true } })
    expect(observationBadges(o)).toEqual(['実測', '上昇中'])
    // 波高の数値はバッジに潰されない
    expect(observationHeightText(o)).toBe('2.1m')
  })

  it('対照: 上昇中でなければバッジは増えない', () => {
    expect(observationBadges(obs({ height: { value: 2.1, description: '2.1m' } }))).toEqual(['実測'])
  })

  it('正: 第1波識別不能は到達時刻の欄に理由を出す', () => {
    expect(observationArrivalFallbackText(obs({ condition: { firstWaveUnidentifiable: true } }))).toBe('到達時刻不明')
  })

  it('対照: 到達時刻があれば何も返さない（呼び出し側が時刻を出す）', () => {
    expect(observationArrivalFallbackText(obs({
      arrivalTime: '2026-09-03T10:00:00+09:00',
      condition: { firstWaveUnidentifiable: true },
    }))).toBe('')
  })

  it('安全弁: 第1波識別不能でも「到達確認」の扱いは変えない（到達そのものは確定している）', () => {
    // 気象庁の定義は「津波を観測したものの第1波の到達時刻が不明瞭」。到達は起きている
    expect(observationBadges(obs({ condition: { firstWaveUnidentifiable: true } }))).toEqual(['到達確認'])
  })
})
