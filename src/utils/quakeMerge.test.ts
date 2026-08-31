import { describe, it, expect } from 'vitest'
import {
  mergeQuakeInto,
  mergeQuakeHistory,
  extractQuakeEventId,
  extractQuakeEventIdFromId,
  sameQuakeEntry,
  hasIntensity,
  quakeEventKey,
  coalesceByEventId,
  findExistingQuakeCard,
  sortQuakes,
} from './quakeMerge'
import type { JMAQuake, IssueType, IntensityScale, EarthquakePoint, DomesticTsunami, CorrectType } from '../types/earthquake'

interface QuakeOpts {
  eventId?: string
  id?: string
  type?: IssueType
  maxScale?: IntensityScale
  points?: EarthquakePoint[]
  time?: string          // 電文発表時刻（issue/telegram time）
  quakeTime?: string     // earthquake.time（発生時刻）
  mag?: number
  hypoName?: string
  correct?: CorrectType  // 訂正区分（既定は 'なし'）
  tsunami?: DomesticTsunami
  cancelledAt?: Date
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
// 空・座標を -200（位置不明センチネル）・深さを -1 で埋める。マグニチュードは経路で違い、
// JSON 経路（ライブ）は `NaN`、XML 経路は `0`（`dmdataParser.ts`）。ここでは NaN を採る。
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

  it('dmdata-xml-quake- 形式にも対応する', () => {
    expect(extractQuakeEventId(makeQuake({ id: 'dmdata-xml-quake-20260728162718-3' }))).toBe('20260728162718')
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

  it('dmdata-xml-quake- 形式にも対応する', () => {
    expect(extractQuakeEventIdFromId('dmdata-xml-quake-20260728162718-3')).toBe('20260728162718')
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

  // 気象庁は震源決定前の震度速報を検知時刻で採番し、震源が決まると震源時刻で採り直すため、
  // 同じ地震でも EventID が変わることがある（2026-08-24 04:05 熊本県天草・芦北地方の実例）。
  // 以下 4 件はその救済と、救済のために緩めすぎていないことの対。
  it('震度速報は eventId が食い違っても、発生時刻と区域が重なれば同一イベントとみなす', () => {
    const prompt = makeQuake({
      id: 'dmdata-xml-quake-20260824040519-1', type: '震度速報', hypoName: '',
      points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
    })
    const detail = makeQuake({
      id: 'dmdata-xml-quake-20260824040526-1', type: '震源・震度情報', hypoName: '熊本県天草・芦北地方',
      points: [
        { pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 },
        { pref: '', addr: '熊本県熊本地方', isArea: true, scale: 20 },
      ],
    })
    expect(sameQuakeEntry(prompt, detail)).toBe(true)
  })

  it('震源が判明している電文どうしは、eventId が食い違えば別イベントのままとする', () => {
    const a = makeQuake({ id: 'dmdata-xml-quake-20260824040519-1', hypoName: '熊本県天草・芦北地方' })
    const b = makeQuake({ id: 'dmdata-xml-quake-20260824040526-1', hypoName: '熊本県天草・芦北地方' })
    expect(sameQuakeEntry(a, b)).toBe(false)
  })

  it('震度速報でも、区域が 1 つも重ならなければ別イベントとする', () => {
    const prompt = makeQuake({
      id: 'dmdata-xml-quake-20260824040519-1', type: '震度速報', hypoName: '',
      points: [{ pref: '', addr: '青森県三八上北', isArea: true, scale: 30 }],
    })
    const detail = makeQuake({
      id: 'dmdata-xml-quake-20260824040526-1', type: '震源・震度情報', hypoName: '熊本県天草・芦北地方',
      points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
    })
    expect(sameQuakeEntry(prompt, detail)).toBe(false)
  })

  it('震度速報でも、発生時刻の一致は免除しない', () => {
    const prompt = makeQuake({
      id: 'dmdata-xml-quake-20260824040519-1', type: '震度速報', hypoName: '',
      quakeTime: '2026-08-24T04:05:00Z',
      points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
    })
    const detail = makeQuake({
      id: 'dmdata-xml-quake-20260824040526-1', type: '震源・震度情報', hypoName: '熊本県天草・芦北地方',
      quakeTime: '2026-08-24T05:05:00Z',
      points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
    })
    expect(sameQuakeEntry(prompt, detail)).toBe(false)
  })

  // 取消電文はパーサが種別を問わず震源名を空で作るため、震源未確定と同じ姿になる。
  // 取消は eventId でのみ照合する（内容照合へ落とすと、時刻も空どうしで一致してしまう）。
  // DMDATA の JSON 経路（ライブ）は都道府県のロールアップ点も isArea: true で持つ。
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
      id: 'dmdata-xml-quake-20260815065801-1', type: '震度速報', hypoName: '',
      points: [{ pref: '', addr: '群馬県南部', isArea: true, scale: 30 }],
    })
    const b = makeQuake({
      id: 'dmdata-xml-quake-20260815065812-1', type: '震度速報', hypoName: '',
      points: [{ pref: '', addr: '群馬県南部', isArea: true, scale: 20 }],
    })
    expect(sameQuakeEntry(a, b)).toBe(false)
  })

  // 同じ分に 2 つの地震が起き、片方がまだ震度速報だけのとき。震源情報（VXSE52）は
  // 仕様上 points を持たないため、区域では引き離せない。時刻の一致だけで合流させると
  // 「揺れていない地域の震度が別の震源に貼り付く」カードができる（2026-08-15 の衝突と同型）。
  it('区域を持たない別地震の震源情報は、震度速報のカードに合流しない', () => {
    const prompt = makeQuake({
      id: 'dmdata-xml-quake-20260815065801-1', type: '震度速報', hypoName: '',
      quakeTime: '2026-08-15T06:58:00Z',
      points: [{ pref: '', addr: '群馬県南部', isArea: true, scale: 30 }],
    })
    const other = makeNoIntensity({
      id: 'dmdata-xml-quake-20260815065812-1', type: '震源情報', hypoName: 'インドネシア、フローレス',
      quakeTime: '2026-08-15T06:58:00Z',
    })
    expect(sameQuakeEntry(prompt, other)).toBe(false)
    expect(sameQuakeEntry(other, prompt)).toBe(false)
  })

  it('取消電文は eventId が食い違えば別イベントとする（震源名・発生時刻が空でも合流しない）', () => {
    const card = makeQuake({ id: 'dmdata-xml-quake-20260824040526-1', hypoName: '熊本県天草・芦北地方' })
    const cancel: JMAQuake = {
      ...makeQuake({ id: 'dmdata-xml-quake-20260824040519-2', hypoName: '' }),
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
    expect(sameQuakeEntry(mk('dmdata-xml-quake-20260824040519-2'), mk('dmdata-xml-quake-20260824040526-2'))).toBe(false)
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

  it('P2P 経路の生電文は発生時刻とレコード id から作る', () => {
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
    expect(merged).toEqual({ ...n, eventKey: quakeEventKey(n) })
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
    expect(mergeQuakeInto(e, n)).toBe(e)
  })

  it('低優先度(既存) に 高優先度 が来たら置換する', () => {
    const e = makeQuake({ type: '震度速報', maxScale: 40 })
    const n = makeQuake({ type: '各地の震度情報', maxScale: 70 })
    expect(mergeQuakeInto(e, n)).toEqual({ ...n, eventKey: quakeEventKey(n) })
  })

  it('震度欠落の後続電文は既存の震度で補完される', () => {
    const e = makeQuake({ type: '震度速報', maxScale: 50 })
    const n = makeNoIntensity({ type: '震源・震度情報' })  // 優先度3 > 1・震度欠落
    const merged = mergeQuakeInto(e, n)
    expect(merged.issue.type).toBe('震源・震度情報')  // 種別は新しい方
    expect(merged.earthquake.maxScale).toBe(50)        // 震度は補完
    expect(merged.points.length).toBeGreaterThan(0)
  })

  it('発表時刻が空の続報は据え置く（異常データを安全側＝据え置きに倒す）', () => {
    const e = makeQuake({ type: '震度速報', maxScale: 50, time: '2026-07-28T07:27:30Z' })
    const n = makeQuake({ type: '震度速報', maxScale: 60, time: '' })
    expect(mergeQuakeInto(e, n)).toBe(e)
  })

  it('取消表示中(cancelledAt)のカードは優先度に関わらず通常電文で置換される', () => {
    const e = makeQuake({ type: '各地の震度情報', maxScale: 70, cancelledAt: new Date() })
    const n = makeQuake({ type: '震度速報', maxScale: 40 })
    expect(mergeQuakeInto(e, n)).toEqual({ ...n, eventKey: quakeEventKey(n) })
  })

  it('顕著地震とマージ済みの完成カード（震度あり）は低優先度の後続電文で据え置く', () => {
    // 既存 = 各地の震度→顕著地震でマージ済み（issue.type=顕著・震度7）。優先度5がガードとして働く。
    const e: JMAQuake = {
      ...makeQuake({ type: '各地の震度情報', maxScale: 70 }),
      issue: { source: 'dmdata', time: '2026-07-28T07:35:00Z', type: '顕著な地震の震源要素更新のお知らせ', correct: 'なし' },
    }
    const n = makeQuake({ type: '震度速報', maxScale: 50, time: '2026-07-28T07:40:00Z' })
    expect(mergeQuakeInto(e, n)).toBe(e)
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
      expect(mergeQuakeInto(afterEpicenter, staleReplay)).toBe(afterEpicenter)
    })

    it('安全弁: VXSE61 とマージ済みの完成カードは、発表時刻が新しくても変わらず据え置く', () => {
      // 既存テスト「顕著地震とマージ済みの完成カード」と同じ保護が、時刻ベースへの変更後も
      // 引き続き有効であることの確認（境界を動かす変更が別の保護を緩めていないか）。
      const e: JMAQuake = {
        ...makeQuake({ type: '各地の震度情報', maxScale: 70 }),
        issue: { source: 'dmdata', time: '2026-07-28T07:35:00Z', type: '顕著な地震の震源要素更新のお知らせ', correct: 'なし' },
      }
      const muchNewer = makeQuake({ type: '震度速報', maxScale: 50, time: '2099-01-01T00:00:00Z' })
      expect(mergeQuakeInto(e, muchNewer)).toBe(e)
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

    it('対照: 震度速報が自前で持つ津波区分・固定付加文は既存で塗り替えない', () => {
      // 補完は震源要素だけ。津波区分と固定付加文は震度速報が自前で持つ値（構造的欠落では
      // ない）なので、電文が主張するとおりに採る。ここを補うと、気象庁が出していない
      // 区分を表示し続けることになる。
      const afterEpicenter = mergeQuakeInto(firstPrompt, epicenterOnly)
      expect(afterEpicenter.earthquake.domesticTsunami).toBe('なし')

      const merged = mergeQuakeInto(afterEpicenter, secondPrompt)
      expect(merged.earthquake.domesticTsunami).toBe('調査中')
      expect(merged.forecastText).toBe('今後の情報に注意してください。')
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
  // fetchDmdataEarthquakes が「速報→詳細」の順で結合する前提を、ここで固定する。
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
    // 現状の仕様（意図した動作ではないが既知の限界）。fetchDmdataEarthquakes 側が
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
  // P2PQuake の発生時刻は分単位のため両者の earthquake.time が完全一致し、
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
  const 発生時刻 = '2026-08-23T19:05:00Z'
  // 2026-08-24 04:05 熊本県天草・芦北地方の実系列。震度速報だけ EventID が別採番されている。
  const 震度速報 = makeQuake({
    id: 'dmdata-xml-quake-20260824040519-1', type: '震度速報', hypoName: '',
    time: '2026-08-23T19:06:00Z', quakeTime: 発生時刻, maxScale: 30,
    points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
  })
  const 震源情報 = makeNoIntensity({
    id: 'dmdata-xml-quake-20260824040526-1', type: '震源情報', hypoName: '熊本県天草・芦北地方',
    time: '2026-08-23T19:08:00Z', quakeTime: 発生時刻,
  })
  const 震源震度情報 = makeQuake({
    id: 'dmdata-xml-quake-20260824040526-2', type: '震源・震度情報', hypoName: '熊本県天草・芦北地方',
    time: '2026-08-23T19:09:00Z', quakeTime: 発生時刻, maxScale: 30,
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
    const cancelled = { ...makeQuake({ id: 'dmdata-xml-quake-20260824040526-1' }), cancelledAt: new Date() }
    const normal = makeQuake({ id: 'dmdata-xml-quake-20260824040526-2' })
    expect(coalesceByEventId([cancelled, normal])).toHaveLength(2)
    expect(coalesceByEventId([normal, cancelled])).toHaveLength(2)
  })

  it('eventId が違うカードは畳まない', () => {
    const a = makeQuake({ id: 'dmdata-xml-quake-20260824040519-1' })
    const b = makeQuake({ id: 'dmdata-xml-quake-20260824040526-1' })
    expect(coalesceByEventId([a, b])).toHaveLength(2)
  })

  it('eventId を持たないカード（P2PQuake 経路）は畳まない', () => {
    const a = makeQuake({ id: 'p2p-1' })
    const b = makeQuake({ id: 'p2p-2' })
    expect(coalesceByEventId([a, b])).toHaveLength(2)
  })

  it('畳むときは震度を持つ完成したカードを残す', () => {
    const 完成 = makeQuake({ id: 'dmdata-xml-quake-20260824040526-2', type: '震源・震度情報', maxScale: 30 })
    const 震源のみ = makeNoIntensity({ id: 'dmdata-xml-quake-20260824040526-1', type: '震源情報' })
    const [card] = coalesceByEventId([完成, 震源のみ])
    expect(card.earthquake.maxScale).toBe(30)
    expect(card.issue.type).toBe('震源・震度情報')
  })
})

describe('findExistingQuakeCard — 一致が 2 枚あるときの選び方', () => {
  const 発生時刻 = '2026-08-23T19:05:00Z'
  const 震度速報 = makeQuake({
    id: 'dmdata-xml-quake-20260824040519-1', type: '震度速報', hypoName: '',
    time: '2026-08-23T19:06:00Z', quakeTime: 発生時刻, maxScale: 30,
    points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
  })
  const 震源情報カード = makeNoIntensity({
    id: 'dmdata-xml-quake-20260824040526-1', type: '震源情報', hypoName: '熊本県天草・芦北地方',
    time: '2026-08-23T19:08:00Z', quakeTime: 発生時刻,
  })
  const 震源震度情報 = makeQuake({
    id: 'dmdata-xml-quake-20260824040526-2', type: '震源・震度情報', hypoName: '熊本県天草・芦北地方',
    time: '2026-08-23T19:09:00Z', quakeTime: 発生時刻, maxScale: 30,
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
    const 完成 = makeQuake({ id: 'dmdata-xml-quake-20260824040526-2', type: '震源・震度情報', maxScale: 30 })
    const 震源のみ = makeNoIntensity({ id: 'dmdata-xml-quake-20260824040526-1', type: '震源情報' })
    for (const order of [[完成, 震源のみ], [震源のみ, 完成]]) {
      const [card] = coalesceByEventId(order)
      expect(card.earthquake.maxScale).toBe(30)
    }
  })
})

describe('区域を持たない電文が先に割り込む場合', () => {
  const 発生時刻 = '2026-08-23T19:05:00Z'
  const 震度速報 = makeQuake({
    id: 'dmdata-xml-quake-20260824040519-1', type: '震度速報', hypoName: '',
    time: '2026-08-23T19:06:00Z', quakeTime: 発生時刻, maxScale: 30,
    points: [{ pref: '', addr: '熊本県天草・芦北地方', isArea: true, scale: 30 }],
  })
  const 震源情報 = makeNoIntensity({
    id: 'dmdata-xml-quake-20260824040526-1', type: '震源情報', hypoName: '熊本県天草・芦北地方',
    time: '2026-08-23T19:08:00Z', quakeTime: 発生時刻,
  })
  // 震源要素更新（VXSE61）も区域を持たない。確定 ID 側のカードだけを更新する。
  const 震源要素更新 = makeNoIntensity({
    id: 'dmdata-xml-quake-20260824040526-9', type: '顕著な地震の震源要素更新のお知らせ',
    hypoName: '天草灘', time: '2026-08-23T19:10:00Z', quakeTime: 発生時刻,
  })
  const 震源震度情報 = makeQuake({
    id: 'dmdata-xml-quake-20260824040526-2', type: '震源・震度情報', hypoName: '熊本県天草・芦北地方',
    time: '2026-08-23T19:09:00Z', quakeTime: 発生時刻, maxScale: 30,
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
