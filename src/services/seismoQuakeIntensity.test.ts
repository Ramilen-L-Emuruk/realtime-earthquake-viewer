// 地震の区間の震度（`GET /quake-intensity`）。
//
// **応答の形はホストの実装から取っている**（`seismo-host/src/receiver/statusServer.ts` の
// `buildQuakeIntensityResponse`）。

import { describe, expect, it, vi } from 'vitest'

import { log } from '../utils/logger'
import { fetchSeismoQuakeIntensity, readQuakeIntensity } from './seismoQuakeIntensity'

vi.mock('../utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger')>()
  return { ...actual, log: { ...actual.log, warn: vi.fn() } }
})

const T0 = 1790689659000

const RESPONSE = {
  stationId: 'station-1',
  stationKnown: true,
  fromMs: T0,
  toMs: T0 + 90_000,
  maxRealtime: 2.34,
  maxRealtimeAtMs: T0 + 31_000,
  realtimeSeries: [
    { atMs: T0 + 30_000, value: 1.2 },
    { atMs: T0 + 31_000, value: 2.34 },
    { atMs: T0 + 32_000, value: null },
  ],
  measured: 1.87,
  measuredUnavailable: null,
  gapCount: 0,
  filesRead: 1,
  filesMissing: 0,
  filesFailed: 0,
  skippedBytes: 0,
  truncated: false,
}

function okFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe('readQuakeIntensity', () => {
  it('2 つの値と区間を読む', () => {
    expect(readQuakeIntensity(RESPONSE)).toEqual({
      value: {
        fromMs: T0,
        toMs: T0 + 90_000,
        maxRealtime: 2.34,
        maxRealtimeAtMs: T0 + 31_000,
        realtimeSeries: RESPONSE.realtimeSeries,
        measured: 1.87,
        measuredUnavailable: null,
        gapCount: 0,
        invalidChunkCount: 0,
        unsolvedChunkCount: 0,
        filesMissing: 0,
        filesFailed: 0,
        skippedBytes: 0,
        truncated: false,
      },
    })
  })

  it('計測震度が出なければ理由を読む', () => {
    const r = readQuakeIntensity({ ...RESPONSE, measured: null, measuredUnavailable: 'gap', gapCount: 1 })
    expect('value' in r && r.value.measuredUnavailable).toBe('gap')
  })

  // 安全弁: 知らない理由を既知の語へ化けさせない。
  it('知らない理由は unknown にする', () => {
    const r = readQuakeIntensity({ ...RESPONSE, measured: null, measuredUnavailable: 'something-new' })
    expect('value' in r && r.value.measuredUnavailable).toBe('unknown')
  })

  // 安全弁: 欄の欠けた応答を「震度が出なかった地震」として通さない。
  it('震度の欄が欠けていれば読めないとする', () => {
    const { measured: _m, ...rest } = RESPONSE
    expect('detail' in readQuakeIntensity(rest)).toBe(true)
    expect('detail' in readQuakeIntensity({ ...RESPONSE, maxRealtime: '2.3' })).toBe(true)
  })

  // 安全弁: ホストが申告した読み込みの欠けを捨てない（記録へ残す材料）。
  it('読み込みの欠けと壊れていたまとまりの数を読む', () => {
    const r = readQuakeIntensity({ ...RESPONSE, filesFailed: 1, skippedBytes: 32, truncated: true, invalidChunkCount: 2 })
    expect('value' in r && r.value).toMatchObject({ filesFailed: 1, skippedBytes: 32, truncated: true, invalidChunkCount: 2 })
  })

  // 正（2026-10-09）: 解けなかった成分で捨てたまとまりの数を、壊れたまとまりと分けて読む。
  it('解けなかった成分で捨てたまとまりの数を読む', () => {
    const r = readQuakeIntensity({ ...RESPONSE, unsolvedChunkCount: 4 })
    expect('value' in r && r.value).toMatchObject({ unsolvedChunkCount: 4, invalidChunkCount: 0 })
  })

  // 対照: 推移を返す前のホストでも、最大と計測震度は読める。
  it('推移の欄が無ければ空の推移として読む', () => {
    const { realtimeSeries: _s, ...rest } = RESPONSE
    const r = readQuakeIntensity(rest)
    expect('value' in r && r.value.realtimeSeries).toEqual([])
    expect('value' in r && r.value.maxRealtime).toBe(2.34)
  })

  // 安全弁: 崩れた点を黙って捨てない（推移の線が「途切れた」ように見えてしまう）。
  it('推移の点が崩れていれば読めないとする', () => {
    const bad = (series: unknown): boolean => 'detail' in readQuakeIntensity({ ...RESPONSE, realtimeSeries: series })
    expect(bad('x')).toBe(true)
    expect(bad([{ atMs: 'a', value: 1 }])).toBe(true)
    expect(bad([{ atMs: T0, value: '1' }])).toBe(true)
    // 時刻が戻る・重なる
    expect(bad([{ atMs: T0 + 1000, value: 1 }, { atMs: T0, value: 1 }])).toBe(true)
  })

  it('範囲が読めなければ読めないとする', () => {
    expect('detail' in readQuakeIntensity({ ...RESPONSE, fromMs: null })).toBe(true)
  })
})

describe('fetchSeismoQuakeIntensity', () => {
  const base = { baseUrl: 'http://192.0.2.137:50506', stationId: 'station-1', fromMs: T0, toMs: T0 + 90_000 }

  it('区間を整数のミリ秒で訊き、結果を返す', async () => {
    const fetchImpl = okFetch(RESPONSE)
    const r = await fetchSeismoQuakeIntensity({ ...base, fromMs: T0 + 0.6, fetchImpl })
    expect(r.kind).toBe('ok')
    const url = (fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]
    expect(url).toBe(`http://192.0.2.137:50506/quake-intensity?station=station-1&from=${T0}&to=${T0 + 90_000}`)
  })

  // 対照: 404 は「配る前のホスト」で、記録へは書かない（呼び出し側が 1 回だけ書く）。
  it('404 は not-supported として返し、記録しない', async () => {
    vi.mocked(log.warn).mockClear()
    const r = await fetchSeismoQuakeIntensity({ ...base, fetchImpl: okFetch({ error: 'not-found' }, 404) })
    expect(r.kind).toBe('not-supported')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('404 以外の失敗は記録する', async () => {
    vi.mocked(log.warn).mockClear()
    const r = await fetchSeismoQuakeIntensity({ ...base, fetchImpl: okFetch({ error: 'x' }, 500) })
    expect(r).toEqual({ kind: 'http-error', status: 500 })
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  // 安全弁: ホストが弾く範囲を投げない（1 往復を無駄にしない）。
  it('10 分を超える範囲は通信せずに弾く', async () => {
    const fetchImpl = okFetch(RESPONSE)
    const r = await fetchSeismoQuakeIntensity({ ...base, toMs: T0 + 600_001, fetchImpl })
    expect(r.kind).toBe('bad-request')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('取り消しは aborted として返し、記録しない', async () => {
    vi.mocked(log.warn).mockClear()
    const ctrl = new AbortController()
    ctrl.abort()
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
      return new Response('{}')
    }) as unknown as typeof fetch
    const r = await fetchSeismoQuakeIntensity({ ...base, signal: ctrl.signal, fetchImpl })
    expect(r.kind).toBe('aborted')
    expect(log.warn).not.toHaveBeenCalled()
  })
})
