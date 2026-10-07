import { describe, expect, it } from 'vitest'

import type { FusedWaveChunk } from '../receiver/sensorFusion'
import type { StationConfig } from '../receiver/stationConfig'
import type { P2pReferenceQuake } from './p2pQuake'
import type { ShakeEventRecord } from './shakeEvent'
import { StationDetection, emitDetectionHourly, formatDetectionHourly, sensorsOf } from './stationDetection'
import type { StationTriggerStatus } from './stationDetection'

const FS = 100
const DT = 1000 / FS
// 2026-10-03 13:24:00 JST から流し、S_AT_SEC 秒後に S 波が来る形にする。
const T0 = Date.UTC(2026, 9, 3, 4, 24, 0)
const S_AT_SEC = 140

const CONFIG: StationConfig = {
  stations: [{ stationId: 'station-1', displayName: '自宅', lat: 35.0, lon: 135.0 }],
  boards: [
    {
      boardKey: 'mac:020000000001',
      stationId: 'station-1',
      sensors: [
        { sensorId: 'i2c0-68', enabled: true, rotation: null, offset: null, sensitivity: null, noiseDensity: null },
        { sensorId: 'i2c0-69', enabled: false, rotation: null, offset: null, sensitivity: null, noiseDensity: null },
      ],
    },
  ],
} as unknown as StationConfig

// 観測点から約 82 km の架空の地震。
const QUAKE: P2pReferenceQuake = {
  originMs: Date.UTC(2026, 9, 3, 4, 26, 0),
  originPrecisionMs: 60_000,
  lat: 34.3,
  lon: 135.3,
  depthKm: 0,
  magnitude: 3.5,
  name: '架空の震央',
  maxScale: 20,
  key: 'k',
}

function gaussian(seed: number): () => number {
  let s = seed >>> 0
  const uniform = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s + 1) / 4294967297
  }
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
}

/** 観測点の合成波形（雑音 ＋ S_AT_SEC から 6 秒の 7 Hz）を 0.3 秒ずつ。 */
function waves(totalSec: number, stationId = 'station-1'): FusedWaveChunk[] {
  const g = gaussian(5)
  const out: FusedWaveChunk[] = []
  for (let i0 = 0; i0 < totalSec * FS; i0 += 30) {
    const gal: [number[], number[], number[]] = [[], [], []]
    for (let i = i0; i < i0 + 30; i++) {
      const t = i / FS
      const on = t >= S_AT_SEC && t < S_AT_SEC + 6
      const ph = 2 * Math.PI * 7 * (t - S_AT_SEC)
      gal[0].push(0.5 * g() + (on ? 1.5 * Math.sin(ph) : 0))
      gal[1].push(0.5 * g() + (on ? 1.5 * Math.cos(ph) : 0))
      gal[2].push(0.5 * g() + (on ? 0.7 * Math.sin(ph + 1) : 0))
    }
    out.push({
      stationId,
      firstSampleIndex: i0,
      firstSampleMs: T0 + i0 * DT,
      msPerSample: DT,
      gal,
      dcGal: [[], [], []],
      memberCount: Array(30).fill(9),
      axisMemberCount: [Array(30).fill(9), Array(30).fill(9), Array(30).fill(9)],
    })
  }
  return out
}

function setup(config: StationConfig = CONFIG) {
  let now = T0
  let current = config
  const saved: ShakeEventRecord[] = []
  const published: ShakeEventRecord[] = []
  const logs: { level: string; key: string; line: string }[] = []
  const detection = new StationDetection({
    save: (r) => saved.push(r),
    publish: (r) => published.push(r),
    storeStatus: () => ({ written: saved.length, writeErrors: 0, lastWriteError: null }),
    feedCovered: () => true,
    feedStatus: () => null,
    config: () => current,
    now: () => now,
    log: (level, key, line) => logs.push({ level, key, line }),
  })
  return {
    detection,
    saved,
    published,
    logs,
    setNow: (ms: number) => (now = ms),
    setConfig: (c: StationConfig) => (current = c),
  }
}

describe('sensorsOf', () => {
  it('観測点に割り当てた基板の、有効なセンサーだけを返す', () => {
    expect(sensorsOf(CONFIG, 'station-1')).toEqual([{ boardKey: 'mac:020000000001', sensorId: 'i2c0-68' }])
    expect(sensorsOf(CONFIG, 'station-x')).toEqual([])
  })
})

describe('StationDetection', () => {
  it('合成波形を流すと揺れを記録して押し出し、地震情報で `quake` の版を足す', () => {
    const t = setup()
    for (const w of waves(170)) {
      t.setNow(w.firstSampleMs)
      t.detection.pushStationWave(w)
      // 最大計測震度相当の材料（毎秒）
      if (w.firstSampleIndex % FS === 0) {
        t.detection.noteStationReading({ stationId: 'station-1', atMs: w.firstSampleMs, intensity: w.firstSampleMs >= T0 + S_AT_SEC * 1000 ? 1.4 : 0.1 })
      }
    }
    expect(t.saved).toHaveLength(1)
    expect(t.saved[0].verdict).toBe('pending')
    expect(t.saved[0].shakeClass).toBe('quake-like')
    expect(t.saved[0].maxIntensity).toBe(1.4)
    expect(t.saved[0].sensors).toEqual([{ boardKey: 'mac:020000000001', sensorId: 'i2c0-68' }])
    expect(t.published).toEqual(t.saved)
    t.detection.addQuake(QUAKE)
    expect(t.saved.map((r) => r.verdict)).toEqual(['pending', 'quake'])
    expect(t.detection.snapshot().shakes).toBe(1)
  })

  it('揺れの行は揺れごとに鍵を分けて記録する（呼び出し側の間引きに 2 件目を食わせない）', () => {
    const t = setup()
    for (const w of waves(170)) t.detection.pushStationWave(w)
    const keys = t.logs.filter((l) => l.line.startsWith('[detect]')).map((l) => l.key)
    expect(keys).toEqual([t.saved[0].id])
  })

  it('設定から外れた観測点の検出器は捨て、開いている揺れは閉じて記録する', () => {
    const t = setup()
    // S の最中で止める（区間が開いたまま）
    for (const w of waves(S_AT_SEC + 3)) t.detection.pushStationWave(w)
    expect(t.saved).toHaveLength(0)
    t.setConfig({ stations: [], boards: [] } as unknown as StationConfig)
    t.detection.forgetRemovedStations()
    expect(t.saved).toHaveLength(1)
    expect(t.saved[0].endReason).toBe('flush')
    expect(t.detection.snapshot().stations).toEqual([])
  })

  it('終了の前に flushAll で開いている揺れを記録する', () => {
    const t = setup()
    for (const w of waves(S_AT_SEC + 3)) t.detection.pushStationWave(w)
    t.detection.flushAll()
    expect(t.saved).toHaveLength(1)
  })

  it('安全弁: 計測震度相当を覚える段で例外が出ても投げず、原因ごとの鍵で残す', () => {
    const t = setup()
    const book = (t.detection as unknown as { book: { noteStationReading: () => void } }).book
    book.noteStationReading = () => {
      throw new Error('boom')
    }
    expect(() => t.detection.noteStationReading({ stationId: 'station-1', atMs: T0, intensity: 0.1 })).not.toThrow()
    expect(t.detection.snapshot().failures).toBe(1)
    expect(t.logs.map((l) => l.key)).toEqual(['failure:reading'])
  })

  it('設定から外して捨てた観測点のぶんも、数え上げの合計から消えない', () => {
    const t = setup()
    // 1 秒の途切れを挟んで検出器を作り直させる
    const chunks = waves(30).filter((w) => w.firstSampleMs - T0 < 10_000 || w.firstSampleMs - T0 >= 12_000)
    for (const w of chunks) t.detection.pushStationWave(w)
    expect(t.detection.snapshot().resets).toBe(1)
    t.setConfig({ stations: [], boards: [] } as unknown as StationConfig)
    t.detection.forgetRemovedStations()
    expect(t.detection.snapshot().stations).toEqual([])
    expect(t.detection.snapshot().resets).toBe(1)
  })

  it('安全弁: 保存が投げても受信を止めず、数えて記録に残す', () => {
    const saved: ShakeEventRecord[] = []
    const logs: string[] = []
    const detection = new StationDetection({
      save: () => {
        throw new Error('disk full')
      },
      publish: (r) => saved.push(r),
      storeStatus: () => ({ written: 0, writeErrors: 0, lastWriteError: null }),
      feedCovered: () => true,
      feedStatus: () => null,
      config: () => CONFIG,
      now: () => T0,
      log: (_l, _k, line) => logs.push(line),
    })
    expect(() => {
      for (const w of waves(170)) detection.pushStationWave(w)
    }).not.toThrow()
    expect(detection.snapshot().failures).toBe(1)
    expect(logs.some((l) => l.includes('disk full'))).toBe(true)
  })
})

describe('StationDetection — 静かだっただけか、止まっているか', () => {
  // T0 は 2026-10-03 13:24:00 JST
  const JST_1325 = '13:25'
  const HOUR = 3_600_000

  /** 合成波形を流す。ホストの時計は、そのまとまりの時刻 ＋ `hostOffsetMs`（基板の時計のずれの逆）。 */
  function feed(t: ReturnType<typeof setup>, chunks: readonly FusedWaveChunk[], hostOffsetMs = 0): void {
    for (const w of chunks) {
      t.setNow(w.firstSampleMs + hostOffsetMs)
      t.detection.pushStationWave(w)
    }
  }

  it('設定にあるのに波形が一度も来ていない観測点も、「届いていない」として状態に載る', () => {
    const t = setup()
    const s = t.detection.snapshot()
    expect(s.stations).toEqual([])
    expect(s.triggers).toHaveLength(1)
    expect(s.triggers[0]).toMatchObject({
      stationId: 'station-1',
      lastSampleMs: null,
      lastFedAtMs: null,
      armed: false,
      peak24h: null,
      droppedChunks: 0,
    })
  })

  it('正: 波形が流れていれば、引き金の状態（比の最大・平常時の強さ・最後に使えた時刻）が観測点ごとに載る', () => {
    const t = setup()
    feed(t, waves(170))
    const [tr] = t.detection.snapshot().triggers
    expect(tr.stationId).toBe('station-1')
    expect(tr.armed).toBe(true)
    expect(tr.baselineGal).toBeGreaterThan(0)
    expect(tr.peak24h!.ratio).toBeGreaterThan(tr.onRatio)
    // 0.3 秒のまとまりで流すので、最後のサンプルは 170 秒をわずかに越える
    expect(tr.lastSampleMs! - T0).toBeGreaterThan(169_000)
    expect(tr.lastSampleMs! - T0).toBeLessThan(170_300)
    expect(tr.lastFedAtMs! - T0).toBeGreaterThan(169_000)
  })

  it('設定から外して捨てた観測点は、状態から消える', () => {
    const t = setup()
    feed(t, waves(70))
    t.setConfig({ stations: [], boards: [] } as unknown as StationConfig)
    t.detection.forgetRemovedStations()
    expect(t.detection.snapshot().triggers).toEqual([])
  })

  it('1 時間の行: 静かに見張っていれば、比の最大・時刻・平常時の揺れ・状態を 1 行で出す', () => {
    const t = setup()
    feed(t, waves(100))
    const lines = t.detection.hourlyLines(T0, T0 + 100_000)
    expect(lines).toHaveLength(1)
    expect(lines[0].level).toBe('log')
    expect(lines[0].key).toBe('hourly:station-1')
    expect(lines[0].line).toMatch(
      new RegExp(`^\\[detect\\] station-1 この 1 時間: 比の最大 \\d\\.\\d\\d 倍（${JST_1325}）・平常時の揺れ 0\\.\\d\\d gal・見張り中$`),
    )
  })

  it('1 時間の行: 一度も波形が来ていなければ「届いていない（起動から一度も）」を警告で出す', () => {
    const t = setup()
    const [l] = t.detection.hourlyLines(T0, T0 + HOUR)
    expect(l.level).toBe('warn')
    expect(l.line).toBe('[detect] station-1 この 1 時間: 波形が届いていない（起動から一度も）')
  })

  it('1 時間の行: 波形が止まっていれば、最後に届いた時刻を添えて警告で出す', () => {
    const t = setup()
    feed(t, waves(100))
    const [l] = t.detection.hourlyLines(T0, T0 + 100_000 + 5 * 60_000)
    expect(l.level).toBe('warn')
    expect(l.line).toBe(`[detect] station-1 この 1 時間: 波形が届いていない（最後は ${JST_1325}）`)
  })

  it('対照: 止まってから 1 分に満たなければ、まだ「届いていない」とは言わない', () => {
    const t = setup()
    feed(t, waves(100))
    const [l] = t.detection.hourlyLines(T0, T0 + 100_000 + 50_000)
    expect(l.level).toBe('log')
    expect(l.line).toContain('見張り中')
  })

  it('1 時間の行: 最後に届いた日が今日（日本時間）でなければ、日付も添える', () => {
    const t = setup()
    feed(t, waves(100))
    const [l] = t.detection.hourlyLines(T0, T0 + 24 * HOUR)
    expect(l.line).toBe(`[detect] station-1 この 1 時間: 波形が届いていない（最後は 10/03 ${JST_1325}）`)
  })

  it('1 時間の行: 助走から抜けられないまま 1 時間を終えたら、比の最大「なし」を警告で出す', () => {
    const t = setup()
    feed(t, waves(30))
    const [l] = t.detection.hourlyLines(T0, T0 + 30_000)
    expect(l.level).toBe('warn')
    expect(l.line).toMatch(/^\[detect\] station-1 この 1 時間: 比の最大 なし・平常時の揺れ \S+ gal・助走中（あと 30 秒）$/)
  })

  it('1 時間の行: 揺れの区間を開いている最中なら「揺れを記録中」', () => {
    const t = setup()
    feed(t, waves(S_AT_SEC + 3))
    const [l] = t.detection.hourlyLines(T0, T0 + (S_AT_SEC + 3) * 1000)
    expect(l.line).toMatch(/・揺れを記録中$/)
  })

  it('正: 基板の時計が 2 時間先へずれていても、比の最大はデータの時刻で拾い、届いているかはホストの時計で見る', () => {
    const t = setup()
    // ホストの時計は、基板が名乗る時刻より 2 時間遅れている
    feed(t, waves(100), -2 * HOUR)
    const hostNow = T0 + 100_000 - 2 * HOUR
    const [alive] = t.detection.hourlyLines(hostNow - HOUR, hostNow)
    expect(alive.level).toBe('log')
    expect(alive.line).toContain('見張り中')
    expect(alive.line).not.toContain('比の最大 なし')
    // 止まって 5 分経てば、データの時刻が「未来」のままでも「届いていない」になる
    const [silent] = t.detection.hourlyLines(hostNow - HOUR, hostNow + 5 * 60_000)
    expect(silent.level).toBe('warn')
    expect(silent.line).toContain('波形が届いていない（最後は ')
  })

  it('対照: 基板の時計が 2 時間遅れていても、動いているうちは「届いていない」と言わない', () => {
    const t = setup()
    feed(t, waves(100), 2 * HOUR)
    const hostNow = T0 + 100_000 + 2 * HOUR
    const [l] = t.detection.hourlyLines(hostNow - HOUR, hostNow)
    expect(l.level).toBe('log')
    expect(l.line).toContain('見張り中')
  })

  it('安全弁: 刻みが読めず捨てたまとまりは「届いている」に数えない（捨てた数は状態に出る）', () => {
    const t = setup()
    feed(t, waves(100))
    const fedBefore = t.detection.snapshot().triggers[0].lastFedAtMs
    const bad = { ...waves(1)[0], firstSampleMs: T0 + 100_000, msPerSample: Number.NaN }
    t.setNow(T0 + 10 * 60_000)
    t.detection.pushStationWave(bad)
    const [tr] = t.detection.snapshot().triggers
    expect(tr.lastFedAtMs).toBe(fedBefore)
    expect(tr.droppedChunks).toBe(1)
    const [l] = t.detection.hourlyLines(T0, T0 + 10 * 60_000)
    expect(l.line).toContain('波形が届いていない')
  })
})

describe('formatDetectionHourly — 数の見せ方', () => {
  const base: StationTriggerStatus = {
    stationId: 'station-1',
    lastSampleMs: T0,
    firstSampleMs: T0,
    lastFedAtMs: T0,
    droppedChunks: 0,
    armed: true,
    warmUntilMs: null,
    inEvent: false,
    baselineGal: 0.16,
    ratio: 1,
    onRatio: 2.5,
    peak24h: { ratio: 1.59, atMs: T0 },
    peakWindowFromMs: T0,
  }

  it('平らな値しか来ていなければ、平常時の揺れを「0 gal」と出す（0.00 と丸めて紛れさせない）', () => {
    const l = formatDetectionHourly({ ...base, baselineGal: 0 }, { ratio: 0, atMs: T0 }, T0)
    expect(l.line).toContain('平常時の揺れ 0 gal')
  })

  it('0.01 gal に満たない平常時の揺れは「0.01 gal 未満」と出す', () => {
    const l = formatDetectionHourly({ ...base, baselineGal: 0.004 }, { ratio: 1.2, atMs: T0 }, T0)
    expect(l.line).toContain('平常時の揺れ 0.01 gal 未満')
  })

  it('引き金を引いた揺れがあった時間は、比の最大が引き金を超える（行の形は同じ）', () => {
    const l = formatDetectionHourly({ ...base, lastFedAtMs: T0 + 119_000 }, { ratio: 5.31, atMs: T0 + 90_000 }, T0 + 120_000)
    expect(l.level).toBe('log')
    expect(l.line).toBe('[detect] station-1 この 1 時間: 比の最大 5.31 倍（13:25）・平常時の揺れ 0.16 gal・見張り中')
  })

  it('助走が明ける時刻を持たない（フィルタを組めず待っている）ときは、残り秒数を言わない', () => {
    const l = formatDetectionHourly({ ...base, armed: false, warmUntilMs: null }, null, T0)
    expect(l.line).toMatch(/・助走中$/)
    expect(l.line).not.toContain('あと 0 秒')
  })
})

describe('emitDetectionHourly — 1 時間の行を出し、起点を進めてよいかを返す', () => {
  const line = { level: 'log' as const, key: 'hourly:station-1', line: '[detect] station-1 この 1 時間: x' }

  it('正: 組めたら全行を出し、true（起点を進めてよい）を返す', () => {
    const out: string[] = []
    const errors: string[] = []
    const ok = emitDetectionHourly(() => [line, line], (l) => out.push(l.key), (m) => errors.push(m))
    expect(ok).toBe(true)
    expect(out).toHaveLength(2)
    expect(errors).toEqual([])
  })

  it('安全弁: 組む途中で投げたら 1 行も出さず、理由を渡して false（起点を進めない）を返す。自分は投げない', () => {
    const out: string[] = []
    const errors: string[] = []
    let ok = true
    expect(() => {
      ok = emitDetectionHourly(
        () => {
          throw new Error('boom')
        },
        (l) => out.push(l.key),
        (m) => errors.push(m),
      )
    }).not.toThrow()
    expect(ok).toBe(false)
    expect(out).toEqual([])
    expect(errors).toEqual(['boom'])
  })
})
