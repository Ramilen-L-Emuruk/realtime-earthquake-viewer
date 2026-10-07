import { describe, expect, it } from 'vitest'

import {
  clipRange,
  EMPTY_UNREADABLE_BOOK,
  eventsQueryRange,
  eventsUrl,
  EVENTS_PAGE_LIMIT,
  INITIAL_LOAD_STATE,
  jstDateOf,
  jstDayRange,
  recentQueryRange,
  formatMatchedQuake,
  truncatedNote,
  formatShakeStart,
  newerRecord,
  nextLoadState,
  nextUnreadableBook,
  readShakeRange,
  readShakeRecord,
  readTriggers,
  shakeRowHtml,
  startPeriodLoad,
  tableFailure,
  triggerLine,
  unreadableCount,
  upsertShake,
  VERDICT_LABELS,
  visibleShakes,
} from './shakeHistory'
import type { ShakeRecordView, TriggerView, UnreadableBook, UnreadableMark } from './shakeHistory'

// 2026-10-06 13:26:04 JST
const T0 = Date.UTC(2026, 9, 6, 4, 26, 4)
const HOUR = 3_600_000

/** ホストが書く記録の形（`detection/shakeEvent.ts` の `ShakeEventRecord`）。値は架空。 */
function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `station-1-${T0}`,
    rev: 1,
    writtenAtMs: T0 + 30_000,
    stationId: 'station-1',
    detectorVersion: 1,
    startMs: T0,
    endMs: T0 + 12_300,
    endReason: 'quiet',
    sMs: T0 + 3_200,
    sSnr: 6.1,
    pMs: null,
    pSnr: 1.2,
    sMinusPSec: null,
    phaseWindow: 'picked',
    peakAccelGal: 3.456,
    peakHorizontalGal: 3.1,
    maxIntensity: 1.24,
    peakRatio: 5.31,
    baselineGal: 0.16,
    verticalRatio: 0.4,
    bandRatios: [1, 2, 3],
    shakeClass: 'quake-like',
    sensors: [],
    spatialConsistency: 'not-evaluated',
    verdict: 'pending',
    matchedQuake: null,
    ...overrides,
  }
}

function rec(overrides: Record<string, unknown> = {}): ShakeRecordView {
  const r = readShakeRecord(wire(overrides))
  if (r === null) throw new Error('fixture が読めない')
  return r
}

describe('readShakeRecord — ホストの記録を読む', () => {
  it('正: 一覧に要る欄を読む', () => {
    const r = rec()
    expect(r).toMatchObject({
      id: `station-1-${T0}`,
      rev: 1,
      stationId: 'station-1',
      startMs: T0,
      endMs: T0 + 12_300,
      sMs: T0 + 3_200,
      pMs: null,
      peakAccelGal: 3.456,
      maxIntensity: 1.24,
      peakRatio: 5.31,
      verdict: 'pending',
      matchedQuake: null,
    })
  })

  it('正: 照合した地震を読む（規模・深さ・最大震度が無くても読む）', () => {
    const r = rec({
      verdict: 'quake',
      matchedQuake: { name: '千葉県北西部', originMs: T0 - 20_000, magnitude: null, depthKm: null, maxScale: null, distanceKm: 61.2 },
    })
    expect(r.matchedQuake).toEqual({ name: '千葉県北西部', magnitude: null, depthKm: null, maxScale: null, distanceKm: 61.2 })
  })

  it('安全弁: 判定が知らない値なら読まない（呼び名の無い判定を黙って別の名前で出さない）', () => {
    expect(readShakeRecord(wire({ verdict: 'maybe' }))).toBeNull()
  })

  it('安全弁: 欄の形が違えば読まない', () => {
    expect(readShakeRecord(wire({ startMs: '13:26' }))).toBeNull()
    expect(readShakeRecord(wire({ id: '' }))).toBeNull()
    expect(readShakeRecord(wire({ endMs: T0 - 1 }))).toBeNull()
    expect(readShakeRecord(null)).toBeNull()
  })

  it('対照: 拾えなかった S・届かなかった震度は null のまま読む（0 にしない）', () => {
    const r = rec({ sMs: null, maxIntensity: null })
    expect(r.sMs).toBeNull()
    expect(r.maxIntensity).toBeNull()
  })
})

describe('readShakeRange — GET /events の応答を読む', () => {
  it('正: 記録と、読めなかったファイルの目印（名前から始まり、なければ月）を読む', () => {
    const r = readShakeRange({
      events: [wire()],
      unreadableFiles: [`2026-10/station-1-${T0}.json`, '2026-10/x.json', '2026-09'],
      truncated: true,
      coveredFromMs: T0 - HOUR,
    })
    expect(r?.events).toHaveLength(1)
    expect(r?.truncated).toBe(true)
    expect(r?.coveredFromMs).toBe(T0 - HOUR)
    expect(r?.marks).toEqual([
      { key: `file:2026-10/station-1-${T0}.json`, startMs: T0, month: '2026-10' },
      { key: 'file:2026-10/x.json', startMs: null, month: '2026-10' },
      { key: 'file:2026-09', startMs: null, month: '2026-09' },
    ])
  })

  it('安全弁: 形の違う記録は目印を添えて外す（黙って捨てない。id が読めれば id と始まりで）', () => {
    const r = readShakeRange({
      events: [wire(), wire({ id: `s-${T0}`, verdict: 'x' }), wire({ id: 'bad', verdict: 'x' }), 7],
      unreadableFiles: [],
      truncated: false,
      coveredFromMs: T0 - HOUR,
    })
    expect(r?.events).toHaveLength(1)
    expect(r?.marks).toEqual([
      { key: `id:s-${T0}`, startMs: T0, month: null },
      { key: 'id:bad', startMs: null, month: null },
      { key: 'raw:7', startMs: null, month: null },
    ])
  })

  it('安全弁: events が配列でなければ応答ごと読めない（空の一覧と取り違えない）', () => {
    expect(readShakeRange({ unreadableFiles: [], truncated: false, coveredFromMs: T0 })).toBeNull()
    expect(readShakeRange('x')).toBeNull()
  })

  it('安全弁: 区切ったか・見終えた範囲の頭が読めなければ応答ごと読めない（「全部」と「一部」を取り違えない）', () => {
    expect(readShakeRange({ events: [], unreadableFiles: [], coveredFromMs: T0 })).toBeNull()
    expect(readShakeRange({ events: [], unreadableFiles: [], truncated: 'yes', coveredFromMs: T0 })).toBeNull()
    expect(readShakeRange({ events: [], unreadableFiles: [], truncated: false })).toBeNull()
  })
})

describe('nextUnreadableBook — 読めなかった記録の帳面', () => {
  const recent = recentQueryRange(T0 + HOUR)
  const fileMark = (startMs: number): UnreadableMark => ({ key: `file:2026-10/s-${startMs}.json`, startMs, month: '2026-10' })
  const keys = (b: UnreadableBook): string[] => [...new Set([...b.period.keys(), ...b.recent.keys()])].sort()

  it('正: 直近の読み返しが見直した範囲の目印は、出てこなければ外す（一時的に読めなかっただけなら消える）', () => {
    const book = nextUnreadableBook(EMPTY_UNREADABLE_BOOK, [fileMark(T0)], recent, 'recent')
    expect(unreadableCount(book)).toBe(1)
    const after = nextUnreadableBook(book, [], recent, 'recent')
    expect(unreadableCount(after)).toBe(0)
  })

  it('正: 期間の読み返しで拾った目印も、直近の読み返しが見直したら外す', () => {
    const book = nextUnreadableBook(EMPTY_UNREADABLE_BOOK, [fileMark(T0)], eventsQueryRange(T0 + HOUR, 7), 'full')
    expect(unreadableCount(nextUnreadableBook(book, [], recent, 'recent'))).toBe(0)
  })

  it('対照: 直近の範囲より古い目印は、直近の読み返しで出てこなくても残す（見直していない）', () => {
    const old = fileMark(T0 - 5 * HOUR)
    const book = nextUnreadableBook(EMPTY_UNREADABLE_BOOK, [old], eventsQueryRange(T0 + HOUR, 7), 'full')
    expect(keys(nextUnreadableBook(book, [], recent, 'recent'))).toEqual([old.key])
  })

  it('安全弁: 直近の範囲から外れていった目印は、まだ壊れているかもしれないので期間の分へ移して残す', () => {
    const m = fileMark(T0)
    const book = nextUnreadableBook(EMPTY_UNREADABLE_BOOK, [m], recentQueryRange(T0 + HOUR), 'recent')
    // 4 時間後の直近の範囲には T0 が入らない（見直されない）。
    const later = nextUnreadableBook(book, [], recentQueryRange(T0 + 5 * HOUR), 'recent')
    expect(keys(later)).toEqual([m.key])
    expect(later.period.has(m.key)).toBe(true)
  })

  it('安全弁: 範囲の端から 1 ミリ秒以内の目印は、見直したとみなさない（名前は始まりを丸めた値）', () => {
    const edge = fileMark(recent.fromMs)
    const book = nextUnreadableBook(EMPTY_UNREADABLE_BOOK, [edge], eventsQueryRange(T0 + HOUR, 7), 'full')
    expect(keys(nextUnreadableBook(book, [], recent, 'recent'))).toEqual([edge.key])
  })

  it('正: 始まりの分からない目印は、その月を一覧した読み返しなら外す。月も分からなければ期間を選び直すまで残す', () => {
    const month: UnreadableMark = { key: 'file:2026-10', startMs: null, month: '2026-10' }
    const raw: UnreadableMark = { key: 'raw:7', startMs: null, month: null }
    const book = nextUnreadableBook(EMPTY_UNREADABLE_BOOK, [month, raw], eventsQueryRange(T0 + HOUR, 7), 'full')
    expect(keys(nextUnreadableBook(book, [], recent, 'recent'))).toEqual(['raw:7'])
    expect(unreadableCount(nextUnreadableBook(book, [], eventsQueryRange(T0 + HOUR, 7), 'full'))).toBe(0)
  })

  it('正: 同じ目印が期間の分と直近の分の両方にあっても 1 件と数える', () => {
    const raw: UnreadableMark = { key: 'raw:7', startMs: null, month: null }
    const book = nextUnreadableBook(EMPTY_UNREADABLE_BOOK, [raw], eventsQueryRange(T0 + HOUR, 7), 'full')
    expect(unreadableCount(nextUnreadableBook(book, [raw], recent, 'recent'))).toBe(1)
  })

  it('正: さらに古い記録を読んだ回は、拾った目印を期間の分へ足す（直近の分を置き換えない）', () => {
    const newer = fileMark(T0)
    const older = fileMark(T0 - 30 * 24 * HOUR)
    const book = nextUnreadableBook(EMPTY_UNREADABLE_BOOK, [newer], recent, 'recent')
    const page = { fromMs: T0 - 40 * 24 * HOUR, toMs: T0 - 20 * 24 * HOUR }
    const after = nextUnreadableBook(book, [older], page, 'older')
    expect(keys(after)).toEqual([older.key, newer.key].sort())
    expect(after.period.has(older.key)).toBe(true)
    expect(after.recent.has(newer.key)).toBe(true)
  })

  it('正: さらに古い記録を読んだ回が見直した範囲の目印は、出てこなければ外す', () => {
    const older = fileMark(T0 - 30 * 24 * HOUR)
    const page = { fromMs: T0 - 40 * 24 * HOUR, toMs: T0 - 20 * 24 * HOUR }
    const book = nextUnreadableBook(EMPTY_UNREADABLE_BOOK, [older], page, 'older')
    expect(unreadableCount(nextUnreadableBook(book, [], page, 'older'))).toBe(0)
  })

  it('対照: さらに古い記録を読んだ回は、見直していない範囲の目印を残す', () => {
    const newer = fileMark(T0 - 2 * 24 * HOUR)
    const book = nextUnreadableBook(EMPTY_UNREADABLE_BOOK, [newer], eventsQueryRange(T0 + HOUR, 7), 'full')
    const page = { fromMs: T0 - 40 * 24 * HOUR, toMs: T0 - 20 * 24 * HOUR }
    expect(keys(nextUnreadableBook(book, [], page, 'older'))).toEqual([newer.key])
  })
})

describe('nextLoadState / tableFailure — 読み返しの成否', () => {
  const loaded = nextLoadState(INITIAL_LOAD_STATE, 'full', null)

  it('正: 期間全体を読めなかった失敗は、直近の読み直しが通っても表に残る', () => {
    const failed = nextLoadState(INITIAL_LOAD_STATE, 'full', '期間の失敗')
    const afterRecent = nextLoadState(failed, 'recent', null)
    expect(tableFailure(afterRecent)).toBe('期間の失敗')
    expect(afterRecent.periodLoaded).toBe(false)
  })

  it('正: 続きを読めなかった失敗は表に出さず、直近の読み直しでも消えない', () => {
    const olderFailed = nextLoadState(loaded, 'older', '続きの失敗')
    expect(tableFailure(olderFailed)).toBeNull()
    expect(nextLoadState(olderFailed, 'recent', null).older).toBe('続きの失敗')
  })

  it('正: 続きの失敗は、続きを読み直して通れば消える', () => {
    const olderFailed = nextLoadState(loaded, 'older', '続きの失敗')
    expect(nextLoadState(olderFailed, 'older', null).older).toBeNull()
  })

  it('正: 期間を選び直すと、前の期間の続きの失敗を捨てる', () => {
    const olderFailed = nextLoadState(loaded, 'older', '続きの失敗')
    const restarted = startPeriodLoad(olderFailed)
    expect(restarted.older).toBeNull()
    expect(restarted.periodLoaded).toBe(false)
  })

  it('対照: 期間を選び直しても、結果が出るまでは期間・直近の失敗を残す', () => {
    const failed = nextLoadState(nextLoadState(INITIAL_LOAD_STATE, 'full', '期間の失敗'), 'recent', '直近の失敗')
    const restarted = startPeriodLoad(failed)
    expect(restarted.period).toBe('期間の失敗')
    expect(restarted.recent).toBe('直近の失敗')
  })

  it('正: 期間全体を読めたら、どの種類の失敗も消える', () => {
    const failed = nextLoadState(
      nextLoadState(nextLoadState(loaded, 'older', '続き'), 'recent', '直近'),
      'full',
      '期間',
    )
    const ok = nextLoadState(failed, 'full', null)
    expect(ok).toEqual({ period: null, recent: null, older: null, periodLoaded: true })
  })

  it('安全弁: 読めた後の期間全体の失敗は、一度読めた印を降ろさない', () => {
    expect(nextLoadState(loaded, 'full', '期間').periodLoaded).toBe(true)
  })

  it('安全弁: 直近の失敗は表に出る（期間の失敗が無いとき）', () => {
    expect(tableFailure(nextLoadState(loaded, 'recent', '直近'))).toBe('直近')
  })
})

describe('newerRecord — 開いている記録を新しい版へ揃える', () => {
  it('正: 一覧の版が進んでいれば、それを返す', () => {
    const open = rec()
    const latest = rec({ rev: 2, verdict: 'quake' })
    expect(newerRecord(open, [latest])).toBe(latest)
  })

  it('対照: 一覧の版が同じか古ければ、開いているものをそのまま返す', () => {
    const open = rec({ rev: 2 })
    expect(newerRecord(open, [rec({ rev: 2 })])).toBe(open)
    expect(newerRecord(open, [rec({ rev: 1 })])).toBe(open)
    expect(newerRecord(open, [])).toBe(open)
  })
})

describe('upsertShake — 版を差し替える', () => {
  it('正: 同じ id は版の大きいほうに置き換わる（照合待ち → 地震）', () => {
    const list = upsertShake([], rec())
    const next = upsertShake(list, rec({ rev: 2, verdict: 'quake' }))
    expect(next).toHaveLength(1)
    expect(next[0].verdict).toBe('quake')
  })

  it('対照: 古い版が後から届いても戻さない', () => {
    const list = upsertShake([], rec({ rev: 3, verdict: 'quake' }))
    const next = upsertShake(list, rec({ rev: 2, verdict: 'pending' }))
    expect(next[0].verdict).toBe('quake')
  })

  it('正: 新しい順に並ぶ', () => {
    let list = upsertShake([], rec())
    list = upsertShake(list, rec({ id: 'b', startMs: T0 + HOUR, endMs: T0 + HOUR + 5_000 }))
    list = upsertShake(list, rec({ id: 'c', startMs: T0 - HOUR, endMs: T0 - HOUR + 5_000 }))
    expect(list.map((r) => r.id)).toEqual(['b', `station-1-${T0}`, 'c'])
  })
})

describe('eventsQueryRange / recentQueryRange — 問い合わせの範囲', () => {
  it('正: 選んだ日数ぶん（＋右端の余裕）を問い合わせる', () => {
    const r = eventsQueryRange(T0, 7)
    expect(r.toMs).toBe(T0 + 60_000)
    expect(r.toMs - r.fromMs).toBe(7 * 24 * HOUR + 60_000)
  })

  it('正: 範囲の広さは詰めない（2026-10-07 ユーザー承認。ホストは件数で区切る）', () => {
    const r = eventsQueryRange(T0, 400)
    expect(r.toMs - r.fromMs).toBe(400 * 24 * HOUR + 60_000)
  })

  it('問い合わせの URL: 件数はホストの上限ちょうど・隠す指定はあるときだけ', () => {
    expect(EVENTS_PAGE_LIMIT).toBe(500)
    expect(eventsUrl({ fromMs: 1, toMs: 2 }, false)).toBe('/events?from=1&to=2&limit=500')
    expect(eventsUrl({ fromMs: 1, toMs: 2 }, true)).toBe('/events?from=1&to=2&limit=500&hide=local')
  })

  it('問い合わせの URL: 端の値は整数へ揃える（ホストは 10 進の整数しか読まない）', () => {
    // 見終えた範囲の頭は名前の丸めから来るので整数だが、念のため小数を渡しても断られない形にする。
    expect(eventsUrl({ fromMs: 1.2, toMs: 2.7 }, false)).toBe('/events?from=1&to=3&limit=500')
  })

  it('正: 直近の読み返しは 3 時間ぶん（照合が最長 2 時間後まで版を進めるのを拾う）', () => {
    const r = recentQueryRange(T0)
    expect(r.fromMs).toBeLessThanOrEqual(T0 - 3 * HOUR)
    expect(r.toMs).toBe(T0 + 60_000)
  })
})

describe('jstDayRange / jstDateOf / clipRange — 日付で選ぶ期間', () => {
  it('正: 日本時間の始まりの日の 0 時から、終わりの日の翌日 0 時まで（終わりの日を含む）', () => {
    const r = jstDayRange('2026-10-01', '2026-10-06')
    expect(r).toEqual({ fromMs: Date.UTC(2026, 8, 30, 15, 0), toMs: Date.UTC(2026, 9, 6, 15, 0) })
  })

  it('対照: 同じ日を選べば 1 日ぶん', () => {
    const r = jstDayRange('2026-10-06', '2026-10-06')
    expect(r !== null && r.toMs - r.fromMs).toBe(24 * HOUR)
  })

  it('安全弁: 終わりが始まりより前・日付として読めない・存在しない日は null（問い合わせない）', () => {
    expect(jstDayRange('2026-10-06', '2026-10-05')).toBeNull()
    expect(jstDayRange('', '2026-10-05')).toBeNull()
    expect(jstDayRange('2026-02-30', '2026-03-01')).toBeNull()
    expect(jstDayRange('2026/10/01', '2026-10-05')).toBeNull()
  })

  it('jstDateOf: 日本時間の日付（UTC の 15 時は翌日）', () => {
    expect(jstDateOf(Date.UTC(2026, 9, 6, 14, 59))).toBe('2026-10-06')
    expect(jstDateOf(Date.UTC(2026, 9, 6, 15, 0))).toBe('2026-10-07')
  })

  it('clipRange: 重なる部分。重ならなければ null', () => {
    expect(clipRange({ fromMs: 0, toMs: 10 }, { fromMs: 5, toMs: 20 })).toEqual({ fromMs: 5, toMs: 10 })
    expect(clipRange({ fromMs: 0, toMs: 10 }, { fromMs: 10, toMs: 20 })).toBeNull()
  })
})

describe('truncatedNote — 区切ったことの添え書き（2026-10-07 ユーザー承認）', () => {
  it('出している件数を添える', () => {
    expect(truncatedNote(500)).toBe('新しいほうから 500 件を出している')
    expect(truncatedNote(1000)).toBe('新しいほうから 1000 件を出している')
  })
})

describe('visibleShakes — 期間と絞り込み', () => {
  const list = [
    rec({ id: 'old', startMs: T0 - 8 * 24 * HOUR, endMs: T0 - 8 * 24 * HOUR + 5_000 }),
    rec({ id: 'local', verdict: 'local-like' }),
    rec({ id: 'quake', verdict: 'quake' }),
  ]

  it('正: 期間に始まりが入るものだけ出す', () => {
    const v = visibleShakes(list, { fromMs: T0 - 7 * 24 * HOUR, toMs: T0 + 1, hideLocal: false })
    expect(v.map((r) => r.id)).toEqual(['local', 'quake'])
  })

  it('正: 生活振動らしいものを隠せる', () => {
    const v = visibleShakes(list, { fromMs: T0 - 7 * 24 * HOUR, toMs: T0 + 1, hideLocal: true })
    expect(v.map((r) => r.id)).toEqual(['quake'])
  })

  it('安全弁: 隠すのは生活振動らしいものだけ（照合できず・地震らしいは隠さない）', () => {
    const more = [...list, rec({ id: 'unchecked', verdict: 'unchecked' }), rec({ id: 'like', verdict: 'quake-like' })]
    const v = visibleShakes(more, { fromMs: T0 - HOUR, toMs: T0 + 1, hideLocal: true })
    expect(v.map((r) => r.id).sort()).toEqual(['like', 'quake', 'unchecked'])
  })
})

describe('見せ方', () => {
  it('判定の呼び名は README の表と同じ 5 つ', () => {
    expect(VERDICT_LABELS).toEqual({
      quake: '地震',
      pending: '照合待ち',
      'quake-like': '地震らしい',
      'local-like': '生活振動らしい',
      unchecked: '照合できず',
    })
  })

  it('始まりは日本時間の MM/DD HH:MM:SS（端末の時間帯に左右されない）', () => {
    expect(formatShakeStart(T0)).toBe('10/06 13:26:04')
  })

  it('照合した地震: 震央・規模・最大震度・距離', () => {
    expect(formatMatchedQuake({ name: '千葉県北西部', magnitude: 4.2, depthKm: 50, maxScale: 30, distanceKm: 120.4 })).toBe(
      '千葉県北西部 M4.2 最大震度3（120 km）',
    )
    expect(formatMatchedQuake({ name: '千葉県北西部', magnitude: 4.2, depthKm: 50, maxScale: 45, distanceKm: 8 })).toBe(
      '千葉県北西部 M4.2 最大震度5弱（8 km）',
    )
  })

  it('対照: 規模・最大震度が分からなければ、その部分だけ省く（推し量らない）', () => {
    expect(formatMatchedQuake({ name: '千葉県北西部', magnitude: null, depthKm: null, maxScale: null, distanceKm: 61.2 })).toBe(
      '千葉県北西部（61 km）',
    )
    // 震度の表に無い値（46 など）も省く
    expect(formatMatchedQuake({ name: '千葉県北西部', magnitude: 3, depthKm: null, maxScale: 46, distanceKm: 61.2 })).toBe(
      '千葉県北西部 M3.0（61 km）',
    )
  })

  it('行: 判定・長さ・最大加速度・計測震度相当・平常時の何倍・S 波（始まりからの秒）を出す', () => {
    const html = shakeRowHtml(rec(), false)
    expect(html).toContain('10/06 13:26:04')
    expect(html).toContain('12.3 秒')
    expect(html).toContain('照合待ち')
    expect(html).toContain('3.46 gal')
    expect(html).toContain('1.2')
    expect(html).toContain('5.3 倍')
    expect(html).toContain('+3.2 秒')
  })

  it('対照: 拾えなかった S・届かなかった震度は「—」（0 と書かない）', () => {
    const html = shakeRowHtml(rec({ sMs: null, maxIntensity: null }), false)
    expect(html).not.toContain('+0.0 秒')
    expect(html.match(/—/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('安全弁: 観測点の ID と震央の名前はエスケープする（ID は運用者が自由に付ける）', () => {
    const html = shakeRowHtml(
      rec({
        id: '<img src=x>',
        stationId: '<b>s</b>',
        verdict: 'quake',
        matchedQuake: { name: '<script>', originMs: T0, magnitude: 3, depthKm: 10, maxScale: 10, distanceKm: 5 },
      }),
      true,
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>s</b>')
    expect(html).toContain('&lt;img src=x&gt;')
  })
})

describe('見張りの 1 行', () => {
  const NOW = T0
  const base: TriggerView = {
    stationId: 'station-1',
    lastFedAtMs: NOW - 1_000,
    lastSampleMs: NOW - 1_000,
    armed: true,
    inEvent: false,
    warmUntilMs: null,
    baselineGal: 0.16,
    peak24h: { ratio: 1.59, atMs: Date.UTC(2026, 9, 6, 1, 23) }, // 10:23 JST
    peakWindowFromMs: NOW - 1_000 - 24 * HOUR,
  }

  it('正: 24 時間ぶん覚えていれば「この 24 時間の比の最大」', () => {
    expect(triggerLine(base, NOW)).toEqual({
      warn: false,
      text: 'station-1：見張り中・この 24 時間の比の最大 1.59 倍（10:23）・平常時の揺れ 0.16 gal',
    })
  })

  it('正: 覚えている範囲が 24 時間に満たなければ「HH:MM からの比の最大」', () => {
    const t = { ...base, peakWindowFromMs: Date.UTC(2026, 9, 5, 22, 35) } // 07:35 JST
    expect(triggerLine(t, NOW).text).toBe('station-1：見張り中・07:35 からの比の最大 1.59 倍（10:23）・平常時の揺れ 0.16 gal')
  })

  it('対照: 24 時間からわずか（1 分以内）に欠けるだけなら「この 24 時間」（1 分刻みで覚えるため）', () => {
    const t = { ...base, peakWindowFromMs: base.lastSampleMs! - 24 * HOUR + 59_000 }
    expect(triggerLine(t, NOW).text).toContain('この 24 時間の比の最大')
  })

  it('正: 一度も届いていなければ警告', () => {
    expect(triggerLine({ ...base, lastFedAtMs: null, lastSampleMs: null, peak24h: null, peakWindowFromMs: null }, NOW)).toEqual({
      warn: true,
      text: 'station-1：波形が届いていない（起動から一度も）',
    })
  })

  it('正: 1 分来ていなければ、最後に届いた時刻を添えて警告（ホストの時計で測る）', () => {
    expect(triggerLine({ ...base, lastFedAtMs: NOW - 60_000 }, NOW)).toEqual({
      warn: true,
      text: 'station-1：波形が届いていない（最後は 13:25）',
    })
  })

  it('対照: 1 分に満たなければ、まだ届いていないとは言わない', () => {
    expect(triggerLine({ ...base, lastFedAtMs: NOW - 59_000 }, NOW).warn).toBe(false)
  })

  it('助走中・比の最大なしは警告（ホストのログと同じ扱い）', () => {
    const t = { ...base, armed: false, warmUntilMs: base.lastSampleMs! + 30_000, peak24h: null }
    expect(triggerLine(t, NOW)).toEqual({
      warn: true,
      text: 'station-1：助走中（あと 30 秒）・この 24 時間の比の最大 なし・平常時の揺れ 0.16 gal',
    })
  })

  it('安全弁: 観測点の ID はエスケープする', () => {
    expect(triggerLine({ ...base, stationId: '<i>x</i>' }, NOW).text).toContain('&lt;i&gt;x&lt;/i&gt;')
  })
})

describe('readTriggers — /status の detection.triggers を読む', () => {
  const item = {
    stationId: 'station-1',
    lastFedAtMs: T0,
    lastSampleMs: T0,
    firstSampleMs: T0 - HOUR,
    armed: true,
    inEvent: false,
    warmUntilMs: null,
    baselineGal: 0.16,
    ratio: 1.1,
    onRatio: 2.5,
    peak24h: { ratio: 1.5, atMs: T0 - 1_000 },
    peakWindowFromMs: T0 - HOUR,
    droppedChunks: 0,
  }

  it('正: 観測点ごとに読む', () => {
    expect(readTriggers({ detection: { triggers: [item] } })).toEqual({
      items: [
        {
          stationId: 'station-1',
          lastFedAtMs: T0,
          lastSampleMs: T0,
          armed: true,
          inEvent: false,
          warmUntilMs: null,
          baselineGal: 0.16,
          peak24h: { ratio: 1.5, atMs: T0 - 1_000 },
          peakWindowFromMs: T0 - HOUR,
        },
      ],
      malformedCount: 0,
    })
  })

  it('対照: 欄が無ければ null（「観測点が無い」と取り違えない）', () => {
    expect(readTriggers({ detection: { stations: [] } })).toBeNull()
    expect(readTriggers({})).toBeNull()
  })

  it('安全弁: 形の違う要素は外し、その数を添える（全部読めないときに空白にしない）', () => {
    const r = readTriggers({ detection: { triggers: [item, { stationId: 3 }] } })
    expect(r?.items).toHaveLength(1)
    expect(r?.malformedCount).toBe(1)
    expect(readTriggers({ detection: { triggers: [{ stationId: 3 }] } })).toEqual({ items: [], malformedCount: 1 })
  })
})
