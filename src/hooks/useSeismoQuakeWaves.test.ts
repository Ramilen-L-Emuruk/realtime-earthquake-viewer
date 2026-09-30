// @vitest-environment jsdom
//
// 有感の地震カードへ出す波形の、選び方と取り方。
//
// 固定するのは 3 つ ——**誰を取りに行くか**（判定と上限）、**何を載せないか**
// （記録が無い・観測点を知らない）、**二度取らないこと**。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

import { NO_SCOPE, type NearbyScope } from '../utils/actionChecklistTrigger'
import { quakeEventKey } from '../utils/quakeMerge'
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

  it('観測点の座標が判れば P/S の到達時刻を添える', async () => {
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result } = setup()
    await waitFor(() => expect(result.current.size).toBe(1))
    const arrival = [...result.current.values()][0]?.[0]?.arrival
    expect(arrival).not.toBeNull()
    const originMs = new Date('2026/09/29 22:00:00').getTime()
    expect(arrival!.pMs).toBeGreaterThan(originMs)
    expect(arrival!.sMs).toBeGreaterThan(arrival!.pMs)
  })

  it('観測点の座標をホストが持っていなければ到達時刻は付かない', async () => {
    // **対照。** 波形そのものは出る（線だけ引かない）。
    fetchSeismoStatus.mockResolvedValue({
      ...okStatus(),
      stations: [{ stationId: 'station-1', displayName: '自宅', lat: null, lon: null }],
    })
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result } = setup()
    await waitFor(() => expect(result.current.size).toBe(1))
    expect([...result.current.values()][0]?.[0]?.arrival).toBeNull()
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

  it('一時的な失敗は「取った」に数えず、時間を置いて取り直す', async () => {
    // **1 巡目のレビューで CRITICAL だった穴。** ホストが重くなるのは地震の直後で、
    // そこで 1 度外すとそのカードは永久に波形を持たない（画面上は「記録が無かった」と
    // 見分けが付かない）。**この動きを固定しておかないと、`doneRef` へ入れる位置を
    // 戻しただけで静かに再発する。**
    vi.useFakeTimers()
    // **地震の直後に立つ。** 取り直すのは発生から 30 分以内のものだけなので、
    // 時計を合わせないと「古いカード」として 1 回で諦める（次のテストがその側）。
    vi.setSystemTime(new Date('2026/09/29 22:00:05'))
    try {
      fetchSeismoStatus.mockResolvedValue(okStatus())
      fetchSeismoWaveHistory
        .mockResolvedValueOnce({ kind: 'unreachable', detail: 'Failed to fetch' })
        .mockResolvedValue(history())
      const { result } = setup()
      await vi.advanceTimersByTimeAsync(10)
      expect(fetchSeismoWaveHistory).toHaveBeenCalledTimes(1)
      expect(result.current.size).toBe(0)

      // 30 秒後に取り直して、今度は取れる。
      // **`act` で包む。** 偽の時計では state の反映が自動では流れない。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(fetchSeismoWaveHistory).toHaveBeenCalledTimes(2)
      expect(result.current.size).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('古い地震は 1 度失敗したら取り直さない', async () => {
    // **安全弁。** ホストが落ちている間、7 日ぶんのカードを延々と叩き続けないため。
    // 前のテストと同じ失敗を、発生から 30 分を過ぎた時計で起こす。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026/09/29 23:00:00'))
    try {
      fetchSeismoStatus.mockResolvedValue(okStatus())
      fetchSeismoWaveHistory.mockResolvedValue({ kind: 'unreachable', detail: 'Failed to fetch' })
      setup()
      await vi.advanceTimersByTimeAsync(10)
      expect(fetchSeismoWaveHistory).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchSeismoWaveHistory).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('古い地震しか無ければ、状態の口が落ちていても叩き直さない', async () => {
    // **同じ歯止めを `/status` 側にも置く**（2 巡目のレビューの HIGH）。
    // ここを無条件に「取り直す」にすると、ホストが落ちている間ずっと 30 秒ごとに
    // 問い合わせ続ける。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026/09/29 23:00:00'))
    try {
      fetchSeismoStatus.mockResolvedValue({ kind: 'unreachable', detail: 'Failed to fetch' })
      setup()
      await vi.advanceTimersByTimeAsync(10)
      expect(fetchSeismoStatus).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchSeismoStatus).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('新しい地震があれば、状態の口が落ちていても取り直す', async () => {
    // **対照。** 一時的に返らないだけなら諦める理由が無い。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026/09/29 22:00:05'))
    try {
      fetchSeismoStatus.mockResolvedValue({ kind: 'unreachable', detail: 'Failed to fetch' })
      setup()
      await vi.advanceTimersByTimeAsync(10)
      expect(fetchSeismoStatus).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(fetchSeismoStatus).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('正: 観測点が 0 件でも、新しい地震があれば取り直す', async () => {
    // **2026-09-30 のレビューで見つかった穴。** 通信は成功しているので `kind` は `'ok'`
    // だが、**ホストの起動直後は必ずこの形を通る**（`sensorHealth.ts` は実際にパケットを
    // 受けたセンサーしか載せない）。ここで諦めると、次に新しい地震が来て `targetKey` が
    // 変わるまでその地震の波形を取りに行かない ——**停電はホストの再起動と地震の両方の
    // 原因になりうる**ので、いちばん見たい地震でこれを踏む。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026/09/29 22:00:05'))
    try {
      fetchSeismoStatus.mockResolvedValue({ ...okStatus(), stations: [], sensorCount: 0 })
      setup()
      await vi.advanceTimersByTimeAsync(10)
      expect(fetchSeismoStatus).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(fetchSeismoStatus).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('対照: 古い地震しか無ければ、観測点が 0 件でも叩き直さない', async () => {
    // 落ちている `/status` に置いたのと同じ歯止め（発生から 30 分）。**取り直しを足した
    // ぶん、こちらの線も引き直せているかを見る。**
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026/09/29 23:00:00'))
    try {
      fetchSeismoStatus.mockResolvedValue({ ...okStatus(), stations: [], sensorCount: 0 })
      setup()
      await vi.advanceTimersByTimeAsync(10)
      expect(fetchSeismoStatus).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchSeismoStatus).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('安全弁: 観測点が 0 件なら、波形は取りに行かない', async () => {
    // **取り直すことと、空の一覧で取りに行くことは別。** 観測点が分からないまま
    // `GET /waves` を叩いても、鍵になる観測点 ID が無い。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026/09/29 22:00:05'))
    try {
      fetchSeismoStatus.mockResolvedValue({ ...okStatus(), stations: [], sensorCount: 0 })
      fetchSeismoWaveHistory.mockResolvedValue(history())
      setup()
      await vi.advanceTimersByTimeAsync(10)
      expect(fetchSeismoWaveHistory).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('こちらの組み立てた窓が通らなかったときは取り直さない', async () => {
    // **対照。** 同じ窓で投げ直しても結果は変わらない。
    vi.useFakeTimers()
    try {
      fetchSeismoStatus.mockResolvedValue(okStatus())
      fetchSeismoWaveHistory.mockResolvedValue({ kind: 'bad-request', detail: '範囲が広すぎる' })
      setup()
      await vi.advanceTimersByTimeAsync(10)
      expect(fetchSeismoWaveHistory).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchSeismoWaveHistory).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('中身が変わっていなければ、同じ配列の参照を返し続ける', async () => {
    // **`EarthquakeCard` の `memo` が効くための前提。** ここが壊れると、波形を繋いで
    // いる間 0.3 秒ごとに**関わりのないカードまで**描き直される（型検査にも他の
    // テストにも掛からない）。
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result, rerender } = setup()
    await waitFor(() => expect(result.current.size).toBe(1))
    const first = result.current.get(quakeEventKey(QUAKES[0]))
    rerender()
    rerender()
    expect(result.current.get(quakeEventKey(QUAKES[0]))).toBe(first)
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
