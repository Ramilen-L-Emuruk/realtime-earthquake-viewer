import { describe, expect, test } from 'vitest'
import {
  computeReachBand,
  measureNoiseBand,
  NOISE_FLOOR_GAL,
  NOISE_WIDTH_RATIO,
  ONSET_RATIO,
  selectQuakeWindow,
  type WaveAxisZero,
} from './seismoQuakeWindow'
import type { TimedColumns } from './seismoWaveColumns'

const ZERO_MS = Date.parse('2026-10-03T13:26:02+09:00')
const SPAN = 250 // 1 秒に 4 列

/**
 * 0 の `fromSec` 秒前から `toSec` 秒後まで、列を並べる。
 * `swingAt(秒)` がその秒の振れ幅の半分（3 成分のうち 1 つにだけ載せる）。
 */
function makeColumns(fromSec: number, toSec: number, swingAt: (sec: number) => number | null): TimedColumns {
  const columns = []
  for (let t = fromSec * 1000; t < toSec * 1000; t += SPAN) {
    const v = swingAt(Math.floor(t / 1000))
    columns.push(v === null ? null : { min: [-v, -0.1, -0.1] as const, max: [v, 0.1, 0.1] as const, minMembers: 3 })
  }
  return { fromMs: ZERO_MS + fromSec * 1000, columnSpanMs: SPAN, columns }
}

const NOISE = 1
const zero: WaveAxisZero = { kind: 'origin', ms: ZERO_MS, source: 'eew' }
// P 15 秒・S 25 秒 → 時間帯は 12〜35 秒。
const reach = computeReachBand(zero, { pMs: ZERO_MS + 15_000, sMs: ZERO_MS + 25_000 })!

describe('computeReachBand', () => {
  test('緊急地震速報なら P の 3 秒前〜S の 10 秒後', () => {
    expect(reach).toEqual({ fromMs: ZERO_MS + 12_000, toMs: ZERO_MS + 35_000 })
  })

  test('地震 ID なら前を 10 秒広げる（実際の発生より遅い値なので）', () => {
    const z: WaveAxisZero = { kind: 'origin', ms: ZERO_MS, source: 'event-id' }
    expect(computeReachBand(z, { pMs: ZERO_MS + 15_000, sMs: ZERO_MS + 25_000 })?.fromMs).toBe(ZERO_MS + 5_000)
  })

  test('分までしか無ければ、分の頭から解いた P 〜 S ＋ 60 秒', () => {
    const z: WaveAxisZero = { kind: 'minute', ms: ZERO_MS }
    expect(computeReachBand(z, { pMs: ZERO_MS + 15_000, sMs: ZERO_MS + 25_000 })).toEqual({
      fromMs: ZERO_MS + 15_000,
      toMs: ZERO_MS + 85_000,
    })
  })

  test('走時が出せなければ null', () => {
    expect(computeReachBand(zero, null)).toBeNull()
  })
})

describe('selectQuakeWindow', () => {
  test('揺れ始めが見つかれば、0 〜 静かさが戻って 15 秒（最低でも時間帯の終わり ＋ 20 秒）', () => {
    // 25〜60 秒に揺れ。60 秒で戻り、10 秒の静けさを経て 60 + 15 = 75 秒まで。
    const base = makeColumns(-30, 200, (s) => (s >= 25 && s < 60 ? NOISE * 4 : NOISE))
    const w = selectQuakeWindow({ base, zero, reach })
    expect(w.basis).toBe('onset')
    expect(w.onsetMs).not.toBeNull()
    expect(w.columns.fromMs).toBe(ZERO_MS)
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(ZERO_MS + 75_000)
  })

  test('揺れが短ければ、時間帯の終わり ＋ 20 秒まで描く', () => {
    const base = makeColumns(-30, 200, (s) => (s >= 25 && s < 28 ? NOISE * 4 : NOISE))
    const w = selectQuakeWindow({ base, zero, reach })
    expect(w.basis).toBe('onset')
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(reach.toMs + 20_000)
  })

  // 対照: 閾値の手前では揺れ始めと読まない。
  test('ノイズの倍率が閾値に届かなければ揺れなしとして、時間帯の終わり ＋ 30 秒', () => {
    const base = makeColumns(-30, 200, (s) => (s >= 25 && s < 60 ? NOISE * (ONSET_RATIO - 0.05) : NOISE))
    const w = selectQuakeWindow({ base, zero, reach })
    expect(w.basis).toBe('no-onset')
    expect(w.onsetMs).toBeNull()
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(reach.toMs + 30_000)
  })

  // 安全弁: 時間帯の外の揺れは、この地震の窓を決める根拠にしない（前後の地震の取り違え）。
  test('時間帯より後の揺れ（次の地震）は揺れ始めにしない', () => {
    const base = makeColumns(-30, 200, (s) => (s >= 100 && s < 140 ? NOISE * 5 : NOISE))
    expect(selectQuakeWindow({ base, zero, reach }).basis).toBe('no-onset')
  })

  test('前の地震の揺れが 0 の手前に残っていても、ノイズを大きく見積もらない', () => {
    // 0 の手前 30 秒のうち 10 秒だけ強い残り。中央値で測るので閾値は膨らまない。
    const base = makeColumns(-30, 200, (s) =>
      (s >= -30 && s < -20 ? NOISE * 6 : s >= 25 && s < 40 ? NOISE * 2 : NOISE))
    expect(selectQuakeWindow({ base, zero, reach }).basis).toBe('onset')
  })

  test('右端は届いている最新の値で頭打ち（まだ伸びている途中）', () => {
    const base = makeColumns(-30, 40, (s) => (s >= 25 ? NOISE * 4 : NOISE))
    const w = selectQuakeWindow({ base, zero, reach })
    expect(w.basis).toBe('onset')
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(ZERO_MS + 40_000)
  })

  test('走時が出せなければ取った範囲をそのまま（末尾の空だけ切る）', () => {
    const base = makeColumns(-30, 100, (s) => (s < 80 ? NOISE : null))
    const w = selectQuakeWindow({ base, zero, reach: null })
    expect(w.basis).toBe('untrimmed')
    expect(w.untrimmedReason).toBe('no-reach')
    expect(w.columns.fromMs).toBe(base.fromMs)
    expect(w.columns.columns.length).toBe(110 * 4)
  })

  // 安全弁: ノイズを測れないときは推測で置かない。
  test('0 の手前の記録が足りなければ判定しない', () => {
    const base = makeColumns(-5, 100, () => NOISE)
    const w = selectQuakeWindow({ base, zero, reach })
    expect(w.basis).toBe('untrimmed')
    expect(w.untrimmedReason).toBe('no-noise')
  })

  test('値のある列が無ければ判定しない（理由は no-data）', () => {
    const base = makeColumns(-30, 100, () => null)
    expect(selectQuakeWindow({ base, zero, reach }).untrimmedReason).toBe('no-data')
  })

  test('判定できたときは理由を持たない', () => {
    const base = makeColumns(-30, 200, () => NOISE)
    expect(selectQuakeWindow({ base, zero, reach }).untrimmedReason).toBeNull()
  })

  // 安全弁: どの経路でも、値のある最後の列より右（まだ来ていない時刻）は描かない。
  test('判定できなくても末尾の空は切る', () => {
    const base = makeColumns(-30, 200, (s) => (s < 50 ? NOISE : null))
    const w = selectQuakeWindow({ base, zero, reach: null })
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(ZERO_MS + 50_000)
  })

  test('値の無い秒は静かと見なさない（欠けの間に揺れが収まったことにしない）', () => {
    const base = makeColumns(-30, 200, (s) =>
      (s >= 25 && s < 50 ? NOISE * 4 : s >= 50 && s < 70 ? null : NOISE))
    const w = selectQuakeWindow({ base, zero, reach })
    // 欠けの後の 70 秒から静けさを数え始め、70 + 15 = 85 秒まで。
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(ZERO_MS + 85_000)
  })

  test('分までしか無いときも 0（分の頭）から描く', () => {
    const z: WaveAxisZero = { kind: 'minute', ms: ZERO_MS }
    const band = computeReachBand(z, { pMs: ZERO_MS + 15_000, sMs: ZERO_MS + 25_000 })!
    const base = makeColumns(-30, 200, () => NOISE)
    const w = selectQuakeWindow({ base, zero: z, reach: band })
    expect(w.basis).toBe('no-onset')
    expect(w.columns.fromMs).toBe(ZERO_MS)
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(band.toMs + 30_000)
  })
})

describe('measureNoiseBand', () => {
  /** 成分ごとに振れの大きさを変えた列（東西 v・南北 v・上下 1.5v）。 */
  function axisColumns(
    fromSec: number,
    toSec: number,
    swingAt: (sec: number) => number | null,
    offset = 0,
  ): TimedColumns {
    const columns = []
    for (let t = fromSec * 1000; t < toSec * 1000; t += SPAN) {
      const v = swingAt(Math.floor(t / 1000))
      columns.push(
        v === null
          ? null
          : {
              min: [offset - v, offset - v, offset - 1.5 * v] as const,
              max: [offset + v, offset + v, offset + 1.5 * v] as const,
              minMembers: 3,
            },
      )
    }
    return { fromMs: ZERO_MS + fromSec * 1000, columnSpanMs: SPAN, columns }
  }

  test('成分ごとに、1 秒ごとの振れの最大の中央値 × 倍率', () => {
    const band = measureNoiseBand(axisColumns(-30, 60, () => 1), ZERO_MS)!
    expect(band.width[0]).toBeCloseTo(NOISE_WIDTH_RATIO)
    expect(band.width[1]).toBeCloseTo(NOISE_WIDTH_RATIO)
    expect(band.width[2]).toBeCloseTo(1.5 * NOISE_WIDTH_RATIO)
    expect(band.center).toEqual([0, 0, 0])
  })

  test('0 より後（揺れ）は測らない', () => {
    const band = measureNoiseBand(axisColumns(-30, 60, (s) => (s >= 0 ? 10 : 1)), ZERO_MS)!
    expect(band.width[0]).toBeCloseTo(NOISE_WIDTH_RATIO)
  })

  test('直流のずれは中心として測り、幅はそこから測る', () => {
    const band = measureNoiseBand(axisColumns(-30, 0, () => 1, 0.4), ZERO_MS)!
    expect(band.center[0]).toBeCloseTo(0.4)
    expect(band.width[0]).toBeCloseTo(NOISE_WIDTH_RATIO)
  })

  // 安全弁: 前の地震の揺れの残りで幅を膨らませない。
  test('手前 30 秒のうち 10 秒が強くても、中央値なので幅は膨らまない', () => {
    const band = measureNoiseBand(axisColumns(-30, 0, (s) => (s < -20 ? 6 : 1)), ZERO_MS)!
    expect(band.width[0]).toBeCloseTo(NOISE_WIDTH_RATIO)
  })

  test('幅には下限がある', () => {
    const band = measureNoiseBand(axisColumns(-30, 0, () => 0.01), ZERO_MS)!
    expect(band.width[0]).toBe(NOISE_FLOOR_GAL)
  })

  // 安全弁: 推測で幅を置かない。
  test('手前の記録が 10 秒に満たなければ測らない', () => {
    expect(measureNoiseBand(axisColumns(-9, 60, () => 1), ZERO_MS)).toBeNull()
    expect(measureNoiseBand(axisColumns(-30, 60, (s) => (s < -9 ? null : 1)), ZERO_MS)).toBeNull()
  })

  // 対照: ちょうど 10 秒あれば測る。
  test('手前の記録が 10 秒あれば測る', () => {
    expect(measureNoiseBand(axisColumns(-10, 60, () => 1), ZERO_MS)).not.toBeNull()
  })

  /** 上下だけ値が無い（NaN）列。観測点の合成が上を解けない間の形。 */
  function upMissing(base: TimedColumns, fromSec: number): TimedColumns {
    const columns = base.columns.map((c, i) => {
      if (c === null) return c
      const sec = fromSec + Math.floor((i * SPAN) / 1000)
      return sec < -20 ? c : { ...c, min: [c.min[0], c.min[1], NaN] as const, max: [c.max[0], c.max[1], NaN] as const }
    })
    return { ...base, columns }
  }

  // 正（2026-10-09）: 上下の値が一部だけ欠けても、中心の中央値は値のある分だけで取る（NaN で壊れない）。
  test('上下の値が一部欠けても、残った値で上下の帯を測る', () => {
    const band = measureNoiseBand(upMissing(axisColumns(-30, 60, () => 1), -30), ZERO_MS)!
    expect(band.width[0]).toBeCloseTo(NOISE_WIDTH_RATIO)
    expect(band.center[2]).toBe(0)
    expect(band.width[2]).toBeCloseTo(1.5 * NOISE_WIDTH_RATIO)
  })

  // 安全弁: 上下がずっと欠けていれば帯を作らない（推測で幅を置かない。描く側は潰さない絵へ戻る）。
  test('上下の値が手前の窓でずっと無ければ、帯を作らない', () => {
    const base = axisColumns(-30, 60, () => 1)
    const columns = base.columns.map((c) =>
      c === null ? c : { ...c, min: [c.min[0], c.min[1], NaN] as const, max: [c.max[0], c.max[1], NaN] as const },
    )
    expect(measureNoiseBand({ ...base, columns }, ZERO_MS)).toBeNull()
  })
})
