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
        measured: 1.87,
        measuredUnavailable: null,
        gapCount: 0,
        invalidChunkCount: 0,
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
