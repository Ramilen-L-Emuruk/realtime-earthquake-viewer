// @vitest-environment jsdom
//
// 地震カードに出す公開観測点の波形の、選び方と取り方（地震ごとに 1 回でまとめて取る・控えを使う）。

import 'fake-indexeddb/auto'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { steim2Record } from '../test-utils/mseed2Fixture'
import type { JMAQuake } from '../types/earthquake'
import type { PublicStationEpoch, PublicStationsFile } from '../utils/publicStations'
import { clearPublicWaveDb } from '../utils/publicQuakeWaveDb'
import { setReplayOffset } from '../utils/clock'
import { quakeEventKey } from '../utils/quakeMerge'
import type { OriginSeconds } from '../utils/quakeOriginSeconds'

const archive = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('../services/publicWaveArchive', () => ({ fetchPublicWaveArchive: archive.fetch }))

const stations = vi.hoisted(() => ({ load: vi.fn(), listeners: new Set<(file: PublicStationsFile) => void>() }))
vi.mock('../utils/publicStations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/publicStations')>()),
  checkPublicStations: () => Promise.resolve(null),
  subscribePublicStations: (listener: (file: PublicStationsFile) => void) => { stations.listeners.add(listener); return () => { stations.listeners.delete(listener) } },
  loadPublicStations: stations.load,
}))

// **トップレベルで一度読む**（テスト本体で初めて読むと、その待ちが 1 件目に乗る。CLAUDE.md「検証」）。
const { pickPublicQuakeTargets, usePublicQuakeWaves } = await import('./usePublicQuakeWaves')

const SENS = 1e9

function epoch(code: string, nameJa: string, lat: number, lon: number): PublicStationEpoch {
  return {
    code,
    nameJa,
    siteName: code,
    lat,
    lon,
    elevation: 0,
    start: '2000-01-01T00:00:00',
    end: null,
    channels: (['BHE', 'BHN', 'BHZ'] as const).map((c) => ({ code: c, sampleRate: 20, sensitivity: SENS, sensitivityFreq: 1, azimuth: 0, dip: 0 })),
  }
}

const FILE: PublicStationsFile = {
  source: { station: '', channel: '' },
  fetchedOn: '2026-10-15',
  stations: [epoch('AAA', '近い', 35.55, 139.85), epoch('BBB', '次に近い', 35.7, 140.0)],
  excluded: [],
}

/** 2026-10-13 20:44:00 JST（= 11:44:00 UTC）。見本のレコードは 11:44:29 から始まる（`mseed2Fixture` の既定）。 */
const TIME = '2026/10/13 20:44:00'

function quake(id: string, time: string, maxScale: number, lat = 35.5, lon = 139.8): JMAQuake {
  return {
    id,
    time,
    issue: { source: '', time, type: '震源・震度情報' },
    earthquake: {
      time,
      hypocenter: { name: '東京湾', latitude: lat, longitude: lon, depth: 10, magnitude: 6.0 },
      maxScale,
      domesticTsunami: 'None',
    },
    points: [],
  } as unknown as JMAQuake
}

function recordsFor(codes: readonly string[]): Uint8Array {
  const parts = codes.flatMap((station) =>
    (['BHE', 'BHN', 'BHZ'] as const).map(
      (channel) => steim2Record(Int32Array.from({ length: 200 }, (_, i) => 1000 + i), { station, channel, factor: 20, multiplier: 1 }).bytes,
    ),
  )
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const NO_SECONDS = new Map()
const readLiveRaw = () => null

function render(quakes: readonly JMAQuake[], enabled = true, replayOffsetMs: number | null = null) {
  return renderHook(() =>
    usePublicQuakeWaves({ enabled, quakes, originSeconds: NO_SECONDS, openedEventKey: null, liveNumbers: null, readLiveRaw, replayOffsetMs }),
  )
}

afterEach(() => {
  setReplayOffset(null)
})

beforeEach(async () => {
  await clearPublicWaveDb()
  archive.fetch.mockReset()
  stations.load.mockReset()
  stations.load.mockResolvedValue(FILE)
})

describe('pickPublicQuakeTargets', () => {
  // 対照: 無感（最大震度を持たない）・震央の分からない地震は対象にしない。
  it('有感で震央の分かる地震だけを、新しい順に並べる', () => {
    const got = pickPublicQuakeTargets(
      [quake('old', '2026/10/13 10:00:00', 30), quake('unfelt', '2026/10/13 11:00:00', 0), quake('new', '2026/10/13 12:00:00', 20)],
      NO_SECONDS,
    )
    expect(got.map((t) => t.eventKey.includes('new') ? 'new' : 'old')).toEqual(['new', 'old'])
    // 古い地震は 1 つ新しい地震の発生で切る
    expect(got[0].cutoffMs).toBeNull()
    expect(got[1].cutoffMs).toBe(Date.parse('2026-10-13T12:00:00+09:00'))
  })
})

describe('usePublicQuakeWaves', () => {
  // 正: 地震 1 件ぶんの観測点を 1 回の問い合わせにまとめ、観測点ごとのカードを番号順に返す。
  it('観測点をまとめて 1 回で取り、観測点ごとのカードにする', async () => {
    archive.fetch.mockResolvedValue({ kind: 'ok', bytes: recordsFor(['AAA', 'BBB']) })
    const h = render([quake('q1', TIME, 30)])
    await waitFor(() => expect([...h.result.current.values()][0]?.length).toBe(2))
    expect(archive.fetch).toHaveBeenCalledTimes(1)
    expect([...archive.fetch.mock.calls[0][0].stations].sort()).toEqual(['AAA', 'BBB'])
    const waves = [...h.result.current.values()][0]
    expect(waves.map((w) => w.number)).toEqual([1, 2])
    const card = waves[0].card
    expect(card.stationId).toBe(`public:${waves[0].code}`)
    expect(card.displayName).toBe(`#1 ${waves[0].nameJa}`)
    expect(card.unit.label).toBe('μm/s')
    expect(card.samples.kind).toBe('held')
    expect(card.columns.columns.length).toBeGreaterThan(0)
  })

  // 安全弁: 入りきってから取った控えは、開き直しても取りに行かない（保存庫を繰り返し問い合わせない）。
  it('控えがあれば取りに行かない', async () => {
    archive.fetch.mockResolvedValue({ kind: 'ok', bytes: recordsFor(['AAA', 'BBB']) })
    const first = render([quake('q1', TIME, 30)])
    await waitFor(() => expect([...first.result.current.values()][0]?.length).toBe(2))
    first.unmount()
    const second = render([quake('q1', TIME, 30)])
    await waitFor(() => expect([...second.result.current.values()][0]?.length).toBe(2))
    expect(archive.fetch).toHaveBeenCalledTimes(1)
  })

  it('取得後に発生秒が判明したら、再取得せず時間軸と到達線を更新する', async () => {
    archive.fetch.mockResolvedValue({ kind: 'ok', bytes: recordsFor(['AAA', 'BBB']) })
    const quakes = [quake('q1', TIME, 30)]
    const key = quakeEventKey(quakes[0])
    const h = renderHook(({ seconds }: { seconds: ReadonlyMap<string, OriginSeconds> }) =>
      usePublicQuakeWaves({ enabled: true, quakes, originSeconds: seconds, openedEventKey: null, liveNumbers: null, readLiveRaw, replayOffsetMs: null }),
      { initialProps: { seconds: NO_SECONDS as ReadonlyMap<string, OriginSeconds> } },
    )
    await waitFor(() => expect(h.result.current.get(key)?.length).toBe(2))
    const before = h.result.current.get(key)![0]
    expect(before.card.axisZero.kind).toBe('minute')
    expect(before.card.arrival).toBeNull()
    const originMs = Date.parse('2026-10-13T11:44:05Z')
    h.rerender({ seconds: new Map([[key, { originMs, source: 'catalog' as const }]]) })
    await waitFor(() => expect(h.result.current.get(key)![0].card.axisZero.kind).toBe('origin'))
    const after = h.result.current.get(key)![0]
    expect(after.card.axisZero.ms).toBe(originMs)
    expect(after.card.arrival).not.toBeNull()
    expect(after.card.reach).not.toEqual(before.card.reach)
    expect(after.window).toBe(before.window)
    expect(archive.fetch).toHaveBeenCalledTimes(1)
    // 秒の出どころだけが変わった場合も反映し、秒が消えたら線を残さない。
    h.rerender({ seconds: new Map([[key, { originMs, source: 'eew' as const }]]) })
    await waitFor(() => expect(h.result.current.get(key)![0].card.axisZero).toMatchObject({ kind: 'origin', source: 'eew' }))
    h.rerender({ seconds: NO_SECONDS })
    await waitFor(() => expect(h.result.current.get(key)![0].card.axisZero.kind).toBe('minute'))
    expect(h.result.current.get(key)![0].card.arrival).toBeNull()
    expect(archive.fetch).toHaveBeenCalledTimes(1)
  })

  it('観測点の感度が更新されたら、取得済みの生バイトで換算し直す', async () => {
    archive.fetch.mockResolvedValue({ kind: 'ok', bytes: recordsFor(['AAA', 'BBB']) })
    const h = render([quake('q1', TIME, 30)])
    await waitFor(() => expect([...h.result.current.values()][0]?.length).toBe(2))
    const before = [...h.result.current.values()][0][0]
    const next: PublicStationsFile = { ...FILE, stations: FILE.stations.map(e => ({ ...e, channels: e.channels.map(c => ({ ...c, sensitivity: c.sensitivity * 2 })) })) }
    await act(async () => { for (const listener of stations.listeners) listener(next) })
    const after = [...h.result.current.values()][0][0]
    expect(after.window!.gal[0][0]).toBeCloseTo(before.window!.gal[0][0] / 2, 6)
    expect(archive.fetch).toHaveBeenCalledTimes(1)
  })

  // 応答に載らなかった観測点は「データが無い」と同じ扱い（カードに出さない）。
  it('応答に載らなかった観測点は出さない', async () => {
    archive.fetch.mockResolvedValue({ kind: 'ok', bytes: recordsFor(['AAA']) })
    const h = render([quake('q1', TIME, 30)])
    await waitFor(() => expect([...h.result.current.values()][0]?.length).toBe(1))
    expect([...h.result.current.values()][0][0].code).toBe('AAA')
  })

  // 安全弁: 問い合わせ全体が 404 なら確かな不在として控えない（保存庫が一時的に何でも 404 を返すことがある）。
  // 開き直すと（次の起動・次の機会）、もう一度取りに行く。
  it('全観測点が 404 なら控えず、次の機会に取り直す', async () => {
    archive.fetch.mockResolvedValue({ kind: 'no-data' })
    const first = render([quake('q1', TIME, 30)])
    await waitFor(() => expect(archive.fetch).toHaveBeenCalledTimes(1))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100))
    })
    expect(first.result.current.size).toBe(0)
    first.unmount()
    archive.fetch.mockResolvedValue({ kind: 'ok', bytes: recordsFor(['AAA', 'BBB']) })
    const second = render([quake('q1', TIME, 30)])
    await waitFor(() => expect([...second.result.current.values()][0]?.length).toBe(2))
    expect(archive.fetch).toHaveBeenCalledTimes(2)
  })

  // 正: 再生中は再生時刻より先を出さない（列も詳細の窓の生のサンプルも）。見本のレコードは 11:44:29〜11:44:39。
  // 対照: 再生時刻が発生より後のサンプルにまだ届いていなければ、カードに出さない（取得中と同じ扱い）。
  it('再生中は再生時刻までで切って出す', async () => {
    archive.fetch.mockResolvedValue({ kind: 'ok', bytes: recordsFor(['AAA', 'BBB']) })
    const until = Date.parse('2026-10-13T11:44:34Z')
    const offset = until - Date.now()
    setReplayOffset(offset)
    const h = render([quake('q1', TIME, 30)], true, offset)
    await waitFor(() => expect([...h.result.current.values()][0]?.length).toBe(2))
    const w = [...h.result.current.values()][0][0]
    const held = w.card.samples.kind === 'held' ? w.card.samples.window : null
    expect(held).not.toBeNull()
    const lastMs = held!.firstSampleMs + (held!.gal[0].length - 1) * held!.msPerSample
    expect(lastMs).toBeLessThanOrEqual(until + 1000)
    expect(lastMs).toBeLessThan(Date.parse('2026-10-13T11:44:38Z'))
    h.unmount()

    const early = Date.parse('2026-10-13T11:44:10Z') - Date.now()
    setReplayOffset(early)
    const h2 = render([quake('q1', TIME, 30)], true, early)
    // 控えを読んで組み立て終えるまで待つ（その間の描き直しを act の中で済ませる）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300))
    })
    expect(h2.result.current.size).toBe(0)
  })

  it('同じカードのまま再生時刻を戻した瞬間に未来のサンプルを外す', async () => {
    archive.fetch.mockResolvedValue({ kind: 'ok', bytes: recordsFor(['AAA', 'BBB']) })
    const quakes = [quake('q1', TIME, 30)]
    const at = Date.parse('2026-10-13T12:00:00Z')
    const offset = at - Date.now()
    setReplayOffset(offset)
    const h = renderHook(({ offset }: { offset: number }) => usePublicQuakeWaves({ enabled: true, quakes, originSeconds: NO_SECONDS, openedEventKey: null, liveNumbers: null, readLiveRaw, replayOffsetMs: offset }), { initialProps: { offset } })
    await waitFor(() => expect([...h.result.current.values()][0]?.length).toBe(2))
    const earlierMs = Date.parse('2026-10-13T11:44:31Z')
    const earlier = earlierMs - Date.now()
    // Appは新offsetでレンダーした後、effectで共有時計を更新する。先に時計を書き換えない。
    h.rerender({ offset: earlier })
    const w = [...h.result.current.values()][0][0].window!
    expect(w.firstSampleMs + (w.gal[0].length - 1) * w.msPerSample).toBeLessThanOrEqual(earlierMs + 100)
    expect(archive.fetch).toHaveBeenCalledTimes(1)
  })

  it('次の地震が後着したら、取得済みの旧波形をその時刻で切り戻す', async () => {
    archive.fetch.mockResolvedValue({ kind: 'ok', bytes: recordsFor(['AAA', 'BBB']) })
    const q1 = quake('q1', TIME, 30)
    const key = quakeEventKey(q1)
    const h = renderHook(({ quakes }: { quakes: readonly JMAQuake[] }) => usePublicQuakeWaves({ enabled: true, quakes, originSeconds: NO_SECONDS, openedEventKey: null, liveNumbers: null, readLiveRaw, replayOffsetMs: null }), { initialProps: { quakes: [q1] } })
    await waitFor(() => expect(h.result.current.get(key)?.length).toBe(2))
    const cutoff = Date.parse('2026-10-13T11:44:30Z')
    h.rerender({ quakes: [quake('q2', '2026/10/13 20:44:30', 30), q1] })
    const w = h.result.current.get(key)![0]
    expect(w.range.toMs).toBe(cutoff)
    expect(w.window!.firstSampleMs + (w.window!.gal[0].length - 1) * w.window!.msPerSample).toBeLessThanOrEqual(cutoff)
    expect(w.card.columns.fromMs + w.card.columns.columns.length * w.card.columns.columnSpanMs).toBeLessThanOrEqual(cutoff + w.card.columns.columnSpanMs)
  })

  it.each([512, 1])('成功応答に壊れたレコード/端数（%iバイト）があっても永続的な不在にしない', async (badLength) => {
    const good = recordsFor(['AAA'])
    const damaged = new Uint8Array(good.length + badLength)
    damaged.set(good)
    archive.fetch.mockResolvedValue({ kind: 'ok', bytes: damaged })
    const first = render([quake('q1', TIME, 30)])
    await waitFor(() => expect([...first.result.current.values()][0]?.length).toBe(1))
    first.unmount()
    archive.fetch.mockResolvedValue({ kind: 'ok', bytes: recordsFor(['AAA', 'BBB']) })
    const second = render([quake('q1', TIME, 30)])
    await waitFor(() => expect([...second.result.current.values()][0]?.length).toBe(2))
    expect(archive.fetch).toHaveBeenCalledTimes(2)
  })

  // 対照: 使わない間は取りに行かない。
  it('使わない間は取りに行かない', async () => {
    const h = render([quake('q1', TIME, 30)], false)
    await new Promise((r) => setTimeout(r, 50))
    expect(archive.fetch).not.toHaveBeenCalled()
    expect(h.result.current.size).toBe(0)
  })
})
