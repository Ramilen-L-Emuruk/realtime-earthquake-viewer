// 基板ごとの震度（#713-1）。**基板を 1 つの観測点に見立てた合成**と、表の行の組み立て。

import { describe, expect, it, vi } from 'vitest'

import type { BoardKey } from '../protocol/types'
import { BoardFusion, boardFusionConfig, buildBoardIntensities } from './boardIntensity'
import type { WaveChunk } from './intensityPipeline'
import { STATION_GRID_MS } from './sensorFusion'
import type { SensorHealth } from './sensorHealth'
import { StationHealthBook } from './stationHealth'
import type { StationHealth } from './stationHealth'
import { defaultAxes } from './stationConfigTypes'
import type { SensorEntry, StationConfig } from './stationConfigTypes'

const IDENTITY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const

const T0 = 1_790_181_865_800
const BOARD_A: BoardKey = 'mac:aaaaaaaaaaaa'
const BOARD_B: BoardKey = 'mac:bbbbbbbbbbbb'

function sensor(sensorId: string, over: Partial<SensorEntry> = {}): SensorEntry {
  return { sensorId, enabled: true, axes: defaultAxes(3), noiseDensity: null, ...over }
}

/** 観測点「自宅」に、基板 2 枚（どちらもセンサー 3 個）を置いた設定。 */
function twoBoards(): StationConfig {
  return {
    stations: [{ stationId: 'home', displayName: '自宅', lat: 35, lon: 139 }],
    boards: [BOARD_A, BOARD_B].map((boardKey) => ({
      boardKey,
      stationId: 'home',
      orientation: IDENTITY,
      sensors: ['s0', 's1', 's2'].map((id) => sensor(id)),
    })),
  }
}

/** 揺らぎのある 3 軸の波形（目盛りの `k` 番目から 30 サンプル）。 */
function chunk(boardKey: BoardKey, sensorId: string, k: number): WaveChunk {
  const ground = [0, 1, 2].map((axis) =>
    Array.from({ length: 30 }, (_, i) => Math.sin((k + i) * 0.37 + axis) * 0.8),
  ) as [number[], number[], number[]]
  return {
    streamKey: `${boardKey}|${sensorId}|boot1`,
    segmentId: 1,
    boardKey,
    sensorId,
    channels: ['HN1', 'HN2', 'HN3'],
    firstSampleIndex: k,
    firstSampleMs: T0 + k * STATION_GRID_MS,
    msPerSample: STATION_GRID_MS,
    timebaseNominalReason: null,
    axes: IDENTITY.map((direction, j) => ({ direction, gal: ground[j]! })),
    ground,
  }
}

/** 基板 2 枚 × センサー 3 個を `rounds` まとまり（1 まとまり 0.3 秒）流す。 */
function feed(fusion: BoardFusion, rounds: number, boards: readonly BoardKey[] = [BOARD_A, BOARD_B]): void {
  for (let r = 0; r < rounds; r++) {
    for (const b of boards) {
      for (const s of ['s0', 's1', 's2']) {
        const w = chunk(b, s, r * 30)
        fusion.ingest(w, w.firstSampleMs + 29 * STATION_GRID_MS)
      }
    }
  }
}

describe('基板ごとの合成へ渡す設定', () => {
  it('各基板の観測点を基板 Key に差し替え、観測点の一覧は空にする', () => {
    const derived = boardFusionConfig(twoBoards())
    expect(derived.stations).toEqual([])
    expect(derived.boards.map((b) => b.stationId)).toEqual([BOARD_A, BOARD_B])
    // 差し替えるのは観測点だけ（センサーと向きはそのまま）。
    expect(derived.boards[0]!.sensors).toEqual(twoBoards().boards[0]!.sensors)
  })
})

describe('基板ごとの合成', () => {
  it('正: 基板 1 枚ずつに震度と混ざった本数（3）が出る', () => {
    const fusion = new BoardFusion(twoBoards(), { onError: () => {} })
    feed(fusion, 40)
    const byBoard = new Map(fusion.snapshot().map((h) => [h.stationId, h]))
    for (const b of [BOARD_A, BOARD_B]) {
      expect(byBoard.get(b)?.lastIntensity).not.toBeNull()
      expect(byBoard.get(b)?.lastMemberCountMax).toBe(3)
    }
  })

  it('対照: 片方の基板しか届かなければ、届いた基板にだけ値が出る', () => {
    const fusion = new BoardFusion(twoBoards(), { onError: () => {} })
    feed(fusion, 40, [BOARD_A])
    const ids = fusion.snapshot().map((h) => h.stationId)
    expect(ids).toEqual([BOARD_A])
  })

  it('安全弁: 合成が投げても外へ投げず、知らせ先へ渡す', () => {
    const onError = vi.fn()
    const fusion = new BoardFusion(twoBoards(), { onError })
    // 締めたあとの ingest は SensorFusion が投げる（誤用の検出）。作り直しの失敗を作るために使う。
    ;(fusion as unknown as { fusion: { closeAll(): unknown } }).fusion.closeAll()
    expect(() => feed(fusion, 1)).not.toThrow()
    expect(onError).toHaveBeenCalled()
  })

  it('安全弁: 結果を帳面へ書く段で投げても、外へ投げない（受信の処理の後段を巻き込まない）', () => {
    const onError = vi.fn()
    const fusion = new BoardFusion(twoBoards(), { onError })
    const spy = vi.spyOn(StationHealthBook.prototype, 'noteWave').mockImplementation(() => {
      throw new Error('帳面が壊れた')
    })
    try {
      expect(() => feed(fusion, 40)).not.toThrow()
      expect(onError).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('作り直すと、新しい設定の割り当てで合成する（センサーを 1 個へ減らした基板は組まない）', () => {
    const fusion = new BoardFusion(twoBoards(), { onError: () => {} })
    feed(fusion, 40)
    const reduced: StationConfig = {
      ...twoBoards(),
      boards: twoBoards().boards.map((b) =>
        b.boardKey === BOARD_B ? { ...b, sensors: [sensor('s0'), sensor('s1', { enabled: false }), sensor('s2', { enabled: false })] } : b,
      ),
    }
    fusion.rebuild(reduced)
    const before = fusion.snapshot().find((h) => h.stationId === BOARD_B)?.lastPacketMs
    feed(fusion, 40)
    // B はもう組まれない（帳面の行は最後の値のまま残る）。A は合成し続ける。
    expect(fusion.snapshot().find((h) => h.stationId === BOARD_B)?.lastPacketMs).toBe(before)
    expect(fusion.snapshot().find((h) => h.stationId === BOARD_A)?.lastMemberCountMax).toBe(3)
  })
})

/** 帳面の行（合成）。 */
function fusedRow(boardKey: string, over: Partial<StationHealth> = {}): StationHealth {
  return {
    stationId: boardKey,
    lastPacketMs: 1000,
    lastIntensity: 0.42,
    lastReadingAtMs: 900,
    lastReadingReceivedMs: 1000,
    lastSkipReason: null,
    closeFailures: 0,
    lastCloseFailure: null,
    lastMemberCountMin: 2,
    lastMemberCountMax: 3,
    uncoveredFusions: 0,
    pairDiffs: [],
    residuals: [],
    ...over,
  }
}

/** センサーの帳面の行。 */
function sensorRow(boardKey: BoardKey, sensorId: string, over: Partial<SensorHealth> = {}): SensorHealth {
  return {
    boardKey,
    sensorId,
    lastPacketMs: 2000,
    streamKey: `${boardKey}|${sensorId}|boot1`,
    axisCount: 3,
    segmentId: 1,
    lastIntensity: 0.31,
    lastReadingAtMs: 1900,
    lastNominalReason: null,
    lastSkipReason: null,
    axisMismatch: null,
    ...over,
  } as SensorHealth
}

function configWith(boards: StationConfig['boards']): StationConfig {
  return { stations: [{ stationId: 'home', displayName: '自宅', lat: 35, lon: 139 }], boards }
}

function board(boardKey: BoardKey, sensors: SensorEntry[], displayName?: string): StationConfig['boards'][number] {
  return { boardKey, stationId: 'home', orientation: IDENTITY, sensors, ...(displayName === undefined ? {} : { displayName }) }
}

describe('「基板ごとの震度」の行', () => {
  it('並びは設定の基板の並びのまま（帳面の音沙汰の順に動かない）', () => {
    const config = configWith([board(BOARD_B, [sensor('s0'), sensor('s1')]), board(BOARD_A, [sensor('s0'), sensor('s1')])])
    const rows = buildBoardIntensities(config, [fusedRow(BOARD_A), fusedRow(BOARD_B)], [])
    expect(rows.map((r) => r.boardKey)).toEqual([BOARD_B, BOARD_A])
  })

  it('正: センサーが 2 個以上の基板は、基板ごとの合成の値と本数を出す', () => {
    const config = configWith([board(BOARD_A, [sensor('s0'), sensor('s1'), sensor('s2')], '北東の隅')])
    const [row] = buildBoardIntensities(config, [fusedRow(BOARD_A)], [sensorRow(BOARD_A, 's0')])
    expect(row).toMatchObject({
      source: 'fused',
      boardName: '北東の隅',
      stationName: '自宅',
      lastIntensity: 0.42,
      lastMemberCountMin: 2,
      lastMemberCountMax: 3,
    })
  })

  it('正: 有効なセンサーが 1 個だけの基板は、そのセンサー単独の値を出す（2026-10-11 ユーザー承認）', () => {
    const config = configWith([board(BOARD_A, [sensor('s0'), sensor('s1', { enabled: false })])])
    const [row] = buildBoardIntensities(config, [fusedRow(BOARD_A, { lastIntensity: 9.9 })], [sensorRow(BOARD_A, 's0')])
    // 帳面に古い合成の行が残っていても、いまの設定で出どころを決める。
    expect(row).toMatchObject({ source: 'single', lastIntensity: 0.31, lastPacketMs: 2000, lastReadingReceivedMs: 2000 })
    expect(row!.lastMemberCountMax).toBeNull()
  })

  it('対照: 1 個だけのセンサーが 2 軸なら値を出さない（「2 軸」の扱い）', () => {
    const config = configWith([board(BOARD_A, [sensor('s0', { axes: defaultAxes(2) })])])
    const [row] = buildBoardIntensities(
      config,
      [],
      [sensorRow(BOARD_A, 's0', { axisCount: 2, lastIntensity: null, lastSkipReason: 'axis-count' })],
    )
    expect(row).toMatchObject({ source: 'two-axis', lastIntensity: null, lastSkipReason: null, lastPacketMs: 2000 })
  })

  it('有効なセンサーが無い基板は、値を持たない行として出す', () => {
    const config = configWith([board(BOARD_A, [sensor('s0', { enabled: false })])])
    const [row] = buildBoardIntensities(config, [], [sensorRow(BOARD_A, 's0')])
    expect(row).toMatchObject({ source: 'no-sensor', lastIntensity: null, lastPacketMs: null })
  })

  it('まだ合成していない基板は、値を空のまま出す（0 で埋めない）', () => {
    const config = configWith([board(BOARD_A, [sensor('s0'), sensor('s1')])])
    const [row] = buildBoardIntensities(config, [], [])
    expect(row).toMatchObject({ source: 'fused', lastIntensity: null, lastPacketMs: null, lastMemberCountMax: null })
  })

  it('観測点が設定に無ければ、観測点の名前は null', () => {
    const config: StationConfig = { stations: [], boards: [board(BOARD_A, [sensor('s0'), sensor('s1')])] }
    const [row] = buildBoardIntensities(config, [], [])
    expect(row!.stationName).toBeNull()
    expect(row!.stationId).toBe('home')
  })
})
