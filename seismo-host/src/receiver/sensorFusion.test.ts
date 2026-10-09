import { afterEach, describe, expect, it, vi } from 'vitest'

import { IntensityStream } from '../intensity/intensityStream'
import type { BoardKey, SensorPacket } from '../protocol/types'
import { IntensityPipeline } from './intensityPipeline'
import type { WaveChunk } from './intensityPipeline'
import {
  FUSION_LIVE_MS,
  FUSION_MAX_FUTURE_MS,
  FUSION_WAIT_MS_DEFAULT,
  STATION_CHUNK_POINTS,
  STATION_GRID_MS,
  SensorFusion,
} from './sensorFusion'
import type { FusedWaveChunk, FusionOutcome, StationIntensityReading } from './sensorFusion'
import { StationDirectory } from './stationConfig'
import type { StationConfig } from './stationConfig'
import { defaultAxes } from './stationConfigTypes'

const IDENTITY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const

/**
 * 観測点の目盛りのまとまり（300 ms）の境目に乗る時刻。**境目に揃えておくと、
 * センサーのまとまりと出てくるまとまりが 1 対 1 になって読みやすい**（揃えない形は
 * 実機の到着を写したテストが見る）。
 */
const T0 = 1_790_181_865_800
const CHUNK_MS = STATION_GRID_MS * STATION_CHUNK_POINTS
const HZ = 1000 / STATION_GRID_MS

/**
 * 待ちを 0 にする指定。**届いたまとまりの末尾まで時刻が進めば、その場で出す。**
 * 待ちと、重み付き平均・差分・流し込みの検証を独立に読むためのもの
 * （待ちそのものは「待って顔ぶれを揃える」の節が見る）。
 */
const NO_WAIT = { waitMs: 0 }

const BOARD_A: BoardKey = 'mac:aaaaaaaaaaaa'
const BOARD_B: BoardKey = 'mac:bbbbbbbbbbbb'
const BOARD_C: BoardKey = 'mac:cccccccccccc'
const BOARD_D: BoardKey = 'mac:dddddddddddd'

type SensorEntry = StationConfig['boards'][number]['sensors'][number]

function sensorEntry(sensorId: string, noiseDensity: number | null, enabled = true): SensorEntry {
  return { sensorId, enabled, axes: defaultAxes(3), noiseDensity }
}

/** 観測点 1 つに、基板 1 枚ずつのセンサーを並べた設定。**並び順は引数の順。** */
function stationConfig(
  members: readonly { boardKey: BoardKey; sensorId: string; noiseDensity: number | null; enabled?: boolean }[],
): StationConfig {
  return {
    stations: [{ stationId: 'home', displayName: '自宅', lat: 35.6, lon: 139.7 }],
    boards: members.map((m) => ({
      boardKey: m.boardKey,
      stationId: 'home',
      orientation: IDENTITY,
      sensors: [sensorEntry(m.sensorId, m.noiseDensity, m.enabled ?? true)],
    })),
  }
}

function twoSensorConfig(
  a: { noiseDensity: number | null; enabled?: boolean },
  b: { noiseDensity: number | null; enabled?: boolean },
): StationConfig {
  return stationConfig([
    { boardKey: BOARD_A, sensorId: 'sensorA', ...a },
    { boardKey: BOARD_B, sensorId: 'sensorB', ...b },
  ])
}

function wave(over: Partial<WaveChunk> & { boardKey: BoardKey; sensorId: string }): WaveChunk {
  const n = over.gal?.[0].length ?? 1
  return {
    streamKey: `${over.boardKey}|${over.sensorId}|boot1`,
    segmentId: 1,
    channels: ['HN1', 'HN2', 'HN3'],
    firstSampleIndex: 0,
    firstSampleMs: T0,
    msPerSample: STATION_GRID_MS,
    timebaseNominalReason: null,
    gal: [new Array(n).fill(0), new Array(n).fill(0), new Array(n).fill(0)],
    ...over,
  }
}

function rows(n: number, v: number): [number[], number[], number[]] {
  return [new Array(n).fill(v), new Array(n).fill(v), new Array(n).fill(v)]
}

/** 目盛りの `k` 番目（`T0` から数えて）から `n` サンプル、刻み 10 ms のまとまり。 */
function gridChunk(
  boardKey: BoardKey,
  sensorId: string,
  k: number,
  gal: [number[], number[], number[]],
  over: Partial<WaveChunk> = {},
): WaveChunk {
  return wave({ boardKey, sensorId, firstSampleIndex: k, firstSampleMs: T0 + k * STATION_GRID_MS, gal, ...over })
}

/** 合成波形の値を、落とした直流を足し戻して読む（＝落とす前の「校正済み gal の重み付き平均」）。 */
function restored(w: FusedWaveChunk, axis: number, i: number): number {
  return w.gal[axis][i] + w.dcGal[axis][i]
}

function wavesOf(outs: readonly FusionOutcome[]): FusedWaveChunk[] {
  return outs.map((o) => o.fusedWave)
}

/** 出た合成波形が、目盛りの上で隙間なく続いているか。**続いていなければ最初の切れ目の位置を返す。** */
function firstBreak(waves: readonly FusedWaveChunk[]): number | null {
  for (let i = 1; i < waves.length; i++) {
    const prev = waves[i - 1]
    if (waves[i].firstSampleIndex !== prev.firstSampleIndex + prev.gal[0].length) return i
  }
  return null
}

/**
 * 時計の合っている台が届けた形で流す（受け取った時刻＝そのまとまりの末尾のサンプルの時刻）。
 * **時計が飛ぶ形を作るテストは、受け取った時刻を明示して `fusion.ingest()` を呼ぶこと。**
 */
function ingestNow(fusion: SensorFusion, w: WaveChunk): readonly FusionOutcome[] {
  return fusion.ingest(w, w.firstSampleMs + (w.gal[0].length - 1) * w.msPerSample)
}

describe('SensorFusion.groupedStationIds', () => {
  it('正: 2 台とも有効なら、その観測点が含まれる', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    expect(fusion.groupedStationIds).toEqual(['home'])
  })

  it('対照: 2 台のうち 1 台が無効なら、有効なセンサーが 1 台だけになり含まれない', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20, enabled: false }))
    expect(fusion.groupedStationIds).toEqual([])
  })

  it('安全弁: 割り当てが無い（空の設定）なら空配列', () => {
    const fusion = new SensorFusion({ stations: [], boards: [] })
    expect(fusion.groupedStationIds).toEqual([])
  })
})

describe('SensorFusion.ingest — グループ化と対象外の扱い', () => {
  it('対照: 観測点に割り当てが無いセンサーは合成の対象にならない', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    expect(ingestNow(fusion, gridChunk(BOARD_C, 'lonely', 0, rows(30, 100)))).toEqual([])
    expect(fusion.closeAll().drained).toEqual([])
  })

  it('安全弁: 観測点に 1 台しか割り当てが無ければ、その 1 台も合成対象にならない', () => {
    const config = twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 })
    const fusion = new SensorFusion({ ...config, boards: [config.boards[0]] }, NO_WAIT)
    expect(ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, rows(30, 100)))).toEqual([])
  })

  it('安全弁: enabled:false のセンサーはグループに入らない（相方が居ないのと同じ扱いになる）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20, enabled: false }), NO_WAIT)
    ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', 0, rows(30, 50)))
    expect(ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, rows(30, 100)))).toEqual([])
  })
})

describe('SensorFusion.ingest — 観測点の目盛り', () => {
  it('正: 刻みは 10 ms 固定・位置は絶対時刻の通し番号（センサーの刻みが揺らいでも）', () => {
    // 実機の刻みは基板ごとに 9.979〜10.018 ms で揺らぐ。**それを合成の刻みへ持ち込むと、
    // PWA は刻みが 0.5% 動いたところで溜めた波形を捨てる**ので、目盛りは固定にする。
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    const outs: FusionOutcome[] = []
    for (let c = 0; c < 6; c++) {
      outs.push(
        ...ingestNow(fusion, 
          wave({ boardKey: BOARD_A, sensorId: 'sensorA', firstSampleMs: T0 + 7 + c * 31 * 9.9792, msPerSample: 9.9792, gal: rows(31, 1) }),
        ),
        ...ingestNow(fusion, 
          wave({ boardKey: BOARD_B, sensorId: 'sensorB', firstSampleMs: T0 + 3 + c * 30 * 10.0178, msPerSample: 10.0178, gal: rows(30, 1) }),
        ),
      )
    }
    outs.push(...fusion.closeAll().drained)
    const waves = wavesOf(outs)
    expect(waves.length).toBeGreaterThan(0)
    for (const w of waves) {
      expect(w.msPerSample).toBe(STATION_GRID_MS)
      expect(w.firstSampleMs).toBe(w.firstSampleIndex * STATION_GRID_MS)
    }
    expect(firstBreak(waves)).toBeNull()
  })

  it('正: まとまりの境目は絶対時刻で決まる（300 ms の倍数）。届き方によらない', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    const outs: FusionOutcome[] = []
    // 境目からずれた位置（目盛り 13 番目）から始まるセンサー。
    for (let c = 0; c < 4; c++) {
      outs.push(...ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 13 + c * 30, rows(30, 1))))
      outs.push(...ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', 13 + c * 30, rows(30, 1))))
    }
    outs.push(...fusion.closeAll().drained)
    const waves = wavesOf(outs)
    // 先頭は境目の手前で切れ（13〜29）、以後は境目から 30 点ずつ。
    expect(waves[0].firstSampleIndex).toBe(T0 / STATION_GRID_MS + 13)
    for (const w of waves.slice(1)) {
      expect(w.firstSampleMs % CHUNK_MS).toBe(0)
    }
  })
})

describe('SensorFusion.ingest — 重み付き平均と差分', () => {
  it('正: 1 台だけが届いていれば、合成値はその台の値になる（memberCount=1）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    const [out] = ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, rows(30, 100)))
    expect(restored(out.fusedWave, 0, 5)).toBeCloseTo(100, 9)
    expect(out.fusedWave.memberCount.every((m) => m === 1)).toBe(true)
  })

  it('正: 両方届けば、重み（ノイズ密度の逆数分散）付きの平均になる', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }))
    expect(ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', 0, rows(30, 50)))).toEqual([])
    const [out] = ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, rows(30, 100)))
    // wA=1/10²=0.01, wB=1/20²=0.0025 → (0.01*100 + 0.0025*50) / 0.0125 = 90
    expect(restored(out.fusedWave, 0, 0)).toBeCloseTo(90, 9)
    expect(out.fusedWave.memberCount.every((m) => m === 2)).toBe(true)
    expect(out.allMembersCovered).toBe(true)
  })

  it('正: ノイズ密度が片方でも未申告なら、グループ全体を単純平均へ倒す', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: null }, { noiseDensity: 100 }))
    ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', 0, rows(30, 50)))
    const [out] = ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, rows(30, 100)))
    expect(restored(out.fusedWave, 0, 0)).toBeCloseTo(75, 9)
  })

  it('正: 成分ごとの本数（axisMemberCount）を持ち、3 軸の台では 3 成分とも同じ', () => {
    // 2 軸の台を後から受けるための備え。**今の台はどれも 3 軸なので値は揃う**。
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }))
    ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', 0, rows(30, 50)))
    const [out] = ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, rows(30, 100)))
    for (let axis = 0; axis < 3; axis++) expect(out.fusedWave.axisMemberCount[axis]).toEqual(out.fusedWave.memberCount)
  })

  it('正: 差分 d=(a1-a2)/2 を出す（メンバー順は設定の並び順）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }))
    // sensorA: [0, 100, 0, …] → 2 サンプル目の直流は (0+100)/2 = 50 なので 100-50 = 50。
    const a = rows(30, 0)
    a[0][1] = 100
    ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', 0, rows(30, 0)))
    const [out] = ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, a))
    expect(out.pairDiffs).toHaveLength(1)
    const d = out.pairDiffs[0]
    expect(d.memberA).toEqual({ boardKey: BOARD_A, sensorId: 'sensorA' })
    expect(d.memberB).toEqual({ boardKey: BOARD_B, sensorId: 'sensorB' })
    expect(d.firstSampleIndex).toBe(out.fusedWave.firstSampleIndex)
    expect(d.msPerSample).toBe(STATION_GRID_MS)
    expect(d.diffGal[0][1]).toBeCloseTo(25, 9)
  })

  it('正: 取り付けの向き・感度のずれ（直流の差）は差分に現れない', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }))
    const b = rows(30, 0)
    b[2].fill(662)
    const a = rows(30, 0)
    a[2].fill(1200)
    ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', 0, b))
    const [out] = ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, a))
    expect(out.pairDiffs[0].diffGal[2][10]).toBeCloseTo(0, 9)
  })

  it('正: 3 台のグループでは全ペア（3 組）の差分が出る', () => {
    const fusion = new SensorFusion(
      stationConfig([
        { boardKey: BOARD_A, sensorId: 'sensorA', noiseDensity: 50 },
        { boardKey: BOARD_B, sensorId: 'sensorB', noiseDensity: 5 },
        { boardKey: BOARD_C, sensorId: 'sensorC', noiseDensity: 20 },
      ]),
    )
    ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, rows(30, 100)))
    ingestNow(fusion, gridChunk(BOARD_C, 'sensorC', 0, rows(30, 100)))
    const [out] = ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', 0, rows(30, 50)))
    expect(out.fusedWave.memberCount.every((m) => m === 3)).toBe(true)
    expect(out.pairDiffs).toHaveLength(3)
  })
})

describe('SensorFusion.ingest — 刻みの違う台を目盛りへ揃える（補間）', () => {
  /** 時刻に比例する値。**線形補間なら、どの時刻でも誤差なく引ける。** */
  function ramp(tMs: number): number {
    return (tMs - T0) * 0.5
  }

  function rampChunk(boardKey: BoardKey, sensorId: string, firstMs: number, n: number, mps: number): WaveChunk {
    const g: [number[], number[], number[]] = [[], [], []]
    for (let i = 0; i < n; i++) {
      const v = ramp(firstMs + i * mps)
      g[0].push(v)
      g[1].push(-v)
      g[2].push(1000 + v)
    }
    return wave({ boardKey, sensorId, firstSampleMs: firstMs, msPerSample: mps, gal: g })
  }

  it('正: 104 Hz の台と 100 Hz の台が混ざっても、目盛りの時刻の値を引く', () => {
    // IIS2ICLX は 104 Hz。**最寄りのサンプルを当てると最大で半サンプル（約 5 ms）ずれる。**
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 10 }))
    const mps104 = 1000 / 104
    ingestNow(fusion, rampChunk(BOARD_B, 'sensorB', T0 - 3, 40, mps104))
    const outs = ingestNow(fusion, rampChunk(BOARD_A, 'sensorA', T0, 30, STATION_GRID_MS))
    expect(outs).toHaveLength(1)
    const w = outs[0].fusedWave
    for (let i = 0; i < w.gal[0].length; i++) {
      const t = w.firstSampleMs + i * STATION_GRID_MS
      expect(w.memberCount[i]).toBe(2)
      expect(restored(w, 0, i)).toBeCloseTo(ramp(t), 6)
      expect(restored(w, 1, i)).toBeCloseTo(-ramp(t), 6)
      expect(restored(w, 2, i)).toBeCloseTo(1000 + ramp(t), 6)
    }
  })

  it('安全弁: 外へは延ばさない（最後のサンプルより後の目盛りには混ざらない）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 10 }), NO_WAIT)
    // sensorB は目盛り 0〜14 だけ持つ。
    ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', 0, rows(15, 50)))
    const outs = ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, rows(30, 100)))
    const counts = wavesOf(outs).flatMap((w) => [...w.memberCount])
    expect(counts.slice(0, 15).every((m) => m === 2)).toBe(true)
    expect(counts.slice(15).every((m) => m === 1)).toBe(true)
  })

  it('安全弁: 刻みの 1.5 倍を超える隙間は補間でまたがない', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 10 }))
    // sensorB は目盛り 10〜12 が抜けている（13 番目から再開）。
    ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', 0, rows(10, 50)))
    ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', 13, rows(17, 50)))
    const outs = ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, rows(30, 100)))
    const counts = wavesOf(outs).flatMap((w) => [...w.memberCount])
    expect(counts.slice(0, 10).every((m) => m === 2)).toBe(true)
    expect(counts.slice(10, 13)).toEqual([1, 1, 1])
    expect(counts.slice(13).every((m) => m === 2)).toBe(true)
  })
})

describe('SensorFusion.ingest — 待って顔ぶれを揃える（#362・#374）', () => {
  /** 実機と同じ 1 まとまり 30 サンプル（約 300ms）。 */
  const WIDE_CHUNK = 30

  /**
   * 実機（2026-09-30・3 基板 × 3 センサー）の到着の形を写した 9 本。数値は
   * `/stream?wave=all` の実測（中央値）。**位相（まとまりの境目）・到着の遅れ・刻みの
   * 3 つが揃って初めて #374 の症状が出る。** 基板の識別子は架空のもの。
   */
  const REAL_SENSORS = [
    { boardKey: BOARD_A, sensorId: 'a1', phase: 229, lag: 0, mps: 9.9792 },
    { boardKey: BOARD_A, sensorId: 'a2', phase: 276, lag: -56, mps: 10.0073 },
    { boardKey: BOARD_A, sensorId: 'a3', phase: 98, lag: -42, mps: 9.9989 },
    { boardKey: BOARD_B, sensorId: 'b1', phase: 184, lag: -41, mps: 10.0087 },
    { boardKey: BOARD_B, sensorId: 'b2', phase: 24, lag: -33, mps: 9.9982 },
    { boardKey: BOARD_B, sensorId: 'b3', phase: 272, lag: -35, mps: 10.0006 },
    { boardKey: BOARD_C, sensorId: 'c1', phase: 21, lag: 144, mps: 10.0052 },
    { boardKey: BOARD_C, sensorId: 'c2', phase: 149, lag: 5, mps: 10.0178 },
    { boardKey: BOARD_C, sensorId: 'c3', phase: 195, lag: 142, mps: 10.0018 },
  ] as const

  function nineSensorConfig(): StationConfig {
    const byBoard = new Map<BoardKey, SensorEntry[]>()
    const order: BoardKey[] = []
    for (const s of REAL_SENSORS) {
      if (!order.includes(s.boardKey)) order.push(s.boardKey)
      const list = byBoard.get(s.boardKey) ?? []
      list.push(sensorEntry(s.sensorId, null))
      byBoard.set(s.boardKey, list)
    }
    return {
      stations: [{ stationId: 'home', displayName: '自宅', lat: 35.6, lon: 139.7 }],
      boards: order.map((boardKey) => ({ boardKey, stationId: 'home', orientation: IDENTITY, sensors: byBoard.get(boardKey) ?? [] })),
    }
  }

  /** 決まった形の揺れ（センサーごとに同じ物理量）。 */
  function shakeAt(tMs: number): number {
    const t = (tMs - T0) / 1000
    return 3 * Math.sin(2 * Math.PI * 2 * t) + Math.cos(2 * Math.PI * 7 * t)
  }

  function skewedEvents(rounds: number, sensors: readonly (typeof REAL_SENSORS)[number][] = REAL_SENSORS) {
    const events: { at: number; wave: WaveChunk }[] = []
    for (const s of sensors) {
      for (let k = 0; k < rounds; k++) {
        const firstSampleMs = T0 + s.phase + k * WIDE_CHUNK * s.mps
        const g: [number[], number[], number[]] = [[], [], []]
        for (let i = 0; i < WIDE_CHUNK; i++) {
          const v = shakeAt(firstSampleMs + i * s.mps)
          g[0].push(v)
          g[1].push(v)
          g[2].push(980 + v)
        }
        events.push({
          at: firstSampleMs + WIDE_CHUNK * s.mps + s.lag,
          wave: wave({ boardKey: s.boardKey, sensorId: s.sensorId, firstSampleIndex: k * WIDE_CHUNK, firstSampleMs, msPerSample: s.mps, gal: g }),
        })
      }
    }
    return events
  }

  /** 到着順に流す（実機の形）。`sortByData` なら、データの時刻順に流す（作り直しの形）。 */
  function runSkewed(waitMs: number, rounds: number, sortByData = false) {
    const fusion = new SensorFusion(nineSensorConfig(), { dcWindowSec: 1, stepSec: 1, waitMs })
    const events = skewedEvents(rounds)
    if (sortByData) events.sort((a, b) => a.wave.firstSampleMs - b.wave.firstSampleMs || a.wave.sensorId.localeCompare(b.wave.sensorId))
    else events.sort((a, b) => a.at - b.at || a.wave.sensorId.localeCompare(b.wave.sensorId))
    const outs: FusionOutcome[] = []
    for (const e of events) outs.push(...ingestNow(fusion, e.wave))
    const live = outs.length
    outs.push(...fusion.closeAll().drained)
    return { outs, live }
  }

  /** 立ち上がり（全員の最初のまとまりが揃う前）と、データの尽きる末尾を除いた本数。 */
  function settledCounts(outs: readonly FusionOutcome[]): number[] {
    return wavesOf(outs).slice(3, -3).flatMap((w) => [...w.memberCount])
  }

  it('正: 既定の待ちなら、まとまりの頭から末尾まで顔ぶれが揃う（#374）', () => {
    const { outs } = runSkewed(FUSION_WAIT_MS_DEFAULT, 20)
    const counts = settledCounts(outs)
    expect(counts.length).toBeGreaterThan(0)
    expect(new Set(counts)).toEqual(new Set([9]))
  })

  it('対照: 待ちを 0 にすると顔ぶれが欠ける（症状の条件が作れていることの裏取り）', () => {
    // **全員が揃うのを待つ判定**が働いていれば 0 でも揃う —— 待ちが要るのは
    // 「まだ届いていない台」を生きている扱いにしたときだけ。ここで見ているのは、
    // 揃ったかの判定を外したら（待ち 0 で、届いた端から出したら）欠けること。
    const fusion = new SensorFusion(nineSensorConfig(), { dcWindowSec: 1, stepSec: 1, waitMs: 0 })
    const events = skewedEvents(20).sort((a, b) => a.at - b.at || a.wave.sensorId.localeCompare(b.wave.sensorId))
    const outs: FusionOutcome[] = []
    for (const e of events) outs.push(...ingestNow(fusion, e.wave))
    // 揃った回に出るので、待ち 0 でも揃っていれば 9。**欠けるのは時刻で切り上げた回だけ。**
    // 待ち 0 では「末尾まで時刻が進んだ」が即座に成り立つので、遅れて届く台が欠ける。
    expect(settledCounts(outs).some((m) => m < 9)).toBe(true)
  })

  it('対照: 顔ぶれが揃っていれば、待ちの上限を延ばしても出る件数は変わらない', () => {
    const base = runSkewed(FUSION_WAIT_MS_DEFAULT, 20).live
    const longer = runSkewed(FUSION_WAIT_MS_DEFAULT * 4, 20).live
    expect(longer).toBe(base)
  })

  it('正: 届いた順に流しても、データの時刻順に流しても（作り直しの形）、同じ合成になる', () => {
    // **作り直し（`stationRewave.ts`）は生データを時刻順に流し直す。** ライブで全員が
    // 間に合っていた区間は、作り直しても同じ値・同じ切れ目になること —— 目盛りが
    // 絶対時刻で決まるので、届き方に依らない。
    const live = wavesOf(runSkewed(FUSION_WAIT_MS_DEFAULT, 20).outs)
    const rewave = wavesOf(runSkewed(FUSION_WAIT_MS_DEFAULT, 20, true).outs)
    const byIndex = new Map(rewave.map((w) => [w.firstSampleIndex, w]))
    const compared = live.slice(3, -3)
    expect(compared.length).toBeGreaterThan(0)
    for (const w of compared) {
      const r = byIndex.get(w.firstSampleIndex)
      expect(r).toBeDefined()
      expect(r?.memberCount).toEqual(w.memberCount)
      for (let i = 0; i < w.gal[0].length; i++) expect(r?.gal[0][i]).toBeCloseTo(w.gal[0][i], 9)
    }
  })

  it('安全弁: 一度も届かない台があっても、上限で切り上げて出す', () => {
    const fusion = new SensorFusion(nineSensorConfig(), { dcWindowSec: 1, stepSec: 1, waitMs: FUSION_WAIT_MS_DEFAULT })
    const events = skewedEvents(20, [REAL_SENSORS[0], REAL_SENSORS[1]]).sort((a, b) => a.at - b.at)
    const outs: FusionOutcome[] = []
    for (const e of events) outs.push(...ingestNow(fusion, e.wave))
    expect(outs.length).toBeGreaterThan(0)
    expect(outs.some((o) => !o.allMembersCovered)).toBe(true)
  })

  it('正: closeAll() は待たせていた分を、届いたデータの末尾まで drained へ返す（#402）', () => {
    const fusion = new SensorFusion(nineSensorConfig(), { dcWindowSec: 1, stepSec: 1, waitMs: FUSION_WAIT_MS_DEFAULT })
    const events = skewedEvents(20, [REAL_SENSORS[0], REAL_SENSORS[1]]).sort((a, b) => a.at - b.at)
    const live: FusionOutcome[] = []
    for (const e of events) live.push(...ingestNow(fusion, e.wave))
    const closed = fusion.closeAll()
    // 症状の条件が作れていることの裏取り —— 待たせていた分が無ければ何も見ていない。
    expect(closed.drained.length).toBeGreaterThan(0)
    const all = wavesOf([...live, ...closed.drained])
    expect(firstBreak(all)).toBeNull()
    // 最後に出た目盛りは、届いたデータの末尾に届いている。
    const lastData = Math.max(...events.map((e) => e.wave.firstSampleMs + (WIDE_CHUNK - 1) * e.wave.msPerSample))
    const last = all[all.length - 1]
    const lastGridMs = last.firstSampleMs + (last.gal[0].length - 1) * STATION_GRID_MS
    expect(lastData - lastGridMs).toBeLessThan(STATION_GRID_MS)
    for (const o of closed.drained) expect(o.pairDiffs.length).toBeGreaterThan(0)
    expect(closed.failures).toEqual([])
  })

  it('対照: 待たせていた分が無ければ drained は空', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    for (let c = 0; c < 5; c++) {
      ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', c * 30, rows(30, 1)))
      ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', c * 30, rows(30, 1)))
    }
    expect(fusion.closeAll().drained).toEqual([])
  })
})

describe('SensorFusion.ingest — 1 台が止まっても観測点は続く', () => {
  const OPTS = { dcWindowSec: 1, stepSec: 1, waitMs: FUSION_WAIT_MS_DEFAULT }

  function threeConfig(): StationConfig {
    // sensorA がいちばん静か（以前の作りでは、この 1 台が合成を進める「駆動役」だった）。
    return stationConfig([
      { boardKey: BOARD_A, sensorId: 'sensorA', noiseDensity: 5 },
      { boardKey: BOARD_B, sensorId: 'sensorB', noiseDensity: 20 },
      { boardKey: BOARD_C, sensorId: 'sensorC', noiseDensity: 20 },
    ])
  }

  function shake(k: number, n: number): [number[], number[], number[]] {
    const g: [number[], number[], number[]] = [[], [], []]
    for (let i = 0; i < n; i++) {
      const t = (k + i) / HZ
      g[0].push(20 * Math.sin(2 * Math.PI * 3 * t))
      g[1].push(20 * Math.cos(2 * Math.PI * 5 * t))
      g[2].push(1000 + 20 * Math.sin(2 * Math.PI * 7 * t))
    }
    return g
  }

  /**
   * 全員を 300 ms ずつ `rounds` 回流す。`skip(member, round)` が真の回はその台を送らない。
   * 返すのは、出た結果と、その結果が出た回。
   */
  function run(rounds: number, skip: (sensorId: string, round: number) => boolean) {
    const fusion = new SensorFusion(threeConfig(), OPTS)
    const emitted: { round: number; out: FusionOutcome }[] = []
    for (let r = 0; r < rounds; r++) {
      for (const [boardKey, sensorId] of [
        [BOARD_A, 'sensorA'],
        [BOARD_B, 'sensorB'],
        [BOARD_C, 'sensorC'],
      ] as const) {
        if (skip(sensorId, r)) continue
        for (const out of ingestNow(fusion, gridChunk(boardKey, sensorId, r * 30, shake(r * 30, 30)))) emitted.push({ round: r, out })
      }
    }
    for (const out of fusion.closeAll().drained) emitted.push({ round: rounds, out })
    return emitted
  }

  it('正: いちばん静かな 1 台が 2 秒止まっても、波形も震度も途切れない', () => {
    // 2026-10-07 13:42 の実機: 「駆動役」の基板が FIFO あふれで 2〜3 秒ずつ欠け、
    // **ほかの 2 枚が持っていたのに**観測点の波形に穴が残った。
    const emitted = run(40, (id, r) => id === 'sensorA' && r >= 14 && r < 21)
    const waves = emitted.map((e) => e.out.fusedWave)
    expect(firstBreak(waves)).toBeNull()
    const counts = waves.flatMap((w) => [...w.memberCount])
    expect(counts.slice(0, 14 * 30).every((m) => m === 3)).toBe(true)
    expect(counts.slice(14 * 30, 21 * 30).every((m) => m === 2)).toBe(true)
    expect(counts.slice(21 * 30).every((m) => m === 3)).toBe(true)
    // 震度は最初の 1 回だけ作り、以後は作り直さない（止まった間も続く）。
    const changed = emitted.filter((e) => e.out.intensityStateChanged)
    expect(changed).toHaveLength(1)
    const readings = emitted.flatMap((e) => e.out.readings)
    expect(readings.length).toBeGreaterThan(10)
    for (let i = 1; i < readings.length; i++) expect(readings[i].atMs - readings[i - 1].atMs).toBe(1000)
  })

  it('対照: 全員が止まった区間は欠けになり、震度はそこで作り直す', () => {
    const emitted = run(40, (_, r) => r >= 14 && r < 21)
    const waves = emitted.map((e) => e.out.fusedWave)
    const at = firstBreak(waves)
    expect(at).not.toBeNull()
    expect(waves[at as number].firstSampleMs - T0).toBe(21 * CHUNK_MS)
    expect(emitted.filter((e) => e.out.intensityStateChanged)).toHaveLength(2)
  })

  it('安全弁: 止まった 1 台を毎回待たない（生きている扱いを外れたら、揃った回にすぐ出す）', () => {
    const emitted = run(60, (id, r) => id === 'sensorA' && r >= 10)
    /** 目盛りのまとまり番号ごとに、それが出た回。 */
    const roundOf = new Map<number, number>()
    for (const e of emitted) roundOf.set((e.out.fusedWave.firstSampleMs - T0) / CHUNK_MS, e.round)
    // 止まった直後は「まだ生きているかもしれない」ので待ちの上限（2 回ぶん）まで待つ。
    expect(roundOf.get(12)).toBeGreaterThan(12)
    // 生きている扱いを外れた後（`FUSION_LIVE_MS` の後）は、その回のうちに出る。
    const staleRound = 10 + Math.ceil(FUSION_LIVE_MS / CHUNK_MS) + 2
    for (let r = staleRound; r < 59; r++) expect(roundOf.get(r)).toBe(r)
  })

  it('正: 1 台の区間（segmentId）が変わっても、震度の流し込みは作り直さない', () => {
    // 以前は「駆動役」の区間が切れるたびに観測点の震度が 60 秒の助走からやり直しだった
    // （その台の再起動・パケット落ち・FIFO あふれのたび）。
    const fusion = new SensorFusion(threeConfig(), OPTS)
    const outs: FusionOutcome[] = []
    for (let r = 0; r < 20; r++) {
      outs.push(...ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', r * 30, shake(r * 30, 30), { segmentId: r < 10 ? 1 : 2 })))
      outs.push(...ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', r * 30, shake(r * 30, 30))))
      outs.push(...ingestNow(fusion, gridChunk(BOARD_C, 'sensorC', r * 30, shake(r * 30, 30))))
    }
    expect(outs.filter((o) => o.intensityStateChanged)).toHaveLength(1)
  })
})

describe('SensorFusion.ingest — 時刻の外れたデータ', () => {
  it('安全弁: 一度出した目盛りより前に届いたサンプルは混ぜず、数える', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, rows(30, 1)))
    ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 30, rows(30, 1)))
    expect(fusion.lateSamples).toBe(0)
    // 0〜29 はもう出した。sensorB のその区間は遅すぎる。
    expect(ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', 0, rows(30, 1)))).toEqual([])
    expect(fusion.lateSamples).toBeGreaterThan(0)
  })

  /** 目盛りの `k` から 30 サンプルのまとまりを、本当の時刻どおりに受け取った時刻（末尾のサンプルの本当の時刻）。 */
  const trueRx = (k: number): number => T0 + (k + 29) * STATION_GRID_MS

  it('安全弁: 1 台だけ時計が大きく先へ飛んだら、その台の分は混ぜずに数え、観測点は止まらない', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }))
    const outs: FusionOutcome[] = []
    for (let r = 0; r < 10; r++) {
      outs.push(...ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', r * 30, rows(30, 1))))
      // sensorB は 5 回目から 1 時間先の時刻を名乗る（受け取るのは本当の時刻）。
      const k = r < 5 ? r * 30 : r * 30 + 360_000
      outs.push(...fusion.ingest(gridChunk(BOARD_B, 'sensorB', k, rows(30, 1)), trueRx(r * 30)))
    }
    expect(fusion.futureSamples).toBe(5 * 30)
    // sensorA の分は途切れず出続ける。
    const waves = wavesOf(outs)
    expect(firstBreak(waves)).toBeNull()
    expect(waves.every((w) => w.firstSampleMs < T0 + 60_000)).toBe(true)
    expect(waves[waves.length - 1].firstSampleMs - T0).toBeGreaterThanOrEqual(7 * CHUNK_MS)
  })

  it('安全弁: 全員の時計が別々の先へ飛んでも、偽の時刻へ観測点ごと移らない', () => {
    // 台どうしを比べる形では、比べる相手がいなくなったときに、いちばん先へ飛んだ台の時刻へ移りうる。
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    const outs: FusionOutcome[] = []
    const rounds = 40
    for (let r = 0; r < rounds; r++) {
      outs.push(...fusion.ingest(gridChunk(BOARD_A, 'sensorA', r < 3 ? r * 30 : r * 30 + 360_000, rows(30, 1)), trueRx(r * 30)))
      outs.push(...fusion.ingest(gridChunk(BOARD_B, 'sensorB', r < 3 ? r * 30 : r * 30 + 720_000, rows(30, 1)), trueRx(r * 30)))
    }
    expect(outs.length).toBeGreaterThan(0)
    expect(wavesOf(outs).every((w) => w.firstSampleMs < T0 + 60_000)).toBe(true)
    expect(fusion.futureSamples).toBe(2 * (rounds - 3) * 30)
  })

  it('正: 全員が長く止まって揃って再開したときは、受け取った時刻も進むので混ぜる', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    const outs: FusionOutcome[] = []
    const gap = 360_000 // 1 時間止まっていた
    for (let r = 0; r < 10; r++) {
      const k = r < 5 ? r * 30 : r * 30 + gap
      outs.push(...fusion.ingest(gridChunk(BOARD_A, 'sensorA', k, rows(30, 1)), trueRx(k)))
      outs.push(...fusion.ingest(gridChunk(BOARD_B, 'sensorB', k, rows(30, 1)), trueRx(k)))
    }
    expect(fusion.futureSamples).toBe(0)
    expect(wavesOf(outs).some((w) => w.firstSampleIndex >= T0 / STATION_GRID_MS + gap)).toBe(true)
  })

  it('対照: 受け取った時刻から線（FUSION_MAX_FUTURE_MS）ちょうど先までは混ぜ、それを超える分だけを落とす（まとまりの途中で切る）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    // 20 番目（添字 19）のサンプルの時刻が、受け取った時刻 + 線ちょうど。
    const rx = T0 + 19 * STATION_GRID_MS - FUSION_MAX_FUTURE_MS
    fusion.ingest(gridChunk(BOARD_B, 'sensorB', 0, rows(30, 1)), rx)
    expect(fusion.futureSamples).toBe(10)
  })

  it('安全弁: 1 パケットだけ数十秒先を名乗っても、観測点はその間止まらない', () => {
    // 線を広く取ると、線の手前を名乗る 1 パケットで目盛りがそこまで進み、後から届く正しい時刻の分が
    // すべて「出した後」に落ちる（現実の時刻がその偽の時刻へ追いつくまで観測点が止まる）。
    // 待ちは既定のまま（0 にすると、先に届いた台だけで毎回まとまりが出て、もう 1 台が常に遅れて見える）。
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }))
    const outs: FusionOutcome[] = []
    for (let r = 0; r < 40; r++) {
      outs.push(...fusion.ingest(gridChunk(BOARD_A, 'sensorA', r * 30, rows(30, 1)), trueRx(r * 30)))
      // sensorB は 10 回目の 1 パケットだけ 30 秒先を名乗り、あとは正しい時刻に戻る。
      const k = r === 10 ? r * 30 + 3_000 : r * 30
      outs.push(...fusion.ingest(gridChunk(BOARD_B, 'sensorB', k, rows(30, 1)), trueRx(r * 30)))
    }
    expect(fusion.futureSamples).toBe(30)
    expect(fusion.lateSamples).toBe(0)
    const waves = wavesOf(outs)
    expect(firstBreak(waves)).toBeNull()
    expect(waves.every((w) => w.firstSampleMs < T0 + 60 * CHUNK_MS)).toBe(true)
    expect(waves[waves.length - 1].firstSampleMs - T0).toBeGreaterThanOrEqual(38 * CHUNK_MS)
  })

  it('対照: 線の内側（待ちより先・2 秒以内）の先回りは混ぜる。空く穴とほかの台の遅れはその幅までに収まり、後は続く', () => {
    // 線を狭めても、線の内側の先回りは残る。目盛りはその分だけ先へ進み、ほかの台の分は「出した後」に落ちる。
    // **失うのは先回りした幅まで**（その幅の穴が空くことがある）。数えるのは futureSamples ではなく lateSamples。
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }))
    const outs: FusionOutcome[] = []
    for (let r = 0; r < 40; r++) {
      outs.push(...fusion.ingest(gridChunk(BOARD_A, 'sensorA', r * 30, rows(30, 1)), trueRx(r * 30)))
      // sensorB は 10 回目の 1 パケットだけ 1.5 秒先を名乗る。
      const k = r === 10 ? r * 30 + 150 : r * 30
      outs.push(...fusion.ingest(gridChunk(BOARD_B, 'sensorB', k, rows(30, 1)), trueRx(r * 30)))
    }
    expect(fusion.futureSamples).toBe(0)
    expect(fusion.lateSamples).toBeGreaterThan(0)
    expect(fusion.lateSamples).toBeLessThanOrEqual(2 * (FUSION_MAX_FUTURE_MS / STATION_GRID_MS))
    const waves = wavesOf(outs)
    let holeMs = 0
    for (let i = 1; i < waves.length; i++) {
      const prev = waves[i - 1]
      holeMs += waves[i].firstSampleMs - (prev.firstSampleMs + prev.gal[0].length * STATION_GRID_MS)
    }
    expect(holeMs).toBeLessThanOrEqual(FUSION_MAX_FUTURE_MS)
    expect(waves[waves.length - 1].firstSampleMs - T0).toBeGreaterThanOrEqual(38 * CHUNK_MS)
  })

  it('対照: 受け取った時刻が判らない（記録に残っていない古い控え）ときは判定しない', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    for (let r = 0; r < 10; r++) {
      fusion.ingest(gridChunk(BOARD_A, 'sensorA', r * 30, rows(30, 1)), null)
      fusion.ingest(gridChunk(BOARD_B, 'sensorB', r < 5 ? r * 30 : r * 30 + 360_000, rows(30, 1)), null)
    }
    expect(fusion.futureSamples).toBe(0)
  })

  it('対照: ほかの台が止まっている間に進み続ける台は、時計が合っていれば混ぜ続ける', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    const outs: FusionOutcome[] = []
    for (let r = 0; r < 400; r++) {
      if (r < 5) outs.push(...ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', r * 30, rows(30, 1))))
      outs.push(...ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', r * 30, rows(30, 1))))
    }
    expect(fusion.futureSamples).toBe(0)
    expect(firstBreak(wavesOf(outs))).toBeNull()
  })

  it('安全弁: 2 度目の closeAll() は何もしない（投げずに空を返す）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, rows(30, 1)))
    fusion.closeAll()
    expect(fusion.closeAll()).toEqual({ drained: [], readings: [], failures: [] })
  })

  it('対照: 上限に届かなければ数えない（ふだんの流れでは 0）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    for (let r = 0; r < 260; r++) {
      ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', r * 30, rows(30, 1)))
      ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', r * 30, rows(30, 1)))
    }
    expect(fusion.discardedSamples).toBe(0)
  })

  it('安全弁: 全員が長く止まって揃って再開しても、観測点は動き出し、空のまとまりを 1 つずつ回さない', () => {
    // 11 日ぶん（約 330 万まとまり）。1 つずつ回すと時間切れになる。
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, rows(30, 1)))
    ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', 0, rows(30, 1)))
    const far = 100_000_000
    const outs = [
      ...ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', far, rows(30, 1))),
      ...ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', far, rows(30, 1))),
    ]
    expect(wavesOf(outs).some((w) => w.firstSampleIndex === T0 / STATION_GRID_MS + far)).toBe(true)
  })
})

describe('SensorFusion.ingest — 観測点ぶんの計測震度相当', () => {
  const OPTS = { dcWindowSec: 1, stepSec: 1, waitMs: 0 }

  /** 決まった形の揺れ。乱数は使わない —— 走るたびに値が変わると再現できない。 */
  function galRows(k: number, n: number, amp: number): [number[], number[], number[]] {
    const out: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
    for (let i = 0; i < n; i++) {
      const t = (k + i) / HZ
      out[0][i] = amp * Math.sin(2 * Math.PI * 3 * t)
      out[1][i] = amp * Math.cos(2 * Math.PI * 5 * t)
      out[2][i] = 1000 + amp * Math.sin(2 * Math.PI * 7 * t)
    }
    return out
  }

  function feedA(fusion: SensorFusion, k: number, n: number): readonly FusionOutcome[] {
    return ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', k, galRows(k, n, 40)))
  }

  it('正: 合成波形を計測震度の流し込みへ通し、観測点ぶんの震度が出る', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    const readings: StationIntensityReading[] = []
    for (let c = 0; c < 14; c++) for (const o of feedA(fusion, c * 30, 30)) readings.push(...o.readings)
    expect(readings.length).toBeGreaterThan(0)
    for (const r of readings) {
      expect(r.stationId).toBe('home')
      expect(typeof r.intensity).toBe('number')
    }
    expect(fusion.unusableIntensities).toBe(0)
  })

  it('正: 震度の時刻は目盛りの絶対時刻（流し込みを始めた位置から数えた秒）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    // 区間の途中にあたる位置（センサーの通し番号は 92949）から始めても、時刻は目盛りで決まる。
    const readings: StationIntensityReading[] = []
    for (let c = 0; c < 8; c++) {
      for (const o of ingestNow(fusion, 
        gridChunk(BOARD_A, 'sensorA', c * 30, galRows(c * 30, 30, 40), { firstSampleIndex: 92949 + c * 30 }),
      )) {
        expect(o.intensitySkipReason).toBeNull()
        readings.push(...o.readings)
      }
    }
    // 刻み 1 秒なので、最初の答えは流し込みを始めてから 100 点目。
    expect(readings[0].atMs).toBe(T0 + 100 * STATION_GRID_MS)
  })

  it('正: 最初の回だけ intensityStateChanged が立ち、続く回では立たない', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    const [first] = feedA(fusion, 0, 30)
    expect(first.intensityStateChanged).toBe(true)
    expect(first.intensitySkipReason).toBeNull()
    const [second] = feedA(fusion, 30, 30)
    expect(second.intensityStateChanged).toBe(false)
  })

  it('正: 直流の違う 3 本を時刻をずらして流しても、合成の震度が跳ばない（#362）', () => {
    // 実機（2026-09-28）: 静止時の Z 軸が 662〜1200 gal に散っていた（感度が未校正）。
    // **直流を落とさずに混ぜると、顔ぶれが入れ替わるたびに数十 gal の段差が立ち、
    // 周期補正フィルタがそれを震度として出す**（実機の合成は 4.36、単体は 1.12〜1.24）。
    const config = stationConfig([
      { boardKey: BOARD_A, sensorId: 'sensorA', noiseDensity: null },
      { boardKey: BOARD_B, sensorId: 'sensorB', noiseDensity: null },
      { boardKey: BOARD_C, sensorId: 'sensorC', noiseDensity: null },
    ])
    function quiet(k: number, n: number, dcZ: number): [number[], number[], number[]] {
      const out: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
      for (let i = 0; i < n; i++) {
        const t = (k + i) / HZ
        out[0][i] = Math.sin(2 * Math.PI * 3 * t)
        out[1][i] = Math.cos(2 * Math.PI * 5 * t)
        out[2][i] = dcZ + Math.sin(2 * Math.PI * 7 * t)
      }
      return out
    }
    /** 裏付けをずらす量。まとまりの半分だけ重なる（顔ぶれを変動させる）。 */
    const SKEW = 15
    function runWith(withOthers: boolean) {
      const fusion = new SensorFusion(config, OPTS)
      const intensities: number[] = []
      const counts = new Set<number>()
      for (let c = 0; c < 14; c++) {
        const k = c * 30
        const outs: FusionOutcome[] = []
        if (withOthers) {
          outs.push(...ingestNow(fusion, gridChunk(BOARD_B, 'sensorB', k + SKEW, quiet(k + SKEW, 30, 662.1))))
          outs.push(...ingestNow(fusion, gridChunk(BOARD_C, 'sensorC', k + SKEW, quiet(k + SKEW, 30, 1200.2))))
        }
        outs.push(...ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', k, quiet(k, 30, 1071.8))))
        for (const o of outs) {
          for (const m of o.fusedWave.memberCount) counts.add(m)
          for (const r of o.readings) if (r.intensity !== null) intensities.push(r.intensity)
        }
      }
      return { intensities, counts }
    }
    const fused = runWith(true)
    const single = runWith(false)
    expect(fused.counts.size).toBeGreaterThan(1)
    expect(fused.intensities.length).toBeGreaterThan(0)
    expect(Math.max(...fused.intensities)).toBeLessThan(Math.max(...single.intensities) + 0.5)
  })

  it('安全弁: 流し込みが投げても投げずに理由を残す（合成波形・差分は道連れにしない）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    feedA(fusion, 0, 30)
    const spy = vi.spyOn(IntensityStream.prototype, 'push').mockImplementationOnce(() => {
      throw new Error('流し込みに失敗した（テスト用）')
    })
    let failed: readonly FusionOutcome[] = []
    expect(() => {
      failed = feedA(fusion, 30, 30)
    }).not.toThrow()
    spy.mockRestore()
    expect(failed[0].intensitySkipReason).toContain('流し込みに失敗した')
    expect(failed[0].intensityStateChanged).toBe(true)
    const [after] = feedA(fusion, 60, 30)
    // 波形は出続け、理由は残ったまま（この回では何も変わっていない）。
    expect(after.fusedWave.gal[0]).toHaveLength(30)
    expect(after.intensitySkipReason).not.toBeNull()
    expect(after.intensityStateChanged).toBe(false)
  })

  it('正: 刻みの位置まで届いた震度はその場で出て、closeAll() で出し残しは無い（失敗も無い）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    const readings = feedA(fusion, 0, 150).flatMap((o) => o.readings)
    expect(readings).toHaveLength(1)
    const closed = fusion.closeAll()
    expect(closed.readings).toEqual([])
    expect(closed.failures).toEqual([])
  })

  it('安全弁: closeAll() のあとに ingest() を呼ぶと投げる', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    fusion.closeAll()
    expect(() => feedA(fusion, 0, 30)).toThrow()
  })

  describe('締めくくり（end()）が失敗したとき', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('安全弁: 欠けで締めたときの失敗は、直後に成功する作り直しで消えず closeFailure に残る', () => {
      const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
      feedA(fusion, 0, 30)
      vi.spyOn(IntensityStream.prototype, 'end').mockImplementation(() => {
        throw new Error('締めくくりに失敗した（テスト用）')
      })
      // 目盛り 30〜59 が欠けて 60 から再開 → 古い流し込みを締めて作り直す。
      const [out] = feedA(fusion, 60, 30)
      expect(out.closeFailure).toEqual({ stationId: 'home', detail: expect.stringContaining('締めくくりに失敗した') })
      expect(out.intensitySkipReason).toBeNull()
      expect(out.intensityStateChanged).toBe(true)
    })

    it('正: closeAll() は締めくくりの失敗を failures へ集め、他の観測点の回収は止めない（2 観測点で検証）', () => {
      const config: StationConfig = {
        stations: [
          { stationId: 'home', displayName: '自宅', lat: 35.6, lon: 139.7 },
          { stationId: 'garage', displayName: '倉庫', lat: 35.7, lon: 139.8 },
        ],
        boards: [
          { boardKey: BOARD_A, stationId: 'home', orientation: IDENTITY, sensors: [sensorEntry('sensorA', 10)] },
          { boardKey: BOARD_B, stationId: 'home', orientation: IDENTITY, sensors: [sensorEntry('sensorB', 20)] },
          { boardKey: BOARD_C, stationId: 'garage', orientation: IDENTITY, sensors: [sensorEntry('sensorC', 10)] },
          { boardKey: BOARD_D, stationId: 'garage', orientation: IDENTITY, sensors: [sensorEntry('sensorD', 20)] },
        ],
      }
      const fusion = new SensorFusion(config, OPTS)
      ingestNow(fusion, gridChunk(BOARD_A, 'sensorA', 0, galRows(0, 30, 40)))
      ingestNow(fusion, gridChunk(BOARD_C, 'sensorC', 0, galRows(0, 30, 40)))
      vi.spyOn(IntensityStream.prototype, 'end').mockImplementationOnce(() => {
        throw new Error('締めくくりに失敗した（テスト用・home のみ）')
      })
      const closed = fusion.closeAll()
      expect(closed.failures).toEqual([{ stationId: 'home', detail: expect.stringContaining('締めくくりに失敗した') }])
    })
  })
})

/**
 * `IntensityPipeline` が実際に組み立てた `WaveChunk`（校正適用後）を合成へ流す。
 * **手組みの `WaveChunk` だけでは、校正済みの gal が実際に合成へ渡っているかを検証できない。**
 */
describe('SensorFusion.ingest — 実際の IntensityPipeline から出た WaveChunk で合成する', () => {
  function packetFor(boardKey: BoardKey, sensorId: string, firstSeq: number): SensorPacket {
    return {
      version: 2,
      boardKey,
      bootId: 'boot1',
      sensorId,
      sensorType: 'MPU6050',
      channels: ['HN1', 'HN2', 'HN3'],
      ugPerLsb: 61.0352,
      fullScaleG: 2,
      sampleRateHz: HZ,
      firstSampleMs: T0 + (firstSeq * 1000) / HZ,
      firstSeq,
      overflowCount: 0,
      samples: Array.from({ length: 30 }, () => [0, 0, 0]),
    }
  }

  it('正: 校正（offset）を適用した後の gal が合成される（校正前の生値ではない）', () => {
    const config: StationConfig = {
      stations: [{ stationId: 'home', displayName: '自宅', lat: 35.6, lon: 139.7 }],
      boards: [
        { boardKey: BOARD_A, stationId: 'home', orientation: IDENTITY, sensors: [{ ...sensorEntry('sensorA', 10), axes: [{ vector: [1, 0, 0], offset: 10 }, ...defaultAxes(3).slice(1)] }] },
        { boardKey: BOARD_B, stationId: 'home', orientation: IDENTITY, sensors: [sensorEntry('sensorB', 10)] },
      ],
    }
    const pipeline = new IntensityPipeline({ stations: new StationDirectory(config) })
    const fusion = new SensorFusion(config)
    const a = pipeline.handlePacket(packetFor(BOARD_A, 'sensorA', 0)).wave
    const b = pipeline.handlePacket(packetFor(BOARD_B, 'sensorB', 0)).wave
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    const outs = [...ingestNow(fusion, a as WaveChunk), ...ingestNow(fusion, b as WaveChunk), ...fusion.closeAll().drained]
    expect(outs.length).toBeGreaterThan(0)
    // sensorA は校正で -10、sensorB は 0 のまま。重みが同じなので単純平均 -5。
    expect(restored(outs[0].fusedWave, 0, 0)).toBeCloseTo(-5)
  })
})
