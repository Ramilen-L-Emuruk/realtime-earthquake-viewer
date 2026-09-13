import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isWarningLevelWhileObserving,
  importantBadgeText,
  forecastHeightImportantBadge,
  estimationBadges,
  estimationHeightText,
  tsunamiMaxGrade,
  tsunamiOverallGrade,
  isTsunamiNewFire,
  sourceEarthquakeTime,
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
  withInheritedTsunamiFacts,
  tsunamiAreaGradeChanges,
  selectUnspokenAreaGradeChanges,
  rememberAreaGrades,
  parseTsunamiObservationCondition,
  isObservationMissing,
  observationBadges,
  observationHeightText,
  observationArrivalFallbackText,
  observationMaxHeightTimeText,
  mergeTsunamiAreas,
  evacuationActionLine,
  mergeTsunamiWarningComments,
  mergeTsunamiReports,
  WARNING_COMMENT_ORDER,
} from './tsunami'
import type { JMATsunami, TsunamiArea, TsunamiObservation } from '../types/earthquake'
import { log } from './logger'

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

  it('eventId が両方 undefined でも原因地震の originTime が異なれば true（P2PQuake 経路のフォールバック）', () => {
    const current = makeTsunami({ sourceEarthquakes: [{ hypocenterName: 'A', originTime: '2026-01-01T00:00:00Z' }] })
    const next = makeTsunami({ sourceEarthquakes: [{ hypocenterName: 'B', originTime: '2026-01-02T00:00:00Z' }] })
    expect(isTsunamiNewFire(next, current)).toBe(true)
  })

  it('eventId が両方 undefined で originTime が同じは false（同一地震の続報）', () => {
    const current = makeTsunami({ sourceEarthquakes: [{ hypocenterName: 'A', originTime: '2026-01-01T00:00:00Z' }] })
    const next = makeTsunami({ sourceEarthquakes: [{ hypocenterName: 'A', originTime: '2026-01-01T00:00:00Z' }] })
    expect(isTsunamiNewFire(next, current)).toBe(false)
  })

  it('eventId も originTime も無い場合は false（保守的に続報扱い）', () => {
    const current = makeTsunami({})
    const next = makeTsunami({})
    expect(isTsunamiNewFire(next, current)).toBe(false)
  })
})

// カードに出す地震の時刻は**発現時刻を先に採る**（地震情報側と揃えるため）。
// 実電文の全期間走査では発生時刻と発現時刻が 11.2% の電文でずれ、気象庁は利用者向けの文へ
// 一貫して発現時刻を書いている（→ `docs/spec/tsunami-spec.md` §4）。
describe('sourceEarthquakeTime', () => {
  // 正: 両方あれば発現時刻。実電文の三陸沖 M7.4（2026-04-20）と同じ形
  it('発現時刻があればそれを返す', () => {
    expect(sourceEarthquakeTime({
      hypocenterName: '三陸沖',
      originTime: '2026-04-20T16:52:00+09:00',
      arrivalTime: '2026-04-20T16:53:00+09:00',
    })).toBe('2026-04-20T16:53:00+09:00')
  })

  // 対照: `arrivalTime` は任意フィールド（電文に無ければパーサーが持たせない）。
  // 落ちる先が無いと、時刻を持つ電文なのに行から時刻が消える
  it('発現時刻が無ければ発生時刻へ落ちる', () => {
    expect(sourceEarthquakeTime({
      hypocenterName: '三陸沖',
      originTime: '2026-04-20T16:52:00+09:00',
    })).toBe('2026-04-20T16:52:00+09:00')
  })

  // 対照: 空文字は「無い」と同じ扱い。`??` で書くと空文字を採ってしまい、
  // 時刻の無い「　発生」だけが行に残る
  it('発現時刻が空文字なら発生時刻へ落ちる', () => {
    expect(sourceEarthquakeTime({
      hypocenterName: '三陸沖',
      originTime: '2026-04-20T16:52:00+09:00',
      arrivalTime: '',
    })).toBe('2026-04-20T16:52:00+09:00')
  })

  it('どちらも無ければ undefined', () => {
    expect(sourceEarthquakeTime({ hypocenterName: '三陸沖' })).toBeUndefined()
    expect(sourceEarthquakeTime({ hypocenterName: '三陸沖', originTime: '', arrivalTime: '' })).toBeUndefined()
  })

  // 安全弁: **表示を発現時刻へ変えても、同一性判定は発生時刻のまま。**
  // `isTsunamiNewFire` は識別子の無い電文でここへ落ちるので、うっかり発現時刻へ
  // 差し替えると、発現時刻だけが動いた続報が別の津波として立ちタブを奪う。
  it('発現時刻が違っても発生時刻が同じなら続報のまま', () => {
    const current = makeTsunami({ sourceEarthquakes: [{ hypocenterName: 'A', originTime: '2026-01-01T00:00:00Z', arrivalTime: '2026-01-01T00:00:00Z' }] })
    const next = makeTsunami({ sourceEarthquakes: [{ hypocenterName: 'A', originTime: '2026-01-01T00:00:00Z', arrivalTime: '2026-01-01T00:01:00Z' }] })
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
      obs({ districtCode: '220', districtName: '別名' }),
      makeArea({ code: '220', name: '宮城県' }),
    )).toBe(true)
  })

  it('code が一致しなければ名前が同じでも一致しない', () => {
    expect(matchesArea(
      obs({ districtCode: '220', districtName: '宮城県' }),
      makeArea({ code: '250', name: '宮城県' }),
    )).toBe(false)
  })

  it('片方に code が無ければ名前で照合する', () => {
    expect(matchesArea(
      obs({ districtName: '宮城県' }),
      makeArea({ code: '220', name: '宮城県' }),
    )).toBe(true)
    expect(matchesArea(
      obs({ districtCode: '220', districtName: '宮城県' }),
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
      area('岩手県', '210', '3m'),
      area('宮城県', '220', '6m'),
      area('福島県', '250', '3m'),
    ], [])
    expect(groups.map(g => [g.heightLabel, g.areas.map(a => a.name)]))
      .toEqual([['3m', ['岩手県']], ['6m', ['宮城県']], ['3m', ['福島県']]])
  })

  it('観測が無ければ電文順を維持する', () => {
    const areas = [area('岩手県', '210', '3m'), area('宮城県', '220', '3m')]
    expect(sortAreasForCardDisplay(areas, []).map(a => a.name)).toEqual(['岩手県', '宮城県'])
  })

  it('グループ内は実測波高の降順に並べ、実測が無い区域は後ろへ回す', () => {
    const areas = [area('岩手県', '210', '3m'), area('宮城県', '220', '3m'), area('福島県', '250', '3m')]
    const sorted = sortAreasForCardDisplay(areas, [height('福島県', '250', 1.2), height('宮城県', '220', 2.4)])
    expect(sorted.map(a => a.name)).toEqual(['宮城県', '福島県', '岩手県'])
  })

  it('実測が同値なら「以上」を優先し、それも同じなら電文順を保つ', () => {
    const areas = [area('岩手県', '210', '3m'), area('宮城県', '220', '3m')]
    expect(sortAreasForCardDisplay(areas, [
      height('岩手県', '210', 2.0),
      height('宮城県', '220', 2.0, true),
    ]).map(a => a.name)).toEqual(['宮城県', '岩手県'])
    expect(sortAreasForCardDisplay(areas, [
      height('岩手県', '210', 2.0),
      height('宮城県', '220', 2.0),
    ]).map(a => a.name)).toEqual(['岩手県', '宮城県'])
  })

  // 正: 「以上」は真の波高の下限しか示さない（上限が無い）ため、値が下でも確定値より上に置く
  it('「以上」は値が確定値より低くても上に並ぶ', () => {
    const areas = [area('岩手県', '210', '3m'), area('宮城県', '220', '3m')]
    expect(sortAreasForCardDisplay(areas, [
      height('岩手県', '210', 9.0),
      height('宮城県', '220', 8.5, true),
    ]).map(a => a.name)).toEqual(['宮城県', '岩手県'])
  })

  // 対照: 「以上」を優先するのは確定値との比較だけ。「以上」どうしは値の大小で並ぶ
  it('「以上」どうしは値の降順に並ぶ', () => {
    const areas = [area('岩手県', '210', '3m'), area('宮城県', '220', '3m')]
    expect(sortAreasForCardDisplay(areas, [
      height('岩手県', '210', 1.5, true),
      height('宮城県', '220', 8.5, true),
    ]).map(a => a.name)).toEqual(['宮城県', '岩手県'])
  })

  // 安全弁: 「以上」優先が「実測が無い区域を後ろへ回す」という上位の規則を追い越さない
  it('「以上」があっても実測の無い区域は後ろのまま', () => {
    const areas = [area('岩手県', '210', '3m'), area('宮城県', '220', '3m')]
    expect(sortAreasForCardDisplay(areas, [
      height('宮城県', '220', 1.5, true),
    ]).map(a => a.name)).toEqual(['宮城県', '岩手県'])
  })

  it('波高を持たない区域は独立したグループになる', () => {
    const groups = groupAreasForCardDisplay([area('岩手県', '210'), area('宮城県', '220')], [])
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
    const areas = [area('北海道太平洋沿岸東部', '100', 'Watch', '1m'), area('岩手県', '210', 'Warning', '1m')]
    expect(sortAreasAcrossGradesForCardDisplay(areas, []).map(a => a.name))
      .toEqual(['岩手県', '北海道太平洋沿岸東部'])
  })

  // 対照: 等級を分けない `sortAreasForCardDisplay` は波高で束ねるため、この並びにならない。
  // 等級混じりの一覧をそちらへ渡すと、注意報の区域が警報より上に出る
  it('等級を分けない並べ替えとは結果が違う', () => {
    const areas = [area('北海道太平洋沿岸東部', '100', 'Watch', '1m'), area('岩手県', '210', 'Warning', '1m')]
    expect(sortAreasForCardDisplay(areas, []).map(a => a.name))
      .toEqual(['北海道太平洋沿岸東部', '岩手県'])
  })

  // 安全弁: 等級の中では従来どおり実測波高の深刻な順。等級で分けたことが、
  // 区域どうしの並べ替えを止めてしまっていないこと
  it('同じ等級の中は実測波高の深刻な順を保つ', () => {
    const areas = [
      area('岩手県', '210', 'Warning', '3m'),
      area('宮城県', '220', 'Warning', '3m'),
      area('北海道太平洋沿岸東部', '100', 'Watch', '1m'),
    ]
    expect(sortAreasAcrossGradesForCardDisplay(areas, [height('宮城県', '220', 2.4)]).map(a => a.name))
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
    const areas = [area('青森県太平洋沿岸', '201', 'Watch'), area('岩手県', '210', 'MajorWarning')]
    const items = [obs('八戸港', '青森県太平洋沿岸', '201', 0.4), obs('宮古', '岩手県', '210', 1.2)]
    expect(sortObservationsForCardDisplay(items, areas).map(o => o.name)).toEqual(['宮古', '八戸港'])
  })

  // 区域の並べ替え（実測の深刻な順）がそのまま観測点の順にも効く
  it('同じ等級では区域の表示順に従う', () => {
    const areas = [area('岩手県', '210', 'Warning', '3m'), area('宮城県', '220', 'Warning', '3m')]
    const items = [obs('宮古', '岩手県', '210', 1.2), obs('石巻市鮎川', '宮城県', '220', 2.4)]
    // 実測が深刻な宮城県の区域が上に来るので、観測点も石巻市鮎川が先
    expect(sortObservationsForCardDisplay(items, areas).map(o => o.name)).toEqual(['石巻市鮎川', '宮古'])
  })

  it('同じ区域の中は電文の並びを保つ', () => {
    const areas = [area('岩手県', '210', 'Warning')]
    const items = [obs('宮古', '岩手県', '210', 1.2), obs('大船渡', '岩手県', '210', 3.0)]
    expect(sortObservationsForCardDisplay(items, areas).map(o => o.name)).toEqual(['宮古', '大船渡'])
  })

  // 安全弁: 区域に紐づかない観測点はカードでも最後（「沖合観測」）。落としてはいけない
  it('区域に紐づかない観測点は最後に置き、取り落とさない', () => {
    const areas = [area('岩手県', '210', 'Warning')]
    const items = [obs('沖合A', '沖合', '999', 0.5), obs('宮古', '岩手県', '210', 1.2)]
    expect(sortObservationsForCardDisplay(items, areas).map(o => o.name)).toEqual(['宮古', '沖合A'])
  })

  it('区域が空でも全件を 電文順で返す', () => {
    const items = [obs('宮古', '岩手県', '210', 1.2), obs('大船渡', '岩手県', '210', 3.0)]
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

describe('withInheritedTsunamiFacts', () => {
  it('最新報が期限を持たなければ同一イベントの過去報から引き継ぐ', () => {
    const older = makeTsunami({ id: 'a', eventId: 'E1', time: '2024-01-02T10:00:00+09:00', validDateTime: '2024-01-02T17:00:00+09:00' })
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T10:03:00+09:00' })
    expect(withInheritedTsunamiFacts(latest, [latest, older]).validDateTime).toBe('2024-01-02T17:00:00+09:00')
  })

  it('最新報が期限を持つならそれを使う', () => {
    const older = makeTsunami({ id: 'a', eventId: 'E1', time: '2024-01-02T10:00:00+09:00', validDateTime: '2024-01-02T17:00:00+09:00' })
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T13:00:00+09:00', validDateTime: '2024-01-03T09:00:00+09:00' })
    expect(withInheritedTsunamiFacts(latest, [latest, older]).validDateTime).toBe('2024-01-03T09:00:00+09:00')
  })

  it('別イベントの報からは引き継がない', () => {
    const other = makeTsunami({ id: 'x', eventId: 'E2', time: '2024-01-02T10:00:00+09:00', validDateTime: '2024-01-02T17:00:00+09:00' })
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T10:03:00+09:00' })
    expect(withInheritedTsunamiFacts(latest, [latest, other]).validDateTime).toBeUndefined()
  })

  it('日時として読めない期限は落とす（残すと以後の比較がすべて偽へ倒れる）', () => {
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T10:03:00+09:00', validDateTime: '壊れた期限' })
    expect(withInheritedTsunamiFacts(latest, [latest]).validDateTime).toBeUndefined()
  })

  it('自分の期限が読めなければ、同一イベントの過去報から引き継ぐ', () => {
    const older = makeTsunami({ id: 'a', eventId: 'E1', time: '2024-01-02T10:00:00+09:00', validDateTime: '2024-01-02T17:00:00+09:00' })
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T10:03:00+09:00', validDateTime: '壊れた期限' })
    expect(withInheritedTsunamiFacts(latest, [latest, older]).validDateTime).toBe('2024-01-02T17:00:00+09:00')
  })

  it('eventId が無い経路（P2PQuake）では id が一致する報だけを見る', () => {
    const other = makeTsunami({ id: 'x', time: '2024-01-02T10:00:00+09:00', validDateTime: '2024-01-02T17:00:00+09:00' })
    const latest = makeTsunami({ id: 'b', time: '2024-01-02T10:03:00+09:00' })
    expect(withInheritedTsunamiFacts(latest, [latest, other]).validDateTime).toBeUndefined()
  })

  // 電文の本文も同じ扱いで引き継ぐ（→ `JMATsunami.bodyText`）。期限と別に固定するのは、
  // **選び方が違う**ため —— 期限は「日時として読める最新のもの」、本文は「本文を持つ最新の報」。
  it('本文を持たない最新報では、同一イベントの過去報から引き継ぐ', () => {
    const older = makeTsunami({ id: 'a', eventId: 'E1', time: '2024-01-02T10:00:00+09:00', bodyText: '前の本文' })
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T10:03:00+09:00' })
    expect(withInheritedTsunamiFacts(latest, [latest, older]).bodyText).toBe('前の本文')
  })

  // 正: 本文を持つ過去報が複数あれば、発表時刻が最も新しいものを採る。
  // **順序を当てにしない** —— 履歴 API は新しい順に並ぶとは限らない
  it('本文を持つ過去報が複数あれば発表時刻が最も新しいものを採る', () => {
    const oldest = makeTsunami({ id: 'a', eventId: 'E1', time: '2024-01-02T10:00:00+09:00', bodyText: '古い本文' })
    const newer = makeTsunami({ id: 'c', eventId: 'E1', time: '2024-01-02T12:00:00+09:00', bodyText: '新しい本文' })
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T13:00:00+09:00' })
    // 履歴の並び順に依存しないことを見るため、時刻の順とは違う順で渡す
    expect(withInheritedTsunamiFacts(latest, [oldest, latest, newer]).bodyText).toBe('新しい本文')
  })

  // 対照: 最新報が本文を持つならそれを使う（過去報で上書きしない）
  it('最新報が本文を持つならそれを使う', () => {
    const older = makeTsunami({ id: 'a', eventId: 'E1', time: '2024-01-02T10:00:00+09:00', bodyText: '前の本文' })
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T10:03:00+09:00', bodyText: '今の本文' })
    expect(withInheritedTsunamiFacts(latest, [latest, older]).bodyText).toBe('今の本文')
  })

  // 安全弁: 別イベントの本文は引き継がない（無関係な津波の文を出さない）
  it('別イベントの報からは本文を引き継がない', () => {
    const other = makeTsunami({ id: 'x', eventId: 'E2', time: '2024-01-02T10:00:00+09:00', bodyText: '別の津波の本文' })
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T10:03:00+09:00' })
    expect(withInheritedTsunamiFacts(latest, [latest, other]).bodyText).toBeUndefined()
  })

  // 安全弁: 発表時刻が読めない報が混ざっても、読める報の中から選べること。
  // 並べ替えの比較が NaN になる要素を含んでも落ちない
  it('発表時刻が読めない報が混ざっても、読める報から選ぶ', () => {
    const broken = makeTsunami({ id: 'z', eventId: 'E1', time: '壊れた時刻', bodyText: '時刻の読めない報の本文' })
    const good = makeTsunami({ id: 'a', eventId: 'E1', time: '2024-01-02T10:00:00+09:00', bodyText: '読める報の本文' })
    const latest = makeTsunami({ id: 'b', eventId: 'E1', time: '2024-01-02T10:03:00+09:00' })
    expect(withInheritedTsunamiFacts(latest, [broken, good, latest]).bodyText).toBe('読める報の本文')
  })

  // ここから下は、ライブ受信で引き継いでいるものを**リロード時にも**引き継げているかの検査。
  // ライブ側にだけ足してこちらへ足し忘れると、「受信中は出るのにリロードすると消える」という
  // 形になる（2026-09-11 に実際にそうなった）。
  //
  // 実電文（2026-04-20 三陸沖）の並びを縮めた形:
  //   16:55 VTSE41 津波警報等  区域あり・観測点なし・避難の呼びかけ・自由付加文
  //   16:56 VTSE51 満潮時刻    同じ区域・観測点あり・満潮の注記

  /** 津波警報等（VTSE41）。区域は運ぶが潮位観測点は運ばない。 */
  const restoreWarning = (over: Partial<JMATsunami> = {}) => makeTsunami({
    id: 'w', eventId: 'E1', time: '2026-04-20T16:55:38+09:00',
    carriesForecastStations: false,
    warningComments: [{ key: 'VTSE41', text: 'ただちに避難してください。' }],
    freeText: '［予想される津波の高さの解説］',
    areas: [makeArea({ name: '岩手県', code: '210', grade: 'Warning' })],
    ...over,
  })

  /** 満潮時刻の報（VTSE51）。同じ区域に潮位観測点を足して載せる。 */
  const restoreHighTide = (over: Partial<JMATsunami> = {}) => makeTsunami({
    id: 'h', eventId: 'E1', time: '2026-04-20T16:56:17+09:00',
    carriesForecastStations: true,
    observationDateTime: '2026-04-20T16:56:00+09:00',
    warningComments: [{ key: 'VTSE51|各地の満潮時刻・津波到達予想時刻に関する情報', text: '津波と満潮が重なると、' }],
    areas: [makeArea({
      name: '岩手県', code: '210', grade: 'Warning',
      stations: [{ name: '宮古', code: '21001', highTideDateTime: '2026-04-20T18:19:00+09:00' }],
    })],
    ...over,
  })

  // 正: 最新報が満潮時刻の報なら、その前の津波警報等から避難の呼びかけと自由付加文を継ぐ。
  it('最新報が満潮時刻の報でも避難の呼びかけと自由付加文が残る', () => {
    const latest = restoreHighTide()
    const merged = withInheritedTsunamiFacts(latest, [restoreWarning(), latest])
    expect(merged.warningComments!.map(c => c.key))
      .toEqual(['VTSE41', 'VTSE51|各地の満潮時刻・津波到達予想時刻に関する情報'])
    expect(merged.freeText).toBe('［予想される津波の高さの解説］')
  })

  // 正: 最新報が津波警報等なら、その前の満潮時刻の報から潮位観測点を継ぐ。
  it('最新報が津波警報等でも満潮時刻が残る', () => {
    const latest = restoreWarning({ id: 'w2', time: '2026-04-20T17:08:19+09:00' })
    const merged = withInheritedTsunamiFacts(latest, [restoreWarning(), restoreHighTide(), latest])
    expect(merged.areas[0].stations?.[0].highTideDateTime).toBe('2026-04-20T18:19:00+09:00')
    // 観測時点も同じ理由で継ぐ（観測情報にしか入らない）
    expect(merged.observationDateTime).toBe('2026-04-20T16:56:00+09:00')
  })

  // 対照: 最新報が潮位観測点を運ぶ種別なら継がない。気象庁が発表をやめた合図なので、
  // 継ぐと解除間際の画面に古い到達予想時刻が残る（ライブ側と同じ判断）。
  it('最新報が津波情報で観測点を載せていなければ継がない', () => {
    const latest = restoreHighTide({
      id: 'h2', time: '2026-04-20T17:45:00+09:00',
      areas: [makeArea({ name: '岩手県', code: '210', grade: 'Forecast' })],
    })
    const merged = withInheritedTsunamiFacts(latest, [restoreHighTide(), latest])
    expect(merged.areas[0].stations).toBeUndefined()
  })

  // 安全弁: 別イベントの報からは何も継がない。
  it('別イベントの報からは継がない', () => {
    const other = restoreHighTide({ id: 'x', eventId: 'E2' })
    const latest = restoreWarning({ id: 'w2', time: '2026-04-20T17:08:19+09:00' })
    const merged = withInheritedTsunamiFacts(latest, [other, latest])
    expect(merged.areas[0].stations).toBeUndefined()
    expect(merged.warningComments!.map(c => c.key)).toEqual(['VTSE41'])
  })

  // 安全弁: **観測点を運ぶ種別の報が「載せなかった」判断を飛び越えない。**
  // 「最後に観測点を載せた報」から 1 回だけ継ぐ形にすると、その判断より古い報の観測点を
  // 復活させてしまう。ライブ受信と同じく古い報から畳むことで防ぐ。
  it('観測点を載せなくなった津波情報を飛び越えて古い値を復活させない', () => {
    const stopped = restoreHighTide({
      id: 'h2', time: '2026-04-20T17:45:00+09:00',
      areas: [makeArea({ name: '岩手県', code: '210', grade: 'Forecast' })],
    })
    // その後に届いた津波警報等（観測点を運ばない種別）。直前の津波情報が観測点を落としている
    // ので、継ぐ相手はもう無い。
    const latest = restoreWarning({ id: 'w4', time: '2026-04-20T17:50:00+09:00' })
    const merged = withInheritedTsunamiFacts(latest, [restoreHighTide(), stopped, latest])
    expect(merged.areas[0].stations).toBeUndefined()
  })

  // 正: 最新報が区域を伝えていない観測のみの続報（沖合の観測など）でも、等級と区域が残る。
  // 観測情報は 1 分に何通も届くので、**この報が最後に届いた状態でリロードするのは普通に起きる**。
  it('最新報が観測のみの続報でも等級と区域が残る', () => {
    const offshore = makeTsunami({
      id: 'o', eventId: 'E1', time: '2026-04-20T17:16:31+09:00',
      areas: [],
      observations: [{ name: '釜石沖', offshore: true, height: { value: 1.2, description: '1.2m' } }],
    })
    const merged = withInheritedTsunamiFacts(offshore, [restoreWarning(), restoreHighTide(), offshore])
    expect(merged.areas.map(a => a.name)).toEqual(['岩手県'])
    expect(merged.areas[0].grade).toBe('Warning')
    // 満潮時刻も残る（区域ごと継いでいるので当然だが、対で確かめる）
    expect(merged.areas[0].stations?.[0].highTideDateTime).toBe('2026-04-20T18:19:00+09:00')
  })

  // 正: 沿岸と沖合は**別の観測点集合**（実電文で沿岸 19 点・沖合 9 点・重複 0）。最新報だけを
  // 採ると、最後に届いたのが沿岸観測なら沖合の点が丸ごと消える。
  it('沿岸と沖合の観測点が両方残る', () => {
    const offshoreReport = makeTsunami({
      id: 'o', eventId: 'E1', time: '2026-04-20T17:16:31+09:00', areas: [],
      observations: [{ name: '岩手宮古沖', offshore: true, height: { value: 1.2, description: '1.2m' } }],
      estimations: [{ name: '岩手県', arrivalTime: '2026-04-20T17:30:00+09:00' }],
    })
    const coastal = makeTsunami({
      id: 'c1', eventId: 'E1', time: '2026-04-20T17:25:00+09:00', areas: [],
      observations: [{ name: '宮古', height: { value: 0.8, description: '0.8m' } }],
    })
    const merged = withInheritedTsunamiFacts(coastal, [restoreHighTide(), offshoreReport, coastal])
    // 並びは見ない（この関数の担当ではない。カード順は `sortObservationsForCardDisplay`）
    expect(new Set(merged.observations?.map(o => o.name))).toEqual(new Set(['宮古', '岩手宮古沖']))
    // 沿岸への推定も残る（沖合の実測が残るのに、そこから導いた推定だけ消えるのは食い違い）
    expect(merged.estimations?.map(e => e.name)).toEqual(['岩手県'])
  })

  // 対照: 解除・取消の報には継がない。区域が空なのは**その報の内容**であって、
  // 運ばないからではない。継ぐと解除されたはずの区域が復活する。
  it('解除の報には区域を継がない', () => {
    const lifted = makeTsunami({
      id: 'c', eventId: 'E1', time: '2026-04-20T18:00:00+09:00',
      cancelled: true, cancelReason: 'lifted', areas: [],
    })
    expect(withInheritedTsunamiFacts(lifted, [restoreWarning(), restoreHighTide(), lifted]).areas).toEqual([])
  })

  // 安全弁: 等級が下がって固定付加文が書き換わったら、古い呼びかけを残さない
  // （同じ主題の枠は置き換わる）。
  it('等級が下がった呼びかけは古いものを残さない', () => {
    const lowered = restoreWarning({
      id: 'w3', time: '2026-04-20T17:45:00+09:00',
      warningComments: [{ key: 'VTSE41', text: '＜津波注意報＞海の中や海岸付近は危険です。' }],
    })
    const merged = withInheritedTsunamiFacts(lowered, [restoreWarning(), lowered])
    const grade = merged.warningComments!.filter(c => c.key === 'VTSE41')
    expect(grade).toHaveLength(1)
    expect(grade[0].text).toContain('津波注意報')
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

// 最大波の観測時刻（`MaxHeight/DateTime`）。波高の数値だけでは、それがいつの観測値か
// 分からない —— 続報で値が変わらないとき、観測し直して同じだったのか前の値が据え置かれて
// いるのかを読み取れる唯一の手がかり。
describe('observationMaxHeightTimeText: 最大波の観測時刻', () => {
  const obs = (o: Partial<TsunamiObservation>): TsunamiObservation => ({ name: '銚子', ...o })

  it('正: 語を冠して時刻を出す（同じ行に並ぶ第1波の到達時刻と紛れないように）', () => {
    expect(observationMaxHeightTimeText(obs({
      height: { value: 8.5, description: '8.5m' },
      maxHeightDateTime: '2026-01-01T12:40:00+09:00',
    }))).toBe('最大波 12:40')
  })

  it('対照: 時刻が無ければ何も返さない', () => {
    expect(observationMaxHeightTimeText(obs({ height: { value: 8.5, description: '8.5m' } }))).toBe('')
  })

  it('安全弁: 波高を出していない行では返さない（値の無い観測点が何かを観測したように見える）', () => {
    expect(observationMaxHeightTimeText(obs({
      maxHeightDateTime: '2026-01-01T12:40:00+09:00',
      condition: { maxHeightMissing: true },
    }))).toBe('')
  })
})

// 「重要」（`MaxHeight/Condition`）の意味は電文で違う。語をそのまま出しても伝わらないので
// 意味の側を書くが、そのとき基準を取り違えると実際より軽い／重い印象を与える。
describe('「重要」の言い換えは出所ごとに分ける', () => {
  // 正: 沖合の観測点・沿岸への推定は大津波警報と津波警報の両方が基準
  // （電文解説資料 Ⅱ.13 1-1-2-2-2 / 1-2-2-3）。
  it('沖合は大津波警報・津波警報の両方を挙げる', () => {
    expect(importantBadgeText(true)).toBe('大津波警報・津波警報の基準超')
  })

  // 対照: 沿岸の潮位観測点は大津波警報のみが基準（Ⅱ.12 1-2-2-2）。広げると過大になる。
  it('沿岸は大津波警報だけを挙げる', () => {
    expect(importantBadgeText(false)).toBe('大津波警報の基準超')
  })

  // 安全弁: 区域の予想波高の「重要」は別の語にする。あちらは実際に観測・推定した高さではなく
  // **予想の書き換え**を指すので（Ⅱ.11 1-1-2-4）、同じ語で出すと取り違える。
  it('区域の予想波高の「重要」は別の語にする', () => {
    expect(forecastHeightImportantBadge()).not.toBe(importantBadgeText(true))
    expect(forecastHeightImportantBadge()).not.toBe(importantBadgeText(false))
  })

  // 対照: この印は引き下げでは付かない。方向が伝わらない語のままにしない
  // （赤い色で出しているのに「下がったかもしれない更新」とも読めてしまう）。
  it('区域の予想波高の語は方向を伝える', () => {
    expect(forecastHeightImportantBadge()).toContain('引き上げ')
  })

  // 正: 沖合の観測点にはその基準でバッジが付く。
  it('沖合の観測点のバッジに沖合の基準を使う', () => {
    const obs: TsunamiObservation = { name: '岩手釜石沖', offshore: true, condition: { important: true }, arrivalTime: '2026-01-01T12:20:00+09:00' }
    expect(observationBadges(obs)).toContain('大津波警報・津波警報の基準超')
  })

  // 対照: 沿岸の観測点は従来どおり。
  it('沿岸の観測点のバッジは従来のまま', () => {
    const obs: TsunamiObservation = { name: '銚子', condition: { important: true }, arrivalTime: '2026-01-01T12:20:00+09:00' }
    expect(observationBadges(obs)).toContain('大津波警報の基準超')
  })
})

// 沿岸への推定は、数値を出せない状態（「推定中」）を電文が明示する。空欄にすると、値が無いのが
// 気象庁の判断なのか読み落としなのか画面から分からない。
describe('沿岸への推定の波高欄', () => {
  // 正: 数値があればそれを出す。
  it('数値があれば数値を出す', () => {
    expect(estimationHeightText({ name: '岩手県', maxHeight: { description: '3m', value: 3 } })).toBe('3m')
  })

  // 正: 数値が無く「推定中」なら理由を出す。
  it('推定中なら理由を出す', () => {
    expect(estimationHeightText({ name: '福島県', condition: { estimating: true } })).toBe('推定中')
  })

  // 対照: どちらも無ければ空（沖合から遠く、推定そのものが出ない沿岸）。
  it('数値も理由も無ければ空にする', () => {
    expect(estimationHeightText({ name: '青森県' })).toBe('')
  })

  // 安全弁: バッジは「重要」のときだけ。「推定中」は波高欄の担当で、両方に出すと 1 行に 2 回並ぶ。
  it('推定中はバッジにしない', () => {
    expect(estimationBadges({ name: '福島県', condition: { estimating: true } })).toEqual([])
    expect(estimationBadges({ name: '岩手県', condition: { important: true } })).toEqual(['大津波警報・津波警報の基準超'])
  })
})

// 「観測中」のまま津波警報に相当する津波を観測している状態。
//
// 気象庁は大津波警報の区域に対応する沖合の観測点で、沿岸で推定される高さが大津波警報の基準
// （3m 超）に届かないとき数値を出さず「観測中」とする。そのとき `Revise` に「更新」と書くことで
// 津波警報相当（1m 超）を観測していることを示す（Ⅱ.13 1-1-2-2-2）。
// **「観測中」の中身は変わりようがないので、値の変化からは導けない。**
describe('観測中のまま津波警報相当', () => {
  const offshoreObserving = (over: Partial<TsunamiObservation> = {}): TsunamiObservation => ({
    name: '岩手宮古沖', offshore: true, condition: { observing: true }, ...over,
  })

  // 正: 沖合・観測中・Revise=更新 の 3 つが揃ったとき。
  it('沖合で観測中のまま更新なら立てる', () => {
    expect(isWarningLevelWhileObserving(offshoreObserving({ maxHeightRevise: '更新' }))).toBe(true)
  })

  // 対照: 「追加」では立てない（新たに観測中になっただけ）。
  it('追加では立てない', () => {
    expect(isWarningLevelWhileObserving(offshoreObserving({ maxHeightRevise: '追加' }))).toBe(false)
  })

  // 対照: Revise が無ければ立てない。
  it('Revise が無ければ立てない', () => {
    expect(isWarningLevelWhileObserving(offshoreObserving())).toBe(false)
  })

  // 安全弁: 沿岸の観測点には当てない。仕組みとしては成り立ちそうに見えるが、資料が注意を
  // 書いているのは沖合だけ。先回りすると気象庁が言っていない警告をアプリが作ることになる。
  it('沿岸の観測点には当てない', () => {
    expect(isWarningLevelWhileObserving({
      name: '銚子', condition: { observing: true }, maxHeightRevise: '更新',
    })).toBe(false)
  })

  // 安全弁: 「観測中」でなければ当てない（数値が出ている観測点の更新は普通の更新）。
  it('観測中でなければ当てない', () => {
    expect(isWarningLevelWhileObserving({
      name: '岩手宮古沖', offshore: true, maxHeightRevise: '更新',
      height: { value: 1.2, description: '1.2m' },
    })).toBe(false)
  })

  // 正: バッジに出る。既存の「重要」のバッジと併記できる。
  it('バッジに出す', () => {
    expect(observationBadges(offshoreObserving({ maxHeightRevise: '更新', arrivalTime: '2026-01-01T12:20:00+09:00' })))
      .toContain('津波警報相当を観測')
  })

  // 安全弁: 「〜の基準超」と同じ形にしない。同じ行に並ぶので、形を揃えると
  // 「実測値が弱いほうの基準だけ超えた」と読める（実際は数値が出ていない）
  it('「基準超」の語形と混ぜない', () => {
    const badge = observationBadges(offshoreObserving({ maxHeightRevise: '更新', arrivalTime: '2026-01-01T12:20:00+09:00' }))
      .find(b => b.includes('津波警報'))!
    expect(badge).not.toContain('基準超')
    expect(badge).not.toBe(importantBadgeText(true))
    expect(badge).not.toBe(importantBadgeText(false))
  })
})

// ============================================================
// 続報のマージ（区域の観測点・固定付加文）
//
// 実電文（2026-04-20 三陸沖・`eventId=20260420165303`・41 通）で確かめた形を固定する。
//   - 津波警報等（VTSE41）は区域一覧を全量で載せるが、区域の中に `Station` を 1 件も持たない
//   - 津波情報（VTSE51）は同じ区域一覧に加えて `Station`（満潮時刻・到達予想時刻）を載せる
//   - 等級が津波予報まで下がると、VTSE51 も `Station` を載せなくなる
// ============================================================

describe('mergeTsunamiAreas', () => {
  const withStations = (name: string, code: string) => makeArea({
    name, code, stations: [{ name: `${name}港`, code: `${code}1`, highTideDateTime: '2026-04-20T18:30:00+09:00' }],
  })

  // 正: 観測点を運ばない種別（津波警報等）では、前報の満潮時刻を継ぐ。
  // これを落とすと、警報が届いた瞬間に満潮時刻が画面から消える（実運用では次の満潮情報まで 24 秒）。
  it('観測点を運ばない種別では前報の観測点を継ぐ', () => {
    const prev = [withStations('岩手県', '210')]
    const next = [makeArea({ name: '岩手県', code: '210', grade: 'Warning' })]
    const merged = mergeTsunamiAreas(prev, next, false)
    expect(merged[0].stations?.[0].highTideDateTime).toBe('2026-04-20T18:30:00+09:00')
    // 等級は新報が正。継ぐのは観測点だけ。
    expect(merged[0].grade).toBe('Warning')
  })

  // 対照: 観測点を運ぶ種別（津波情報）で観測点が消えたなら、気象庁が発表をやめたということ。
  // 継ぐと、解除間際の画面に古い到達予想時刻が残り続ける。
  it('観測点を運ぶ種別で空になったら継がない', () => {
    const prev = [withStations('岩手県', '210')]
    const next = [makeArea({ name: '岩手県', code: '210', grade: 'Forecast' })]
    expect(mergeTsunamiAreas(prev, next, true)[0].stations).toBeUndefined()
  })

  // 安全弁: 区域そのものを前報から復活させない。気象庁は一部解除を「区域が電文から消える」形で
  // 出すので、キー単位の upsert にすると解除済みの等級を出し続ける。
  it('前報にしかない区域を復活させない', () => {
    const prev = [withStations('岩手県', '210'), withStations('宮城県', '220')]
    const next = [makeArea({ name: '岩手県', code: '210' })]
    expect(mergeTsunamiAreas(prev, next, false).map(a => a.name)).toEqual(['岩手県'])
  })

  // 安全弁: 新報が観測点を持つなら、そちらが勝つ（前報で上書きしない）。
  it('新報の観測点を前報で上書きしない', () => {
    const prev = [withStations('岩手県', '210')]
    const next = [makeArea({
      name: '岩手県', code: '210',
      stations: [{ name: '宮古', code: '21001', highTideDateTime: '2026-04-20T19:00:00+09:00' }],
    })]
    expect(mergeTsunamiAreas(prev, next, true)[0].stations?.[0].name).toBe('宮古')
    expect(mergeTsunamiAreas(prev, next, false)[0].stations?.[0].name).toBe('宮古')
  })

  // 種別を判定できない経路（P2PQuake）は安全側＝継ぐ。あちらは観測点を配信しないので実害は無いが、
  // 判定できないことを「継がない」に倒すと、種別が増えたときに黙って落ちる。
  it('種別が分からなければ継ぐ', () => {
    const prev = [withStations('岩手県', '210')]
    const next = [makeArea({ name: '岩手県', code: '210' })]
    expect(mergeTsunamiAreas(prev, next, undefined)[0].stations?.length).toBe(1)
  })

  // 区域コードが無い経路（P2PQuake）でも名前で引き当てられること。
  it('コードが無ければ区域名で引き当てる', () => {
    const prev = [makeArea({ name: '岩手県', code: undefined, stations: [{ name: '宮古', code: '21001' }] })]
    const next = [makeArea({ name: '岩手県', code: undefined })]
    expect(mergeTsunamiAreas(prev, next, false)[0].stations?.length).toBe(1)
  })
})

describe('mergeTsunamiWarningComments', () => {
  const grade = { key: 'VTSE41', text: 'ただちに避難してください。' }
  const highTide = { key: 'VTSE51|各地の満潮時刻・津波到達予想時刻に関する情報', text: '津波と満潮が重なると、' }
  const observation = { key: 'VTSE51|津波観測に関する情報', text: '津波による潮位変化が観測されてから' }
  const offshore = { key: 'VTSE52', text: '沖合での観測値であり、' }

  // 正: 主題が違えば足す。上書きしていた頃は、避難の呼びかけが 1 分後の満潮時刻の報で消えていた。
  it('主題が違えば足す', () => {
    const merged = mergeTsunamiWarningComments([grade], [highTide])!
    expect(merged.map(c => c.key)).toEqual([grade.key, highTide.key])
  })

  // 対照: 同じ主題なら置き換える。等級が下がれば呼びかけも書き換わるので、
  // 足していくと解除済みの等級の呼びかけが残る。
  it('同じ主題なら置き換える', () => {
    const lowered = { key: 'VTSE41', text: '＜津波注意報＞海の中や海岸付近は危険です。' }
    const merged = mergeTsunamiWarningComments([grade, highTide], [lowered])!
    expect(merged).toHaveLength(2)
    expect(merged.find(c => c.key === 'VTSE41')!.text).toBe(lowered.text)
  })

  // 安全弁: 並びは到着順ではなく主題順。途中から受信を始めても等級の呼びかけが先頭に来る。
  it('到着順によらず主題の順で並べる', () => {
    const merged = mergeTsunamiWarningComments([observation, offshore], [highTide, grade])!
    expect(merged.map(c => c.key)).toEqual([grade.key, highTide.key, observation.key, offshore.key])
  })

  // 安全弁: 表に無い鍵でも落とさない（気象庁が情報名を増やしても消えない）。末尾へ回す。
  it('表に無い鍵は末尾へ回して落とさない', () => {
    const unknown = { key: 'VTSE51|新しい情報名', text: '未知の注記' }
    const merged = mergeTsunamiWarningComments([unknown], [grade])!
    expect(merged.map(c => c.key)).toEqual([grade.key, unknown.key])
    expect(WARNING_COMMENT_ORDER).not.toContain(unknown.key)
  })

  // 新報が持たなければ前報をそのまま返す（`mergeTsunamiObservations` と同じ扱い）。
  it('新報が持たなければ前報を残す', () => {
    expect(mergeTsunamiWarningComments([grade], undefined)).toEqual([grade])
    expect(mergeTsunamiWarningComments(undefined, undefined)).toBeUndefined()
  })
})

// 行動指示の行に出す文。**実電文（2024-01-01 能登半島地震の VTSE41）で 1 行目の形が報によって
// 変わることを確かめてある** —— 16:12 の報は「ただちに避難してください。」で始まり、20:30 の報は
// 「＜津波警報＞」という小見出しで始まる。**どちらも最高等級は津波警報**で、形は等級から
// 予測できない（→ `evacuationActionLine`）。

// バナーの行動指示の行は固定付加文（VTSE41）の 1 行目を出す。固定付加文は主題の鍵ごとに
// 上書きするので、等級を動かす報がその付加文を持たないと、前の等級に向けた避難の呼びかけが
// いちばん目立つ位置に残り続ける（→ docs/spec/tsunami-spec.md §9）。画面には痕跡が出ない
// ので、記録だけは残す。
describe('等級が動いた報に避難行動の付加文が無いとき', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const withComment = (text: string) => [{ key: 'VTSE41', text }]
  const current = makeTsunami({
    areas: [makeArea({ code: '100', grade: 'MajorWarning' })],
    warningComments: withComment('ただちに避難してください。'),
  })

  // 正: 等級が下がったのに付加文が無い。前報の「ただちに避難してください。」が残る。
  it('記録を残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    mergeTsunamiReports(current, makeTsunami({ areas: [makeArea({ code: '100', grade: 'Warning' })] }))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('避難行動の付加文がありません')
  })

  // 対照: 等級が動いていなければ、前報の文がそのまま正しい。満潮時刻の続報はこちら。
  it('等級が動いていなければ記録しない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    mergeTsunamiReports(current, makeTsunami({ areas: [makeArea({ code: '100', grade: 'MajorWarning' })] }))
    expect(warn).not.toHaveBeenCalled()
  })

  // 安全弁: 新報が付加文を持っていれば行は入れ替わる。等級が動いても記録しない。
  it('新報が付加文を持っていれば記録しない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    mergeTsunamiReports(current, makeTsunami({
      areas: [makeArea({ code: '100', grade: 'Warning' })],
      warningComments: withComment('高い津波が襲います。'),
    }))
    expect(warn).not.toHaveBeenCalled()
  })

  // 安全弁: 区域を伝えない報（観測のみの続報）は等級を語っていない。数えない。
  it('区域を伝えない報では記録しない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    mergeTsunamiReports(current, makeTsunami({ areas: [] }))
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('evacuationActionLine', () => {
  const warn = (text: string) => [{ key: 'VTSE41', text }]

  // 正: 1 行目が文として完結していれば、それを採る。
  it('1 行目が文なら採る', () => {
    const text = 'ただちに避難してください。' + '\n' + '　' + '\n' + '＜大津波警報＞' + '\n' + '大きな津波が襲い甚大な被害が発生します。'
    expect(evacuationActionLine(warn(text))).toBe('ただちに避難してください。')
  })

  // 対照: 1 行目が小見出しなら採らない。**そのまま出すと何をすべきか伝わらない**ので、
  // 呼び出し側がアプリの文へ戻す。
  it('1 行目が小見出しなら採らない', () => {
    const text = '＜津波警報＞' + '\n' + '津波による被害が発生します。'
    expect(evacuationActionLine(warn(text))).toBeUndefined()
  })

  // 安全弁: 津波警報等（VTSE41）以外の付加文からは採らない。満潮や観測値の注記を
  // 行動指示の位置に出すと、すべきことと読み方の注意が入れ替わる。
  it('津波警報等以外の付加文からは採らない', () => {
    expect(evacuationActionLine([
      { key: 'VTSE51|各地の満潮時刻・津波到達予想時刻に関する情報', text: '津波と満潮が重なると、津波はより高くなりますので一層厳重な警戒が必要です。' },
      { key: 'VTSE52', text: '沖合での観測値であり、沿岸では津波はさらに高くなります。' },
    ])).toBeUndefined()
  })

  // 付加文が無い経路（P2PQuake）では採れない。呼び出し側がアプリの文へ戻る。
  it('付加文が無ければ採らない', () => {
    expect(evacuationActionLine(undefined)).toBeUndefined()
    expect(evacuationActionLine([])).toBeUndefined()
  })
})
