import { describe, it, expect } from 'vitest'
import {
  mergeQuakeInto,
  mergeQuakeHistory as mergeQuakeHistoryWithIndex,
  extractQuakeEventId,
  extractQuakeEventIdFromId,
  sameQuakeEntry as sameQuakeEntryWithIndex,
  hasIntensity,
  quakeEventKey,
  coalesceByEventId,
  findExistingQuakeCard as findExistingQuakeCardWithIndex,
  sortQuakes,
  isRetractedQuakeReport as isRetractedQuakeReportWithIndex,
  quakeRetractionOf,
  addQuakeRetraction,
  quakeKeyForLpgmEventId,
} from './quakeMerge'
import type { JMAQuake, IssueType, IntensityScale, EarthquakePoint, DomesticTsunami, CorrectType } from '../types/earthquake'
import { reportsText } from '../test-utils/quakeReports'

// 区域名の索引を渡す引数は、本番の呼び出し側が渡し忘れないよう必須にしてある
// （→ quakeMerge.ts の mergeQuakeHistory のコメント）。このファイルの既存のテストは
// **索引なしの経路**を見るので、ここで一度だけ既定値を与えて包む。索引を渡したときの
// 違い（区域名が県名と同じ奈良県を区域として引き当てられる）は専用の describe で確かめる。
import { readFileSync } from 'node:fs'
import { buildAreaPrefIndex, type StationCoordsData } from './stationCoords'
import type { AreaPrefIndex } from './quakePoints'
import { isMaxScaleUnreceived } from './quakePoints'

const sameQuakeEntry = (a: JMAQuake, b: JMAQuake, idx: AreaPrefIndex = null) =>
  sameQuakeEntryWithIndex(a, b, idx)
const mergeQuakeHistory = (
  newQuakes: JMAQuake[],
  base: JMAQuake[] = [],
  knownRetractions: Parameters<typeof mergeQuakeHistoryWithIndex>[2] = [],
  idx: AreaPrefIndex = null,
) => mergeQuakeHistoryWithIndex(newQuakes, base, knownRetractions, idx)
const findExistingQuakeCard = (cards: JMAQuake[], incoming: JMAQuake, idx: AreaPrefIndex = null) =>
  findExistingQuakeCardWithIndex(cards, incoming, idx)
const isRetractedQuakeReport = (
  retractions: Parameters<typeof isRetractedQuakeReportWithIndex>[0],
  incoming: JMAQuake,
  idx: AreaPrefIndex = null,
) => isRetractedQuakeReportWithIndex(retractions, incoming, idx)

/**
 * 受け取った電文種別の記録（`reports`）を除いた中身。
 *
 * **据え置き・置換の確認に同一参照や素の `toEqual` は使えない。** 記録は据え置く経路でも
 * 更新されるため（→ quakeMerge.ts の `holdBack`）、内容が据え置かれた回でも新しい
 * オブジェクトが返る。ここで見たいのは「incoming の内容を採ったかどうか」なので、
 * 記録を外して比べる。記録の積み上がり方は専用の describe（「受け取った電文種別の記録」）が見る。
 */
function withoutReports(q: JMAQuake): Omit<JMAQuake, 'reports'> {
  const { reports: _reports, ...rest } = q
  return rest
}

interface QuakeOpts {
  eventId?: string
  id?: string
  type?: IssueType
  maxScale?: IntensityScale
  points?: EarthquakePoint[]
  time?: string          // 電文発表時刻（issue/telegram time）
  quakeTime?: string     // earthquake.time（地震の時刻。→ docs/spec/quake-spec.md §1）
  mag?: number
  hypoName?: string
  correct?: CorrectType  // 訂正区分（既定は 'なし'）
  tsunami?: DomesticTsunami
  cancelledAt?: Date
  telegramKey?: string   // 電文の一意鍵（→ JMAQuake.telegramKey）。省略すると id が鍵になる
  reportSerial?: number  // 電文が名乗る報番号（→ JMAQuake.reportSerial）
}

// 熊本 M7.1・震度7（2026-07-28 16:27 JST = 07:27 UTC）を既定とするヘルパ。
function makeQuake(o: QuakeOpts = {}): JMAQuake {
  const eventId = o.eventId ?? '20260728162718'
  const time = o.time ?? '2026-07-28T07:27:30Z'
  const type = o.type ?? '各地の震度情報'
  const hasInt = o.maxScale !== undefined || o.points !== undefined
  return {
    kind: 'quake',
    id: o.id ?? `dmdata-quake-${eventId}-1`,
    ...(o.telegramKey !== undefined && { telegramKey: o.telegramKey }),
    ...(o.reportSerial !== undefined && { reportSerial: o.reportSerial }),
    time,
    ...(o.cancelledAt ? { cancelledAt: o.cancelledAt } : {}),
    issue: { source: 'dmdata', time, type, correct: o.correct ?? 'なし' },
    earthquake: {
      time: o.quakeTime ?? '2026-07-28T07:27:00Z',
      hypocenter: {
        name: o.hypoName ?? '熊本県熊本地方',
        latitude: 32.7,
        longitude: 130.7,
        depth: 10,
        magnitude: o.mag ?? 7.1,
      },
      maxScale: o.maxScale ?? (hasInt ? 70 : 70),
      domesticTsunami: o.tsunami ?? 'なし',
    },
    points: o.points ?? [{ pref: '熊本県', addr: '熊本市', isArea: false, scale: 70 }],
  }
}

// 震度を持たない電文（VXSE61 単独 / 震源のみ）を作る。
function makeNoIntensity(o: QuakeOpts = {}): JMAQuake {
  return {
    ...makeQuake(o),
    earthquake: {
      ...makeQuake(o).earthquake,
      maxScale: -1,
    },
    points: [],
  }
}

// 実電文どおりの震度速報を作る。**`makeQuake({ type: '震度速報' })` では駄目**で、あちらは
// 震源要素を持たせてしまう。実際の VXSE51 は電文に Earthquake 要素が無く、パーサーは震源名を
// 空・座標を -200（位置不明センチネル）・深さを -1 で埋める。マグニチュードは
// 震源要素を持たない電文では `NaN`（`dmdataParser.ts`）。
//
// **津波区分と固定付加文は自前で持つ。** 震度速報が津波の情報を持たないと思い込むと、そこを
// 補完する誤った実装を通してしまう。実データ（能登 2024/1/1 の前震・
// `public/data/test-scenarios/2024-noto.json`）では津波区分 `調査中`・固定付加文
// 「今後の情報に注意してください。」が入っている。値をこれに揃えておく。
function makePrompt(o: QuakeOpts = {}): JMAQuake {
  const base = makeQuake({ type: '震度速報', maxScale: 50, ...o })
  return {
    ...base,
    earthquake: {
      ...base.earthquake,
      hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: NaN },
      domesticTsunami: '調査中',
    },
    forecastText: '今後の情報に注意してください。',
  }
}

describe('extractQuakeEventId', () => {
  it('dmdata-quake- 形式の id から14桁 eventId を抽出する', () => {
    expect(extractQuakeEventId(makeQuake({ id: 'dmdata-quake-20260728162718-1' }))).toBe('20260728162718')
  })

  it('dmdata-quake- 形式にも対応する', () => {
    expect(extractQuakeEventId(makeQuake({ id: 'dmdata-quake-20260728162718-3' }))).toBe('20260728162718')
  })

  it('形式外の id では null を返す（P2P 由来など）', () => {
    expect(extractQuakeEventId(makeQuake({ id: 'p2p-12345' }))).toBeNull()
  })
})

describe('extractQuakeEventIdFromId', () => {
  it('undefined 入力は null を返す', () => {
    expect(extractQuakeEventIdFromId(undefined)).toBeNull()
  })

  it('null 入力は null を返す', () => {
    expect(extractQuakeEventIdFromId(null)).toBeNull()
  })

  it('空文字は null を返す', () => {
    expect(extractQuakeEventIdFromId('')).toBeNull()
  })

  it('dmdata-quake- 形式から14桁 eventId を抽出する', () => {
    expect(extractQuakeEventIdFromId('dmdata-quake-20260728162718-1')).toBe('20260728162718')
  })

  it('dmdata-quake- 形式にも対応する', () => {
    expect(extractQuakeEventIdFromId('dmdata-quake-20260728162718-3')).toBe('20260728162718')
  })

  it('形式外の id 文字列は null を返す', () => {
    expect(extractQuakeEventIdFromId('p2p-12345')).toBeNull()
  })
})

describe('sameQuakeEntry', () => {
  it('同一 eventId なら earthquake.time がずれていても同一とみなす', () => {
    const a = makeQuake({ id: 'dmdata-quake-20260728162718-1', quakeTime: '2026-07-28T07:27:00Z' })
    const b = makeQuake({ id: 'dmdata-quake-20260728162718-2', quakeTime: '2026-07-28T07:28:00Z' })
    expect(sameQuakeEntry(a, b)).toBe(true)
  })

  it('eventId が無い場合は earthquake.time で判定する', () => {
    const a = makeQuake({ id: 'p2p-1', quakeTime: '2026-07-28T07:27:00Z' })
    const b = makeQuake({ id: 'p2p-2', quakeTime: '2026-07-28T07:27:00Z' })
    const c = makeQuake({ id: 'p2p-3', quakeTime: '2026-07-28T09:00:00Z' })
    expect(sameQuakeEntry(a, b)).toBe(true)
    expect(sameQuakeEntry(a, c)).toBe(false)
  })

  it('eventId が無い場合、同時刻でも震源名が食い違えば別イベントとする', () => {
    const domestic = makeQuake({ id: 'p2p-1', hypoName: '群馬県南部' })
    const foreign = makeQuake({ id: 'p2p-2', hypoName: 'インドネシア、フローレス' })
    expect(sameQuakeEntry(domestic, foreign)).toBe(false)
  })

  it('震源名が空の震度速報は、震源を伴う続報と同一イベントとみなす', () => {
    const prompt = makeQuake({ id: 'p2p-1', type: '震度速報', hypoName: '' })
    const detail = makeQuake({ id: 'p2p-2', type: '各地の震度情報', hypoName: '熊本県熊本地方' })
    expect(sameQuakeEntry(prompt, detail)).toBe(true)
  })

  // 気象庁は震源決定の前と後とで EventID を別々に採番するため、同じ地震でも EventID が
  // 変わることがある（2026-08-24 04:05 熊本県天草・芦北地方の実例）。
  // 以下 4 件はその救済と、救済のために緩めすぎていないことの対。
  it('震度速報は eventId が食い違っても、地震の時刻と区域が重なれば同一イベントとみなす', () => {
    const prompt = makeQuake({
      id: 'dmdata-quake-20260824040519-1', type: '震度速報', hypoName: '',
      points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
    })
    const detail = makeQuake({
      id: 'dmdata-quake-20260824040526-1', type: '震源・震度情報', hypoName: '熊本県天草・芦北地方',
      points: [
        { pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 },
        { pref: '', addr: '熊本県熊本地方', isArea: true, scale: 20 },
      ],
    })
    expect(sameQuakeEntry(prompt, detail)).toBe(true)
  })

  it('震源が判明している電文どうしは、eventId が食い違えば別イベントのままとする', () => {
    const a = makeQuake({ id: 'dmdata-quake-20260824040519-1', hypoName: '熊本県天草・芦北地方' })
    const b = makeQuake({ id: 'dmdata-quake-20260824040526-1', hypoName: '熊本県天草・芦北地方' })
    expect(sameQuakeEntry(a, b)).toBe(false)
  })

  it('震度速報でも、区域が 1 つも重ならなければ別イベントとする', () => {
    const prompt = makeQuake({
      id: 'dmdata-quake-20260824040519-1', type: '震度速報', hypoName: '',
      points: [{ pref: '', addr: '青森県三八上北', isArea: true, scale: 30 }],
    })
    const detail = makeQuake({
      id: 'dmdata-quake-20260824040526-1', type: '震源・震度情報', hypoName: '熊本県天草・芦北地方',
      points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
    })
    expect(sameQuakeEntry(prompt, detail)).toBe(false)
  })

  it('震度速報でも、地震の時刻の一致は免除しない', () => {
    const prompt = makeQuake({
      id: 'dmdata-quake-20260824040519-1', type: '震度速報', hypoName: '',
      quakeTime: '2026-08-24T04:05:00Z',
      points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
    })
    const detail = makeQuake({
      id: 'dmdata-quake-20260824040526-1', type: '震源・震度情報', hypoName: '熊本県天草・芦北地方',
      quakeTime: '2026-08-24T05:05:00Z',
      points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
    })
    expect(sameQuakeEntry(prompt, detail)).toBe(false)
  })

  // 取消電文はパーサが種別を問わず震源名を空で作るため、震源未確定と同じ姿になる。
  // 取消は eventId でのみ照合する（内容照合へ落とすと、時刻も空どうしで一致してしまう）。
  // DMDSS 経路（DMDATA）は都道府県のロールアップ点も isArea: true で持つ。
  // これを区域として数えると、同じ県の別々の区域で起きた 2 つの地震が「重なる」ことになる。
  it('都道府県のロールアップ点は区域の重なりに数えない', () => {
    const prompt = makeQuake({
      id: 'dmdata-quake-20260824040519-1', type: '震度速報', hypoName: '',
      points: [
        { pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 },
        { pref: '熊本県', addr: '熊本県', isArea: true, scale: 30 },
      ],
    })
    const other = makeQuake({
      id: 'dmdata-quake-20260824040526-1', type: '震源・震度情報', hypoName: '熊本県熊本地方',
      points: [
        { pref: '', addr: '熊本県熊本地方', isArea: true, scale: 20 },
        { pref: '熊本県', addr: '熊本県', isArea: true, scale: 20 },
      ],
    })
    expect(sameQuakeEntry(prompt, other)).toBe(false)
  })

  // 同じ地震の震度速報どうしは同じ EventID を共有する（2026-08-23 22:45 の 2 通で確認）。
  // したがって「両方が震源未確定で ID が違う」なら別々の地震。区域が重なっても合流させない。
  it('震度速報どうしは eventId が違えば別イベントとする（区域が重なっても）', () => {
    const a = makeQuake({
      id: 'dmdata-quake-20260815065801-1', type: '震度速報', hypoName: '',
      points: [{ pref: '', addr: '群馬県南部', isArea: true, scale: 30 }],
    })
    const b = makeQuake({
      id: 'dmdata-quake-20260815065812-1', type: '震度速報', hypoName: '',
      points: [{ pref: '', addr: '群馬県南部', isArea: true, scale: 20 }],
    })
    expect(sameQuakeEntry(a, b)).toBe(false)
  })

  // 同じ分に 2 つの地震が起き、片方がまだ震度速報だけのとき。震源情報（VXSE52）は
  // 仕様上 points を持たないため、区域では引き離せない。時刻の一致だけで合流させると
  // 「揺れていない地域の震度が別の震源に貼り付く」カードができる（2026-08-15 の衝突と同型）。
  it('区域を持たない別地震の震源情報は、震度速報のカードに合流しない', () => {
    const prompt = makeQuake({
      id: 'dmdata-quake-20260815065801-1', type: '震度速報', hypoName: '',
      quakeTime: '2026-08-15T06:58:00Z',
      points: [{ pref: '', addr: '群馬県南部', isArea: true, scale: 30 }],
    })
    const other = makeNoIntensity({
      id: 'dmdata-quake-20260815065812-1', type: '震源情報', hypoName: 'インドネシア、フローレス',
      quakeTime: '2026-08-15T06:58:00Z',
    })
    expect(sameQuakeEntry(prompt, other)).toBe(false)
    expect(sameQuakeEntry(other, prompt)).toBe(false)
  })

  it('取消電文は eventId が食い違えば別イベントとする（震源名・地震の時刻が空でも合流しない）', () => {
    const card = makeQuake({ id: 'dmdata-quake-20260824040526-1', hypoName: '熊本県天草・芦北地方' })
    const cancel: JMAQuake = {
      ...makeQuake({ id: 'dmdata-quake-20260824040519-2', hypoName: '' }),
      cancelled: true,
      earthquake: { ...makeQuake().earthquake, time: '', hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: 0 }, maxScale: -1 },
      points: [],
    }
    expect(sameQuakeEntry(card, cancel)).toBe(false)
    expect(sameQuakeEntry(cancel, card)).toBe(false)
  })

  it('取消電文どうしも eventId が食い違えば別イベントとする', () => {
    const mk = (id: string): JMAQuake => ({
      ...makeQuake({ id, hypoName: '' }),
      cancelled: true,
      earthquake: { ...makeQuake().earthquake, time: '', hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: 0 }, maxScale: -1 },
      points: [],
    })
    expect(sameQuakeEntry(mk('dmdata-quake-20260824040519-2'), mk('dmdata-quake-20260824040526-2'))).toBe(false)
  })

  // P2PQuake 経路（eventId が無い）でも区域の重なりが効くことを固定する。
  it('eventId が無い経路でも、同時刻・震源名が空・区域が重なれば同一イベントとする', () => {
    const prompt = makeQuake({
      id: 'p2p-1', type: '震度速報', hypoName: '',
      points: [{ pref: '', addr: '群馬県南部', isArea: true, scale: 30 }],
    })
    const detail = makeQuake({
      id: 'p2p-2', type: '各地の震度情報', hypoName: '群馬県南部',
      points: [{ pref: '', addr: '群馬県南部', isArea: true, scale: 30 }],
    })
    expect(sameQuakeEntry(prompt, detail)).toBe(true)
  })

  it('eventId が無い経路で、同時刻でも区域が 1 つも重ならなければ別イベントとする', () => {
    const a = makeQuake({
      id: 'p2p-1', type: '震度速報', hypoName: '',
      points: [{ pref: '', addr: '群馬県南部', isArea: true, scale: 30 }],
    })
    const b = makeQuake({
      id: 'p2p-2', type: '震度速報', hypoName: '',
      points: [{ pref: '', addr: '沖縄本島近海', isArea: true, scale: 20 }],
    })
    expect(sameQuakeEntry(a, b)).toBe(false)
  })

  it('訂正報は震源名が変わっても同一イベントとみなす', () => {
    const original = makeQuake({ id: 'p2p-1', hypoName: '日向灘' })
    const corrected = makeQuake({ id: 'p2p-2', hypoName: '豊後水道', correct: '震源を訂正' })
    expect(sameQuakeEntry(original, corrected)).toBe(true)
  })

  // VXSE61（P2PQuake の DestinationAmended）は震源要素を差し替える電文で、issue.correct は
  // 「なし」のまま来る。これを訂正報と同じ扱いにしないと、震源名が変わった更新報が
  // P2PQuake 経路で別カードに分裂する。
  it('震源要素更新は issue.correct が「なし」でも震源名の変更を許容する', () => {
    const original = makeQuake({ id: 'p2p-1', hypoName: '石川県能登地方' })
    const amended = makeQuake({ id: 'p2p-2', hypoName: '能登半島沖', type: '顕著な地震の震源要素更新のお知らせ' })
    expect(sameQuakeEntry(original, amended)).toBe(true)
  })

  it('eventKey を持つカード同士は eventKey だけで判定する', () => {
    const a: JMAQuake = { ...makeQuake({ id: 'p2p-1' }), eventKey: 'key-1' }
    const b: JMAQuake = { ...makeQuake({ id: 'p2p-2' }), eventKey: 'key-1' }
    const c: JMAQuake = { ...makeQuake({ id: 'p2p-3' }), eventKey: 'key-2' }
    expect(sameQuakeEntry(a, b)).toBe(true)
    expect(sameQuakeEntry(a, c)).toBe(false)
  })
})

describe('quakeEventKey', () => {
  it('DMDATA 経路は電文の eventId をキーにする', () => {
    expect(quakeEventKey(makeQuake({ id: 'dmdata-quake-20260728162718-1' }))).toBe('20260728162718')
  })

  it('P2P 経路の生電文は地震の時刻とレコード id から作る', () => {
    const key = quakeEventKey(makeQuake({ id: 'p2p-1', quakeTime: '2026-07-28T07:27:00Z' }))
    expect(key).toBe('p2p:2026-07-28T07:27:00Z#p2p-1')
  })

  it('付与済みの eventKey を優先する（続報で id が変わっても不変）', () => {
    const card: JMAQuake = { ...makeQuake({ id: 'p2p-9' }), eventKey: 'p2p:2026-07-28T07:27:00Z#p2p-1' }
    expect(quakeEventKey(card)).toBe('p2p:2026-07-28T07:27:00Z#p2p-1')
  })
})

describe('hasIntensity', () => {
  it('maxScale >= 0 なら true', () => {
    expect(hasIntensity(makeQuake({ maxScale: 10 }))).toBe(true)
  })
  it('maxScale < 0 かつ points 空なら false', () => {
    expect(hasIntensity(makeNoIntensity())).toBe(false)
  })
  it('maxScale < 0 でも points があれば true', () => {
    const q = makeNoIntensity()
    q.points = [{ pref: '熊本県', addr: '熊本市', isArea: false, scale: 70 }]
    expect(hasIntensity(q)).toBe(true)
  })
})

describe('mergeQuakeInto — VXSE61（顕著地震）', () => {
  it('各地の震度→顕著地震: 震度を保持しつつ震源・種別を更新する', () => {
    const e = makeQuake({ type: '各地の震度情報', maxScale: 70, mag: 7.1 })
    const n = makeNoIntensity({
      type: '顕著な地震の震源要素更新のお知らせ',
      mag: 7.3,
      time: '2026-07-28T07:35:00Z',
    })
    const merged = mergeQuakeInto(e, n)
    expect(merged.earthquake.maxScale).toBe(70)       // 震度7 保持
    expect(merged.points.length).toBeGreaterThan(0)   // 各地の震度 保持
    expect(merged.issue.type).toBe('顕著な地震の震源要素更新のお知らせ')
    expect(merged.earthquake.hypocenter.magnitude).toBe(7.3)  // 震源要素は更新
    expect(merged.time).toBe('2026-07-28T07:35:00Z')
  })

  it('既存が無ければ顕著地震は震度なし単独カードになる', () => {
    const n = makeNoIntensity({ type: '顕著な地震の震源要素更新のお知らせ' })
    const merged = mergeQuakeInto(undefined, n)
    // 統合結果には eventKey が付くため、中身が incoming と一致することで確認する。
    expect(withoutReports(merged)).toEqual({ ...n, eventKey: quakeEventKey(n) })
    expect(hasIntensity(merged)).toBe(false)
  })

  it('顕著地震の国内津波が「不明」なら既存の津波情報を保持する', () => {
    const e = makeQuake({ tsunami: 'なし' })
    const n = makeNoIntensity({ type: '顕著な地震の震源要素更新のお知らせ', tsunami: '不明' })
    expect(mergeQuakeInto(e, n).earthquake.domesticTsunami).toBe('なし')
  })

  it('顕著地震が実際の津波情報を持てば更新する', () => {
    const e = makeQuake({ tsunami: 'なし' })
    const n = makeNoIntensity({ type: '顕著な地震の震源要素更新のお知らせ', tsunami: '警報等' })
    expect(mergeQuakeInto(e, n).earthquake.domesticTsunami).toBe('警報等')
  })

  // VXSE61 は自由付加文を必ず持ち、定型文だけのこともあれば精査後のモーメントマグニチュードが
  // 添えられることもある。土台が `...existing` なので、明示的に採らないと更新前の付加文が残る
  it('顕著地震が自由付加文を持てば更新する', () => {
    const e: JMAQuake = { ...makeQuake(), freeText: '更新前の付加文。' }
    const amendment = 'なお、この地震の精査したモーメントマグニチュード（Ｍｗ）は６．８です。'
    const n: JMAQuake = { ...makeNoIntensity({ type: '顕著な地震の震源要素更新のお知らせ' }), freeText: amendment }
    expect(mergeQuakeInto(e, n).freeText).toBe(amendment)
  })

  // 対照: 持たない報では既存の付加文を残す（津波区分を「不明」なら据え置くのと同じ考え方）
  // 震度を既存から補完する経路でも自由付加文を落とさない。震度だけ引き継いで本文を捨てると、
  // 「津波注意報を発表中です」のような状況説明が後続の震源情報で消える
  // 安全弁: 「5弱以上・未入電」が続報で断定形へ降格しないこと。
  //
  // **これは印を `points` から導く設計に依っている。** 震度を引き継ぐ経路は `maxScale` と
  // `points` を必ず一緒に運ぶので、点が持つ印もそのまま残る。フィールドで別に持つと、
  // この経路でコピーを書き足し忘れて黙って降格する（実際にそうなっていた）。
  it('震度欠落の後続電文でも未入電の印が残る', () => {
    const e: JMAQuake = {
      ...makeQuake({ type: '震度速報' }),
      earthquake: { ...makeQuake({ type: '震度速報' }).earthquake, maxScale: 45 },
      points: [{ pref: '', addr: '岩手県沿岸北部', isArea: true, scale: 45, unreceived: true }],
    }
    const merged = mergeQuakeInto(e, makeNoIntensity({ type: '震源情報' }))
    expect(merged.earthquake.maxScale).toBe(45)
    expect(isMaxScaleUnreceived(merged.earthquake.maxScale, merged.points)).toBe(true)
  })

  it('震度欠落の後続電文でも既存の自由付加文を保持する', () => {
    const notice = 'なお、茨城県から沖縄県地方にかけての太平洋側を中心に津波注意報を発表中です。'
    const e: JMAQuake = { ...makeQuake({ type: '震度速報' }), freeText: notice }
    const n = makeNoIntensity({ type: '震源情報' })
    expect(mergeQuakeInto(e, n).freeText).toBe(notice)
  })

  // 対照: 後続電文が自分の自由付加文を持っていれば、そちらで置き換える
  it('震度欠落の後続電文が自由付加文を持てばそちらを採る', () => {
    const e: JMAQuake = { ...makeQuake({ type: '震度速報' }), freeText: '古い本文。' }
    const n: JMAQuake = { ...makeNoIntensity({ type: '震源情報' }), freeText: '新しい本文。' }
    expect(mergeQuakeInto(e, n).freeText).toBe('新しい本文。')
  })

  it('顕著地震が自由付加文を持たなければ既存の付加文を保持する', () => {
    const e: JMAQuake = { ...makeQuake(), freeText: '既存の付加文。' }
    const n = makeNoIntensity({ type: '顕著な地震の震源要素更新のお知らせ' })
    expect(mergeQuakeInto(e, n).freeText).toBe('既存の付加文。')
  })

  // 固定付加文（その他）（`VarComment/Text`）。震源要素更新は訂正の説明をここへ載せる
  // （コード 0256「震源要素を訂正します。」）ので、自由付加文と同じ扱いで引き継ぐ。
  it('顕著地震が固定付加文（その他）を持てば更新する', () => {
    const e: JMAQuake = { ...makeQuake(), varCommentText: '更新前の注記。' }
    const n: JMAQuake = {
      ...makeNoIntensity({ type: '顕著な地震の震源要素更新のお知らせ' }),
      varCommentText: '震源要素を訂正します。',
    }
    expect(mergeQuakeInto(e, n).varCommentText).toBe('震源要素を訂正します。')
  })

  // 対照: 持たない報では既存を残す。
  it('顕著地震が固定付加文（その他）を持たなければ既存を保持する', () => {
    const e: JMAQuake = { ...makeQuake(), varCommentText: '既存の注記。' }
    const n = makeNoIntensity({ type: '顕著な地震の震源要素更新のお知らせ' })
    expect(mergeQuakeInto(e, n).varCommentText).toBe('既存の注記。')
  })

  it('震度欠落の後続電文でも既存の固定付加文（その他）を保持する', () => {
    const e: JMAQuake = { ...makeQuake({ type: '震度速報' }), varCommentText: '既存の注記。' }
    expect(mergeQuakeInto(e, makeNoIntensity({ type: '震源情報' })).varCommentText).toBe('既存の注記。')
  })

  // 震度速報が続報として届く経路。**震度速報は固定付加文（その他）を持たない**ので、
  // incoming を採ると前の報が伝えた注記が消える（津波区分・固定付加文と同じ扱い）。
  it('震度速報の続報でも既存の固定付加文（その他）が残る', () => {
    const e: JMAQuake = { ...makeQuake(), varCommentText: '震源要素を訂正します。' }
    const n = makeQuake({ type: '震度速報', id: 'dmdata-quake-20260728162718-2' })
    expect(mergeQuakeInto(e, n).varCommentText).toBe('震源要素を訂正します。')
  })

  // 対照: 既存が持たなければ、震度速報側の値をそのまま使う（握り潰さない）。
  it('既存が固定付加文（その他）を持たなければ震度速報側を採る', () => {
    const e = makeQuake()
    const n: JMAQuake = {
      ...makeQuake({ type: '震度速報', id: 'dmdata-quake-20260728162718-2' }),
      varCommentText: '新しい注記。',
    }
    expect(mergeQuakeInto(e, n).varCommentText).toBe('新しい注記。')
  })
})

// 固定付加文（その他）の原文（`VarComment/Text`）とコード（`VarComment/Code`）は
// **同じ報から採る**（`pickVarComment`）。
//
// コードは読み上げの落とし漏れの検出に使うので（→ `utils/ttsText.ts` の
// `warnUnmatchedBoilerplate`）、原文と組が崩れると**別の報の原文と突き合わせて**一致・不一致を
// 誤る —— 気象庁が文面を変えたことに気づけなくなるか、正常な電文で警告が出る。同じ電文が運ぶ
// 同じ事実なので、震度を補うときに市町村も一緒に補うのと同じ規律（→ quake-spec.md §6.4）。
//
// **`mergeQuakeInto` が原文を選び直す 4 分岐すべてを並べる。** 共有の関数を通しているとはいえ、
// 分岐ごとに土台（`...existing` / `...incoming`）が違うので、スプレッドの順序を崩せば
// どれか 1 つだけが壊れうる。
describe('mergeQuakeInto — 固定付加文（その他）のコードは原文と同じ報から採る', () => {
  // ① 顕著地震（VXSE61）を受け取る分岐。あちらは訂正の説明をここへ載せる（コード 0256）。
  it('顕著地震の原文を採れば、コードもその報のものになる', () => {
    const e: JMAQuake = { ...makeQuake(), varCommentText: '更新前の注記。', varCommentCodes: ['0262'] }
    const n: JMAQuake = {
      ...makeNoIntensity({ type: '顕著な地震の震源要素更新のお知らせ' }),
      varCommentText: '震源要素を訂正します。',
      varCommentCodes: ['0256'],
    }
    const merged = mergeQuakeInto(e, n)
    expect(merged.varCommentText).toBe('震源要素を訂正します。')
    expect(merged.varCommentCodes).toEqual(['0256'])
  })

  // ② 震度欠落の後続電文で既存を補完する分岐。**土台は後続（`...result`）側**なので、原文を
  // 既存から採るときにコードを一緒に運ばないと、**既存の原文に後続のコード（ここでは undefined）が
  // 付く**形になる。
  it('震度欠落の後続電文が原文を持たなければ、既存の原文とコードが残る', () => {
    const e: JMAQuake = { ...makeQuake({ type: '震度速報' }), varCommentText: '既存の注記。', varCommentCodes: ['0262'] }
    const n = makeNoIntensity({ type: '震源情報' })
    const merged = mergeQuakeInto(e, n)
    expect(merged.varCommentText).toBe('既存の注記。')
    expect(merged.varCommentCodes).toEqual(['0262'])
  })

  // 対照: 同じ分岐で後続が原文を持てば、コードも後続側になる。
  it('震度欠落の後続電文が原文を持てば、コードもその報のものになる', () => {
    const e: JMAQuake = { ...makeQuake({ type: '震度速報' }), varCommentText: '既存の注記。', varCommentCodes: ['0262'] }
    const n: JMAQuake = {
      ...makeNoIntensity({ type: '震源情報' }),
      varCommentText: '震源要素を訂正します。',
      varCommentCodes: ['0256'],
    }
    const merged = mergeQuakeInto(e, n)
    expect(merged.varCommentText).toBe('震源要素を訂正します。')
    expect(merged.varCommentCodes).toEqual(['0256'])
  })

  // ③ 震度速報の続報で既存を据え置く分岐。**震度速報は固定付加文（その他）を持たない**ので、
  // `makePrompt`（実電文どおりの震度速報）を使う —— `makeQuake({ type: '震度速報' })` では
  // 震源要素まで持たせてしまう（このファイルの `makePrompt` の説明を参照）。
  it('震度速報の続報では、既存の原文とコードが残る', () => {
    const e: JMAQuake = { ...makeQuake(), varCommentText: '既存の注記。', varCommentCodes: ['0262'] }
    const n = makePrompt({ id: 'dmdata-quake-20260728162718-2' })
    const merged = mergeQuakeInto(e, n)
    expect(merged.varCommentText).toBe('既存の注記。')
    expect(merged.varCommentCodes).toEqual(['0262'])
  })

  // ④ 既存の VXSE61 が新しく、後から震度電文が届く分岐（§8 QUAKE-4 の経路）。
  // 土台が incoming（震度電文）へ替わるので、明示しないと VXSE61 側の組が消える。
  it('既存の顕著地震が新しければ、その原文とコードが残る', () => {
    const e: JMAQuake = {
      ...makeNoIntensity({ type: '顕著な地震の震源要素更新のお知らせ', time: '2026-07-28T07:40:00Z' }),
      varCommentText: '震源要素を訂正します。',
      varCommentCodes: ['0256'],
    }
    const n: JMAQuake = {
      ...makeQuake({ time: '2026-07-28T07:30:00Z' }),
      varCommentText: '震度電文の注記。',
      varCommentCodes: ['0262'],
    }
    const merged = mergeQuakeInto(e, n)
    expect(merged.varCommentText).toBe('震源要素を訂正します。')
    expect(merged.varCommentCodes).toEqual(['0256'])
  })

  // 安全弁: 原文を採った側がコードを持たなければ、**土台に残っていたコードも消す**。
  // 残すと「別の報のコード × この報の原文」という組ができ、検出が誤る。
  it('原文を採った側がコードを持たなければ、コードは残らない', () => {
    const e: JMAQuake = { ...makeQuake(), varCommentText: '既存の注記。', varCommentCodes: ['0262'] }
    const n: JMAQuake = {
      ...makeNoIntensity({ type: '顕著な地震の震源要素更新のお知らせ' }),
      varCommentText: 'コードを持たない報の注記。',
    }
    const merged = mergeQuakeInto(e, n)
    expect(merged.varCommentText).toBe('コードを持たない報の注記。')
    expect(merged.varCommentCodes).toBeUndefined()
  })
})

describe('mergeQuakeInto — 顕著地震カードが先にある場合（本バグの核心）', () => {
  // 震度が復活する経路では土台が incoming（震度電文）に替わる。明示的に採らないと
  // VXSE61 が伝える精査後の Mw が、震度が確定した瞬間に消える
  it('顕著地震単独カードの自由付加文は、震度電文で震度が復活しても残る', () => {
    const amendment = 'なお、この地震の精査したモーメントマグニチュード（Ｍｗ）は６．８です。'
    const e: JMAQuake = {
      ...makeNoIntensity({ type: '顕著な地震の震源要素更新のお知らせ', time: '2026-07-28T07:40:00Z' }),
      freeText: amendment,
    }
    const n = makeQuake({ time: '2026-07-28T07:30:00Z' })
    expect(mergeQuakeInto(e, n).freeText).toBe(amendment)
  })

  it('顕著地震単独カード（震度なし）に各地の震度が来たら震度を復活させる', () => {
    // 既存 = 先に単独カード化した VXSE61（優先度5・震度なし・発表が新しい）
    const e = makeNoIntensity({
      type: '顕著な地震の震源要素更新のお知らせ',
      time: '2026-07-28T07:35:00Z',
      mag: 7.3,
    })
    // 後続バッチで届いた VXSE53（各地の震度・震度7・発表が古い）
    const n = makeQuake({ type: '各地の震度情報', maxScale: 70, time: '2026-07-28T07:30:00Z', mag: 7.1 })
    const merged = mergeQuakeInto(e, n)
    expect(merged.earthquake.maxScale).toBe(70)   // 震度7 が入る（優先度5に弾かれない）
    expect(merged.points.length).toBeGreaterThan(0)
    // より新しい VXSE61 の震源・種別は保持される
    expect(merged.issue.type).toBe('顕著な地震の震源要素更新のお知らせ')
    expect(merged.earthquake.hypocenter.magnitude).toBe(7.3)
  })
})

describe('mergeQuakeInto — 通常電文どうし', () => {
  // 仕様変更（能登 2024/1/1 実データの回帰修正）: incoming が実震度を持つ続報は issue.type の
  // 優先度ではなく発表時刻で判定する。同じ分（気象庁電文の time は分精度）に届けば種別を問わず
  // 受け入れる。理由は quakeMerge.ts の据え置き判定コメントを参照。
  it('各地の震度(既存) に 同時刻の震度速報 が来たら受け入れる（種別優先度ではなく時刻で判定）', () => {
    // time を明示的に完全一致させ、等号側の分岐（incoming.time === existing.time）を
    // 正面から検証する。気象庁電文の time は分単位までしか精度が無く、同じ分に複数種別の
    // 電文が発表されることは実データでも確認済み（震源情報と震度速報の続報。下の
    // describe ブロック参照）。
    const time = '2026-07-28T07:27:30Z'
    const e = makeQuake({ type: '各地の震度情報', maxScale: 70, time })
    const n = makeQuake({ type: '震度速報', maxScale: 50, time })
    const merged = mergeQuakeInto(e, n)
    expect(merged.issue.type).toBe('震度速報')
    expect(merged.earthquake.maxScale).toBe(50)
  })

  it('各地の震度(既存) に 発表が古い震度速報 が来たら据え置く（対照）', () => {
    const e = makeQuake({ type: '各地の震度情報', maxScale: 70, time: '2026-07-28T07:30:00Z' })
    const n = makeQuake({ type: '震度速報', maxScale: 50, time: '2026-07-28T07:20:00Z' })
    expect(withoutReports(mergeQuakeInto(e, n))).toEqual(withoutReports(e))
  })

  it('低優先度(既存) に 高優先度 が来たら置換する', () => {
    const e = makeQuake({ type: '震度速報', maxScale: 40 })
    const n = makeQuake({ type: '各地の震度情報', maxScale: 70 })
    expect(withoutReports(mergeQuakeInto(e, n))).toEqual({ ...n, eventKey: quakeEventKey(n) })
  })

  it('震度欠落の後続電文は既存の震度で補完される', () => {
    const e = makeQuake({ type: '震度速報', maxScale: 50 })
    const n = makeNoIntensity({ type: '震源・震度情報' })  // 優先度3 > 1・震度欠落
    const merged = mergeQuakeInto(e, n)
    expect(merged.issue.type).toBe('震源・震度情報')  // 種別は新しい方
    expect(merged.earthquake.maxScale).toBe(50)        // 震度は補完
    expect(merged.points.length).toBeGreaterThan(0)
  })

  // 正: 市町村ごとの震度も点と同じ扱いで補う。片方だけ戻すと、観測点は残るのに市町村の段だけが
  // 消え、震度一覧が 4 段から 3 段へ静かに落ちる（→ docs/spec/quake-spec.md §6.4・§8）。
  it('震度欠落の後続電文でも市町村の震度は引き継ぐ', () => {
    const cities = [{ name: '普代村', area: '岩手県沿岸北部', pref: '岩手県', scale: 30 as IntensityScale }]
    const e = { ...makeQuake({ type: '震源・震度情報', maxScale: 50 }), cities }
    const n = makeNoIntensity({ type: '震源・震度情報' })
    const merged = mergeQuakeInto(e, n)
    expect(merged.points.length).toBeGreaterThan(0)   // 対の確認: 点は従来どおり戻る
    expect(merged.cities).toEqual(cities)
  })

  // 対照: 震度を持つ続報では、市町村も**その報に従う**（消えたのなら気象庁が取り下げた）。
  // 補完は「その種別が構造的に持たない」場合だけで、値の増減には介入しない（§6.4 の②）。
  it('震度を持つ続報では、市町村もその報の内容に従う', () => {
    const cities = [{ name: '普代村', area: '岩手県沿岸北部', pref: '岩手県', scale: 30 as IntensityScale }]
    const e = { ...makeQuake({ type: '震源・震度情報', maxScale: 50 }), cities }
    const n = makeQuake({ type: '震源・震度情報', maxScale: 50 })  // 市町村を持たない続報
    const merged = mergeQuakeInto(e, n)
    expect(merged.cities).toBeUndefined()
  })

  it('発表時刻が空の続報は据え置く（異常データを安全側＝据え置きに倒す）', () => {
    const e = makeQuake({ type: '震度速報', maxScale: 50, time: '2026-07-28T07:27:30Z' })
    const n = makeQuake({ type: '震度速報', maxScale: 60, time: '' })
    expect(withoutReports(mergeQuakeInto(e, n))).toEqual(withoutReports(e))
  })

  it('取消表示中(cancelledAt)のカードは優先度に関わらず通常電文で置換される', () => {
    const e = makeQuake({ type: '各地の震度情報', maxScale: 70, cancelledAt: new Date() })
    const n = makeQuake({ type: '震度速報', maxScale: 40 })
    expect(withoutReports(mergeQuakeInto(e, n))).toEqual({ ...n, eventKey: quakeEventKey(n) })
  })

  it('顕著地震とマージ済みの完成カード（震度あり）は低優先度の後続電文で据え置く', () => {
    // 既存 = 各地の震度→顕著地震でマージ済み（issue.type=顕著・震度7）。優先度5がガードとして働く。
    const e: JMAQuake = {
      ...makeQuake({ type: '各地の震度情報', maxScale: 70 }),
      issue: { source: 'dmdata', time: '2026-07-28T07:35:00Z', type: '顕著な地震の震源要素更新のお知らせ', correct: 'なし' },
    }
    const n = makeQuake({ type: '震度速報', maxScale: 50, time: '2026-07-28T07:40:00Z' })
    expect(withoutReports(mergeQuakeInto(e, n))).toEqual(withoutReports(e))
  })

  // 能登 2024/1/1 16:06〜16:08 の実データで確認された不具合の回帰テスト（3件セット）。
  // 震度速報(優先度1)→震源情報(優先度2、震度なし)→震度速報の続報(優先度1) という気象庁の
  // 実際の発表順序で、旧ロジック（issue.type の優先度のみで判定）だと最後の続報が「震源情報より
  // 優先度が低い」という理由だけで無視され、新しく増えた区域（新潟県佐渡）が地図・カードに
  // 反映されなかった。
  describe('震源情報を挟んだ震度速報の複数報（能登 2024/1/1 実データの回帰）', () => {
    const firstPrompt = makeQuake({
      type: '震度速報', maxScale: 50, time: '2026-01-01T07:07:42Z',
      points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
    })
    const epicenterOnly = makeNoIntensity({ type: '震源情報', time: '2026-01-01T07:08:32Z' })

    it('正: 震源情報の後でも、時系列的に新しい震度速報の続報（新規区域あり）を取り込む', () => {
      const afterEpicenter = mergeQuakeInto(firstPrompt, epicenterOnly)
      expect(afterEpicenter.issue.type).toBe('震源情報')  // 震源情報に一旦切り替わる（既存の既知の挙動）

      const secondPrompt = makeQuake({
        type: '震度速報', maxScale: 50, time: '2026-01-01T07:08:42Z',
        points: [
          { pref: '', addr: '石川県能登', isArea: true, scale: 50 },
          { pref: '', addr: '新潟県佐渡', isArea: true, scale: 30 },
        ],
      })
      const merged = mergeQuakeInto(afterEpicenter, secondPrompt)
      expect(merged.issue.type).toBe('震度速報')
      expect(merged.points.map(p => p.addr)).toContain('新潟県佐渡')
    })

    it('対照: 震源情報より発表が古い震度速報（取りこぼれて遅れて届いた分）は据え置く', () => {
      const afterEpicenter = mergeQuakeInto(firstPrompt, epicenterOnly)
      const staleReplay = makeQuake({
        type: '震度速報', maxScale: 50, time: '2026-01-01T07:07:50Z',  // epicenterOnly より古い
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      expect(withoutReports(mergeQuakeInto(afterEpicenter, staleReplay))).toEqual(withoutReports(afterEpicenter))
    })

    it('安全弁: VXSE61 とマージ済みの完成カードは、発表時刻が新しくても変わらず据え置く', () => {
      // 既存テスト「顕著地震とマージ済みの完成カード」と同じ保護が、時刻ベースへの変更後も
      // 引き続き有効であることの確認（境界を動かす変更が別の保護を緩めていないか）。
      const e: JMAQuake = {
        ...makeQuake({ type: '各地の震度情報', maxScale: 70 }),
        issue: { source: 'dmdata', time: '2026-07-28T07:35:00Z', type: '顕著な地震の震源要素更新のお知らせ', correct: 'なし' },
      }
      const muchNewer = makeQuake({ type: '震度速報', maxScale: 50, time: '2099-01-01T00:00:00Z' })
      expect(withoutReports(mergeQuakeInto(e, muchNewer))).toEqual(withoutReports(e))
    })
  })

  // 上の回帰テストは震度（points）だけを見ており、`makeQuake` が震度速報にも震源要素を
  // 持たせるため震源の消失を検出できていなかった。実電文どおりの震度速報（`makePrompt`）で
  // 固定する。能登 2024/1/1 の実データでは 3 通の `time` がいずれも分精度で 16:08 に並ぶため、
  // 据え置き判定は続報を受け入れる（＝置換が走る）。
  describe('震源を持たない続報（震度速報）は既存の震源を消さない', () => {
    const firstPrompt = makePrompt({
      time: '2026-01-01T07:07:42Z',
      points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
    })
    const epicenterOnly: JMAQuake = {
      ...makeNoIntensity({
        type: '震源情報', time: '2026-01-01T07:08:00Z',
        hypoName: '石川県能登地方', mag: 5.7, tsunami: 'なし',
      }),
      forecastText: 'この地震による津波の心配はありません。',
    }
    const secondPrompt = makePrompt({
      time: '2026-01-01T07:08:00Z',
      points: [
        { pref: '', addr: '石川県能登', isArea: true, scale: 50 },
        { pref: '', addr: '新潟県佐渡', isArea: true, scale: 30 },
      ],
    })

    it('正: 震源情報が確定させた震源要素が、震度速報の続報でも残る', () => {
      const afterEpicenter = mergeQuakeInto(firstPrompt, epicenterOnly)
      expect(afterEpicenter.earthquake.hypocenter.name).toBe('石川県能登地方')

      const merged = mergeQuakeInto(afterEpicenter, secondPrompt)
      // 新しく増えた区域は取り込む（従来の回帰テストが守っている挙動）
      expect(merged.points.map(p => p.addr)).toContain('新潟県佐渡')
      // 震源要素は既存カードのものが残る
      expect(merged.earthquake.hypocenter.name).toBe('石川県能登地方')
      expect(merged.earthquake.hypocenter.magnitude).toBe(5.7)
      expect(merged.earthquake.hypocenter.depth).toBe(10)
      // 座標が -200（位置不明センチネル）へ戻らない＝地図の震源マーカーが消えない
      expect(merged.earthquake.hypocenter.latitude).toBe(epicenterOnly.earthquake.hypocenter.latitude)
      expect(merged.earthquake.hypocenter.longitude).toBe(epicenterOnly.earthquake.hypocenter.longitude)
    })

    // 旧テスト「対照: 震度速報が自前で持つ津波区分・固定付加文は既存で塗り替えない」を覆した。
    // 震度速報の津波区分は種別に付く定型文で、その報の判断を表していないため採らないことにした
    // （実データでは震源情報が `なし` と判断した 10 秒後の続報が `調査中` のまま届く）。
    it('正: 震度速報の続報でも、既存カードの津波区分・固定付加文が残る', () => {
      const afterEpicenter = mergeQuakeInto(firstPrompt, epicenterOnly)
      expect(afterEpicenter.earthquake.domesticTsunami).toBe('なし')

      const merged = mergeQuakeInto(afterEpicenter, secondPrompt)
      expect(merged.earthquake.domesticTsunami).toBe('なし')
      expect(merged.forecastText).toBe('この地震による津波の心配はありません。')
    })

    it('対照: 既存が津波区分を持たない（不明）なら震度速報の値を使う', () => {
      // 判断がまだ無いカードに「なし」を捏造しない。震度速報の `調査中` が正しい表示になる。
      const unknown: JMAQuake = {
        ...makeNoIntensity({ type: '震源情報', time: '2026-01-01T07:08:00Z', hypoName: '石川県能登地方' }),
        earthquake: {
          ...makeNoIntensity({ type: '震源情報', hypoName: '石川県能登地方' }).earthquake,
          domesticTsunami: '不明',
        },
        forecastText: undefined,
      }
      const merged = mergeQuakeInto(unknown, secondPrompt)
      expect(merged.earthquake.domesticTsunami).toBe('調査中')
      expect(merged.forecastText).toBe('今後の情報に注意してください。')
    })

    it('安全弁: 震度速報以外の続報は津波区分を普通に置き換える（引き下げも反映する）', () => {
      // 定型文を採らないのは震度速報だけ。他の種別は実際の判断を運ぶので、値が軽くなる
      // 方向でも従う（§6.4 の「値の取り下げには従う」）。
      const warned = makeQuake({ type: '震源・震度情報', maxScale: 50, time: '2026-01-01T07:10:00Z', tsunami: '注意報' })
      const cleared = makeQuake({ type: '各地の震度情報', maxScale: 50, time: '2026-01-01T07:20:00Z', tsunami: 'なし' })
      expect(mergeQuakeInto(warned, cleared).earthquake.domesticTsunami).toBe('なし')
    })

    it('対照: incoming が震源を持つ電文なら、既存の震源で塗り替えず incoming の値を採る', () => {
      // 補完は「その種別が構造的に震源を持たない」場合だけ。震源を持つ電文の値まで
      // 既存へ固定すると、精査で更新されたマグニチュードが反映されなくなる。
      const existing = makeQuake({ type: '震源・震度情報', maxScale: 50, mag: 7.1, time: '2026-01-01T07:08:00Z' })
      const revised = makeQuake({ type: '各地の震度情報', maxScale: 50, mag: 6.8, time: '2026-01-01T07:10:00Z' })
      expect(mergeQuakeInto(existing, revised).earthquake.hypocenter.magnitude).toBe(6.8)
    })

    it('安全弁: 既存も震源未確定（震度速報どうし）なら震源を作らない', () => {
      // 空を無理に埋めない。埋めると「位置不明」の判定が壊れ、緯度経度 0 の地点に
      // 震源マーカーが立ちうる。
      const merged = mergeQuakeInto(firstPrompt, secondPrompt)
      expect(merged.earthquake.hypocenter.name).toBe('')
      expect(merged.earthquake.hypocenter.latitude).toBe(-200)
      expect(merged.points.map(p => p.addr)).toContain('新潟県佐渡')
    })

    it('安全弁: 既存が震源名を持たなければ、座標が入っていても引き継がない', () => {
      // 判定の軸は震源名。実運用ではパーサーが「名前は空だが座標は有効」を作らない
      // （震源を持つ電文で座標が読めないものは捨てる）が、その前提に寄りかからず
      // 引き継ぎの条件そのものを固定する。上の安全弁だけでは、既存側の震源が常に
      // センチネル値になるため `!isHypocenterPending(existing)` を外しても検出できない。
      const nameless: JMAQuake = {
        ...firstPrompt,
        earthquake: {
          ...firstPrompt.earthquake,
          hypocenter: { name: '', latitude: 37.5, longitude: 137.3, depth: 10, magnitude: 5.7 },
        },
      }
      const merged = mergeQuakeInto(nameless, secondPrompt)
      expect(merged.earthquake.hypocenter.latitude).toBe(-200)
      expect(merged.earthquake.hypocenter.magnitude).toBeNaN()
    })

    it('安全弁: 取消表示中のカードからは震源を引き継がない', () => {
      // 取消は「その報の内容が誤りだった」意味なので、取り下げられた震源を新しいカードへ
      // 持ち込まない（持ち込むと気象庁が消した位置を地図に出し直すことになる）。
      const cancelledEpicenter: JMAQuake = { ...epicenterOnly, cancelledAt: new Date() }
      const merged = mergeQuakeInto(cancelledEpicenter, secondPrompt)
      expect(merged.earthquake.hypocenter.name).toBe('')
      expect(merged.earthquake.hypocenter.latitude).toBe(-200)
    })

    it('安全弁: 逆方向（震度を持たない震源情報が既存の震度を引き継ぐ）が生きている', () => {
      // 対の補完を壊していないことの確認。片方だけ効く状態になっていないか。
      const afterEpicenter = mergeQuakeInto(firstPrompt, epicenterOnly)
      expect(afterEpicenter.earthquake.maxScale).toBe(50)
      expect(afterEpicenter.points.map(p => p.addr)).toContain('石川県能登')
    })
  })
})

describe('mergeQuakeHistory', () => {
  it('単一バッチに 51/52/53/61 が順不同で混在しても1カードに統合する', () => {
    const v51 = makeQuake({ type: '震度速報', maxScale: 50, time: '2026-07-28T07:28:00Z' })
    const v53 = makeQuake({ type: '各地の震度情報', maxScale: 70, time: '2026-07-28T07:31:00Z' })
    const v61 = makeNoIntensity({ type: '顕著な地震の震源要素更新のお知らせ', mag: 7.3, time: '2026-07-28T07:35:00Z' })
    const merged = mergeQuakeHistory([v61, v51, v53])
    expect(merged).toHaveLength(1)
    expect(merged[0].earthquake.maxScale).toBe(70)
    expect(merged[0].issue.type).toBe('顕著な地震の震源要素更新のお知らせ')
    expect(merged[0].earthquake.hypocenter.magnitude).toBe(7.3)
  })

  // mergeQuakeHistory の「既知の限界」（同関数の宣言コメント参照）: 同じ分（time は分精度）に
  // 詳しい電文と粗い電文が混在すると、newQuakes の入力順序がそのまま結果に効く。
  // 安全弁: 日時として読めない時刻が混ざっても、比較関数が全順序のままであること。
  // 素朴に `getTime()` の差を返す形では、読めない a と読める b・c について a=b・a=c なのに
  // b<c が成り立ち、`sort` の結果が実装依存になる（症状は「同じ入力なのに並びが違う」）。
  it('読めない発表時刻が混ざっても並びが決まる（末尾へ寄せる）', () => {
    // **別の地震にする**（同じ eventId だと 1 枚のカードへ畳まれて並びが見えない）
    const broken = {
      ...makeQuake({ eventId: '20260810030000', maxScale: 30 }),
      time: 'これは日時ではない',
    }
    const later = makeQuake({ eventId: '20260810020000', time: '2026-08-10T02:05:00+09:00', maxScale: 40 })
    const earlier = makeQuake({ eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00', maxScale: 20 })

    // 入力の順番を変えても結果の並びが同じであること（全順序なら決まる）
    const ids = (list: JMAQuake[]) => mergeQuakeHistory(list, [], [], null).map(q => q.id)

    expect(ids([broken, later, earlier])).toEqual(ids([earlier, broken, later]))
    expect(ids([broken, later, earlier])).toEqual(ids([later, earlier, broken]))
    expect(ids([broken, later, earlier])).toHaveLength(3)
  })

  // 呼び出し側（`orderedForMerge`）が「速報→詳細」の順に並べ直す前提を、ここで固定する。
  it('正: 同じ分でも「粗い→詳しい」の順（実際の発表順）で来れば、詳しい方が勝つ', () => {
    const time = '2026-07-28T07:30:00Z'
    const prompt = makeQuake({ type: '震度速報', maxScale: 50, time })
    const detailed = makeQuake({ type: '各地の震度情報', maxScale: 70, time })
    const merged = mergeQuakeHistory([prompt, detailed])
    expect(merged).toHaveLength(1)
    expect(merged[0].issue.type).toBe('各地の震度情報')
    expect(merged[0].earthquake.maxScale).toBe(70)
  })

  it('既知の限界: 同じ分で「詳しい→粗い」の順（発表順に反する）だと、粗い方に後退する', () => {
    const time = '2026-07-28T07:30:00Z'
    const detailed = makeQuake({ type: '各地の震度情報', maxScale: 70, time })
    const prompt = makeQuake({ type: '震度速報', maxScale: 50, time })
    const merged = mergeQuakeHistory([detailed, prompt])
    expect(merged).toHaveLength(1)
    // 現状の仕様（意図した動作ではないが既知の限界）。`orderedForMerge` 側が
    // 常に「速報→詳細」の順で結合することでこの逆転を避けている。
    expect(merged[0].issue.type).toBe('震度速報')
    expect(merged[0].earthquake.maxScale).toBe(50)
  })

  it('バッチ跨ぎ: 既存の完成カードは維持し、新バッチの別イベントを追加する（回帰テスト）', () => {
    const base = [makeQuake({ eventId: '20260728162718', type: '各地の震度情報', maxScale: 70 })]
    // 「もっと見る」で再取得された 16:27 の VXSE61 と、別イベントの古い53
    const reV61 = makeNoIntensity({ eventId: '20260728162718', type: '顕著な地震の震源要素更新のお知らせ', mag: 7.3, time: '2026-07-28T07:35:00Z' })
    const other = makeQuake({ eventId: '20260728160000', type: '各地の震度情報', maxScale: 30, quakeTime: '2026-07-28T07:00:00Z', hypoName: '別の場所' })
    const merged = mergeQuakeHistory([reV61, other], base)
    const main = merged.find(q => extractQuakeEventId(q) === '20260728162718')!
    expect(main.earthquake.maxScale).toBe(70)  // 震度7 維持
    expect(merged).toHaveLength(2)             // 別イベントが追加
  })

  it('バッチ跨ぎ: 先に顕著地震単独カードが出ていても、後続バッチの震度で完成する', () => {
    const base = [makeNoIntensity({ eventId: '20260728162718', type: '顕著な地震の震源要素更新のお知らせ', mag: 7.3, time: '2026-07-28T07:35:00Z' })]
    const v53 = makeQuake({ eventId: '20260728162718', type: '各地の震度情報', maxScale: 70, time: '2026-07-28T07:30:00Z' })
    const merged = mergeQuakeHistory([v53], base)
    expect(merged).toHaveLength(1)
    expect(merged[0].earthquake.maxScale).toBe(70)
    expect(merged[0].issue.type).toBe('顕著な地震の震源要素更新のお知らせ')
  })

  it('統合後カードから eventId を抽出できる（LPGM 紐付けの担保）', () => {
    const merged = mergeQuakeHistory([
      makeQuake({ eventId: '20260728162718', type: '各地の震度情報', maxScale: 70 }),
      makeNoIntensity({ eventId: '20260728162718', type: '顕著な地震の震源要素更新のお知らせ', time: '2026-07-28T07:35:00Z' }),
    ])
    expect(extractQuakeEventId(merged[0])).toBe('20260728162718')
  })

  it('earthquake.time がずれても同一 eventId は1カードに集約する', () => {
    const v51 = makeQuake({ eventId: '20260728162718', id: 'dmdata-quake-20260728162718-1', type: '震度速報', maxScale: 50, quakeTime: '2026-07-28T07:28:00Z', time: '2026-07-28T07:28:30Z' })
    const v53 = makeQuake({ eventId: '20260728162718', id: 'dmdata-quake-20260728162718-2', type: '各地の震度情報', maxScale: 70, quakeTime: '2026-07-28T07:27:00Z', time: '2026-07-28T07:31:00Z' })
    expect(mergeQuakeHistory([v51, v53])).toHaveLength(1)
  })

  it('eventId が無い（P2P 由来）データは earthquake.time で集約し優先度で選ぶ', () => {
    const a = makeQuake({ id: 'p2p-1', type: '震度速報', maxScale: 40, quakeTime: '2026-07-28T07:27:00Z', time: '2026-07-28T07:28:00Z' })
    const b = makeQuake({ id: 'p2p-2', type: '各地の震度情報', maxScale: 70, quakeTime: '2026-07-28T07:27:00Z', time: '2026-07-28T07:31:00Z' })
    const merged = mergeQuakeHistory([a, b])
    expect(merged).toHaveLength(1)
    expect(merged[0].earthquake.maxScale).toBe(70)
  })

  // 2026-08-15 06:58 の実データ（群馬県南部 震度2／インドネシア、フローレスの遠地地震）。
  // P2PQuake の地震の時刻は分単位のため両者の earthquake.time が完全一致し、
  // 以前は優先度比較（各地の震度情報 4 > 遠地地震 0）で遠地地震のカードが捨てられていた。
  it('P2P 由来で同じ分に起きた別震源の地震は 2 枚に分かれる', () => {
    const domestic = makeQuake({
      id: 'p2p-1', type: '各地の震度情報', maxScale: 20, hypoName: '群馬県南部',
      quakeTime: '2026-08-15T06:58:00+09:00', time: '2026-08-15T07:01:29+09:00',
    })
    const foreign = makeNoIntensity({
      id: 'p2p-2', type: '遠地地震', hypoName: 'インドネシア、フローレス',
      quakeTime: '2026-08-15T06:58:00+09:00', time: '2026-08-15T07:29:04+09:00',
    })
    const merged = mergeQuakeHistory([domestic, foreign])
    expect(merged).toHaveLength(2)
    expect(merged.map(q => q.earthquake.hypocenter.name).sort())
      .toEqual(['インドネシア、フローレス', '群馬県南部'])
    // キーが衝突していない＝選択・通知が 2 枚の間で連動しない
    expect(new Set(merged.map(q => q.eventKey)).size).toBe(2)
  })

  it('DMDATA 由来で同じ分に起きた 2 地震も別 eventKey になる', () => {
    const domestic = makeQuake({
      id: 'dmdata-quake-20260815065801-1', hypoName: '群馬県南部',
      quakeTime: '2026-08-15T06:58:00+09:00',
    })
    const foreign = makeNoIntensity({
      id: 'dmdata-quake-20260815065802-1', type: '遠地地震', hypoName: 'インドネシア、フローレス',
      quakeTime: '2026-08-15T06:58:00+09:00',
    })
    const merged = mergeQuakeHistory([domestic, foreign])
    expect(merged).toHaveLength(2)
    expect(new Set(merged.map(q => q.eventKey)).size).toBe(2)
  })

  it('P2P 経路で震源要素更新が震源名を変えてもカードは 1 枚のまま', () => {
    const detail = makeQuake({
      id: 'p2p-1', type: '各地の震度情報', maxScale: 70,
      hypoName: '石川県能登地方', time: '2026-07-28T07:31:00Z',
    })
    const amended = makeNoIntensity({
      id: 'p2p-2', type: '顕著な地震の震源要素更新のお知らせ',
      hypoName: '能登半島沖', time: '2026-07-28T07:45:00Z',
    })
    const merged = mergeQuakeHistory([detail, amended])
    expect(merged).toHaveLength(1)
    expect(merged[0].earthquake.hypocenter.name).toBe('能登半島沖')  // 震源は更新される
    expect(merged[0].earthquake.maxScale).toBe(70)                   // 震度は保持される
  })

  // 既知の限界（docs/spec/quake-spec.md §6.1）。震源が未確定の震度速報は震源名が空で、
  // 同じ分に起きたどの地震の速報かを電文から判別できない。先に届いた震源付きの報と
  // 合流するため、カードの中身が別の地震に入れ替わる。分離できないことを固定しておく。
  it('［限界］震源名が空の震度速報は、同じ分の別地震の詳細報と合流してしまう', () => {
    const promptOfY = makeQuake({ id: 'p2p-y1', type: '震度速報', maxScale: 30, hypoName: '' })
    const detailOfX = makeQuake({
      id: 'p2p-x1', type: '各地の震度情報', maxScale: 50,
      hypoName: '大阪府北部', time: '2026-07-28T07:29:00Z',
    })
    const detailOfY = makeQuake({
      id: 'p2p-y2', type: '各地の震度情報', maxScale: 40,
      hypoName: '東京都２３区', time: '2026-07-28T07:31:00Z',
    })
    const merged = mergeQuakeHistory([promptOfY, detailOfX, detailOfY])
    // 最終的な枚数と表示内容は正しく 2 枚に落ち着く
    expect(merged.map(q => q.earthquake.hypocenter.name).sort()).toEqual(['大阪府北部', '東京都２３区'])
    // ただし Y の速報が確保したキーを X のカードが引き継いでいる（＝この過程で
    // Y のカードを選択していたユーザーには中身が X にすり替わって見える）
    expect(merged.find(q => q.earthquake.hypocenter.name === '大阪府北部')?.eventKey)
      .toBe('p2p:2026-07-28T07:27:00Z#p2p-y1')
  })

  it('統合結果には eventKey が付き、続報でも初報のキーを保つ', () => {
    const first = mergeQuakeInto(undefined, makeQuake({ id: 'p2p-1', type: '震度速報', maxScale: 40 }))
    const second = mergeQuakeInto(first, makeQuake({ id: 'p2p-2', type: '各地の震度情報', maxScale: 70 }))
    expect(first.eventKey).toBe('p2p:2026-07-28T07:27:00Z#p2p-1')
    expect(second.eventKey).toBe(first.eventKey)
  })

  it('新しい地震が先頭に来るよう earthquake.time 降順で並ぶ', () => {
    const older = makeQuake({ eventId: '20260728160000', quakeTime: '2026-07-28T07:00:00Z' })
    const newer = makeQuake({ eventId: '20260728162718', quakeTime: '2026-07-28T07:27:00Z' })
    const merged = mergeQuakeHistory([older, newer])
    expect(extractQuakeEventId(merged[0])).toBe('20260728162718')
  })

  it('取消電文が来たら該当 eventId のカードを履歴から除外する（base にあっても消える）', () => {
    const base = [makeQuake({ eventId: '20260728162718', type: '各地の震度情報', maxScale: 70 })]
    const cancel: JMAQuake = {
      ...makeNoIntensity({ eventId: '20260728162718', type: '各地の震度情報', time: '2026-07-28T07:40:00Z' }),
      cancelled: true,
    }
    const merged = mergeQuakeHistory([cancel], base)
    expect(merged.find(q => extractQuakeEventId(q) === '20260728162718')).toBeUndefined()
  })

  it('同一バッチ内で震度電文の後に取消電文が来た場合も除外する', () => {
    const v53 = makeQuake({ eventId: '20260728162718', type: '各地の震度情報', maxScale: 70, time: '2026-07-28T07:31:00Z' })
    const cancel: JMAQuake = {
      ...makeNoIntensity({ eventId: '20260728162718', type: '各地の震度情報', time: '2026-07-28T07:40:00Z' }),
      cancelled: true,
    }
    expect(mergeQuakeHistory([v53, cancel])).toHaveLength(0)
  })

  it('取消の後に新しい電文が来れば再度カード化される（時刻順foldの確認）', () => {
    const cancel: JMAQuake = {
      ...makeNoIntensity({ eventId: '20260728162718', type: '各地の震度情報', time: '2026-07-28T07:40:00Z' }),
      cancelled: true,
    }
    const reissue = makeQuake({ eventId: '20260728162718', type: '各地の震度情報', maxScale: 70, time: '2026-07-28T07:45:00Z' })
    expect(mergeQuakeHistory([cancel, reissue])).toHaveLength(1)
  })

  it('空配列を渡しても壊れない', () => {
    expect(mergeQuakeHistory([])).toEqual([])
    expect(mergeQuakeHistory([], [])).toEqual([])
  })
})

describe('coalesceByEventId — 暫定 EventID で分かれたカードを畳む', () => {
  const 地震の時刻 = '2026-08-23T19:05:00Z'
  // 2026-08-24 04:05 熊本県天草・芦北地方の実系列。震度速報だけ EventID が別採番されている。
  const 震度速報 = makeQuake({
    id: 'dmdata-quake-20260824040519-1', type: '震度速報', hypoName: '',
    time: '2026-08-23T19:06:00Z', quakeTime: 地震の時刻, maxScale: 30,
    points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
  })
  const 震源情報 = makeNoIntensity({
    id: 'dmdata-quake-20260824040526-1', type: '震源情報', hypoName: '熊本県天草・芦北地方',
    time: '2026-08-23T19:08:00Z', quakeTime: 地震の時刻,
  })
  const 震源震度情報 = makeQuake({
    id: 'dmdata-quake-20260824040526-2', type: '震源・震度情報', hypoName: '熊本県天草・芦北地方',
    time: '2026-08-23T19:09:00Z', quakeTime: 地震の時刻, maxScale: 30,
    points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
  })

  it('3 通そろえば 1 枚に収まる（震源・震度とも欠けない）', () => {
    const merged = mergeQuakeHistory([震度速報, 震源情報, 震源震度情報])
    expect(merged).toHaveLength(1)
    expect(merged[0].earthquake.hypocenter.name).toBe('熊本県天草・芦北地方')
    expect(merged[0].earthquake.maxScale).toBe(30)
    expect(merged[0].points.map(p => p.addr)).toContain('熊本県天草・芦北地方')
  })

  it('震源情報までしか届いていない間は 2 枚のまま（区域の裏付けが無いうちは合流させない）', () => {
    expect(mergeQuakeHistory([震度速報, 震源情報])).toHaveLength(2)
  })

  it('取消表示中のカードは畳まない（purge 予約が空振りするため）', () => {
    const cancelled = { ...makeQuake({ id: 'dmdata-quake-20260824040526-1' }), cancelledAt: new Date() }
    const normal = makeQuake({ id: 'dmdata-quake-20260824040526-2' })
    expect(coalesceByEventId([cancelled, normal])).toHaveLength(2)
    expect(coalesceByEventId([normal, cancelled])).toHaveLength(2)
  })

  it('eventId が違うカードは畳まない', () => {
    const a = makeQuake({ id: 'dmdata-quake-20260824040519-1' })
    const b = makeQuake({ id: 'dmdata-quake-20260824040526-1' })
    expect(coalesceByEventId([a, b])).toHaveLength(2)
  })

  it('eventId を持たないカード（P2PQuake 経路）は畳まない', () => {
    const a = makeQuake({ id: 'p2p-1' })
    const b = makeQuake({ id: 'p2p-2' })
    expect(coalesceByEventId([a, b])).toHaveLength(2)
  })

  it('畳むときは震度を持つ完成したカードを残す', () => {
    const 完成 = makeQuake({ id: 'dmdata-quake-20260824040526-2', type: '震源・震度情報', maxScale: 30 })
    const 震源のみ = makeNoIntensity({ id: 'dmdata-quake-20260824040526-1', type: '震源情報' })
    const [card] = coalesceByEventId([完成, 震源のみ])
    expect(card.earthquake.maxScale).toBe(30)
    expect(card.issue.type).toBe('震源・震度情報')
  })
})

describe('findExistingQuakeCard — 一致が 2 枚あるときの選び方', () => {
  const 地震の時刻 = '2026-08-23T19:05:00Z'
  const 震度速報 = makeQuake({
    id: 'dmdata-quake-20260824040519-1', type: '震度速報', hypoName: '',
    time: '2026-08-23T19:06:00Z', quakeTime: 地震の時刻, maxScale: 30,
    points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
  })
  const 震源情報カード = makeNoIntensity({
    id: 'dmdata-quake-20260824040526-1', type: '震源情報', hypoName: '熊本県天草・芦北地方',
    time: '2026-08-23T19:08:00Z', quakeTime: 地震の時刻,
  })
  const 震源震度情報 = makeQuake({
    id: 'dmdata-quake-20260824040526-2', type: '震源・震度情報', hypoName: '熊本県天草・芦北地方',
    time: '2026-08-23T19:09:00Z', quakeTime: 地震の時刻, maxScale: 30,
    points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
  })

  it('2 枚とも一致するときは先に立った方（発表時刻が古い方）を返す', () => {
    // ライブでは新しいカードが先頭に積まれる。配列順に引きずられないことを固定する。
    const found = findExistingQuakeCard([震源情報カード, 震度速報], 震源震度情報)
    expect(found?.id).toBe(震度速報.id)
  })

  it('一致が 1 枚ならそれを返し、無ければ undefined', () => {
    expect(findExistingQuakeCard([震源情報カード], 震源震度情報)?.id).toBe(震源情報カード.id)
    expect(findExistingQuakeCard([], 震源震度情報)).toBeUndefined()
  })

  // eventKey が入れ替わるとブラウザ通知の重複抑止が破れ、同じ地震の通知が二度出る。
  it('ライブの到着順（震度速報→震源情報→震源・震度情報）で eventKey が入れ替わらない', () => {
    let cards: JMAQuake[] = []
    for (const incoming of [震度速報, 震源情報カード, 震源震度情報]) {
      const existing = findExistingQuakeCard(cards, incoming)
      const merged = mergeQuakeInto(existing, incoming)
      cards = sortQuakes(coalesceByEventId([merged, ...cards.filter(e => !sameQuakeEntry(e, incoming))]))
    }
    expect(cards).toHaveLength(1)
    expect(cards[0].eventKey).toBe('20260824040519')
    expect(cards[0].earthquake.hypocenter.name).toBe('熊本県天草・芦北地方')
    expect(cards[0].earthquake.maxScale).toBe(30)
  })

  it('畳み込みは並び順に関わらず震度を持つカードを残す', () => {
    const 完成 = makeQuake({ id: 'dmdata-quake-20260824040526-2', type: '震源・震度情報', maxScale: 30 })
    const 震源のみ = makeNoIntensity({ id: 'dmdata-quake-20260824040526-1', type: '震源情報' })
    for (const order of [[完成, 震源のみ], [震源のみ, 完成]]) {
      const [card] = coalesceByEventId(order)
      expect(card.earthquake.maxScale).toBe(30)
    }
  })
})

describe('区域を持たない電文が先に割り込む場合', () => {
  const 地震の時刻 = '2026-08-23T19:05:00Z'
  const 震度速報 = makeQuake({
    id: 'dmdata-quake-20260824040519-1', type: '震度速報', hypoName: '',
    time: '2026-08-23T19:06:00Z', quakeTime: 地震の時刻, maxScale: 30,
    points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
  })
  const 震源情報 = makeNoIntensity({
    id: 'dmdata-quake-20260824040526-1', type: '震源情報', hypoName: '熊本県天草・芦北地方',
    time: '2026-08-23T19:08:00Z', quakeTime: 地震の時刻,
  })
  // 震源要素更新（VXSE61）も区域を持たない。確定 ID 側のカードだけを更新する。
  const 震源要素更新 = makeNoIntensity({
    id: 'dmdata-quake-20260824040526-9', type: '顕著な地震の震源要素更新のお知らせ',
    hypoName: '天草灘', time: '2026-08-23T19:10:00Z', quakeTime: 地震の時刻,
  })
  const 震源震度情報 = makeQuake({
    id: 'dmdata-quake-20260824040526-2', type: '震源・震度情報', hypoName: '熊本県天草・芦北地方',
    time: '2026-08-23T19:09:00Z', quakeTime: 地震の時刻, maxScale: 30,
    points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
  })

  it('震度を伴う続報が来るまでは 2 枚のまま（区域の裏付けが無いため合流できない）', () => {
    expect(mergeQuakeHistory([震度速報, 震源情報, 震源要素更新])).toHaveLength(2)
  })

  it('震度を伴う続報が届けば 1 枚に収束し、震源要素更新の内容も残る', () => {
    const merged = mergeQuakeHistory([震度速報, 震源情報, 震源震度情報, 震源要素更新])
    expect(merged).toHaveLength(1)
    expect(merged[0].earthquake.hypocenter.name).toBe('天草灘')  // 更新後の震源
    expect(merged[0].earthquake.maxScale).toBe(30)               // 震度は保持
  })
})

// 取消の後に届いた報の扱い（`isRetractedQuakeReport` / `findExistingQuakeCard` / `mergeQuakeHistory`）。
//
// 正常な運用では取消の後に同じ地震の続報は来ない。届いたなら「到着順の入れ替わり」か
// 「同一性の誤認識」のどちらかで、発表時刻で切り分ける（詳細は `isRetractedQuakeReport`）。
describe('取消の後に届いた報', () => {
  const 地震の時刻 = '2026-01-01T07:06:00Z'
  const 震度速報 = makeQuake({
    id: 'dmdata-quake-20260101160610-1', type: '震度速報', hypoName: '',
    time: '2026-01-01T07:07:00Z', quakeTime: 地震の時刻, maxScale: 50,
    points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
  })
  // 取消電文はパーサが地震の時刻・震源名とも空で作る（照合は eventId のみ）。
  const 取消: JMAQuake = {
    ...makeQuake({ id: 'dmdata-quake-20260101160610-2', type: '震度速報', time: '2026-01-01T07:10:00Z' }),
    cancelled: true,
    earthquake: {
      time: '', hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: 0 },
      maxScale: -1, domesticTsunami: '不明',
    },
    points: [],
  }
  // 取消を受けたカード（ライブ経路が作る形）。照合の材料が揃っている。
  const 取消済みカード: JMAQuake = { ...震度速報, cancelledAt: new Date() }
  const retractions = [quakeRetractionOf(取消, 取消済みカード)]

  describe('isRetractedQuakeReport', () => {
    it('正: 取消より前に発表された報は取り下げ済みとみなす', () => {
      const stale = makeQuake({
        id: 'dmdata-quake-20260101160610-3', type: '震度速報', hypoName: '',
        time: '2026-01-01T07:09:00Z', quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      expect(isRetractedQuakeReport(retractions, stale)).toBe(true)
    })

    it('正: 発表時刻が同じ報も取り下げ側へ倒す（分精度では前後を決められない）', () => {
      const tie = makeQuake({
        id: 'dmdata-quake-20260101160610-4', type: '震度速報', hypoName: '',
        time: 取消.time, quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      expect(isRetractedQuakeReport(retractions, tie)).toBe(true)
    })

    it('正: 発表時刻が空の報も取り下げ側へ倒す', () => {
      const noTime = makeQuake({
        id: 'dmdata-quake-20260101160610-5', type: '震度速報', hypoName: '',
        time: '', quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      expect(isRetractedQuakeReport(retractions, noTime)).toBe(true)
    })

    it('対照: 取消より後に発表された報は取り下げ済みとしない（別カードとして立てる）', () => {
      // 種別は取消と同じにして、発表時刻の条件だけを見る。
      const fresh = makeQuake({
        id: 'dmdata-quake-20260101160610-6', type: '震度速報', hypoName: '',
        time: '2026-01-01T07:11:00Z', quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      expect(isRetractedQuakeReport(retractions, fresh)).toBe(false)
    })

    it('対照: 種別が違う報は取り下げの対象にしない（取消の適用側と対称に保つ）', () => {
      // 取消は情報単位で、適用側（`useEarthquakes` の取消分岐）も種別まで見て絞っている。
      // 参照側で広げると、取消と無関係な種別の正常な報が無音で消える。
      const otherType = makeQuake({
        id: 'dmdata-quake-20260101160610-8', type: '震源・震度情報', hypoName: '石川県能登地方',
        time: '2026-01-01T07:09:00Z', quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      expect(isRetractedQuakeReport(retractions, otherType)).toBe(false)
    })

    it('対照: 別イベントの報は取り下げの対象にしない', () => {
      const other = makeQuake({
        id: 'dmdata-quake-20260101161010-1', type: '震度速報', hypoName: '',
        time: '2026-01-01T07:09:00Z', quakeTime: '2026-01-01T07:10:00Z', maxScale: 40,
        points: [{ pref: '', addr: '新潟県上越', isArea: true, scale: 40 }],
      })
      expect(isRetractedQuakeReport(retractions, other)).toBe(false)
    })

    it('安全弁: 記録が空なら何も取り下げない', () => {
      expect(isRetractedQuakeReport([], 震度速報)).toBe(false)
    })
  })

  describe('findExistingQuakeCard', () => {
    it('正: 取消表示中のカードは既存として選ばない（置換で取消が消えるのを防ぐ）', () => {
      const fresh = makeQuake({
        id: 'dmdata-quake-20260101160610-6', type: '震源・震度情報', hypoName: '石川県能登地方',
        time: '2026-01-01T07:11:00Z', quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      expect(findExistingQuakeCard([取消済みカード], fresh)).toBeUndefined()
    })

    it('対照: 取消されていない同一イベントのカードは従来どおり選ぶ', () => {
      const fresh = makeQuake({
        id: 'dmdata-quake-20260101160610-6', type: '震源・震度情報', hypoName: '石川県能登地方',
        time: '2026-01-01T07:11:00Z', quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      expect(findExistingQuakeCard([震度速報], fresh)?.id).toBe(震度速報.id)
    })
  })

  describe('mergeQuakeHistory', () => {
    // **取消と同じ分の報でしかこの経路は通らない。** `mergeQuakeHistory` は `time` 昇順で
    // 畳み込むので、取消より古い報は必ず取消の前に処理され、取消がカードを消して終わる。
    // 取消と同時刻の報だけが「取消を処理した後」に回ってきうる（同時刻の相対順序は入力順）。
    it('正: 取消と同じ分に発表された報が、入力順で取消より後に来ても復活させない', () => {
      const tie = makeQuake({
        id: 'dmdata-quake-20260101160610-3', type: '震度速報', hypoName: '',
        time: 取消.time, quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      // 履歴はカードを消してしまうため、取消を見た事実を別に覚えていないと復活する。
      expect(mergeQuakeHistory([震度速報, 取消, tie])).toHaveLength(0)
    })

    it('対照: 取消より前に発表された報は、時刻順で取消の前に処理されて取消で消える', () => {
      const stale = makeQuake({
        id: 'dmdata-quake-20260101160610-7', type: '震度速報', hypoName: '',
        time: '2026-01-01T07:09:00Z', quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      expect(mergeQuakeHistory([震度速報, stale, 取消])).toHaveLength(0)
    })

    it('対照: 取消より後に発表された報は新しいカードとして残る', () => {
      const fresh = makeQuake({
        id: 'dmdata-quake-20260101160610-6', type: '震源・震度情報', hypoName: '石川県能登地方',
        time: '2026-01-01T07:11:00Z', quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      const merged = mergeQuakeHistory([震度速報, 取消, fresh])
      expect(merged).toHaveLength(1)
      expect(merged[0].earthquake.hypocenter.name).toBe('石川県能登地方')
    })

    it('安全弁: 取消が無ければ従来どおり統合する', () => {
      const fresh = makeQuake({
        id: 'dmdata-quake-20260101160610-6', type: '震源・震度情報', hypoName: '石川県能登地方',
        time: '2026-01-01T07:11:00Z', quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      expect(mergeQuakeHistory([震度速報, fresh])).toHaveLength(1)
    })

    // 「もっと見る」は `base` に画面のカード群を渡すため、取消表示中のカード（10 秒 purge 待ち）が
    // 混ざりうる。ライブ経路と同じ守りが要る。
    it('正: base の取消表示中のカードを置換しない（取消と purge 予約を保つ）', () => {
      const fresh = makeQuake({
        id: 'dmdata-quake-20260101160610-9', type: '震源・震度情報', hypoName: '石川県能登地方',
        time: '2026-01-01T07:11:00Z', quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      const merged = mergeQuakeHistory([fresh], [取消済みカード])
      // 取消済みカードは残り、新しい報は別カードとして立つ。
      expect(merged).toHaveLength(2)
      const kept = merged.find(q => q.cancelledAt)
      expect(kept?.id).toBe(取消済みカード.id)
    })

    it('正: 呼び出し側の台帳に載っている取消でも、取り下げ済みの報を弾く', () => {
      // `base` の取消はこのバッチに含まれないため、台帳を渡さないと照合できない。
      const stale = makeQuake({
        id: 'dmdata-quake-20260101160610-10', type: '震度速報', hypoName: '',
        time: '2026-01-01T07:09:00Z', quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      expect(mergeQuakeHistory([stale], [], retractions)).toHaveLength(0)
    })

    it('対照: 台帳を渡さなければ弾かない（台帳が効いていることの裏返し）', () => {
      const stale = makeQuake({
        id: 'dmdata-quake-20260101160610-10', type: '震度速報', hypoName: '',
        time: '2026-01-01T07:09:00Z', quakeTime: 地震の時刻, maxScale: 50,
        points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
      })
      expect(mergeQuakeHistory([stale])).toHaveLength(1)
    })
  })
})

// 区域名が県名と同じ奈良県は、標準版（P2PQuake）だと `addr === pref` になる。ロールアップ点と
// 同じ形なので、名前だけで除くとこの区域が区域の重なり判定から消え、同じ分に起きた別々の地震を
// 引き離せなくなる。索引を渡せば区域として数えられる（→ docs/spec/quake-spec.md §4）。
describe('区域の重なり判定: 区域名が県名と同じ奈良県', () => {
  const AREA_PREF_INDEX = buildAreaPrefIndex(
    JSON.parse(readFileSync('public/data/station-coords.json', 'utf8')) as StationCoordsData,
  )

  // 標準版は区域の点にも pref を積む。eventId を持たない ID にして区域の重なり判定へ通す。
  const naraOnly = () => makeQuake({
    id: 'p2p-1', type: '震度速報', hypoName: '',
    points: [{ pref: '奈良県', addr: '奈良県', isArea: true, scale: 30 }],
  })
  const osakaOnly = () => makeQuake({
    id: 'p2p-2', type: '震度速報', hypoName: '',
    points: [{ pref: '大阪府', addr: '大阪府南部', isArea: true, scale: 30 }],
  })

  // 正: 索引を渡せば奈良県も区域として数えられるので、重ならない 2 つを別の地震だと言える。
  it('索引を渡せば、奈良県だけの地震と大阪府南部だけの地震を引き離せる', () => {
    expect(sameQuakeEntry(naraOnly(), osakaOnly(), AREA_PREF_INDEX)).toBe(false)
  })

  // 対照: 索引なしでは奈良県の区域点が消えて区域集合が空になり、引き離す材料を失う。
  // これは記録済みの縮退（quakeMerge は座標テーブルを import できないため既定でこちら）。
  it('索引が無いと引き離せない（区域集合が空になり「別の地震」と言えない）', () => {
    expect(sameQuakeEntry(naraOnly(), osakaOnly(), null)).toBe(true)
  })

  // 安全弁: 索引を渡しても、同じ区域なら同一イベントのまま。引き離す方向へ過剰に倒さない。
  it('索引を渡しても、同じ奈良県どうしは同一イベントのまま', () => {
    expect(sameQuakeEntry(naraOnly(), naraOnly(), AREA_PREF_INDEX)).toBe(true)
  })
})

// 長周期地震動の表示は電文の `eventId` で持つのに、選択はカードの `eventKey`。**鍵の体系が
// 違う**ので引き当てが要る。同じ述語を長周期電文の自動表示（`useLiveEventHandler`）と
// カードのバッジ（`App`）の 2 箇所で使うため、ここで固定する。
describe('quakeKeyForLpgmEventId', () => {
  // 正: DMDATA の電文 id から eventId を取り出して引き当てる
  it('同じ eventId を持つカードの選択鍵を返す', () => {
    const target = makeQuake({ eventId: '20260728162718' })
    const other = makeQuake({ eventId: '20260728170000' })
    expect(quakeKeyForLpgmEventId([other, target], '20260728162718')).toBe(quakeEventKey(target))
  })

  // 対照: 引き当てられなければ null（選択を動かさない側へ倒す）
  it('該当するカードが無ければ null', () => {
    expect(quakeKeyForLpgmEventId([makeQuake({ eventId: '20260728162718' })], '20260101160010')).toBeNull()
  })

  it('カードが 1 枚も無ければ null', () => {
    expect(quakeKeyForLpgmEventId([], '20260728162718')).toBeNull()
  })

  // 安全弁: 統合済みカードは `eventKey` を持つので、そちらを返す（電文 id から導いた値ではない）。
  // 続報でレコード id が変わっても選択が同じカードに留まるのはこの鍵のため。
  it('統合済みカードでは、そのカードが持つ eventKey を返す', () => {
    const merged = { ...makeQuake({ eventId: '20260728162718' }), eventKey: 'merged-key' } as JMAQuake
    expect(quakeKeyForLpgmEventId([merged], '20260728162718')).toBe('merged-key')
  })
})

// --- 受け取った電文種別の記録（カードの見出しの材料。→ `QuakeReportRecord`） ---
//
// 能登 2024-01-01 の前震（EventID 20240101160608）の並びを土台にする。DMDATA のアーカイブから
// 生電文を引いて確かめた実際の順序:
//   07:07:40Z VXSE51 震度速報 → 07:08:31Z VXSE52 震源情報 → 07:08:40Z VXSE51 震度速報
//   → 07:10:04Z VXSE53 震源・震度情報（Serial=1）
//   （時刻は `Control/DateTime`＝UTC。JST では 16:07〜16:10 で、2 通目と 3 通目は発表時刻が同じ 16:08）
// VXSE51/52 は `Head/Serial` が空要素なので、通数は受信側で数えるほかない。
describe('受け取った電文種別の記録', () => {
  const NOTO = '20240101160608'
  const 速報1 = () => makePrompt({
    eventId: NOTO, id: `dmdata-quake-${NOTO}-1`,
    telegramKey: '2024-01-01T07:07:40Z', time: '2024-01-01T16:07:00+09:00',
  })
  const 震源情報 = () => makeNoIntensity({
    type: '震源情報', eventId: NOTO, id: `dmdata-quake-${NOTO}-1`,
    telegramKey: '2024-01-01T07:08:31Z', time: '2024-01-01T16:08:00+09:00',
  })
  const 速報2 = () => makePrompt({
    eventId: NOTO, id: `dmdata-quake-${NOTO}-1`,
    telegramKey: '2024-01-01T07:08:40Z', time: '2024-01-01T16:08:00+09:00',
  })
  /** 取りこぼれて遅れて届いた震度速報（内容は据え置かれる）。 */
  const 古い速報 = () => makePrompt({
    eventId: NOTO, id: `dmdata-quake-${NOTO}-1`,
    telegramKey: '2024-01-01T07:06:00Z', time: '2024-01-01T16:06:00+09:00',
  })
  const 震源震度 = (o: { telegramKey?: string; time?: string; reportSerial?: number } = {}) => makeQuake({
    type: '震源・震度情報', eventId: NOTO, id: `dmdata-quake-${NOTO}-1`,
    telegramKey: o.telegramKey ?? '2024-01-01T07:10:04Z',
    time: o.time ?? '2024-01-01T16:10:00+09:00',
    reportSerial: o.reportSerial ?? 1,
  })

  /** 電文を順に流して、カードの見出しに出る文字列を得る。 */
  function headline(...telegrams: JMAQuake[]): string {
    let card: JMAQuake | undefined
    for (const t of telegrams) card = mergeQuakeInto(card, t)
    return reportsText(card!.reports, card!.issue.type)
  }

  // 正: 種別が前後して届いても、受け取った全種別が初出順に並び、2 通目以降に #N が付く。
  it('震度速報 → 震源情報 → 震度速報 の順で受けると「震度速報#2/震源情報」になる', () => {
    expect(headline(速報1(), 震源情報(), 速報2())).toBe('震度速報#2/震源情報')
  })

  // 対照: 同じ電文が二度流れても増えない。「もっと見る」は既存カードへ過去の電文を流し直すため、
  // 重複は現実に起きる（`mergeQuakeHistory` の base 経由）。
  it('同じ電文が二度流れても通数は増えない', () => {
    expect(headline(速報1(), 速報1())).toBe('震度速報')
    expect(headline(速報1(), 震源情報(), 速報2(), 速報2(), 震源情報())).toBe('震度速報#2/震源情報')
  })

  // 安全弁: 記録も変わらないなら「変化なし」を表す同一参照を返す。ここが崩れると、据え置いた
  // はずの電文のたびに state が更新され、再描画が走り続ける。
  //
  // **据え置く経路で確かめる。** incoming の内容を採る経路は記録に関わらず新しいカードを作る
  // ので、そちらは同一参照にならない（この機能を入れる前からそう）。
  it('据え置く電文で記録も変わらないなら、既存カードをそのまま返す', () => {
    const card = mergeQuakeInto(undefined, 速報2())
    const once = mergeQuakeInto(card, 古い速報())
    expect(once).not.toBe(card)   // 対の確認: 記録が増えた回は新しいカードになる
    expect(mergeQuakeInto(once, 古い速報())).toBe(once)
  })

  // 正: 完全版が届いたら速報段階は見出しから落ちる。
  it('震源・震度情報が届いたら、震度速報・震源情報は見出しから落ちる', () => {
    expect(headline(速報1(), 震源情報(), 速報2(), 震源震度())).toBe('震源・震度情報')
  })

  // 正: 電文が報番号を名乗っていればそちらを優先する。途中から受信し始めた端末では受信通数が
  // 気象庁の報番号より少なくなるため、電文の値の方が正しい。
  it('電文の報番号があれば、受信通数ではなくそちらを出す', () => {
    // 第 2 報だけを受け取った端末でも「#2」と出る（受信通数は 1 なので、通数で数えると出ない）。
    expect(headline(震源震度({ reportSerial: 2 }))).toBe('震源・震度情報#2')
    // 逆に、報番号を名乗らない種別は受信通数で数える。
    expect(headline(速報1(), 速報2())).toBe('震度速報#2')
  })

  // 安全弁: 報番号は大きい方を採り、古い報が後から流れても下がらない。
  //
  // **通数と食い違う組で確かめる。** 「第 1 報と第 2 報を受け取る」だと通数も報番号も 2 になり、
  // 報番号を捨てる実装でも同じ答えが出てしまう（それで一度すり抜けた）。
  it('報番号は大きい方を採る（到着順が入れ替わっても下がらない）', () => {
    const 第2報 = 震源震度({ telegramKey: '2024-01-01T07:24:29Z', time: '2024-01-01T16:24:00+09:00', reportSerial: 2 })
    const 第3報 = 震源震度({ telegramKey: '2024-01-01T07:40:00Z', time: '2024-01-01T16:40:00+09:00', reportSerial: 3 })
    // 受け取ったのは 2 通。気象庁が名乗るのは第 3 報。
    expect(headline(第2報, 第3報)).toBe('震源・震度情報#3')
    expect(headline(第3報, 第2報)).toBe('震源・震度情報#3')
  })

  // 正: 顕著な地震の震源要素更新のお知らせは単独で出す（従来の見出しと同じ振る舞い）。
  it('顕著な地震の震源要素更新のお知らせが届いたら、それだけを出す', () => {
    const 更新 = makeNoIntensity({
      type: '顕著な地震の震源要素更新のお知らせ', eventId: NOTO, id: `dmdata-quake-${NOTO}-1`,
      telegramKey: '2024-01-02T00:00:00Z', time: '2024-01-02T09:00:00+09:00',
    })
    expect(headline(速報1(), 震源情報(), 震源震度(), 更新)).toBe('顕著な地震の震源要素更新のお知らせ')
  })

  // 正: 中身が据え置かれる電文でも、受け取った事実は見出しに出る。ここが抜けると、
  // 「震源情報も受け取っている」ことが画面から消えるという、この機能そのものが成り立たない。
  it('発表時刻が古くて内容が据え置かれる電文でも、通数には数える', () => {
    const card = mergeQuakeInto(undefined, 速報2())
    const merged = mergeQuakeInto(card, 古い速報())
    // 中身（発表時刻）は新しい方のまま。
    expect(merged.time).toBe('2024-01-01T16:08:00+09:00')
    // 受け取った事実は残る。
    expect(reportsText(merged.reports, merged.issue.type)).toBe('震度速報#2')
  })

  // 安全弁: 履歴経路（「もっと見る」）でも重複は数えない。
  it('履歴経路で同じ電文が再度流れても通数は増えない', () => {
    const first = mergeQuakeHistory([速報1(), 震源情報(), 速報2()])
    expect(reportsText(first[0].reports, first[0].issue.type)).toBe('震度速報#2/震源情報')
    const again = mergeQuakeHistory([速報1(), 震源情報(), 速報2()], first)
    expect(reportsText(again[0].reports, again[0].issue.type)).toBe('震度速報#2/震源情報')
  })

  // 安全弁: 暫定 ID と確定 ID のカードを畳む経路でも記録が落ちない。合流の向きは決まって
  // いないので、どちらから畳んでも同じ見出しになること。
  it('同じ eventId のカードを畳んでも記録は失われない', () => {
    const a = mergeQuakeInto(undefined, 速報1())
    const b = mergeQuakeInto(undefined, 震源情報())
    expect(reportsText(coalesceByEventId([a, b])[0].reports, '震度速報')).toBe('震度速報/震源情報')
    expect(reportsText(coalesceByEventId([b, a])[0].reports, '震度速報')).toBe('震源情報/震度速報')
  })

  // 安全弁: 記録を持たないカード（統合を通らない生電文・古い履歴）は従来の見出しへ落ちる。
  it('記録を持たないカードは種別 1 つに落ちる', () => {
    expect(reportsText(undefined, '震源・震度情報')).toBe('震源・震度情報')
    expect(reportsText([], '震度速報')).toBe('震度速報')
  })
})

// 取消の台帳は複数の経路から埋まる —— 履歴の途中経過と最後の集約、ライブ受信と履歴の重なり、
// 「もっと見る」での読み直し。**重複を許すと上限が同じ取消だけで埋まり、まだ生きている
// 別の取消の記録を押し出す**（取り下げ済みの地震カードが復活する）。
describe('addQuakeRetraction', () => {
  const retractionOf = (id: string, reportTime: string) =>
    quakeRetractionOf(
      makeQuake({ id, time: reportTime, cancelledAt: new Date(reportTime) }),
      makeQuake({ id, time: reportTime }),
    )

  // 正: 同じ取消を何度足しても 1 件のまま
  it('同じ取消を二度積まない', () => {
    const list: ReturnType<typeof retractionOf>[] = []
    const r = retractionOf('q1', '2026-09-15T10:00:00+09:00')

    addQuakeRetraction(list, r, 20)
    addQuakeRetraction(list, r, 20)
    addQuakeRetraction(list, { ...r }, 20)   // 作り直した同値でも同じ

    expect(list).toHaveLength(1)
  })

  // 対照: 別の取消は別の記録として残す（重複排除が効きすぎて取りこぼさない）
  it('別の取消は別に積む', () => {
    const list: ReturnType<typeof retractionOf>[] = []

    addQuakeRetraction(list, retractionOf('q1', '2026-09-15T10:00:00+09:00'), 20)
    addQuakeRetraction(list, retractionOf('q2', '2026-09-15T10:00:00+09:00'), 20)
    addQuakeRetraction(list, retractionOf('q1', '2026-09-15T11:00:00+09:00'), 20)

    expect(list).toHaveLength(3)
  })

  // 安全弁: **重複で上限を埋めても、先に積んだ別の取消を押し出さない**。
  // これが重複排除の目的そのもの（押し出されると、その取消の対象だった報が後から
  // 届いたときに取り下げ済みだと判定できず、カードが復活する）
  it('重複では上限を消費せず、先の記録を押し出さない', () => {
    const list: ReturnType<typeof retractionOf>[] = []
    const first = retractionOf('first', '2026-09-15T09:00:00+09:00')
    addQuakeRetraction(list, first, 3)

    const dup = retractionOf('dup', '2026-09-15T10:00:00+09:00')
    for (let i = 0; i < 10; i++) addQuakeRetraction(list, dup, 3)

    expect(list).toHaveLength(2)
    expect(list[0].entry.id).toBe('first')
  })

  // 安全弁: 上限そのものは効く（別々の取消が並べば古い方から捨てる）
  it('別々の取消が上限を超えたら古い方から捨てる', () => {
    const list: ReturnType<typeof retractionOf>[] = []
    for (let i = 0; i < 5; i++) {
      addQuakeRetraction(list, retractionOf(`q${i}`, '2026-09-15T10:00:00+09:00'), 3)
    }

    expect(list).toHaveLength(3)
    expect(list[0].entry.id).toBe('q2')   // 古い 2 件が落ちる
  })
})
