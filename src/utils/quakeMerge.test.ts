import { describe, it, expect } from 'vitest'
import {
  mergeQuakeInto,
  mergeQuakeHistory,
  extractQuakeEventId,
  extractQuakeEventIdFromId,
  sameQuakeEntry,
  hasIntensity,
  quakeEventKey,
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
})

describe('mergeQuakeInto — 顕著地震カードが先にある場合（本バグの核心）', () => {
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
  it('各地の震度(既存) に 震度速報 が来たら据え置く（戻り値は既存と同一参照）', () => {
    const e = makeQuake({ type: '各地の震度情報', maxScale: 70 })
    const n = makeQuake({ type: '震度速報', maxScale: 50 })
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
