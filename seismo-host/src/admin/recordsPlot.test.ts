import { describe, expect, it } from 'vitest'

import {
  MIN_SPAN_MS,
  RANGE_MAX_MS,
  SAMPLES_RANGE_MAX_MS,
  centerAt,
  clampRange,
  compositeRuns,
  durationLabel,
  fullSpanMs,
  groupChannels,
  intensityHeader,
  overviewRange,
  overviewSpread,
  peakLabel,
  periodText,
  pixelPlan,
  planFetch,
  problemsNote,
  readChannelList,
  readEnvelopeData,
  readIntensityData,
  readSamplesData,
  readoutText,
  recordTicks,
  recordsUrl,
  scaleLabel,
  shiftBy,
  sourceNote,
  traceCenter,
  traceGaps,
  tracePeak,
  traceValueAt,
  withSpan,
  zoomAt,
  type AxisTrace,
  type EnvelopeData,
  type RecordChannelView,
} from './recordsPlot'

const HOUR = 3_600_000
const DAY = 24 * HOUR
// **時刻は地域の時刻で組む**（目盛りや文言は地域の時刻で出すので、テストを走らせる端末の地域に依らないように）。
const H0 = new Date(2026, 9, 7, 12, 0, 0, 0).getTime()

function ch(p: Partial<RecordChannelView> & Pick<RecordChannelView, 'id' | 'kind'>): RecordChannelView {
  return { firstHourMs: H0, lastHourMs: H0, hours: 1, sensor: null, board: null, station: null, ...p }
}

describe('groupChannels', () => {
  it('合成波形は札ごと・生データはセンサーごとに 3 軸を束ね、合成波形を先に並べる', () => {
    const groups = groupChannels([
      ch({ id: 'FDSN:XX_A1_S1_H_N_2', kind: 'raw', sensor: 'FDSN:XX_A1_S1', hours: 3 }),
      ch({ id: 'FDSN:XX_A1_S1_H_N_1', kind: 'raw', sensor: 'FDSN:XX_A1_S1', hours: 2 }),
      ch({ id: 'station/home/Z', kind: 'station', station: { stationId: 'home', displayName: '自宅' } }),
      ch({ id: 'station/home/X', kind: 'station', station: { stationId: 'home', displayName: '自宅' }, firstHourMs: H0 - HOUR }),
      ch({ id: 'station/old/X', kind: 'station' }),
    ])
    expect(groups.map((g) => g.label)).toEqual(['外した観測点（札 old）', '自宅', '割り当ての無いセンサー（FDSN:XX_A1_S1）'])
    const home = groups[1]!
    expect(home.axes.map((a) => a.label)).toEqual(['X 軸（東が ＋）', 'Z 軸（上が ＋）'])
    expect(home.stationKey).toBe('home')
    expect(home.firstHourMs).toBe(H0 - HOUR)
    const raw = groups[2]!
    expect(raw.axes.map((a) => [a.short, a.label])).toEqual([
      ['1', '1 軸（センサーの向きのまま）'],
      ['2', '2 軸（センサーの向きのまま）'],
    ])
    expect(raw.hours).toBe(3)
    expect(raw.stationKey).toBeNull()
  })

  it('印の段の材料: 合成波形はいまの割り当てのセンサーを、生データは自分のセンサーと割り当て先を持つ', () => {
    const groups = groupChannels([
      ch({ id: 'station/home/X', kind: 'station', station: { stationId: 'home', displayName: '自宅' } }),
      ch({ id: 'station/old/X', kind: 'station' }),
      ch({ id: 'FDSN:XX_A1_S1_H_N_1', kind: 'raw', sensor: 'FDSN:XX_A1_S1', board: { boardKey: 'b1', sensorId: 'S1', stationId: 'home', stationName: '自宅' } }),
      ch({ id: 'FDSN:XX_B2_S1_H_N_1', kind: 'raw', sensor: 'FDSN:XX_B2_S1', board: { boardKey: 'b2', sensorId: 'S1', stationId: 'home', stationName: '自宅' } }),
      ch({ id: 'FDSN:XX_C3_S1_H_N_1', kind: 'raw', sensor: 'FDSN:XX_C3_S1' }),
    ])
    const by = (label: string) => groups.find((g) => g.label === label)!
    expect(by('自宅')).toMatchObject({ stationId: 'home', sensors: ['FDSN:XX_A1_S1', 'FDSN:XX_B2_S1'] })
    // 設定から外した観測点は、どのセンサーだったか分からない
    expect(by('外した観測点（札 old）')).toMatchObject({ stationId: null, sensors: [] })
    expect(by('自宅 ／ 基板 b1 のセンサー S1')).toMatchObject({ stationId: 'home', sensors: ['FDSN:XX_A1_S1'] })
    expect(by('割り当ての無いセンサー（FDSN:XX_C3_S1）')).toMatchObject({ stationId: null, sensors: ['FDSN:XX_C3_S1'] })
  })

  it('割り当てのある生データは「観測点名 ／ 基板 … のセンサー …」と名乗る（観測点が設定に無ければ ID）', () => {
    const [named] = groupChannels([
      ch({ id: 'FDSN:XX_A1_S1_H_N_1', kind: 'raw', sensor: 'FDSN:XX_A1_S1', board: { boardKey: 'b1', sensorId: 'S1', stationId: 'home', stationName: '自宅' } }),
    ])
    expect(named!.label).toBe('自宅 ／ 基板 b1 のセンサー S1')
    const [unnamed] = groupChannels([
      ch({ id: 'FDSN:XX_A1_S1_H_N_1', kind: 'raw', sensor: 'FDSN:XX_A1_S1', board: { boardKey: 'b1', sensorId: 'S1', stationId: 'home', stationName: null } }),
    ])
    expect(unnamed!.label).toBe('home ／ 基板 b1 のセンサー S1')
  })

  it('記録がある期間は最後の時の終わりまで', () => {
    const [g] = groupChannels([ch({ id: 'station/home/X', kind: 'station', firstHourMs: H0, lastHourMs: H0 + 2 * HOUR, hours: 3 })])
    expect(periodText(g!)).toBe('記録がある期間: 10/07 12:00〜10/07 15:00（3 時間ぶん）')
  })
})

describe('readChannelList', () => {
  it('形の違う行が 1 つでもあれば応答ごと読めない', () => {
    const good = { id: 'station/home/X', kind: 'station', firstHourMs: H0, lastHourMs: H0, hours: 1, sensor: null, board: null, station: null }
    expect(readChannelList({ channels: [good], unreadable: 0 })?.channels).toHaveLength(1)
    expect(readChannelList({ channels: [good, { ...good, kind: 'other' }], unreadable: 0 })).toBeNull()
    expect(readChannelList({ channels: [{ ...good, board: { boardKey: 'b' } }], unreadable: 0 })).toBeNull()
    expect(readChannelList({ channels: [good] })).toBeNull()
  })
})

describe('範囲の操作', () => {
  const bounds = { fromMs: H0, toMs: H0 + 10 * HOUR }

  it('期間の外へは出さず、はみ出した分は幅を保ってずらす', () => {
    expect(clampRange({ fromMs: H0 - HOUR, toMs: H0 + HOUR }, bounds)).toEqual({ fromMs: H0, toMs: H0 + 2 * HOUR })
    expect(clampRange({ fromMs: H0 + 9 * HOUR, toMs: H0 + 11 * HOUR }, bounds)).toEqual({ fromMs: H0 + 8 * HOUR, toMs: H0 + 10 * HOUR })
  })

  it('幅は下限から期間の幅まで（下限ちょうどは通す）', () => {
    expect(clampRange({ fromMs: H0, toMs: H0 + 1 }, bounds)).toEqual({ fromMs: H0, toMs: H0 + MIN_SPAN_MS })
    expect(clampRange({ fromMs: H0, toMs: H0 + MIN_SPAN_MS }, bounds)).toEqual({ fromMs: H0, toMs: H0 + MIN_SPAN_MS })
    expect(clampRange({ fromMs: H0 - HOUR, toMs: H0 + 20 * HOUR }, bounds)).toEqual(bounds)
  })

  it('端は整数のミリ秒へ（ホストは整数でない時刻を弾く）', () => {
    const got = clampRange({ fromMs: H0 + 0.4, toMs: H0 + 1000.7 }, bounds)
    expect(Number.isInteger(got.fromMs) && Number.isInteger(got.toMs)).toBe(true)
  })

  it('幅のボタンは中心を保ち、全体は期間そのもの', () => {
    const r = { fromMs: H0 + 4 * HOUR, toMs: H0 + 6 * HOUR }
    expect(withSpan(r, HOUR, bounds)).toEqual({ fromMs: H0 + 4.5 * HOUR, toMs: H0 + 5.5 * HOUR })
    expect(withSpan(r, null, bounds)).toEqual(bounds)
  })

  it('記録が 400 日より長くても、幅はホストが読む上限の 400 日まで（全体は新しい側の 400 日）', () => {
    const long = { fromMs: H0, toMs: H0 + 500 * DAY }
    expect(clampRange(long, long)).toEqual({ fromMs: H0, toMs: H0 + RANGE_MAX_MS })
    expect(withSpan({ fromMs: H0, toMs: H0 + DAY }, null, long)).toEqual({ fromMs: long.toMs - RANGE_MAX_MS, toMs: long.toMs })
    // 全体の帯と同じ範囲を指す
    const [g] = groupChannels([ch({ id: 'station/home/X', kind: 'station', firstHourMs: long.fromMs, lastHourMs: long.toMs - HOUR })])
    expect(withSpan({ fromMs: H0, toMs: H0 + DAY }, null, long)).toEqual(overviewRange(g!))
    // 安全弁: 引いて広げても、送っても 400 日を超えない
    const wide = zoomAt({ fromMs: H0 + 100 * DAY, toMs: H0 + 399 * DAY }, 2, H0 + 200 * DAY, long)
    expect(wide.toMs - wide.fromMs).toBe(RANGE_MAX_MS)
    const shifted = shiftBy(wide, 30 * DAY, long)
    expect(shifted.toMs - shifted.fromMs).toBe(RANGE_MAX_MS)
  })

  it('対照: 記録が 400 日ちょうどなら全体は期間そのもの', () => {
    const exact = { fromMs: H0, toMs: H0 + RANGE_MAX_MS }
    expect(withSpan({ fromMs: H0, toMs: H0 + DAY }, null, exact)).toEqual(exact)
  })

  it('「全体」の幅（押された見た目の判定に使う）は、全体を押したときの幅と一致する', () => {
    for (const days of [0.5, 400, 500]) {
      const b = { fromMs: H0, toMs: H0 + days * DAY }
      const r = withSpan({ fromMs: H0, toMs: H0 + HOUR }, null, b)
      expect(r.toMs - r.fromMs).toBe(fullSpanMs(b))
    }
  })

  it('指した時刻を動かさずに寄せる・送る・中心へ', () => {
    const r = { fromMs: H0 + 2 * HOUR, toMs: H0 + 6 * HOUR }
    const z = zoomAt(r, 0.5, H0 + 3 * HOUR, bounds)
    expect(z).toEqual({ fromMs: H0 + 2.5 * HOUR, toMs: H0 + 4.5 * HOUR })
    expect(shiftBy(r, HOUR, bounds)).toEqual({ fromMs: H0 + 3 * HOUR, toMs: H0 + 7 * HOUR })
    expect(centerAt(r, H0 + 9.5 * HOUR, bounds)).toEqual({ fromMs: H0 + 6 * HOUR, toMs: H0 + 10 * HOUR })
  })
})

describe('planFetch', () => {
  it('10 分以内は生のサンプル（境目ちょうどを含む）、それより広ければ画面の幅ぶんの列', () => {
    expect(planFetch({ fromMs: H0, toMs: H0 + SAMPLES_RANGE_MAX_MS }, 800)).toEqual({ kind: 'samples' })
    expect(planFetch({ fromMs: H0, toMs: H0 + SAMPLES_RANGE_MAX_MS + 1 }, 800)).toEqual({ kind: 'envelope', columns: 800 })
    expect(planFetch({ fromMs: H0, toMs: H0 + HOUR }, 99999)).toEqual({ kind: 'envelope', columns: 4096 })
  })

  it('URL の数は整数へ', () => {
    expect(recordsUrl('envelope', { channel: 'station/home/X', from: 1.6, to: 3, columns: 2.2 })).toBe(
      '/api/records/envelope?channel=station%2Fhome%2FX&from=2&to=3&columns=2',
    )
  })
})

function envelopeBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: 'station/home/X',
    source: 'coarse',
    unit: 'gal',
    columnMs: 60_000,
    firstColumnMs: H0,
    n: [3, 0],
    min: [-1, null],
    max: [2, null],
    mean: [0.5, null],
    std: [1, null],
    noiseStd: [1, null],
    hours: { ok: 1, stale: 0, pending: 0, failed: 0, absent: 0 },
    irregularHours: [],
    files: null,
    problems: { skippedBytes: 0, badRecords: 0, unscaledHours: 0 },
    ...over,
  }
}

describe('応答を読む', () => {
  it('列の null は NaN として持ち、形の違いは応答ごと読めない', () => {
    const e = readEnvelopeData(envelopeBody())!
    expect(e.min[0]).toBe(-1)
    expect(Number.isNaN(e.min[1]!)).toBe(true)
    expect(readEnvelopeData(envelopeBody({ min: [-1] }))).toBeNull()
    expect(readEnvelopeData(envelopeBody({ irregularHours: [{ hourStartMs: H0, state: 'odd' }] }))).toBeNull()
    expect(readEnvelopeData(envelopeBody({ problems: undefined }))).toBeNull()
    // 生のサンプルから束ねたときは時の数えが無い
    expect(readEnvelopeData(envelopeBody({ hours: null, irregularHours: null }))?.hours).toBeNull()
  })

  it('サンプルの null は NaN、続きは時刻の順へ並べ直す', () => {
    const s = readSamplesData({
      unit: 'gal',
      runs: [
        { firstSampleMs: H0 + 100, msPerSample: 10, origin: 'live', timeQuestionable: false, values: [1] },
        { firstSampleMs: H0, msPerSample: 10, origin: 'live', timeQuestionable: false, values: [1, null] },
      ],
      problems: { skippedBytes: 0, badRecords: 0, unscaledHours: 0 },
    })!
    expect(s.runs.map((r) => r.firstSampleMs)).toEqual([H0, H0 + 100])
    expect(Number.isNaN(s.runs[0]!.values[1]!)).toBe(true)
  })

  it('震度の推移の値の無い刻みは null のまま', () => {
    const d = readIntensityData({ maxRealtime: 1.23, maxRealtimeAtMs: H0, measured: null, realtimeSeries: [{ atMs: H0, value: null }] })!
    expect(d.series[0]!.value).toBeNull()
    expect(readIntensityData({ maxRealtime: 'x', maxRealtimeAtMs: H0, measured: null, realtimeSeries: [] })).toBeNull()
  })
})

const columnsTrace = (n: number[], min: number[], max: number[], mean: number[], columnMs = 60_000): AxisTrace => ({
  kind: 'columns',
  columnMs,
  firstColumnMs: H0,
  n,
  min,
  max,
  mean,
})

const samplesTrace = (runs: Array<[number, number[]]>): AxisTrace => ({
  kind: 'samples',
  runs: runs.map(([firstSampleMs, values]) => ({ firstSampleMs, msPerSample: 10, values, origin: 'live' as const, timeQuestionable: false })),
})

describe('中心と最大', () => {
  it('最大は中心からの隔たりで測る（重力の乗った軸で値そのものを最大にしない）', () => {
    const t = columnsTrace([10, 10], [979, 970], [981, 985], [980, 980])
    const r = { fromMs: H0, toMs: H0 + 2 * 60_000 }
    const c = traceCenter(t, r)
    expect(c).toBe(980)
    const p = tracePeak(t, r, c)!
    expect(p.deviation).toBe(10)
    expect(p.value).toBe(970)
    expect(p.atMs).toBe(H0 + 60_000)
    expect(p.approximate).toBe(true)
  })

  it('サンプルの最大は時刻がちょうど', () => {
    const t = samplesTrace([[H0, [0, 3, -5, 1]]])
    const r = { fromMs: H0, toMs: H0 + 40 }
    const p = tracePeak(t, r, 0)!
    expect(p).toEqual({ deviation: 5, value: -5, atMs: H0 + 20, approximate: false })
  })

  it('範囲の外の値は数えない', () => {
    const t = samplesTrace([[H0, [100, 1, 1]]])
    expect(tracePeak(t, { fromMs: H0 + 10, toMs: H0 + 30 }, 0)!.deviation).toBe(1)
  })

  it('値が無ければ中心は NaN・最大は null', () => {
    const t = columnsTrace([0], [Number.NaN], [Number.NaN], [Number.NaN])
    const r = { fromMs: H0, toMs: H0 + 60_000 }
    expect(Number.isNaN(traceCenter(t, r))).toBe(true)
    expect(tracePeak(t, r, Number.NaN)).toBeNull()
  })
})

describe('pixelPlan', () => {
  it('点が画素より少なければ線で結び、値の無い所で線を切る', () => {
    const t = samplesTrace([[H0, [1, 2, Number.NaN, 4]]])
    const plan = pixelPlan(t, { fromMs: H0, toMs: H0 + 40 }, 100)
    expect(plan.mode).toBe('line')
    if (plan.mode !== 'line') return
    expect(plan.segments.map((s) => s.vs)).toEqual([[1, 2], [4]])
  })

  it('点が画素より多ければ画素ごとの上下の端（間引きでピークを落とさない）', () => {
    const values = Array.from({ length: 100 }, (_, i) => (i === 37 ? 50 : 0))
    const plan = pixelPlan(samplesTrace([[H0, values]]), { fromMs: H0, toMs: H0 + 1000 }, 10)
    expect(plan.mode).toBe('band')
    if (plan.mode !== 'band') return
    expect(Math.max(...plan.hi)).toBe(50)
    expect(plan.hi[3]).toBe(50)
  })

  it('列が画素より広ければ覆う画素すべてへ置き、値の無い列の画素は NaN', () => {
    const t = columnsTrace([1, 0], [-1, Number.NaN], [1, Number.NaN], [0, Number.NaN])
    const plan = pixelPlan(t, { fromMs: H0, toMs: H0 + 2 * 60_000 }, 10)
    if (plan.mode !== 'band') throw new Error('band のはず')
    expect(Array.from(plan.hi.slice(0, 5))).toEqual([1, 1, 1, 1, 1])
    expect(plan.hi.slice(5).every((v) => Number.isNaN(v))).toBe(true)
  })
})

describe('traceGaps', () => {
  const r = { fromMs: H0, toMs: H0 + 3 * 60_000 }

  it('本数 0 の列を欠けにし、要約がまだ無い時は pending、読めない時は記録が無い扱い', () => {
    const t = columnsTrace([1, 0, 0], [0, Number.NaN, Number.NaN], [0, Number.NaN, Number.NaN], [0, Number.NaN, Number.NaN])
    expect(traceGaps(t, r, r, [])).toEqual([{ fromMs: H0 + 60_000, toMs: H0 + 3 * 60_000, kind: 'none' }])
    expect(traceGaps(t, r, r, [{ hourStartMs: H0, state: 'pending' }])).toEqual([{ fromMs: H0 + 60_000, toMs: H0 + 3 * 60_000, kind: 'pending' }])
    expect(traceGaps(t, r, r, [{ hourStartMs: H0, state: 'failed' }])[0]!.kind).toBe('none')
  })

  it('取っていない範囲は欠けにしない', () => {
    const t = columnsTrace([0, 0, 0], [Number.NaN, Number.NaN, Number.NaN], [Number.NaN, Number.NaN, Number.NaN], [Number.NaN, Number.NaN, Number.NaN])
    expect(traceGaps(t, r, { fromMs: H0, toMs: H0 + 60_000 }, [])).toEqual([{ fromMs: H0, toMs: H0 + 60_000, kind: 'none' }])
  })

  it('サンプルは続きの間と両端の空きを欠けにし、刻み 1 つ分の隙間は欠けにしない', () => {
    const t = samplesTrace([
      [H0 + 1000, [0, 0]],
      [H0 + 1020, [0]],
      [H0 + 2000, [0]],
    ])
    const got = traceGaps(t, { fromMs: H0, toMs: H0 + 3000 }, { fromMs: H0, toMs: H0 + 3000 }, [])
    expect(got).toEqual([
      { fromMs: H0, toMs: H0 + 1000, kind: 'none' },
      { fromMs: H0 + 1030, toMs: H0 + 2000, kind: 'none' },
      { fromMs: H0 + 2010, toMs: H0 + 3000, kind: 'none' },
    ])
  })
})

describe('traceValueAt と合成', () => {
  it('サンプルは刻みの半分より離れていれば無し', () => {
    const t = samplesTrace([[H0, [1, 2]]])
    expect(traceValueAt(t, H0 + 14)).toEqual({ kind: 'sample', atMs: H0 + 10, value: 2 })
    expect(traceValueAt(t, H0 + 40)).toBeNull()
  })

  it('軸の合成は各軸の中心を引いた √Σ²、1 軸でも欠けた時刻は NaN', () => {
    const x = samplesTrace([[H0, [3, 3]]])
    const y = samplesTrace([[H0, [4]]])
    const got = compositeRuns([x, y], [0, 0])!
    expect(got[0]!.values[0]).toBe(5)
    expect(Number.isNaN(got[0]!.values[1]!)).toBe(true)
    // 列（要約）からは作らない
    expect(compositeRuns([columnsTrace([1], [0], [1], [0])], [0])).toBeNull()
  })
})

describe('overviewSpread', () => {
  it('列ごとに振れ幅のいちばん大きい軸を取り、値の無い列は NaN', () => {
    const a: EnvelopeData = readEnvelopeData(envelopeBody({ n: [3, 0], min: [-1, null], max: [2, null], mean: [0, null] }))!
    const b: EnvelopeData = readEnvelopeData(envelopeBody({ n: [3, 0], min: [0, null], max: [5, null], mean: [0, null] }))!
    const got = overviewSpread([a, b])!
    expect(got.spread[0]).toBe(5)
    expect(Number.isNaN(got.spread[1]!)).toBe(true)
  })
})

describe('文言', () => {
  it('段の見出しの最大は、サンプルなら時刻ちょうど、要約なら「ごろ」', () => {
    const at = new Date(2026, 9, 7, 12, 3, 4, 250).getTime()
    expect(peakLabel({ deviation: 12.34, value: 12.34, atMs: at, approximate: false }, 'gal', 60_000, null)).toBe('最大 12.3 gal（12:03:04.25）')
    expect(peakLabel({ deviation: 12.34, value: 12.34, atMs: at, approximate: true }, 'gal', HOUR, 120_000)).toBe('最大 12.3 gal（12:03 ごろ）')
    expect(peakLabel({ deviation: 12.34, value: 12.34, atMs: at, approximate: true }, 'gal', HOUR, 3000)).toBe('最大 12.3 gal（12:03:04 ごろ）')
    expect(peakLabel({ deviation: 1234, value: 1234, atMs: at, approximate: true }, 'count', 3 * 24 * HOUR, 600_000)).toBe('最大 1234 カウント（10/07 12:03 ごろ）')
  })

  it('描いている段・縦の物差し・長さ', () => {
    expect(sourceNote('coarse', 120_000)).toBe('1 分の要約から描いている（列 1 本＝2 分）')
    expect(sourceNote('fine', 3000)).toBe('1 秒の要約から描いている（列 1 本＝3 秒）')
    expect(sourceNote('raw-samples', null)).toBe('生のサンプルから描いている')
    expect(scaleLabel(20, 'gal')).toBe('±20 gal')
    expect(scaleLabel(0.5, 'gal')).toBe('±0.50 gal')
    expect(durationLabel(HOUR)).toBe('1 時間')
  })

  it('要約の不調はどれも 0 なら出さない', () => {
    expect(problemsNote({ ok: 3, stale: 0, pending: 0, failed: 0, absent: 2 })).toBeNull()
    expect(problemsNote({ ok: 0, stale: 1, pending: 3, failed: 0, absent: 0 })).toBe(
      '要約がまだ無い時が 3、作ったあとで元の記録が伸びた時が 1（末尾が欠けているかもしれない）、読めない時が 0',
    )
  })

  it('震度の段の見出し', () => {
    const at = new Date(2026, 9, 7, 12, 3, 6).getTime()
    expect(intensityHeader({ series: [], maxRealtime: 1.23, maxRealtimeAtMs: at, measured: 0.84 })).toBe('最大 1.2（12:03:06） 計測 0.8')
    expect(intensityHeader({ series: [], maxRealtime: null, maxRealtimeAtMs: null, measured: null })).toBe('最大 — 計測 —')
    // PWA と同じ数字を出す（気象庁の手順。四捨五入なら 1.3・0.9 になる）。
    expect(intensityHeader({ series: [], maxRealtime: 1.26, maxRealtimeAtMs: null, measured: 0.86 })).toBe('最大 1.2 計測 0.8')
  })

  it('指した所の値（負号は −）', () => {
    const at = new Date(2026, 9, 7, 12, 3, 4, 250).getTime()
    expect(
      readoutText(
        [
          { short: 'X', value: { kind: 'sample', atMs: at, value: 0.12 } },
          { short: 'Y', value: { kind: 'sample', atMs: at, value: -0.4 } },
        ],
        'gal',
        at,
        60_000,
      ),
    ).toBe('12:03:04.25　X 0.12　Y −0.40 gal')
    const col = new Date(2026, 9, 7, 12, 3, 0).getTime()
    expect(
      readoutText([{ short: 'X', value: { kind: 'column', columnStartMs: col, columnMs: 60_000, min: -0.52, max: 0.61 } }, { short: 'Y', value: null }], 'gal', col, HOUR),
    ).toBe('12:03:00 からの 1 分　X −0.52〜0.61　Y — gal')
  })
})

describe('recordTicks', () => {
  it('1 日の刻みは地域の 0 時に揃え、日付で書く', () => {
    const from = new Date(2026, 9, 1, 13, 0).getTime()
    const to = new Date(2026, 9, 7, 13, 0).getTime()
    const ticks = recordTicks({ fromMs: from, toMs: to }, 8)
    expect(ticks[0]!.atMs).toBe(new Date(2026, 9, 2, 0, 0).getTime())
    expect(ticks[0]!.label).toBe('10/02')
  })

  it('1 秒より細かい刻みは小数 2 桁、時の刻みは時:分（0 時だけ日付）', () => {
    const t = recordTicks({ fromMs: H0, toMs: H0 + 100 }, 5)
    expect(t[1]!.label).toBe('12:00:00.02')
    const h = recordTicks({ fromMs: new Date(2026, 9, 7, 22, 0).getTime(), toMs: new Date(2026, 9, 8, 4, 0).getTime() }, 6)
    expect(h.map((x) => x.label)).toContain('10/08')
    expect(h.map((x) => x.label)).toContain('23:00')
  })
})
