import { describe, expect, it } from 'vitest'

import {
  arrivalMark,
  originUnderline,
  quakeFailedDaysText,
  quakeReadout,
  quakesAt,
  readQuakesData,
  readReceptionData,
  receptionAt,
  receptionLane,
  receptionPendingNote,
  shakeReadout,
  shakesAt,
  spanX,
  type QuakeMarkView,
} from './recordsMarks'
import type { SampleRunView } from './recordsPlot'
import type { ShakeRecordView } from './shakeHistory'

const H0 = new Date(2026, 9, 7, 12, 0, 0).getTime()
const R = { fromMs: H0, toMs: H0 + 100_000 }

describe('readReceptionData', () => {
  const body = {
    sensors: [
      { sensor: 'FDSN:XX_A1_S1', backlog: [{ fromMs: H0, toMs: H0 + 5000 }], late: [], questionable: [{ fromMs: H0 + 9000, toMs: H0 + 9500 }] },
      { sensor: 'FDSN:XX_B2_S1', backlog: [{ fromMs: H0 + 3000, toMs: H0 + 8000 }], late: [{ fromMs: H0 + 20_000, toMs: H0 + 21_000 }], questionable: [] },
    ],
    unreadable: { items: [{ atMs: H0 + 4000, rxMs: null, lane: 'live', why: 'x' }], truncated: false, cappedHours: 0 },
    unreadableLogs: 0,
    hours: { ok: 1, stale: 0, pending: 2, failed: 0, absent: 0 },
  }

  it('帯と読めなかったパケットを読み、選んだセンサーの帯を種類ごとに重ねる', () => {
    const r = readReceptionData(body)!
    expect(r.hours.pending).toBe(2)
    const lane = receptionLane(r, new Set(['FDSN:XX_A1_S1', 'FDSN:XX_B2_S1']))
    expect(lane.backlog).toEqual([{ fromMs: H0, toMs: H0 + 8000 }])
    expect(lane.late).toEqual([{ fromMs: H0 + 20_000, toMs: H0 + 21_000 }])
    expect(lane.questionable).toHaveLength(1)
    expect(lane.unreadableAtMs).toEqual([H0 + 4000])
    // 選ばなかったセンサーの帯は入らない（読めなかったパケットはセンサーを持たないので入れる）
    const one = receptionLane(r, new Set(['FDSN:XX_B2_S1']))
    expect(one.backlog).toEqual([{ fromMs: H0 + 3000, toMs: H0 + 8000 }])
    expect(one.questionable).toEqual([])
    expect(one.unreadableAtMs).toEqual([H0 + 4000])
  })

  it('形が違えば応答ごと読めない', () => {
    expect(readReceptionData({ ...body, sensors: 'x' })).toBeNull()
    expect(readReceptionData({ ...body, hours: null })).toBeNull()
  })
})

describe('readQuakesData', () => {
  it('地震と P・S の幅を読む（観測点が無ければ P・S は null）', () => {
    const d = readQuakesData({
      off: false,
      located: true,
      quakes: [
        { name: '千葉県北西部', originMs: H0, originPrecisionMs: 100, originSource: 'hypocenter-list', magnitude: 4.2, maxScale: 30, depthKm: 40, distanceKm: 120, p: { fromMs: H0 + 18_000, toMs: H0 + 18_100 }, s: { fromMs: H0 + 32_000, toMs: H0 + 32_100 } },
        { name: '遠い地震', originMs: H0 + 1000, originPrecisionMs: 60_000, originSource: 'quake-info', magnitude: null, maxScale: null, depthKm: null, distanceKm: null, p: null, s: null },
      ],
      failedDays: ['2026-10-03'],
      unreadable: 0,
      problem: null,
    })!
    expect(d.quakes).toHaveLength(2)
    expect(d.quakes[1]!.p).toBeNull()
    expect(d.failedDays).toEqual(['2026-10-03'])
  })

  it('取らない設定の答えも読む', () => {
    expect(readQuakesData({ off: true, located: false, quakes: [], failedDays: [], unreadable: 0, problem: null })!.off).toBe(true)
    expect(readQuakesData({ off: false, located: true, quakes: [{ name: 1 }], failedDays: [], unreadable: 0, problem: null })).toBeNull()
  })
})

describe('originUnderline', () => {
  function run(firstSampleMs: number, n: number, origin: SampleRunView['origin'], timeQuestionable = false): SampleRunView {
    return { firstSampleMs, msPerSample: 10, values: new Array<number>(n).fill(0), origin, timeQuestionable }
  }

  it('ライブ以外の届き方を、続いた区間ごとに 1 本へまとめる。時刻の疑わしさは別に引く', () => {
    const lines = originUnderline([run(H0, 30, 'live'), run(H0 + 300, 30, 'backlog'), run(H0 + 600, 30, 'backlog'), run(H0 + 900, 30, 'revised', true)])
    expect(lines).toEqual([
      { kind: 'backlog', fromMs: H0 + 300, toMs: H0 + 900 },
      { kind: 'revised', fromMs: H0 + 900, toMs: H0 + 1200 },
      { kind: 'questionable', fromMs: H0 + 900, toMs: H0 + 1200 },
    ])
  })

  it('対照: ライブと分からない届き方には線を引かない', () => {
    expect(originUnderline([run(H0, 30, 'live'), run(H0 + 300, 30, 'unknown')])).toEqual([])
  })
})

describe('spanX と arrivalMark', () => {
  it('範囲の外は null、端は切る、細すぎる帯も 1 画素は残す', () => {
    expect(spanX({ fromMs: H0 - 2000, toMs: H0 - 1000 }, R, 1000)).toBeNull()
    expect(spanX({ fromMs: H0 - 2000, toMs: H0 + 10_000 }, R, 1000)).toEqual({ x0: 0, x1: 100 })
    const thin = spanX({ fromMs: H0 + 50_000, toMs: H0 + 50_001 }, R, 1000)!
    expect(thin.x1 - thin.x0).toBeGreaterThanOrEqual(1)
  })

  it('2 画素に満たない幅は線、それ以上は帯', () => {
    expect(arrivalMark({ fromMs: H0 + 18_000, toMs: H0 + 18_100 }, R, 1000)).toEqual({ kind: 'line', x: 180.5 })
    expect(arrivalMark({ fromMs: H0 + 10_000, toMs: H0 + 70_000 }, R, 1000)).toEqual({ kind: 'band', x0: 100, x1: 700 })
    expect(arrivalMark({ fromMs: H0 + 200_000, toMs: H0 + 200_100 }, R, 1000)).toBeNull()
  })
})

describe('カーソルの読み取り', () => {
  const precise: QuakeMarkView = {
    name: '千葉県北西部',
    originMs: H0,
    originPrecisionMs: 100,
    magnitude: 4.2,
    maxScale: 30,
    distanceKm: 120,
    p: { fromMs: H0 + 18_000, toMs: H0 + 18_100 },
    s: { fromMs: H0 + 32_000, toMs: H0 + 32_100 },
  }

  it('秒まで分かった地震は P・S を時刻 1 つで、幅のある地震は幅で書く', () => {
    expect(quakeReadout(precise)).toBe('気象庁: 千葉県北西部 M4.2 最大震度3（120 km） P 12:00:18.0・S 12:00:32.0')
    const band = { ...precise, originPrecisionMs: 60_000, p: { fromMs: H0 + 18_000, toMs: H0 + 78_000 }, s: { fromMs: H0 + 32_000, toMs: H0 + 92_000 } }
    expect(quakeReadout(band)).toBe('気象庁: 千葉県北西部 M4.2 最大震度3（120 km） P 12:00:18〜12:01:18・S 12:00:32〜12:01:32')
    // 観測点の位置が無ければ距離と P・S を省く
    expect(quakeReadout({ ...precise, distanceKm: null, p: null, s: null })).toBe('気象庁: 千葉県北西部 M4.2 最大震度3')
  })

  it('発生から S の終わりまでの間を指したら、その地震を拾う', () => {
    expect(quakesAt([precise], H0 + 25_000, 500)).toHaveLength(1)
    expect(quakesAt([precise], H0 + 40_000, 500)).toHaveLength(0)
  })

  it('揺れの記録は判定と区間を書く', () => {
    const e = { id: 'home-1', rev: 1, stationId: 'home', startMs: H0 + 30_000, endMs: H0 + 70_000, sMs: null, pMs: null, peakAccelGal: 3, maxIntensity: null, peakRatio: 4, verdict: 'quake-like', matchedQuake: null } satisfies ShakeRecordView
    expect(shakeReadout(e)).toBe('揺れの記録: 地震らしい 12:00:30〜12:01:10')
    expect(shakesAt([e], H0 + 50_000, 0)).toHaveLength(1)
    expect(shakesAt([e], H0 + 80_000, 0)).toHaveLength(0)
  })

  it('受信は指した所に掛かる種類だけを並べる', () => {
    const lane = { backlog: [{ fromMs: H0, toMs: H0 + 5000 }], late: [], questionable: [{ fromMs: H0 + 3000, toMs: H0 + 4000 }], unreadableAtMs: [H0 + 9000] }
    expect(receptionAt(lane, H0 + 3500, 0)).toBe('受信: 基板から取り戻した分・時刻が疑わしい分')
    expect(receptionAt(lane, H0 + 9000, 100)).toBe('受信: 読めなかったパケット')
    expect(receptionAt(lane, H0 + 7000, 0)).toBeNull()
  })
})

describe('文言', () => {
  it('取れなかった日・要約の無い時', () => {
    expect(quakeFailedDaysText(['2026-10-03', '2026-10-04'])).toBe('地震一覧を取れていない日がある（10/03・10/04）')
    expect(receptionPendingNote(3)).toBe('受信の記録の要約がまだ無い時が 3（作り終えると出る）')
    expect(receptionPendingNote(0)).toBeNull()
  })
})
