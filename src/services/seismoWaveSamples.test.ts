// 過ぎた合成波形をサンプルのまま取る（`GET /waves` を `columns` なしで呼ぶ）。
//
// **応答の形はホストの実装から取っている**（`seismo-host/src/receiver/statusServer.ts` の
// `buildWaveResponse` の生サンプル側）。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { log } from '../utils/logger'
import { fetchSeismoWaveSamples, readWaveSamples, SAMPLES_RANGE_MAX_MS, SAMPLES_SPAN_MAX_MS } from './seismoWaveSamples'

vi.mock('../utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger')>()
  return { ...actual, log: { ...actual.log, warn: vi.fn() } }
})

const BASE = 'http://192.0.2.137:50506'
const T0 = 1_790_000_000_000

function body(firstSampleMs: number, extra: Record<string, unknown> = {}): unknown {
  return {
    stationId: 'station-1',
    stationKnown: true,
    filesFailed: 0,
    skippedBytes: 0,
    truncated: false,
    chunks: [{ firstSampleMs, msPerSample: 10, dcGal: [0, 0, 980], gal: [[1, null], [2, 3], [4, 5]], memberCount: [3, 3] }],
    ...extra,
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => value } as unknown as Response
}

// 安全弁: ホストの上限と食い違うと、2 分ずつ割った問い合わせが毎回 400 で断られ、詳細の窓が
// ずっとカードの列のまま描かれる（取得層の記録にしか出ない）。別のパッケージなので import できず、
// ソースの字面で突き合わせる。
describe('ホストの上限との一致', () => {
  it('1 回で取る幅がホストの WAVE_RAW_RANGE_MAX_MS と同じ', () => {
    const src = readFileSync(resolve(__dirname, '../../seismo-host/src/receiver/statusServer.ts'), 'utf8')
    const m = /const WAVE_RAW_RANGE_MAX_MS = ([\d\s*]+)\n/.exec(src)
    expect(m).not.toBeNull()
    const value = m![1].split('*').reduce((p, x) => p * Number(x.trim()), 1)
    expect(value).toBe(SAMPLES_RANGE_MAX_MS)
  })
})

describe('readWaveSamples', () => {
  it('null は欠測として NaN に読む', () => {
    const r = readWaveSamples(body(T0))
    if (!('value' in r)) throw new Error(r.detail)
    const c = r.value.chunks[0]
    expect(c.firstSampleMs).toBe(T0)
    expect(c.gal[0][0]).toBe(1)
    expect(Number.isNaN(c.gal[0][1])).toBe(true)
  })

  // 安全弁: 数でない要素を詰めると時間の縮んだ絵になるので、応答ごと捨てる。
  it('数でない要素があれば読めない', () => {
    const bad = body(T0) as { chunks: { gal: unknown[][] }[] }
    bad.chunks[0].gal[1][0] = 'x'
    expect('detail' in readWaveSamples(bad)).toBe(true)
  })

  it('成分の長さが揃っていなければ読めない', () => {
    const bad = body(T0) as { chunks: { gal: unknown[][] }[] }
    bad.chunks[0].gal[2] = [1]
    expect('detail' in readWaveSamples(bad)).toBe(true)
  })
})

describe('fetchSeismoWaveSamples', () => {
  // 正: 2 分を超える区間は 2 分ずつ順に取る。
  it('2 分を超える区間は 2 分ずつに割って取る', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return jsonResponse(body(T0))
    }) as unknown as typeof fetch
    const r = await fetchSeismoWaveSamples({ baseUrl: BASE, stationId: 'station-1', fromMs: T0, toMs: T0 + 270_000, fetchImpl })
    expect(r.kind).toBe('ok')
    expect(urls).toHaveLength(3)
    expect(urls[0]).toContain(`from=${T0}&to=${T0 + SAMPLES_RANGE_MAX_MS}`)
    expect(urls[2]).toContain(`from=${T0 + 2 * SAMPLES_RANGE_MAX_MS}&to=${T0 + 270_000}`)
    for (const u of urls) expect(u).not.toContain('columns')
  })

  // 安全弁: 一部だけ描くと取れなかった区間が「揺れていなかった」ように見えるので、失敗をそのまま返す。
  it('途中で 1 つでも失敗したら、その失敗を返して先は取らない', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => {
      n += 1
      return n === 2 ? jsonResponse({}, 500) : jsonResponse(body(T0))
    }) as unknown as typeof fetch
    const r = await fetchSeismoWaveSamples({ baseUrl: BASE, stationId: 'station-1', fromMs: T0, toMs: T0 + 270_000, fetchImpl })
    expect(r).toEqual({ kind: 'http-error', status: 500 })
    expect(n).toBe(2)
  })

  // 対照: 上限を超える範囲はリクエストを 1 件も出さずに弾く。
  it('上限を超える範囲は取りに行かない', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const r = await fetchSeismoWaveSamples({ baseUrl: BASE, stationId: 'station-1', fromMs: T0, toMs: T0 + SAMPLES_SPAN_MAX_MS + 1, fetchImpl })
    expect(r.kind).toBe('bad-request')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('取り消されたら aborted を返し、記録へは残さない', async () => {
    const ctrl = new AbortController()
    const fetchImpl = vi.fn(async () => {
      ctrl.abort()
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof fetch
    vi.mocked(log.warn).mockClear()
    const r = await fetchSeismoWaveSamples({ baseUrl: BASE, stationId: 'station-1', fromMs: T0, toMs: T0 + 1000, signal: ctrl.signal, fetchImpl })
    expect(r.kind).toBe('aborted')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('ホストが申告した読み込みの欠けは記録へ残す', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(body(T0, { filesFailed: 1 }))) as unknown as typeof fetch
    vi.mocked(log.warn).mockClear()
    const r = await fetchSeismoWaveSamples({ baseUrl: BASE, stationId: 'station-1', fromMs: T0, toMs: T0 + 1000, fetchImpl })
    expect(r.kind).toBe('ok')
    expect(vi.mocked(log.warn).mock.calls.some((c) => String(c[0]).includes('読み込みの欠け'))).toBe(true)
  })
})
