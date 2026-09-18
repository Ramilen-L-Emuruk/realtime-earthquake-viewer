import { describe, it, expect } from 'vitest'
import { borrowHypocenterFromTsunami, withBorrowedHypocenter, withBorrowedFromTsunami, borrowDomesticTsunamiFromTsunami, borrowFromTsunamiIntoCards } from './borrowFromTsunami'
import type { JMAQuake, JMATsunami, TsunamiSourceEarthquake } from '../types/earthquake'

// 能登 2024/1/1 の本震（EventID 20240101161010）の実電文に合わせる。
// 震度速報は 16:11〜16:14 に 7 通、津波警報は 16:12 に Ｍ７．４、その続報が 16:22 に Ｍ７．６。
const EVENT_ID = '20240101161010'

/**
 * 実電文どおりの震度速報を作る。**震源要素を持たせないこと** —— 実際の VXSE51 は電文に
 * Earthquake 要素が無く、パーサーは震源名を空・座標を -200（位置不明センチネル）・深さを -1・
 * 規模を NaN で埋める（`quakeMerge.test.ts` の `makePrompt` と同じ形）。
 */
function makePrompt(overrides: Partial<JMAQuake> = {}): JMAQuake {
  return {
    kind: 'quake',
    id: `dmdata-quake-${EVENT_ID}-1`,
    time: '2024-01-01T07:11:00Z',
    issue: { source: 'dmdata', time: '2024-01-01T07:11:00Z', type: '震度速報', correct: 'なし' },
    earthquake: {
      time: '2024-01-01T07:10:00Z',
      hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: NaN },
      maxScale: 60,
      domesticTsunami: '調査中',
    },
    points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 60 }],
    ...overrides,
  }
}

/** 16:12 の津波警報が載せていた原因地震（実電文の値）。 */
function notoSource(overrides: Partial<TsunamiSourceEarthquake> = {}): TsunamiSourceEarthquake {
  return {
    hypocenterName: '石川県能登地方',
    magnitude: 7.4,
    magnitudeType: 'Mj',
    originTime: '2024-01-01T16:10:00+09:00',
    latitude: 37.5,
    longitude: 137.2,
    depth: 0,
    nameFromMark: '輪島の東北東３０ｋｍ付近',
    ...overrides,
  }
}

function makeTsunami(overrides: Partial<JMATsunami> = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: 'dmdata-tsunami-20240101161010-1',
    eventId: EVENT_ID,
    time: '2024-01-01T07:12:00Z',
    cancelled: false,
    infoName: '津波警報・津波注意報・津波予報',
    issue: { source: 'dmdata', time: '2024-01-01T07:12:00Z', type: 'Focus' },
    areas: [],
    sourceEarthquakes: [notoSource()],
    ...overrides,
  }
}

describe('borrowHypocenterFromTsunami', () => {
  // 正: 同じ地震の津波が震源を載せていれば借りる。
  it('eventId が一致する津波から震源・規模・深さを借りる', () => {
    const borrowed = borrowHypocenterFromTsunami(makePrompt(), [makeTsunami()])
    expect(borrowed?.hypocenter.name).toBe('石川県能登地方')
    expect(borrowed?.hypocenter.magnitude).toBe(7.4)
    // **深さ 0 は「ごく浅い」という有効値。** センチネル（-1）へ落とさないこと。
    expect(borrowed?.hypocenter.depth).toBe(0)
    expect(borrowed?.hypocenter.latitude).toBe(37.5)
  })

  it('出どころは等級を名乗らない短い語と、電文の名乗り・発表時刻を持つ', () => {
    const borrowed = borrowHypocenterFromTsunami(makePrompt(), [makeTsunami()])
    // 「津波警報」と書くと大津波警報の地震で一段軽く見える（→ quake-spec §3）。
    expect(borrowed?.source.shortLabel).toBe('津波情報')
    expect(borrowed?.source.shortLabel).not.toContain('警報')
    expect(borrowed?.source.infoName).toBe('津波警報・津波注意報・津波予報')
    expect(borrowed?.source.reportTime).toBe('2024-01-01T07:12:00Z')
  })

  it('津波の続報で震源が更新されたら新しい報の値を借りる', () => {
    // 実電文では 16:22 に Ｍ７．４ → Ｍ７．６（地震情報が同じ更新を伝えるのは 16:24）。
    const first = makeTsunami()
    const later = makeTsunami({
      id: 'dmdata-tsunami-20240101161010-2',
      time: '2024-01-01T07:22:00Z',
      infoName: '津波情報',
      sourceEarthquakes: [notoSource({ magnitude: 7.6 })],
    })
    // 配列の順序に依存しないこと（到着順は保証されない）。
    expect(borrowHypocenterFromTsunami(makePrompt(), [first, later])?.hypocenter.magnitude).toBe(7.6)
    expect(borrowHypocenterFromTsunami(makePrompt(), [later, first])?.hypocenter.magnitude).toBe(7.6)
  })

  // 対照: 結ぶ根拠が無いときは借りない。
  it('eventId が食い違う津波からは借りない', () => {
    // 震度速報の eventId は震源決定前の採番で、確定後の電文と別値になることがある
    // （→ quakeMerge.ts の isHypocenterPending）。区域の重なりという追加の証拠を
    // 津波電文は出せないので、結ばない側へ倒す。
    const other = makeTsunami({ eventId: '20240101161017' })
    expect(borrowHypocenterFromTsunami(makePrompt(), [other])).toBeNull()
  })

  it('eventId を持たない地震電文（P2PQuake 経路）では借りない', () => {
    const p2p = makePrompt({ id: 'p2p-1' })
    expect(borrowHypocenterFromTsunami(p2p, [makeTsunami()])).toBeNull()
  })

  it('震源が既に判っている電文には借りない', () => {
    const withHypo = makePrompt({
      issue: { source: 'dmdata', time: '2024-01-01T07:16:00Z', type: '震源・震度情報', correct: 'なし' },
      earthquake: {
        time: '2024-01-01T07:10:00Z',
        hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 0, magnitude: 7.4 },
        maxScale: 70,
        domesticTsunami: '警報等',
      },
    })
    expect(borrowHypocenterFromTsunami(withHypo, [makeTsunami()])).toBeNull()
  })

  // 安全弁: 取り下げられた内容と、震源を載せていない津波を巻き込まない。
  it('取消された津波からは借りない', () => {
    expect(borrowHypocenterFromTsunami(makePrompt(), [makeTsunami({ cancelled: true })])).toBeNull()
  })

  // 安全弁: 取消の状態更新は**表示中の津波（cancelled: false）を土台に cancelledAt を足す**形なので、
  // `cancelled` だけを見ると、誤報取消を表示している 10 秒のあいだ取り下げられた震源を借りてしまう。
  it('誤報取消を表示している津波からは借りない（cancelled は false のまま）', () => {
    const retracted = makeTsunami({ cancelledAt: new Date('2024-01-01T07:20:00Z'), cancelReason: 'retracted' })
    expect(retracted.cancelled).toBe(false)
    expect(borrowHypocenterFromTsunami(makePrompt(), [retracted])).toBeNull()
  })

  // 対照: 解除・失効は借りてよい。津波が引いても、その地震の震源は有効なまま。
  it('解除・失効した津波からは借りる', () => {
    const lifted = makeTsunami({ cancelledAt: new Date('2024-01-01T08:00:00Z'), cancelReason: 'lifted' })
    expect(borrowHypocenterFromTsunami(makePrompt(), [lifted])?.hypocenter.name).toBe('石川県能登地方')
    const expired = makeTsunami({ cancelledAt: new Date('2024-01-01T08:00:00Z'), cancelReason: 'expired' })
    expect(borrowHypocenterFromTsunami(makePrompt(), [expired])?.hypocenter.name).toBe('石川県能登地方')
  })

  it('原因地震を載せていない津波からは借りない', () => {
    expect(borrowHypocenterFromTsunami(makePrompt(), [makeTsunami({ sourceEarthquakes: undefined })])).toBeNull()
    const nameless = makeTsunami({ sourceEarthquakes: [notoSource({ hypocenterName: '' })] })
    expect(borrowHypocenterFromTsunami(makePrompt(), [nameless])).toBeNull()
  })

  it('取消された地震電文には借りない', () => {
    // 取消はパーサーが種別を問わず震源名を空で作るため、除かないと「震源未確定」として通る。
    const cancelled = makePrompt({ cancelled: true })
    expect(borrowHypocenterFromTsunami(cancelled, [makeTsunami()])).toBeNull()
  })
})

describe('withBorrowedHypocenter', () => {
  it('借りられないときは元の参照をそのまま返す', () => {
    const quake = makePrompt()
    expect(withBorrowedHypocenter(quake, [])).toBe(quake)
  })

  it('借りたときは写しを返し、元を書き換えない', () => {
    const quake = makePrompt()
    const applied = withBorrowedHypocenter(quake, [makeTsunami()])
    expect(applied).not.toBe(quake)
    expect(applied.earthquake.hypocenter.name).toBe('石川県能登地方')
    expect(applied.hypocenterSource?.shortLabel).toBe('津波情報')
    // 元のオブジェクトは震源未確定のまま（不変）。
    expect(quake.earthquake.hypocenter.name).toBe('')
    expect(quake.hypocenterSource).toBeUndefined()
  })

  // 安全弁: 津波の続報は 1 つの津波で 40 通を超える（能登の実電文）。震源を変えない続報で
  // 毎回新しいカードを作ると、地震一覧全体が無駄に描き直される。
  it('震源が変わらない続報では、元の参照をそのまま返す', () => {
    const borrowedCard = withBorrowedHypocenter(makePrompt(), [makeTsunami()])
    // 同じ震源を載せた別の報（観測情報の続報など）。
    const later = makeTsunami({
      id: 'dmdata-tsunami-20240101161010-2',
      time: '2024-01-01T07:25:00Z',
      infoName: '津波情報',
    })
    expect(withBorrowedHypocenter(borrowedCard, [later])).toBe(borrowedCard)
  })

  it('震源が変わらない続報では、出どころの発表時刻も進めない', () => {
    // 進めると、値が変わっていないのに「この時刻に震源が更新された」ように読める。
    const borrowedCard = withBorrowedHypocenter(makePrompt(), [makeTsunami()])
    const later = makeTsunami({ time: '2024-01-01T07:25:00Z', infoName: '津波情報' })
    expect(withBorrowedHypocenter(borrowedCard, [later]).hypocenterSource?.reportTime)
      .toBe('2024-01-01T07:12:00Z')
    expect(withBorrowedHypocenter(borrowedCard, [later]).hypocenterSource?.infoName)
      .toBe('津波警報・津波注意報・津波予報')
  })

  it('借りていないカードには出どころを持たせない', () => {
    // 画面はこの有無で注記を出し分ける。常に埋めると自前の震源にまで注記が付く。
    const quake = makePrompt()
    expect(withBorrowedHypocenter(quake, [makeTsunami({ eventId: 'x' })]).hypocenterSource).toBeUndefined()
  })

  it('津波が先に届いた順序でも、あとから来た地震電文が震源を借りられる', () => {
    // 受信側（useEarthquakes の 'quake'）が通る経路。津波が state に居る状態で震度速報が届く。
    const applied = withBorrowedHypocenter(makePrompt(), [makeTsunami()])
    expect(applied.earthquake.hypocenter.name).toBe('石川県能登地方')
  })

  // 正: 借りた震源は津波の続報に追随する。実電文では 16:22 に Ｍ７．４→Ｍ７．６と上がり、
  // 地震情報の同じ更新は 16:24 で 2 分遅い。借りた時点で固まると、その 2 分が古い値になる。
  it('借りた震源は、津波の続報で更新される', () => {
    const borrowedCard = withBorrowedHypocenter(makePrompt(), [makeTsunami()])
    expect(borrowedCard.earthquake.hypocenter.magnitude).toBe(7.4)
    const later = makeTsunami({
      time: '2024-01-01T07:22:00Z',
      infoName: '津波情報',
      sourceEarthquakes: [notoSource({ magnitude: 7.6 })],
    })
    const updated = withBorrowedHypocenter(borrowedCard, [later])
    expect(updated.earthquake.hypocenter.magnitude).toBe(7.6)
    expect(updated.hypocenterSource?.infoName).toBe('津波情報')
  })

  // 安全弁: 借り手が居なくなっても、前に借りた震源と印は保つ。落とすと震源だけが残って
  // 出どころが消え、借り物が自前の震源のように見える。
  it('津波が取り消されても、前に借りた震源と出どころは残す', () => {
    const borrowedCard = withBorrowedHypocenter(makePrompt(), [makeTsunami()])
    const kept = withBorrowedHypocenter(borrowedCard, [makeTsunami({ cancelled: true })])
    expect(kept).toBe(borrowedCard)
    expect(kept.earthquake.hypocenter.name).toBe('石川県能登地方')
    expect(kept.hypocenterSource?.shortLabel).toBe('津波情報')
  })

  // 対照: 自前の震源を持つカード（印が無い）は、津波があっても触らない。
  it('印を持たないカードは、震源があれば津波で上書きしない', () => {
    const own: JMAQuake = {
      ...makePrompt(),
      issue: { source: 'dmdata', time: '2024-01-01T07:16:00Z', type: '震源・震度情報', correct: 'なし' },
      earthquake: {
        ...makePrompt().earthquake,
        hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 16, magnitude: 7.6 },
      },
    }
    const next = withBorrowedHypocenter(own, [makeTsunami()])
    expect(next).toBe(own)
    expect(next.earthquake.hypocenter.depth).toBe(16)
    expect(next.earthquake.hypocenter.magnitude).toBe(7.6)
  })
})

describe('borrowFromTsunamiIntoCards', () => {
  // 正: 津波が先に届いた順序を拾う。
  it('津波を受け取ったとき、震源が未確定のカードへ配る', () => {
    const cards = [makePrompt()]
    const next = borrowFromTsunamiIntoCards(cards, [makeTsunami()])
    expect(next[0].earthquake.hypocenter.name).toBe('石川県能登地方')
    expect(next[0].hypocenterSource?.shortLabel).toBe('津波情報')
  })

  // 対照: 取り下げられた内容へは書き込まない。
  it('取消表示中のカードには配らない', () => {
    const cancelled = makePrompt({ cancelledAt: new Date('2024-01-01T07:13:00Z') })
    const next = borrowFromTsunamiIntoCards([cancelled], [makeTsunami()])
    expect(next[0]).toBe(cancelled)
    expect(next[0].earthquake.hypocenter.name).toBe('')
  })

  it('別の地震のカードには配らない', () => {
    const other = makePrompt({ id: 'dmdata-quake-20240101160608-1' })
    const next = borrowFromTsunamiIntoCards([other], [makeTsunami()])
    expect(next[0].earthquake.hypocenter.name).toBe('')
  })

  // 安全弁: 変化が無ければ参照を保つ（無駄な再レンダーを起こさない）。
  it('1 枚も変わらなければ元の配列参照を返す', () => {
    const cards = [makePrompt({ id: 'dmdata-quake-20240101160608-1' })]
    expect(borrowFromTsunamiIntoCards(cards, [makeTsunami()])).toBe(cards)
    expect(borrowFromTsunamiIntoCards(cards, [])).toBe(cards)
  })
})

// 津波区分（`domesticTsunami`）を等級から借りる。**震源とは借りる条件も選ぶ報も違う**ので、
// 別の describe で固定する。
describe('borrowDomesticTsunamiFromTsunami', () => {
  /** 等級を持つ津波（実電文の 16:12 は大津波警報 1 区域・津波警報 2 区域）。 */
  const withGrade = (grade: JMATsunami['areas'][number]['grade'], extra: Partial<JMATsunami> = {}) =>
    makeTsunami({ areas: [{ grade, immediate: true, name: '石川県能登' }], ...extra })

  // 正: 「調査中」のカードへ、警報級の等級から `警報等` を借りる。
  it('警報級の津波があれば「警報等」を借りる', () => {
    for (const grade of ['MajorWarning', 'Warning', 'Watch'] as const) {
      const borrowed = borrowDomesticTsunamiFromTsunami(makePrompt(), [withGrade(grade)])
      expect(borrowed?.domesticTsunami).toBe('警報等')
    }
  })

  it('出どころは震源と同じ形（等級を名乗らない短い語・電文の名乗り・発表時刻）', () => {
    const borrowed = borrowDomesticTsunamiFromTsunami(makePrompt(), [withGrade('MajorWarning')])
    expect(borrowed?.source.shortLabel).toBe('津波情報')
    expect(borrowed?.source.shortLabel).not.toContain('警報')
    expect(borrowed?.source.reportTime).toBe('2024-01-01T07:12:00Z')
  })

  // 対照: 気象庁が判断を示した値は上書きしない。
  it('「なし」など判断が入っているカードには借りない', () => {
    for (const t of ['なし', '若干の海面変動', '海面変動の可能性', '注意報', '警報等'] as const) {
      const quake = makePrompt({ earthquake: { ...makePrompt().earthquake, domesticTsunami: t } })
      expect(borrowDomesticTsunamiFromTsunami(quake, [withGrade('MajorWarning')])).toBeNull()
    }
  })

  // 対照: 津波予報だけの津波からは借りない（定型文が 3 通りに分かれ、等級から決まらない）。
  it('津波予報・等級不明の津波からは借りない', () => {
    expect(borrowDomesticTsunamiFromTsunami(makePrompt(), [withGrade('Forecast')])).toBeNull()
    expect(borrowDomesticTsunamiFromTsunami(makePrompt(), [withGrade('Unknown')])).toBeNull()
    // 区域を 1 つも持たない報（観測情報だけの続報）も等級を伝えていないので借りない。
    expect(borrowDomesticTsunamiFromTsunami(makePrompt(), [makeTsunami()])).toBeNull()
  })

  // 安全弁: 取消された津波からは借りない（震源側と同じ規律）。
  it('取消・誤報取消の津波からは借りない', () => {
    expect(borrowDomesticTsunamiFromTsunami(makePrompt(), [withGrade('MajorWarning', { cancelled: true })])).toBeNull()
    expect(borrowDomesticTsunamiFromTsunami(makePrompt(), [withGrade('MajorWarning', { cancelReason: 'retracted' })])).toBeNull()
  })

  // 安全弁: 別の地震の津波は根拠にしない。
  it('eventId が違う津波からは借りない', () => {
    expect(borrowDomesticTsunamiFromTsunami(makePrompt(), [withGrade('MajorWarning', { eventId: 'x' })])).toBeNull()
  })
})

describe('withBorrowedFromTsunami', () => {
  const warned = makeTsunami({ areas: [{ grade: 'MajorWarning', immediate: true, name: '石川県能登' }] })

  // 正: 震源と津波区分を同時に借りる（実電文はどちらも 16:12 の 1 通が運んでくる）。
  it('震源と津波区分を両方借り、印もそれぞれ持つ', () => {
    const applied = withBorrowedFromTsunami(makePrompt(), [warned])
    expect(applied.earthquake.hypocenter.name).toBe('石川県能登地方')
    expect(applied.earthquake.domesticTsunami).toBe('警報等')
    expect(applied.hypocenterSource?.shortLabel).toBe('津波情報')
    expect(applied.domesticTsunamiSource?.shortLabel).toBe('津波情報')
  })

  // 対照: 読み上げ用の関数は区分を借りない（同じ津波の読み上げが等級を語るので二重になる）。
  it('読み上げ用（withBorrowedHypocenter）は津波区分を借りない', () => {
    const applied = withBorrowedHypocenter(makePrompt(), [warned])
    expect(applied.earthquake.hypocenter.name).toBe('石川県能登地方')
    expect(applied.earthquake.domesticTsunami).toBe('調査中')
    expect(applied.domesticTsunamiSource).toBeUndefined()
  })

  // 安全弁: 中身が変わらなければ参照を保つ（観測情報の続報のたびに一覧を描き直さない）。
  it('同じ内容の続報では元の参照を返す', () => {
    const borrowedCard = withBorrowedFromTsunami(makePrompt(), [warned])
    const later = makeTsunami({
      id: 'dmdata-tsunami-20240101161010-2',
      time: '2024-01-01T07:22:00Z',
      areas: [{ grade: 'MajorWarning', immediate: true, name: '石川県能登' }],
    })
    expect(withBorrowedFromTsunami(borrowedCard, [later])).toBe(borrowedCard)
  })
})
