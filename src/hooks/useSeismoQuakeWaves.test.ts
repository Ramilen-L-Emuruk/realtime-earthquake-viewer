// @vitest-environment jsdom
//
// 有感の地震カードへ出す波形の、選び方と取り方。
//
// 固定するのは 3 つ ——**誰を取りに行くか**（判定と上限）、**何を載せないか**
// （記録が無い・観測点を知らない）、**二度取らないこと**。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

import { NO_SCOPE, type NearbyScope } from '../utils/actionChecklistTrigger'
import type { JMAQuake } from '../types/earthquake'

const fetchSeismoStatus = vi.hoisted(() => vi.fn())
const fetchSeismoWaveHistory = vi.hoisted(() => vi.fn())

vi.mock('../services/seismoStream', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/seismoStream')>()),
  fetchSeismoStatus,
}))
vi.mock('../services/seismoWaveHistory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/seismoWaveHistory')>()),
  fetchSeismoWaveHistory,
}))

// **トップレベルで一度読む。** テスト本体で初めて解決すると、その待ちが 1 件目の
// 所要時間に乗って並列実行のときだけ時間切れになる（CLAUDE.md「検証」）。
const { pickTargets, useSeismoQuakeWaves } = await import('./useSeismoQuakeWaves')

function quake(id: string, time: string, maxScale: number, points: JMAQuake['points']): JMAQuake {
  return {
    id,
    time,
    issue: { source: '', time, type: '震源・震度情報' },
    earthquake: {
      time,
      hypocenter: { name: '東京湾', latitude: 35.5, longitude: 139.8, depth: 10, magnitude: 6.0 },
      maxScale,
      domesticTsunami: 'None',
    },
    points,
  } as unknown as JMAQuake
}

/** 半径内に観測点がある scope（自宅の周りで判定する形）。 */
const HOME: NearbyScope = {
  ...NO_SCOPE,
  stationNames: new Set(['自宅の隣']),
  regionNames: new Set(['東京都２３区']),
  // **索引が生きていることを示す集合。** これが電文の点を 1 件も引けないと
  // 「粒度が噛み合っていない」と見て全国基準へ倒れる（`recognizesTelegram`）。
  knownStationNames: new Set(['自宅の隣', '遠くの観測点']),
}

function history(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'ok' as const,
    history: {
      stationId: 'station-1',
      stationKnown: true,
      fromMs: 0,
      columnSpanMs: 350,
      columns: [{ min: [-1, -1, -1] as const, max: [1, 1, 1] as const, minMembers: 9 }],
      hasAnyValue: true,
      peakGal: 1,
      filesMissing: 0,
      filesFailed: 0,
      skippedBytes: 0,
      truncated: false,
      ...overrides,
    },
  }
}

function okStatus() {
  return {
    kind: 'ok' as const,
    stations: [{ stationId: 'station-1', displayName: '自宅', lat: 35.5, lon: 139.8 }],
    sensorCount: 1,
    sensors: [],
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('pickTargets', () => {
  it('半径内で閾値に達した地震を選ぶ', () => {
    const q = quake('a', '2026/09/29 22:00:00', 40, [
      { pref: '', addr: '自宅の隣', isArea: false, scale: 30 },
    ] as JMAQuake['points'])
    expect(pickTargets([q], HOME)).toHaveLength(1)
  })

  it('半径内が揺れていない地震は選ばない', () => {
    // **対照。** 電文の点は引けるが、自宅の周りは載っていない＝震度1未満。
    const q = quake('a', '2026/09/29 22:00:00', 40, [
      { pref: '', addr: '遠くの観測点', isArea: false, scale: 40 },
    ] as JMAQuake['points'])
    expect(pickTargets([q], HOME)).toHaveLength(0)
  })

  it('地点を持たない端末では全国の最大震度で判定する', () => {
    const q = quake('a', '2026/09/29 22:00:00', 30, [] as JMAQuake['points'])
    expect(pickTargets([q], NO_SCOPE)).toHaveLength(1)
  })

  it('時刻として読めない地震は選ばない', () => {
    const q = quake('a', 'こわれた時刻', 40, [] as JMAQuake['points'])
    expect(pickTargets([q], NO_SCOPE)).toHaveLength(0)
  })

  it('件数の上限は置かず、新しい順に並べる', () => {
    // **上限を外した**（2026-09-30 のユーザー判断）—— 有感の地震は 7 日でせいぜい数件。
    const quakes = Array.from({ length: 8 }, (_, i) =>
      quake(`q${i}`, `2026/09/2${i} 10:00:00`, 30, [] as JMAQuake['points']),
    )
    const picked = pickTargets(quakes, NO_SCOPE)
    expect(picked).toHaveLength(8)
    // 新しい順（渡した並びに依存しない）。
    for (let i = 1; i < picked.length; i += 1) {
      expect(picked[i - 1].originMs).toBeGreaterThanOrEqual(picked[i].originMs)
    }
    expect(picked[0].originMs).toBe(new Date('2026/09/27 10:00:00').getTime())
  })

  it('打ち切りは 1 つ新しい地震の発生時刻（いちばん新しいものは無限）', () => {
    // **重なる区間が 2 枚のカードに出るのを防ぐ**（2026-09-30 のユーザー判断・C 案）。
    const older = quake('a', '2026/09/29 22:00:00', 30, [] as JMAQuake['points'])
    const newer = quake('b', '2026/09/29 22:10:00', 30, [] as JMAQuake['points'])
    const picked = pickTargets([older, newer], NO_SCOPE)
    expect(picked[0].cutoffMs).toBe(Infinity)
    expect(picked[1].cutoffMs).toBe(new Date('2026/09/29 22:10:00').getTime())
  })

  it('同じ分に起きた地震では、窓が潰れないよう下限を確保する', () => {
    // **同時刻の 2 つの揺れは、そもそも切り分けられない。** ここだけ重なりを許す。
    const a = quake('a', '2026/09/29 22:00:00', 30, [] as JMAQuake['points'])
    const b = quake('b', '2026/09/29 22:00:00', 30, [] as JMAQuake['points'])
    const picked = pickTargets([a, b], NO_SCOPE)
    const origin = new Date('2026/09/29 22:00:00').getTime()
    expect(picked[1].cutoffMs).toBe(origin + 30_000)
  })
})

describe('useSeismoQuakeWaves', () => {
  const QUAKES = [quake('a', '2026/09/29 22:00:00', 30, [] as JMAQuake['points'])]

  function setup(enabled = true) {
    return renderHook(() =>
      useSeismoQuakeWaves({
        enabled,
        baseUrl: 'http://host:50506',
        quakes: QUAKES,
        scope: NO_SCOPE,
        readWave: () => null,
        replayOffsetMs: null,
      }),
    )
  }

  it('取れた波形を地震の鍵で引ける', async () => {
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result } = setup()
    await waitFor(() => expect(result.current.size).toBe(1))
    const entries = [...result.current.values()][0]
    expect(entries?.[0]?.stationId).toBe('station-1')
    expect(entries?.[0]?.displayName).toBe('自宅')
  })

  it('記録が 1 件も無ければ載せない', async () => {
    // 2026-09-29 のユーザー判断：「記録が無い」ことを画面へ出さない。
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history({ hasAnyValue: false, filesMissing: 2 }))
    const { result } = setup()
    await waitFor(() => expect(fetchSeismoWaveHistory).toHaveBeenCalled())
    expect(result.current.size).toBe(0)
  })

  it('ホストが知らない観測点の応答は載せない', async () => {
    // **静かな波形として描くと嘘になる。** 取り違えなので黙って捨て、記録へ残す。
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history({ stationKnown: false }))
    const { result } = setup()
    await waitFor(() => expect(fetchSeismoWaveHistory).toHaveBeenCalled())
    expect(result.current.size).toBe(0)
  })

  it('機能が無効なら 1 件も取りに行かない', async () => {
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result } = setup(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchSeismoStatus).not.toHaveBeenCalled()
    expect(result.current.size).toBe(0)
  })

  it('同じ地震を二度取りに行かない', async () => {
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result, rerender } = setup()
    await waitFor(() => expect(result.current.size).toBe(1))
    rerender()
    rerender()
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchSeismoWaveHistory).toHaveBeenCalledTimes(1)
  })

  it('状態の口を読めなければ波形も取りに行かない', async () => {
    fetchSeismoStatus.mockResolvedValue({ kind: 'unreachable', detail: 'Failed to fetch' })
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result } = setup()
    await waitFor(() => expect(fetchSeismoStatus).toHaveBeenCalled())
    expect(fetchSeismoWaveHistory).not.toHaveBeenCalled()
    expect(result.current.size).toBe(0)
  })
})
