import { describe, expect, it } from 'vitest'

import type { FusedWaveChunk } from '../receiver/sensorFusion'
import type { StationConfig } from '../receiver/stationConfig'
import type { P2pReferenceQuake } from './p2pQuake'
import type { ShakeEventRecord } from './shakeEvent'
import { StationDetection, sensorsOf } from './stationDetection'

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
      driver: { boardKey: 'mac:020000000001', sensorId: 'i2c0-68' },
      firstSampleIndex: i0,
      firstSampleMs: T0 + i0 * DT,
      msPerSample: DT,
      gal,
      dcGal: [[], [], []],
      memberCount: Array(30).fill(9),
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
