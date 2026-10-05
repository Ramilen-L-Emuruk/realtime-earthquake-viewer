// 到達時刻を絵の横位置へ落とすところ。
//
// **固定するのは 3 つ** ——0〜1 の比になること・**絵の外の時刻を範囲の外として返すこと**
// （描く側が捨てる）・**分母が「末尾を切った後」の列であること**。

import { describe, expect, it } from 'vitest'

import { axisZeroLabel, buildArrivalMarks, foldQuakeWaveColumns, formatQuakeIntensityParts } from './QuakeSeismoWave'
import { P_WAVE_COLOR, S_WAVE_COLOR } from '../Map/gl/psWaveStyle'
import type { TimedColumns } from '../../utils/seismoWaveColumns'

const FROM_MS = 1_000_000

/** 1 列 100ms × `count` 列（中身は使わないので空の列で足りる）。 */
function columns(count: number): TimedColumns {
  return { fromMs: FROM_MS, columnSpanMs: 100, columns: new Array(count).fill(null) }
}

describe('buildArrivalMarks', () => {
  it('P と S を左端 0・右端 1 の比で返す', () => {
    // 100 列 × 100ms ＝ 10 秒ぶんの絵。P は 2 秒後・S は 5 秒後。
    const marks = buildArrivalMarks(columns(100), {
      pMs: FROM_MS + 2000,
      sMs: FROM_MS + 5000,
    })
    expect(marks.map((m) => m.label)).toEqual(['P', 'S'])
    expect(marks[0].ratio).toBeCloseTo(0.2)
    expect(marks[1].ratio).toBeCloseTo(0.5)
  })

  it('絵の右より後の到達は 1 を超える比で返す（描く側が捨てる）', () => {
    // **0〜1 に丸めない。** 端へ張り付けると、まだ届いていない時刻の線が右端に出る。
    const marks = buildArrivalMarks(columns(100), {
      pMs: FROM_MS + 2000,
      sMs: FROM_MS + 30_000,
    })
    expect(marks[1].ratio).toBeGreaterThan(1)
  })

  it('分母は末尾を切った後の列（切る前の窓ではない）', () => {
    // **対照。** 同じ到達時刻でも、絵が短ければ比は右へ寄る。
    const long = buildArrivalMarks(columns(100), { pMs: FROM_MS + 2000, sMs: FROM_MS + 5000 })
    const short = buildArrivalMarks(columns(50), { pMs: FROM_MS + 2000, sMs: FROM_MS + 5000 })
    expect(short[0].ratio).toBeGreaterThan(long[0].ratio)
    expect(short[0].ratio).toBeCloseTo(0.4)
  })

  it('到達が求まらなければ 1 本も引かない', () => {
    expect(buildArrivalMarks(columns(100), null)).toEqual([])
  })

  it('列が 1 つも無ければ引かない（0 除算を作らない）', () => {
    // **安全弁。** 割ると `Infinity` になり、範囲の判定をすり抜けて端に線が出る。
    expect(buildArrivalMarks(columns(0), { pMs: FROM_MS, sMs: FROM_MS })).toEqual([])
  })

  it('P は破線・S は実線で、見た目でも見分けられる', () => {
    const marks = buildArrivalMarks(columns(100), { pMs: FROM_MS, sMs: FROM_MS + 100 })
    expect(marks[0].dashed).toBe(true)
    expect(marks[1].dashed).toBe(false)
  })

  it('色は地図の予報円から引く（直書きへ戻さない）', () => {
    // **同じ画面で同じものを指すのに色が違うと、別の量に見える。**
    const marks = buildArrivalMarks(columns(100), { pMs: FROM_MS, sMs: FROM_MS + 100 })
    expect(marks[0].color).toBe(P_WAVE_COLOR)
    expect(marks[1].color).toBe(S_WAVE_COLOR)
  })
})

describe('axisZeroLabel', () => {
  it('秒まで取れていれば「発生」', () => {
    expect(axisZeroLabel({ kind: 'origin', ms: Date.parse('2026-10-03T13:26:02+09:00'), source: 'eew' })).toBe('発生')
  })

  // 対照: 分までしか無ければ発生を名乗らず、数え始めた時刻を書く。
  it('分までしか無ければ、その分の頭の時刻', () => {
    expect(axisZeroLabel({ kind: 'minute', ms: Date.parse('2026-10-03T13:26:00+09:00') })).toBe('13:26:00')
  })
})

describe('foldQuakeWaveColumns', () => {
  // 0 の 30 秒前から 60 秒後まで、1 秒に 4 列。0 より前は ±1 gal のノイズ、0 から ±5 gal の揺れ。
  const ZERO = FROM_MS + 30_000
  const SPAN = 250
  /** `upAfter` は 0 から後の上下動の振れ（既定は他と同じ 5）。 */
  function quake(upAfter = 5): TimedColumns {
    const cols = []
    for (let t = FROM_MS; t < ZERO + 60_000; t += SPAN) {
      const v = t < ZERO ? 1 : 5
      const u = t < ZERO ? 1 : upAfter
      cols.push({ min: [-v, -v, -u] as const, max: [v, v, u] as const, minMembers: 3 })
    }
    return { fromMs: FROM_MS, columnSpanMs: SPAN, columns: cols }
  }
  /** 0 から後だけを切り出した列（描く側に渡す形）。 */
  function trimmedOf(base: TimedColumns): TimedColumns {
    const start = (ZERO - base.fromMs) / SPAN
    return { ...base, fromMs: ZERO, columns: base.columns.slice(start) }
  }
  const ALL = [true, true, true] as const

  // 正: ノイズは切り出す前の列で測り、潰した表示になる。
  it('強調するなら、切り出す前の列でノイズを測って潰す', () => {
    const base = quake()
    const r = foldQuakeWaveColumns({
      base,
      trimmed: trimmedOf(base),
      zeroMs: ZERO,
      emphasized: true,
      visibleAxes: ALL,
      columnCount: 10,
    })
    expect(r.noiseMissing).toBe(false)
    // 幅は 1 × 1.5 = 1.5、残りは 5 − 1.5 = 3.5
    expect(r.columns.scaleLabel).toBe('±1.5〜±5.0 gal')
  })

  // 対照: 強調しなければ従来どおり（下限 10 gal）。
  it('強調しなければ潰さない', () => {
    const base = quake()
    const r = foldQuakeWaveColumns({
      base,
      trimmed: trimmedOf(base),
      zeroMs: ZERO,
      emphasized: false,
      visibleAxes: ALL,
      columnCount: 10,
    })
    expect(r.noiseMissing).toBe(false)
    expect(r.columns.scaleLabel).toBeUndefined()
    expect(r.columns.scaleGal).toBe(10)
  })

  // 安全弁: 0 の手前が無ければ潰さず、測れなかったことを返す（呼び出し側が記録へ残す）。
  it('0 の手前の記録が無ければ潰さず、測れなかったことを返す', () => {
    const trimmed = trimmedOf(quake())
    const r = foldQuakeWaveColumns({
      base: trimmed,
      trimmed,
      zeroMs: ZERO,
      emphasized: true,
      visibleAxes: ALL,
      columnCount: 10,
    })
    expect(r.noiseMissing).toBe(true)
    expect(r.columns.scaleLabel).toBeUndefined()
  })

  it('消した向きは強調の表示にも数えない', () => {
    // 上下だけ 0 から後に ±9 gal。消さなければ上下が上端を決める。
    const base = quake(9)
    const args = { base, trimmed: trimmedOf(base), zeroMs: ZERO, emphasized: true, columnCount: 10 }
    expect(foldQuakeWaveColumns({ ...args, visibleAxes: ALL }).columns.scaleLabel).toBe('±1.5〜±9.0 gal')
    expect(foldQuakeWaveColumns({ ...args, visibleAxes: [true, true, false] }).columns.scaleLabel).toBe(
      '±1.5〜±5.0 gal',
    )
  })
})

describe('formatQuakeIntensityParts', () => {
  const span = { fromMs: 1000, toMs: 91_000 }
  const base = { ...span, maxRealtime: 2.34, maxRealtimeAtMs: null, realtimeSeries: [], measured: 1.87, measuredUnavailable: null, gapCount: 0, invalidChunkCount: 0, filesMissing: 0, filesFailed: 0, skippedBytes: 0, truncated: false }
  const text = (parts: ReturnType<typeof formatQuakeIntensityParts>) => parts?.map((p) => `${p.label} ${p.value}`).join(' ') ?? null

  // 正: 短い名前と値だけ。階級は添えない（2026-10-05 のユーザー判断）。正式な名前はホバー用に持つ。
  it('2 つの値を短い名前で並べ、正式な名前を title に持つ', () => {
    const parts = formatQuakeIntensityParts(base, span)
    expect(text(parts)).toBe('最大 2.3 計測 1.9')
    expect(parts?.map((p) => p.title)).toEqual(['最大リアルタイム震度', '計測震度'])
  })

  it('計測震度が出なければ最大だけ', () => {
    expect(text(formatQuakeIntensityParts({ ...base, measured: null, measuredUnavailable: 'gap' }, span))).toBe('最大 2.3')
  })

  it('静穏時のわずかな負の値をマイナスゼロにしない', () => {
    expect(text(formatQuakeIntensityParts({ ...base, maxRealtime: -0.04, measured: null }, span))).toBe('最大 0.0')
  })

  it('どちらも出なければ行ごと出さない', () => {
    expect(formatQuakeIntensityParts({ ...base, maxRealtime: null, measured: null }, span)).toBeNull()
  })

  // 安全弁: 描いた区間と違う区間の値は出さない（末尾が切り戻された直後）。
  it('区間が描いた絵と違えば出さない', () => {
    expect(formatQuakeIntensityParts(base, { fromMs: 1000, toMs: 80_000 })).toBeNull()
    expect(formatQuakeIntensityParts(null, span)).toBeNull()
  })
})
