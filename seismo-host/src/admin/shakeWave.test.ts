import { describe, expect, it } from 'vitest'

import { QUAKE_OFF_TEXT, quakeFailedDaysText, type QuakeMarkView, type QuakesView } from './recordsMarks'
import {
  detailMarkers,
  detailNote,
  detailTicks,
  detailWindow,
  DETAIL_MAX_MS,
  findMatchedQuake,
  JMA_ARRIVAL_LEGEND,
  JMA_ARRIVAL_NOT_FOUND_TEXT,
  JMA_ARRIVAL_UNLOCATED_TEXT,
  jmaArrivalMarks,
  jmaArrivalNote,
  readEnvelope,
  recordsSelectionFor,
  wavesUrl,
} from './shakeWave'

const T0 = Date.UTC(2026, 9, 6, 4, 26, 4)

describe('detailWindow — 描く範囲', () => {
  it('正: 気象庁 P が始まりの 10 秒前より前なら、左端をその P の 5 秒前まで広げる', () => {
    const p = { fromMs: T0 - 20_000, toMs: T0 - 20_000 }
    expect(detailWindow({ startMs: T0, endMs: T0 + 12_000 }, { p }).fromMs).toBe(T0 - 25_000)
  })

  it('対照: 気象庁 P が 10 秒前より後なら、これまでどおり 10 秒前から（右へは縮めない）', () => {
    const p = { fromMs: T0 - 2_000, toMs: T0 - 2_000 }
    expect(detailWindow({ startMs: T0, endMs: T0 + 12_000 }, { p }).fromMs).toBe(T0 - 10_000)
    expect(detailWindow({ startMs: T0, endMs: T0 + 12_000 }, { p: null }).fromMs).toBe(T0 - 10_000)
  })

  it('安全弁: 広げるのは始まりの 60 秒前まで', () => {
    const p = { fromMs: T0 - 300_000, toMs: T0 - 240_000 }
    const w = detailWindow({ startMs: T0, endMs: T0 + 12_000 }, { p })
    expect(w.fromMs).toBe(T0 - 60_000)
    expect(w.toMs).toBe(T0 + 32_000)
  })

  it('安全弁: 広げても、終わりの 20 秒後は 10 分の上限で削らない（削るのは広げる幅のほう）', () => {
    // 揺れが 9 分 20 秒。終わりの 20 秒後から 10 分さかのぼると始まりの 20 秒前で、そこより左へは広げない。
    const r = { startMs: T0, endMs: T0 + 560_000 }
    const p = { fromMs: T0 - 50_000, toMs: T0 - 50_000 }
    expect(detailWindow(r, { p })).toEqual({ fromMs: T0 - 20_000, toMs: T0 + 580_000 })
  })

  it('対照: 10 分を超える揺れでは広げず、これまでどおり始まりの 10 秒前から 10 分', () => {
    const p = { fromMs: T0 - 50_000, toMs: T0 - 50_000 }
    expect(detailWindow({ startMs: T0, endMs: T0 + 30 * 60_000 }, { p })).toEqual({ fromMs: T0 - 10_000, toMs: T0 - 10_000 + DETAIL_MAX_MS })
  })

  it('正: 始まりの 10 秒前から、終わりの 20 秒後まで', () => {
    expect(detailWindow({ startMs: T0, endMs: T0 + 12_000 })).toEqual({ fromMs: T0 - 10_000, toMs: T0 + 32_000 })
  })

  it('安全弁: 長い揺れでも 10 分を超えない（/waves の上限）', () => {
    const w = detailWindow({ startMs: T0, endMs: T0 + 30 * 60_000 })
    expect(w.toMs - w.fromMs).toBe(DETAIL_MAX_MS)
    expect(DETAIL_MAX_MS).toBe(10 * 60_000)
  })

  it('安全弁: 端が整数でなくても、整数のミリ秒にしてから上限で切る（問い合わせで幅が上限を越えない）', () => {
    const w = detailWindow({ startMs: T0 + 0.4, endMs: T0 + 30 * 60_000 + 0.7 })
    expect(Number.isInteger(w.fromMs) && Number.isInteger(w.toMs)).toBe(true)
    expect(w.toMs - w.fromMs).toBeLessThanOrEqual(DETAIL_MAX_MS)
  })
})

describe('wavesUrl', () => {
  it('観測点・範囲・列の数を問い合わせに載せる（観測点の ID はエスケープする）', () => {
    expect(wavesUrl('station 1/a', 1000, 2000, 600)).toBe('/waves?station=station+1%2Fa&from=1000&to=2000&columns=600')
  })

  it('安全弁: 範囲は整数のミリ秒で渡す（小数はホストが bad-range で弾く）', () => {
    expect(wavesUrl('s', 1000.4, 2000.6, 10.2)).toBe('/waves?station=s&from=1000&to=2001&columns=10')
  })
})

function envelopeJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stationId: 's',
    stationKnown: true,
    fromMs: T0,
    toMs: T0 + 3000,
    filesRead: 1,
    filesMissing: 0,
    filesFailed: 0,
    skippedBytes: 0,
    truncated: false,
    columnSpanMs: 1000,
    columns: [{ min: [-1, -2, -3], max: [1, 2, 3], minMembers: 3 }, null, { min: [0, 0, 0], max: [0.5, 0.5, 0.5], minMembers: 2 }],
    hasAnyValue: true,
    peakGal: 3,
    ...overrides,
  }
}

describe('readEnvelope — 列ごとにまとめた波形を読む', () => {
  it('正: 列と欠けた列（null）をそのまま読む', () => {
    const e = readEnvelope(envelopeJson())
    expect(e?.columns).toHaveLength(3)
    expect(e?.columns[1]).toBeNull()
    expect(e?.columns[0]).toEqual({ min: [-1, -2, -3], max: [1, 2, 3] })
    expect(e?.partial).toBe(false)
  })

  it('正: 読めなかったファイル・打ち切り・途中で読まなかったバイトがあれば一部欠け', () => {
    expect(readEnvelope(envelopeJson({ filesFailed: 1 }))?.partial).toBe(true)
    expect(readEnvelope(envelopeJson({ skippedBytes: 12 }))?.partial).toBe(true)
    expect(readEnvelope(envelopeJson({ truncated: true }))?.partial).toBe(true)
  })

  it('対照: ファイルが無かっただけ（記録していない時）は一部欠けと言わない', () => {
    expect(readEnvelope(envelopeJson({ filesMissing: 1 }))?.partial).toBe(false)
  })

  it('安全弁: 読めなかった量の欄が無ければ応答ごと読めない（0 と見なして「全部読めた」にしない）', () => {
    const { filesFailed: _a, ...noFailed } = envelopeJson()
    const { truncated: _b, ...noTruncated } = envelopeJson()
    expect(readEnvelope(noFailed)).toBeNull()
    expect(readEnvelope(noTruncated)).toBeNull()
  })

  it('正（2026-10-09）: 列の中で 1 成分だけ欠けていれば（null）、その成分だけ NaN にして読む', () => {
    const e = readEnvelope(envelopeJson({ columns: [{ min: [-1, -2, null], max: [1, 2, null], minMembers: 2 }] }))
    expect(e?.columns[0]?.min[0]).toBe(-1)
    expect(e?.columns[0]?.min[2]).toBeNaN()
  })

  it('安全弁: 列の形が違えば応答ごと読めない（欠けた列と取り違えない）', () => {
    expect(readEnvelope(envelopeJson({ columns: [{ min: [1, 2], max: [1, 2, 3] }] }))).toBeNull()
    expect(readEnvelope(envelopeJson({ columns: 'x' }))).toBeNull()
    expect(readEnvelope(envelopeJson({ columnSpanMs: 0 }))).toBeNull()
  })
})

describe('detailNote', () => {
  it('値を持つ列が 1 つも無ければ「この区間の波形は残っていない」', () => {
    expect(detailNote(readEnvelope(envelopeJson({ hasAnyValue: false, columns: [null, null] }))!)).toBe(
      'この区間の波形は残っていない',
    )
  })

  it('一部だけ読めなかったら「読めなかった部分がある」', () => {
    expect(detailNote(readEnvelope(envelopeJson({ filesFailed: 1 }))!)).toBe('読めなかった部分がある')
  })

  it('対照: 全部読めていれば何も言わない', () => {
    expect(detailNote(readEnvelope(envelopeJson())!)).toBeNull()
  })
})

describe('detailTicks — 横軸の目盛り（始まりからの秒）', () => {
  it('正: 始まりを 0 として秒で刻む（前は −）', () => {
    const ticks = detailTicks(T0 - 10_000, T0 + 32_000, T0, 6)
    expect(ticks.map((t) => t.label)).toEqual(['-10s', '0s', '+10s', '+20s', '+30s'])
    expect(ticks[1].atMs).toBe(T0)
  })

  it('対照: 始まりが秒の途中でも、始まりからの切りのいい秒に置く（時計の秒には揃えない）', () => {
    const start = T0 + 300
    const ticks = detailTicks(start - 10_000, start + 20_000, start, 4)
    expect(ticks.every((t) => (t.atMs - start) % 10_000 === 0)).toBe(true)
  })
})

describe('detailMarkers — 縦に引く線', () => {
  const win = { fromMs: T0 - 10_000, toMs: T0 + 32_000 }

  it('正: 始まり・終わり・拾った S・P を引く（気象庁の P・S と並ぶので「拾った」を名乗る）', () => {
    const m = detailMarkers({ startMs: T0, endMs: T0 + 12_000, sMs: T0 + 3_000, pMs: T0 + 500 }, win)
    expect(m.map((x) => x.label)).toEqual(['始まり', '終わり', '拾った S', '拾った P'])
  })

  it('対照: 拾えなかった S・P は引かない', () => {
    const m = detailMarkers({ startMs: T0, endMs: T0 + 12_000, sMs: null, pMs: null }, win)
    expect(m.map((x) => x.label)).toEqual(['始まり', '終わり'])
  })

  it('安全弁: 範囲の外の線は引かない（10 分で切った長い揺れの終わり）', () => {
    const m = detailMarkers({ startMs: T0, endMs: T0 + 3_600_000, sMs: null, pMs: null }, win)
    expect(m.map((x) => x.label)).toEqual(['始まり'])
  })
})

/** 地震一覧の 1 件（`/api/records/quakes` の形）。値は架空。 */
function quake(overrides: Partial<QuakeMarkView> = {}): QuakeMarkView {
  return {
    name: '千葉県北西部',
    originMs: T0 - 15_000,
    originPrecisionMs: 100,
    magnitude: 4.2,
    maxScale: 30,
    distanceKm: 60,
    p: { fromMs: T0 - 5_000, toMs: T0 - 5_000 },
    s: { fromMs: T0 + 2_000, toMs: T0 + 2_000 },
    ...overrides,
  }
}

describe('findMatchedQuake — 照合した地震を地震一覧から引き当てる', () => {
  // 照合したときの発生時刻は地震情報のまま（分の頭・幅 60 秒）。一覧は震源リストで秒まで寄せてある。
  const minuteHead = T0 - 64_000
  const matched = { name: '千葉県北西部', originMs: minuteHead, originPrecisionMs: 60_000 }

  it('正: 名前が同じで、照合したときの分の幅に入る地震を引く', () => {
    const q = quake()
    expect(findMatchedQuake([q], matched)).toBe(q)
  })

  it('正: 候補が複数あれば、分の幅までの隔たりが小さいほう', () => {
    const near = quake({ originMs: minuteHead + 10_000 })
    const far = quake({ originMs: minuteHead + 110_000 })
    expect(findMatchedQuake([far, near], matched)).toBe(near)
  })

  it('正: 幅の中にあるものを、幅の外で分の頭に近いものより先に選ぶ（群発で同じ名前が続くとき）', () => {
    const before = quake({ originMs: minuteHead - 10_000 })
    const inside = quake({ originMs: minuteHead + 50_000 })
    expect(findMatchedQuake([before, inside], matched)).toBe(inside)
  })

  it('対照: 名前が違えば引かない', () => {
    expect(findMatchedQuake([quake({ name: '茨城県南部' })], matched)).toBeNull()
  })

  it('対照: 分の幅（＋前後 60 秒）の外なら引かない', () => {
    expect(findMatchedQuake([quake({ originMs: minuteHead + 60_000 + 60_001 })], matched)).toBeNull()
    expect(findMatchedQuake([quake({ originMs: minuteHead - 60_001 })], matched)).toBeNull()
  })

  it('安全弁: 照合したときの発生時刻を持たない記録は、名前の合うものがちょうど 1 つのときだけ', () => {
    const ref = { name: '千葉県北西部', originMs: null, originPrecisionMs: null }
    const q = quake()
    expect(findMatchedQuake([q], ref)).toBe(q)
    expect(findMatchedQuake([q, quake({ originMs: T0 + 600_000 })], ref)).toBeNull()
  })
})

describe('jmaArrivalMarks — 気象庁の P・S を詳細の印へ', () => {
  const win = { fromMs: T0 - 10_000, toMs: T0 + 32_000 }

  it('正: 秒まで分かれば線（幅 0）、名前は「気象庁 P」「気象庁 S」', () => {
    expect(jmaArrivalMarks(quake(), win)).toEqual([
      { phase: 'P', label: '気象庁 P', fromMs: T0 - 5_000, toMs: T0 - 5_000 },
      { phase: 'S', label: '気象庁 S', fromMs: T0 + 2_000, toMs: T0 + 2_000 },
    ])
  })

  it('正: 発生時刻が分までなら帯（幅のまま）', () => {
    const q = quake({ p: { fromMs: T0 - 30_000, toMs: T0 + 30_000 }, s: null })
    expect(jmaArrivalMarks(q, win)).toEqual([{ phase: 'P', label: '気象庁 P', fromMs: T0 - 30_000, toMs: T0 + 30_000 }])
  })

  it('境: 幅が 1 秒ちょうどまでは線として扱い、中点に置く（波形の記録の arrivalMark と同じ境）', () => {
    const q = quake({ p: { fromMs: T0, toMs: T0 + 1000 }, s: null })
    expect(jmaArrivalMarks(q, win)).toEqual([{ phase: 'P', label: '気象庁 P', fromMs: T0 + 500, toMs: T0 + 500 }])
  })

  it('対照: 範囲と重ならない印は出さない', () => {
    const q = quake({ p: { fromMs: T0 - 60_000, toMs: T0 - 60_000 }, s: { fromMs: T0 + 90_000, toMs: T0 + 90_000 } })
    expect(jmaArrivalMarks(q, win)).toEqual([])
  })
})

describe('jmaArrivalNote — 詳細に添える一行', () => {
  const list = (o: Partial<QuakesView> = {}): QuakesView => ({
    off: false,
    located: true,
    quakes: [],
    failedDays: [],
    problem: null,
    refineFailedDays: { hypocenter: [], eew: [] },
    ...o,
  })

  it('正: 引けたら凡例', () => {
    expect(jmaArrivalNote(list(), quake())).toBe(JMA_ARRIVAL_LEGEND)
  })

  it('正: 見つからず、一覧を取得できなかった日があれば、その日を出す（「見つからない」と言い切らない）', () => {
    const failed = list({ failedDays: ['2026-10-03'], problem: 'P2PQuake: HTTP 503' })
    expect(jmaArrivalNote(failed, null)).toBe(quakeFailedDaysText(['2026-10-03'], 'P2PQuake: HTTP 503'))
  })

  it('対照: 取得できなかった日があっても、見つかれば凡例', () => {
    expect(jmaArrivalNote(list({ failedDays: ['2026-10-03'] }), quake())).toBe(JMA_ARRIVAL_LEGEND)
  })

  it('対照: 見つからない・位置が分からない・取らない設定は、それぞれの文', () => {
    expect(jmaArrivalNote(list(), null)).toBe(JMA_ARRIVAL_NOT_FOUND_TEXT)
    expect(jmaArrivalNote(list({ located: false }), null)).toBe(JMA_ARRIVAL_UNLOCATED_TEXT)
    expect(jmaArrivalNote(list({ off: true }), null)).toBe(QUAKE_OFF_TEXT)
  })
})

describe('recordsSelectionFor — 波形の記録を同じ区間で開く', () => {
  it('正: 札・観測点 ID と、整数のミリ秒にした範囲', () => {
    const record = { stationId: 'station-1', stationKey: 'station-1-0123456789ab' }
    expect(recordsSelectionFor(record, { fromMs: T0 - 10_000.4, toMs: T0 + 32_000.6 })).toEqual({
      from: String(T0 - 10_000),
      station: 'station-1',
      stationKey: 'station-1-0123456789ab',
      to: String(T0 + 32_001),
    })
  })
})
