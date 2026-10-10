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
import { computeWaveArrival } from '../utils/seismoWaveArrival'
import type { OriginSeconds } from '../utils/quakeOriginSeconds'
import type { JMAQuake } from '../types/earthquake'
import type { QuakeIntensityResult } from '../services/seismoQuakeIntensity'

const fetchSeismoStatus = vi.hoisted(() => vi.fn())
const fetchSeismoWaveHistory = vi.hoisted(() => vi.fn())
// **既定は「配る前のホスト」。** 震度を訊くのは伸ばし終えた後なので、既存のテストでも
// 呼ばれうる —— 素の `fetch` へ流すと、テストが実際に通信を出しにいく。
const fetchSeismoQuakeIntensity = vi.hoisted(() =>
  vi.fn(async (): Promise<QuakeIntensityResult> => ({ kind: 'not-supported' })),
)

vi.mock('../services/seismoStream', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/seismoStream')>()),
  fetchSeismoStatus,
}))
vi.mock('../services/seismoQuakeIntensity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/seismoQuakeIntensity')>()),
  fetchSeismoQuakeIntensity,
}))
vi.mock('../services/seismoWaveHistory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/seismoWaveHistory')>()),
  fetchSeismoWaveHistory,
}))

// **トップレベルで一度読む。** テスト本体で初めて解決すると、その待ちが 1 件目の
// 所要時間に乗って並列実行のときだけ時間切れになる（CLAUDE.md「検証」）。
const { pickTargets, useSeismoQuakeWaves, judgeWaveInterrupted } = await import(
  './useSeismoQuakeWaves'
)

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
    expect(pickTargets([q], HOME, new Map())).toHaveLength(1)
  })

  it('半径内が揺れていない地震は選ばない', () => {
    // **対照。** 電文の点は引けるが、自宅の周りは載っていない＝震度1未満。
    const q = quake('a', '2026/09/29 22:00:00', 40, [
      { pref: '', addr: '遠くの観測点', isArea: false, scale: 40 },
    ] as JMAQuake['points'])
    expect(pickTargets([q], HOME, new Map())).toHaveLength(0)
  })

  it('地点を持たない端末では全国の最大震度で判定する', () => {
    const q = quake('a', '2026/09/29 22:00:00', 30, [] as JMAQuake['points'])
    expect(pickTargets([q], NO_SCOPE, new Map())).toHaveLength(1)
  })

  it('時刻として読めない地震は選ばない', () => {
    const q = quake('a', 'こわれた時刻', 40, [] as JMAQuake['points'])
    expect(pickTargets([q], NO_SCOPE, new Map())).toHaveLength(0)
  })

  it('件数の上限は置かず、新しい順に並べる', () => {
    // **上限を外した**（2026-09-30 のユーザー判断）—— 有感の地震は 7 日でせいぜい数件。
    const quakes = Array.from({ length: 8 }, (_, i) =>
      quake(`q${i}`, `2026/09/2${i} 10:00:00`, 30, [] as JMAQuake['points']),
    )
    const picked = pickTargets(quakes, NO_SCOPE, new Map())
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
    const picked = pickTargets([older, newer], NO_SCOPE, new Map())
    expect(picked[0].cutoffMs).toBe(Infinity)
    expect(picked[1].cutoffMs).toBe(new Date('2026/09/29 22:10:00').getTime())
  })

  it('同じ分に起きた地震では、窓が潰れないよう下限を確保する', () => {
    // **同時刻の 2 つの揺れは、そもそも切り分けられない。** ここだけ重なりを許す。
    const a = quake('a', '2026/09/29 22:00:00', 30, [] as JMAQuake['points'])
    const b = quake('b', '2026/09/29 22:00:00', 30, [] as JMAQuake['points'])
    const picked = pickTargets([a, b], NO_SCOPE, new Map())
    const origin = new Date('2026/09/29 22:00:00').getTime()
    expect(picked[1].cutoffMs).toBe(origin + 30_000)
  })
})

// 地震カードの秒（緊急地震速報の発生時刻）。**地震情報の時刻（22:00:00）と 3 秒ずらしてある** ——
// 線の起点がどちらから来たかをテストで見分けるため。
const ORIGIN_SECONDS_MS = new Date('2026/09/29 22:00:03').getTime()
/** 作り直しの知らせを流さない口（知らせを見る試験以外）。参照は安定。 */
const NO_REVISED = (): (() => void) => () => {}

const SECONDS_QUAKE = quake('a', '2026/09/29 22:00:00', 30, [] as JMAQuake['points'])
const SECONDS: ReadonlyMap<string, OriginSeconds> = new Map([
  [quakeEventKey(SECONDS_QUAKE), { originMs: ORIGIN_SECONDS_MS, source: 'eew' as const }],
])

describe('useSeismoQuakeWaves', () => {
  const QUAKES = [SECONDS_QUAKE]

  function setup(enabled = true, originSeconds: ReadonlyMap<string, OriginSeconds> = SECONDS) {
    return renderHook(() =>
      useSeismoQuakeWaves({
        enabled,
        baseUrl: 'http://host:50506',
        quakes: QUAKES,
        scope: NO_SCOPE,
        readWave: () => null,
        replayOffsetMs: null,
        originSeconds,
        subscribeWaveRevised: NO_REVISED,
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
    // **起点は秒まである発生時刻**（地震情報の 22:00:00 ではない）。
    expect(arrival!.pMs).toBeGreaterThan(ORIGIN_SECONDS_MS)
    expect(arrival!.sMs).toBeGreaterThan(arrival!.pMs)
  })

  it('起点は秒まである発生時刻で、地震情報の分の時刻ではない', async () => {
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result: withSeconds } = setup()
    await waitFor(() => expect(withSeconds.current.size).toBe(1))
    const shifted = [...withSeconds.current.values()][0]?.[0]?.arrival
    const minuteOnly = computeWaveArrival({
      originMs: new Date('2026/09/29 22:00:00').getTime(),
      hypocenter: SECONDS_QUAKE.earthquake.hypocenter,
      stationLat: 35.5, stationLon: 139.8,
    })
    expect(shifted!.pMs - minuteOnly!.pMs).toBe(3000)
  })

  it('秒が取れていない地震は線を引かない（波形そのものは出す）', async () => {
    // **対照。** 分の時刻で引くと最大 59 秒ずれる。根拠の無い線は引かない。
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result } = setup(true, new Map())
    await waitFor(() => expect(result.current.size).toBe(1))
    expect([...result.current.values()][0]?.[0]?.arrival).toBeNull()
  })

  it('秒が後から取れたら、取り直さずに線だけ引き直す', async () => {
    // 過去分の取得は開いた直後に非同期で返る。**波形を読み返し直さない**こと。
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result, rerender } = renderHook(
      ({ originSeconds }: { originSeconds: ReadonlyMap<string, OriginSeconds> }) =>
        useSeismoQuakeWaves({
          enabled: true,
          baseUrl: 'http://host:50506',
          quakes: QUAKES,
          scope: NO_SCOPE,
          readWave: () => null,
          replayOffsetMs: null,
          originSeconds,
          subscribeWaveRevised: NO_REVISED,
        }),
      { initialProps: { originSeconds: new Map() as ReadonlyMap<string, OriginSeconds> } },
    )
    await waitFor(() => expect(result.current.size).toBe(1))
    expect([...result.current.values()][0]?.[0]?.arrival).toBeNull()
    const fetched = fetchSeismoWaveHistory.mock.calls.length
    rerender({ originSeconds: SECONDS })
    await waitFor(() => expect([...result.current.values()][0]?.[0]?.arrival).not.toBeNull())
    expect(fetchSeismoWaveHistory.mock.calls.length).toBe(fetched)
  })

  it('時間軸の 0 は、秒が取れれば発生時刻・取れなければ分の頭', async () => {
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result: withSeconds } = setup()
    await waitFor(() => expect(withSeconds.current.size).toBe(1))
    expect([...withSeconds.current.values()][0]?.[0]?.axisZero).toEqual({
      kind: 'origin', ms: ORIGIN_SECONDS_MS, source: 'eew',
    })

    const { result: minuteOnly } = setup(true, new Map())
    await waitFor(() => expect(minuteOnly.current.size).toBe(1))
    expect([...minuteOnly.current.values()][0]?.[0]?.axisZero).toEqual({
      kind: 'minute', ms: new Date('2026/09/29 22:00:00').getTime(),
    })
  })

  it('秒が取れなくても、届きうる時間帯は出す（線は引かない）', async () => {
    // 分の頭から解いた走時に 60 秒の幅を持たせれば、描く範囲を決める材料になる。
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result } = setup(true, new Map())
    await waitFor(() => expect(result.current.size).toBe(1))
    const wave = [...result.current.values()][0]?.[0]
    expect(wave?.arrival).toBeNull()
    const fromMinute = computeWaveArrival({
      originMs: new Date('2026/09/29 22:00:00').getTime(),
      hypocenter: SECONDS_QUAKE.earthquake.hypocenter,
      stationLat: 35.5, stationLon: 139.8,
    })!
    expect(wave?.reach).toEqual({ fromMs: fromMinute.pMs, toMs: fromMinute.sMs + 60_000 })
  })

  it('秒が後から取れたら、時間軸の 0 も発生時刻へ動く', async () => {
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result, rerender } = renderHook(
      ({ originSeconds }: { originSeconds: ReadonlyMap<string, OriginSeconds> }) =>
        useSeismoQuakeWaves({
          enabled: true,
          baseUrl: 'http://host:50506',
          quakes: QUAKES,
          scope: NO_SCOPE,
          readWave: () => null,
          replayOffsetMs: null,
          originSeconds,
          subscribeWaveRevised: NO_REVISED,
        }),
      { initialProps: { originSeconds: new Map() as ReadonlyMap<string, OriginSeconds> } },
    )
    await waitFor(() => expect(result.current.size).toBe(1))
    expect([...result.current.values()][0]?.[0]?.axisZero.kind).toBe('minute')
    rerender({ originSeconds: SECONDS })
    await waitFor(() => expect([...result.current.values()][0]?.[0]?.axisZero.kind).toBe('origin'))
  })

  it('対象から外れた地震は、途中の巡回で落ちずに消える（取消・表示する震度の設定変更）', async () => {
    // **同じ描画の中で、出し直し（到達の鍵が変わる）が帳面の掃除より先に走る。** そのとき
    // 地震の対象が無いので、前に出した姿を使い回す分岐を通る —— そこで落ちず、最後は消えること。
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history())
    const { result, rerender } = renderHook(
      ({ quakes }: { quakes: JMAQuake[] }) =>
        useSeismoQuakeWaves({
          enabled: true,
          baseUrl: 'http://host:50506',
          quakes,
          scope: NO_SCOPE,
          readWave: () => null,
          replayOffsetMs: null,
          originSeconds: SECONDS,
          subscribeWaveRevised: NO_REVISED,
        }),
      { initialProps: { quakes: QUAKES } },
    )
    await waitFor(() => expect(result.current.size).toBe(1))
    rerender({ quakes: [] })
    await waitFor(() => expect(result.current.size).toBe(0))
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

  // #423 の形 3。**列が 1 つも伸びないことを伝える**ので、
  // 「変わったら出し直す」だけの作りでは画面に出ない。
  describe('繋ぎ足しが途切れたとき', () => {
    /** 地震の直後に立ち、押し出しは 1 件も届かない状況を作る。 */
    async function freshWithNoPush() {
      vi.setSystemTime(new Date('2026/09/29 22:00:05'))
      fetchSeismoStatus.mockResolvedValue(okStatus())
      fetchSeismoWaveHistory.mockResolvedValue(history())
      // **`readWave` は `null`** ＝押し出しが 1 件も来ない（`appendWaveWindow` が
      // 同じ参照を返すので列は伸びない）。
      const h = setup()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
      return h
    }

    const interruptedOf = (waves: ReadonlyMap<string, readonly { interrupted: boolean }[]>) =>
      [...waves.values()][0]?.[0]?.interrupted

    it('正: 列が 1 つも伸びなくても、巡回が印を立てて出し直す', async () => {
      vi.useFakeTimers()
      try {
        const { result } = await freshWithNoPush()
        expect(interruptedOf(result.current)).toBe(false)
        // 5 秒（`WAVE_STALE_MS`）を跨ぐ。
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6000)
        })
        expect(interruptedOf(result.current)).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('対照: 閾値の手前では立てない', async () => {
      vi.useFakeTimers()
      try {
        const { result } = await freshWithNoPush()
        await act(async () => {
          await vi.advanceTimersByTimeAsync(4000)
        })
        expect(interruptedOf(result.current)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('安全弁: 再生中は印を立てない（押し出しを繋いでいないので伸びないのが当たり前）', async () => {
      // **`App.tsx` は再生中に押し出しの購読を切る**ので `readWave()` は必ず `null`。
      // ここを見ないと、**再生を始めて 5 秒で絵が全部薄くなる** —— しかも
      // 「読み取りの変更はリプレイで確かめる」という検証手順のただ中で起きる。
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026/09/29 22:00:05'))
        fetchSeismoStatus.mockResolvedValue(okStatus())
        fetchSeismoWaveHistory.mockResolvedValue(history())
        const { result } = renderHook(() =>
          useSeismoQuakeWaves({
            enabled: true,
            baseUrl: 'http://host:50506',
            quakes: QUAKES,
            scope: NO_SCOPE,
            readWave: () => null,
            // ここだけが上の「正」と違う。
            replayOffsetMs: -3600_000,
            originSeconds: SECONDS,
            subscribeWaveRevised: NO_REVISED,
          }),
        )
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10)
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000)
        })
        expect(interruptedOf(result.current)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('安全弁: 先頭から降りたら印を戻す（完結した前の地震のカードを薄いまま残さない）', async () => {
      // **継ぎ足しの巡回が触るのは先頭の対象だけ。** 降りた後も印が立っていると、
      // **新しい地震が来た拍子に、完結した前の地震のカードが壊れて見える。**
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026/09/29 22:00:05'))
        fetchSeismoStatus.mockResolvedValue(okStatus())
        fetchSeismoWaveHistory.mockResolvedValue(history())
        const older = QUAKES
        const { result, rerender } = renderHook(
          ({ quakes }: { quakes: readonly JMAQuake[] }) =>
            useSeismoQuakeWaves({
              enabled: true,
              baseUrl: 'http://host:50506',
              quakes,
              scope: NO_SCOPE,
              readWave: () => null,
              replayOffsetMs: null,
              originSeconds: SECONDS,
              subscribeWaveRevised: NO_REVISED,
            }),
          { initialProps: { quakes: older } },
        )
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10)
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6000)
        })
        const key = quakeEventKey(older[0])
        expect(result.current.get(key)?.[0]?.interrupted).toBe(true)

        // **より新しい地震が来て、先頭が入れ替わる。**
        const newer = quake('b', '2026/09/29 22:05:00', 30, [] as JMAQuake['points'])
        await act(async () => {
          rerender({ quakes: [newer, ...older] })
          await vi.advanceTimersByTimeAsync(500)
        })
        expect(result.current.get(key)?.[0]?.interrupted).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('安全弁: 伸ばす番を過ぎたら印を戻す（完結した絵を薄いまま残さない）', async () => {
      vi.useFakeTimers()
      try {
        const { result } = await freshWithNoPush()
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6000)
        })
        expect(interruptedOf(result.current)).toBe(true)
        // 発生から 30 分（`GROW_SAFETY_MS`）を跨ぐと、もう伸ばす番ではない。
        vi.setSystemTime(new Date('2026/09/29 22:31:00'))
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400)
        })
        expect(interruptedOf(result.current)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

describe('震度を訊く（#494 段3）', () => {
  function intensityOk() {
    return {
      kind: 'ok' as const,
      intensity: {
        fromMs: 0,
        toMs: 0,
        maxRealtime: 2.3,
        maxRealtimeAtMs: null,
        realtimeSeries: [],
        measured: 1.9,
        measuredUnavailable: null,
        gapCount: 0,
        invalidChunkCount: 0,
        unsolvedChunkCount: 0,
        filesMissing: 0,
        filesFailed: 0,
        skippedBytes: 0,
        truncated: false,
      },
    }
  }

  function render(replayOffsetMs: number | null = null) {
    return renderHook(
      ({ originSeconds }: { originSeconds: ReadonlyMap<string, OriginSeconds> }) =>
        useSeismoQuakeWaves({
          enabled: true,
          baseUrl: 'http://host:50506',
          quakes: [SECONDS_QUAKE],
          scope: NO_SCOPE,
          readWave: () => null,
          replayOffsetMs,
          originSeconds,
          subscribeWaveRevised: NO_REVISED,
        }),
      { initialProps: { originSeconds: SECONDS } },
    )
  }

  const intensityOf = (waves: ReadonlyMap<string, readonly { intensity: unknown }[]>) =>
    [...waves.values()][0]?.[0]?.intensity

  // 正: 伸ばし終えた地震（ここでは安全弁の 30 分を過ぎたもの）は震度を訊き、訊いた区間で持つ。
  it('伸ばし終えた地震は震度を訊き、訊いた区間の値として載せる', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026/09/29 23:00:00'))
      fetchSeismoStatus.mockResolvedValue(okStatus())
      fetchSeismoWaveHistory.mockResolvedValue(history())
      fetchSeismoQuakeIntensity.mockResolvedValueOnce(intensityOk())
      const { result } = render()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(fetchSeismoQuakeIntensity).toHaveBeenCalledTimes(1)
      const asked = fetchSeismoQuakeIntensity.mock.calls[0] as unknown as [{ fromMs: number; toMs: number; stationId: string }]
      expect(asked[0].stationId).toBe('station-1')
      // **ホストが丸めて返した区間ではなく、訊いた区間で持つ**（描く側と突き合わせるため）。
      expect(intensityOf(result.current)).toMatchObject({ fromMs: asked[0].fromMs, toMs: asked[0].toMs, maxRealtime: 2.3 })
    } finally {
      vi.useRealTimers()
    }
  })

  // 対照: 伸ばしている最中は訊かない（後半の入らない計測震度になる）。
  it('揺れの直後で伸ばしている最中は訊かない', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026/09/29 22:00:05'))
      fetchSeismoStatus.mockResolvedValue(okStatus())
      fetchSeismoWaveHistory.mockResolvedValue(history())
      render()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(fetchSeismoQuakeIntensity).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('再生中は伸ばさないので、すぐ訊く', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026/09/29 22:00:05'))
      fetchSeismoStatus.mockResolvedValue(okStatus())
      fetchSeismoWaveHistory.mockResolvedValue(history())
      render(-3600_000)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(fetchSeismoQuakeIntensity).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // 安全弁: 配る前のホスト（404）へは、出し直しのたびに訊き直さない。
  it('ホストが口を持っていなければ、出し直しても訊き直さない', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026/09/29 23:00:00'))
      fetchSeismoStatus.mockResolvedValue(okStatus())
      fetchSeismoWaveHistory.mockResolvedValue(history())
      const { rerender } = render()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(fetchSeismoQuakeIntensity).toHaveBeenCalledTimes(1)
      // 秒が変わる＝線を引き直して出し直す（震度を訊く契機になる）
      rerender({ originSeconds: new Map() })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(fetchSeismoQuakeIntensity).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('震度を訊けなかったときの取り直し（#494 段3）', () => {
  const unreachable = { kind: 'unreachable' as const, detail: 'TypeError: Failed to fetch' }

  function renderReplay(now: string, replayOffsetMs: number | null) {
    vi.setSystemTime(new Date(now))
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValue(history())
    return renderHook(() =>
      useSeismoQuakeWaves({
        enabled: true,
        baseUrl: 'http://host:50506',
        quakes: [SECONDS_QUAKE],
        scope: NO_SCOPE,
        readWave: () => null,
        replayOffsetMs,
        originSeconds: SECONDS,
        subscribeWaveRevised: NO_REVISED,
      }),
    )
  }

  // 正: 新しい地震は 30 秒後に取り直す。
  it('一時的に失敗したら 30 秒後に取り直す', async () => {
    vi.useFakeTimers()
    try {
      fetchSeismoQuakeIntensity.mockResolvedValueOnce(unreachable)
      // 再生中＝伸ばさないので、発生の 5 秒後でもすぐ訊く（発生から 30 分以内＝取り直す対象）
      renderReplay('2026/09/29 22:00:05', -3600_000)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(fetchSeismoQuakeIntensity).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(fetchSeismoQuakeIntensity).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  // 対照: 30 秒に満たないうちは取り直さない。
  it('30 秒に満たないうちは取り直さない', async () => {
    vi.useFakeTimers()
    try {
      fetchSeismoQuakeIntensity.mockResolvedValueOnce(unreachable)
      renderReplay('2026/09/29 22:00:05', -3600_000)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })
      expect(fetchSeismoQuakeIntensity).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // 安全弁: 発生から 30 分を過ぎた地震は取り直さない（ホストが落ちている間、古いカードのために叩き続けない）。
  it('古い地震は失敗しても取り直さない', async () => {
    vi.useFakeTimers()
    try {
      fetchSeismoQuakeIntensity.mockResolvedValue(unreachable)
      renderReplay('2026/09/29 23:00:00', null)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(fetchSeismoQuakeIntensity).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000)
      })
      expect(fetchSeismoQuakeIntensity).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('judgeWaveInterrupted', () => {
  it('正: 伸ばす番なのに閾値を超えて伸びていない', () => {
    expect(judgeWaveInterrupted({ growing: true, lastGrewAt: 0, now: 5000 })).toBe(true)
  })

  it('対照: 閾値の手前では立てない', () => {
    expect(judgeWaveInterrupted({ growing: true, lastGrewAt: 0, now: 4999 })).toBe(false)
  })

  // **ここを落とすと、正常に完結した 7 日ぶんのカードが全部薄くなる**
  // （伸びないのが当たり前の区間と、伸びるはずなのに伸びない区間は列では区別が付かない）。
  it('安全弁: 伸ばす番でなければ、どれだけ経っても立てない', () => {
    expect(judgeWaveInterrupted({ growing: false, lastGrewAt: 0, now: 60 * 60 * 1000 })).toBe(false)
  })

  // 時刻の較正で `serverNow()` が巻き戻ることがある（→ `utils/seismoSilence.ts`）。
  it('安全弁: 時刻が巻き戻っても立てない', () => {
    expect(judgeWaveInterrupted({ growing: true, lastGrewAt: 10_000, now: 0 })).toBe(false)
  })
})

// 取り戻した区間を作り直した知らせ（#597・2026-10-07 ユーザー承認）。カードの列のうち、その区間に掛かる
// 列をホストから取り直して差し替える。
describe('useSeismoQuakeWaves: 作り直しの知らせ', () => {
  const QUAKES = [SECONDS_QUAKE]
  const COL = (v: number) => ({ min: [-v, -v, -v] as const, max: [v, v, v] as const, minMembers: 9 })

  /** 知らせを流す口。`emit` で 1 件流す。 */
  function revisedChannel() {
    const listeners = new Set<(r: { stationId: string; fromMs: number; toMs: number }) => void>()
    return {
      subscribe: (l: (r: { stationId: string; fromMs: number; toMs: number }) => void) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
      emit: (r: { stationId: string; fromMs: number; toMs: number }) => listeners.forEach((l) => l(r)),
    }
  }

  function setup(channel: ReturnType<typeof revisedChannel>, replayOffsetMs: number | null = null) {
    return renderHook(() =>
      useSeismoQuakeWaves({
        enabled: true,
        baseUrl: 'http://host:50506',
        quakes: QUAKES,
        scope: NO_SCOPE,
        readWave: () => null,
        replayOffsetMs,
        originSeconds: SECONDS,
        subscribeWaveRevised: channel.subscribe,
      }),
    )
  }

  it('正: 知らせの区間に掛かる列を、列の境目へ揃えて取り直し差し替える', async () => {
    fetchSeismoStatus.mockResolvedValue(okStatus())
    // 起点 0・1 列 350 ms・3 列（真ん中が穴）。
    fetchSeismoWaveHistory.mockResolvedValueOnce(history({ columns: [COL(1), null, COL(1)] }))
    const channel = revisedChannel()
    const { result } = setup(channel)
    await waitFor(() => expect(result.current.size).toBe(1))

    fetchSeismoWaveHistory.mockResolvedValueOnce(history({ fromMs: 350, columns: [COL(5)] }))
    act(() => channel.emit({ stationId: 'station-1', fromMs: 400, toMs: 600 }))

    await waitFor(() => expect([...result.current.values()][0]?.[0]?.columns.columns[1]).toEqual(COL(5)))
    const call = fetchSeismoWaveHistory.mock.calls[1]?.[0] as { range: unknown; columns: number }
    expect(call.range).toEqual({ fromMs: 350, toMs: 700 })
    expect(call.columns).toBe(1)
  })

  it('安全弁: 取り直した列にホストが読み込みの欠けを申告していたら、差し替えたうえで記録へ残す', async () => {
    const { log } = await import('../utils/logger')
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValueOnce(history({ columns: [COL(1), null, COL(1)] }))
    const channel = revisedChannel()
    const { result } = setup(channel)
    await waitFor(() => expect(result.current.size).toBe(1))

    fetchSeismoWaveHistory.mockResolvedValueOnce(history({ fromMs: 350, columns: [COL(5)], filesFailed: 1 }))
    act(() => channel.emit({ stationId: 'station-1', fromMs: 400, toMs: 600 }))

    await waitFor(() => expect([...result.current.values()][0]?.[0]?.columns.columns[1]).toEqual(COL(5)))
    expect(warn.mock.calls.some((c) => String(c[0]).includes('取り直した波形に欠けがある'))).toBe(true)
    warn.mockRestore()
  })

  it('対照: 別の観測点・カードの列に掛からない区間の知らせでは取りに行かない', async () => {
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValueOnce(history({ columns: [COL(1), null, COL(1)] }))
    const channel = revisedChannel()
    const { result } = setup(channel)
    await waitFor(() => expect(result.current.size).toBe(1))

    act(() => {
      channel.emit({ stationId: 'other', fromMs: 0, toMs: 1050 })
      channel.emit({ stationId: 'station-1', fromMs: 1050, toMs: 5000 })
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(fetchSeismoWaveHistory).toHaveBeenCalledTimes(1)
  })

  it('安全弁: ホストが知らない観測点と答えたら差し替えず、記録へ残す', async () => {
    const { log } = await import('../utils/logger')
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    fetchSeismoStatus.mockResolvedValue(okStatus())
    fetchSeismoWaveHistory.mockResolvedValueOnce(history({ columns: [COL(1), null, COL(1)] }))
    const channel = revisedChannel()
    const { result } = setup(channel)
    await waitFor(() => expect(result.current.size).toBe(1))

    fetchSeismoWaveHistory.mockResolvedValueOnce(history({ fromMs: 350, columns: [COL(5)], stationKnown: false }))
    act(() => channel.emit({ stationId: 'station-1', fromMs: 400, toMs: 600 }))
    await waitFor(() => expect(fetchSeismoWaveHistory).toHaveBeenCalledTimes(2))
    await act(async () => {
      await Promise.resolve()
    })

    expect([...result.current.values()][0]?.[0]?.columns.columns[1]).toBeNull()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('ホストが知らない観測点の波形を取り直した'))).toBe(true)
    warn.mockRestore()
  })
})
