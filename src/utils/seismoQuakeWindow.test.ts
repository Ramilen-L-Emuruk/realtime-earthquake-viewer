import { describe, expect, test } from 'vitest'
import {
  computeReachBand,
  measureQuietLevel,
  NOISE_FLOOR_GAL,
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
    columns.push(v === null ? null : { min: [-v, -0.1, -0.1] as const, max: [v, 0.1, 0.1] as const, minMembers: 3, magMin: NaN, magMax: NaN, magSum: NaN, magCount: 0 })
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

  test('長期震源カタログなら緊急地震速報と同じ余裕（P の 3 秒前〜S の 10 秒後）', () => {
    const z: WaveAxisZero = { kind: 'origin', ms: ZERO_MS, source: 'catalog' }
    expect(computeReachBand(z, { pMs: ZERO_MS + 15_000, sMs: ZERO_MS + 25_000 })).toEqual({
      fromMs: ZERO_MS + 12_000,
      toMs: ZERO_MS + 35_000,
    })
  })

  // 発生は分の頭の 30 秒前〜65 秒後のどこか（カードの時刻は地震発現の分で、発生はそれより前へ出うる）。
  test('分までしか無ければ、分の頭から解いた P − 30 秒 〜 S ＋ 65 秒', () => {
    const z: WaveAxisZero = { kind: 'minute', ms: ZERO_MS }
    expect(computeReachBand(z, { pMs: ZERO_MS + 15_000, sMs: ZERO_MS + 25_000 })).toEqual({
      fromMs: ZERO_MS - 15_000,
      toMs: ZERO_MS + 90_000,
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
    const w = selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero, reach })
    expect(w.basis).toBe('onset')
    expect(w.onsetMs).not.toBeNull()
    expect(w.columns.fromMs).toBe(ZERO_MS)
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(ZERO_MS + 75_000)
  })

  // 分までしか無い地震では時間帯が 0 の手前へ広がるが、手前の振れ（前の地震の残り）を揺れ始めにしない。
  test('0 より手前の振れは揺れ始めにしない（分までしか無い地震）', () => {
    const minute: WaveAxisZero = { kind: 'minute', ms: ZERO_MS }
    const wide = computeReachBand(minute, { pMs: ZERO_MS + 15_000, sMs: ZERO_MS + 25_000 })!
    expect(wide.fromMs).toBeLessThan(ZERO_MS)
    const base = makeColumns(-30, 200, (s) => ((s >= -8 && s < -4) || (s >= 20 && s < 40) ? NOISE * 4 : NOISE))
    const w = selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero: minute, reach: wide })
    expect(w.basis).toBe('onset')
    expect(w.onsetMs).toBeGreaterThanOrEqual(ZERO_MS + 17_000)
  })

  test('揺れが短ければ、時間帯の終わり ＋ 20 秒まで描く', () => {
    const base = makeColumns(-30, 200, (s) => (s >= 25 && s < 28 ? NOISE * 4 : NOISE))
    const w = selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero, reach })
    expect(w.basis).toBe('onset')
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(reach.toMs + 20_000)
  })

  // 対照: 閾値の手前では揺れ始めと読まない。
  test('ノイズの倍率が閾値に届かなければ揺れなしとして、時間帯の終わり ＋ 30 秒', () => {
    const base = makeColumns(-30, 200, (s) => (s >= 25 && s < 60 ? NOISE * (ONSET_RATIO - 0.05) : NOISE))
    const w = selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero, reach })
    expect(w.basis).toBe('no-onset')
    expect(w.onsetMs).toBeNull()
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(reach.toMs + 30_000)
  })

  // 安全弁: 時間帯の外の揺れは、この地震の窓を決める根拠にしない（前後の地震の取り違え）。
  test('時間帯より後の揺れ（次の地震）は揺れ始めにしない', () => {
    const base = makeColumns(-30, 200, (s) => (s >= 100 && s < 140 ? NOISE * 5 : NOISE))
    expect(selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero, reach }).basis).toBe('no-onset')
  })

  test('前の地震の揺れが 0 の手前に残っていても、ノイズを大きく見積もらない', () => {
    // 0 の手前 30 秒のうち 10 秒だけ強い残り。中央値で測るので閾値は膨らまない。
    const base = makeColumns(-30, 200, (s) =>
      (s >= -30 && s < -20 ? NOISE * 6 : s >= 25 && s < 40 ? NOISE * 2 : NOISE))
    expect(selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero, reach }).basis).toBe('onset')
  })

  test('右端は届いている最新の値で頭打ち（まだ伸びている途中）', () => {
    const base = makeColumns(-30, 40, (s) => (s >= 25 ? NOISE * 4 : NOISE))
    const w = selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero, reach })
    expect(w.basis).toBe('onset')
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(ZERO_MS + 40_000)
  })

  test('走時が出せなければ取った範囲をそのまま（末尾の空だけ切る）', () => {
    const base = makeColumns(-30, 100, (s) => (s < 80 ? NOISE : null))
    const w = selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero, reach: null })
    expect(w.basis).toBe('untrimmed')
    expect(w.untrimmedReason).toBe('no-reach')
    expect(w.columns.fromMs).toBe(base.fromMs)
    expect(w.columns.columns.length).toBe(110 * 4)
  })

  // 安全弁: ノイズを測れないときは推測で置かない。
  test('0 の手前の記録が足りなければ判定しない', () => {
    const base = makeColumns(-5, 100, () => NOISE)
    const w = selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero, reach })
    expect(w.basis).toBe('untrimmed')
    expect(w.untrimmedReason).toBe('no-noise')
  })

  test('値のある列が無ければ判定しない（理由は no-data）', () => {
    const base = makeColumns(-30, 100, () => null)
    expect(selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero, reach }).untrimmedReason).toBe('no-data')
  })

  test('判定できたときは理由を持たない', () => {
    const base = makeColumns(-30, 200, () => NOISE)
    expect(selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero, reach }).untrimmedReason).toBeNull()
  })

  // 安全弁: どの経路でも、値のある最後の列より右（まだ来ていない時刻）は描かない。
  test('判定できなくても末尾の空は切る', () => {
    const base = makeColumns(-30, 200, (s) => (s < 50 ? NOISE : null))
    const w = selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero, reach: null })
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(ZERO_MS + 50_000)
  })

  test('値の無い秒は静かと見なさない（欠けの間に揺れが収まったことにしない）', () => {
    const base = makeColumns(-30, 200, (s) =>
      (s >= 25 && s < 50 ? NOISE * 4 : s >= 50 && s < 70 ? null : NOISE))
    const w = selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero, reach })
    // 欠けの後の 70 秒から静けさを数え始め、70 + 15 = 85 秒まで。
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(ZERO_MS + 85_000)
  })

  test('分までしか無いときも 0（分の頭）から描く', () => {
    const z: WaveAxisZero = { kind: 'minute', ms: ZERO_MS }
    const band = computeReachBand(z, { pMs: ZERO_MS + 15_000, sMs: ZERO_MS + 25_000 })!
    const base = makeColumns(-30, 200, () => NOISE)
    const w = selectQuakeWindow({ noiseFloor: NOISE_FLOOR_GAL, base, zero: z, reach: band })
    expect(w.basis).toBe('no-onset')
    expect(w.columns.fromMs).toBe(ZERO_MS)
    expect(w.columns.fromMs + w.columns.columns.length * SPAN).toBe(band.toMs + 30_000)
  })
})

describe('measureQuietLevel', () => {
  // 正: 0 の手前 30 秒の「1 秒ごとの振れの最大」の中央値を、3 成分のうち最大で返す。
  test('3 成分のうち最も振れた成分の中央値を返す', () => {
    expect(measureQuietLevel(makeColumns(-30, 60, (s) => (s >= 0 ? 10 : 0.3)), ZERO_MS)).toBeCloseTo(0.3)
  })

  // 正: 上を解けない観測点（1 成分が値なし）でも、残りの成分で測る。
  test('値の無い成分があっても、残りの成分で測る', () => {
    const columns = []
    for (let t = -30_000; t < 0; t += SPAN) columns.push({ min: [-0.3, -0.2, NaN] as const, max: [0.3, 0.2, NaN] as const, minMembers: 3, magMin: NaN, magMax: NaN, magSum: NaN, magCount: 0 })
    const base: TimedColumns = { fromMs: ZERO_MS - 30_000, columnSpanMs: SPAN, columns }
    expect(measureQuietLevel(base, ZERO_MS)).toBeCloseTo(0.3)
  })

  // 安全弁: 推測で物差しを置かない。
  test('手前の記録が 10 秒に満たなければ null', () => {
    expect(measureQuietLevel(makeColumns(-9, 60, () => 1), ZERO_MS)).toBeNull()
  })
})
