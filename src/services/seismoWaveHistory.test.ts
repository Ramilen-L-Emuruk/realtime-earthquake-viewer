// 過ぎた合成波形の読み返し（`GET /waves`）。
//
// **応答の形はホストの実装から取っている**（`seismo-host/src/receiver/statusServer.ts` の
// `buildWaveResponse`）。2026-09-29 に実機（ramsdesktop 50506）で取った応答をそのまま
// 縮めたものをフィクスチャにしてある。

import { describe, expect, it, vi } from 'vitest'

import {
  buildWaveHistoryRange,
  fetchSeismoWaveHistory,
  readWaveHistory,
  WAVE_HISTORY_LEAD_MS,
  WAVE_HISTORY_TAIL_MS,
} from './seismoWaveHistory'

/** 実機の応答（2026-09-29 実測）を 3 列へ縮めたもの。 */
const RESPONSE = {
  stationId: 'station-1',
  stationKnown: true,
  fromMs: 1790689659199,
  toMs: 1790689869199,
  filesRead: 2,
  filesMissing: 0,
  filesFailed: 0,
  skippedBytes: 0,
  truncated: false,
  columnSpanMs: 350,
  columns: [
    { min: [-1.29892, -0.51962, -0.97282], max: [0.98729, 0.53547, 0.96435], minMembers: 9 },
    null,
    { min: [-0.5, -0.4, -0.3], max: [0.5, 0.4, 0.3], minMembers: 1 },
  ],
  hasAnyValue: true,
  peakGal: 2.11908,
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('buildWaveHistoryRange', () => {
  it('発生時刻の前後へ窓を広げる', () => {
    const range = buildWaveHistoryRange(1_000_000)
    expect(range).toEqual({
      fromMs: 1_000_000 - WAVE_HISTORY_LEAD_MS,
      toMs: 1_000_000 + WAVE_HISTORY_TAIL_MS,
    })
  })

  it('窓はホストの上限（列で 10 分）に収まる', () => {
    // **安全弁。** 定数を伸ばした人がここで気づく。
    expect(WAVE_HISTORY_LEAD_MS + WAVE_HISTORY_TAIL_MS).toBeLessThanOrEqual(10 * 60 * 1000)
  })

  it('時刻として読めなければ窓を作らない', () => {
    expect(buildWaveHistoryRange(NaN)).toBeNull()
    expect(buildWaveHistoryRange(Infinity)).toBeNull()
  })
})

describe('readWaveHistory', () => {
  it('実機の応答を読める', () => {
    const read = readWaveHistory(RESPONSE)
    expect('value' in read).toBe(true)
    if (!('value' in read)) return
    const h = read.value
    expect(h.stationId).toBe('station-1')
    expect(h.stationKnown).toBe(true)
    expect(h.columnSpanMs).toBe(350)
    expect(h.columns).toHaveLength(3)
    expect(h.columns[0]?.min).toEqual([-1.29892, -0.51962, -0.97282])
    expect(h.columns[0]?.minMembers).toBe(9)
    expect(h.hasAnyValue).toBe(true)
    expect(h.peakGal).toBeCloseTo(2.11908)
  })

  it('値を持たない列は null のまま残す', () => {
    const read = readWaveHistory(RESPONSE)
    if (!('value' in read)) throw new Error('読めるはず')
    // **詰めない。** 抜いて前後を繋ぐと、そこだけ時間が縮んだ絵になる。
    expect(read.value.columns[1]).toBeNull()
    expect(read.value.columns[2]).not.toBeNull()
  })

  it('stationKnown が欠けていれば false として扱う', () => {
    // **既定を true にしない。** 版が古い応答を「知っている観測点」として通すと、
    // 観測点 ID の取り違えを示す唯一の手掛かりが消える。
    const { stationKnown: _drop, ...rest } = RESPONSE
    const read = readWaveHistory(rest)
    if (!('value' in read)) throw new Error('読めるはず')
    expect(read.value.stationKnown).toBe(false)
  })

  it('stationKnown が false の応答をそのまま通す（断らない）', () => {
    const read = readWaveHistory({ ...RESPONSE, stationKnown: false })
    if (!('value' in read)) throw new Error('読めるはず')
    expect(read.value.stationKnown).toBe(false)
  })

  it('stationId が無い応答は捨てる', () => {
    const read = readWaveHistory({ ...RESPONSE, stationId: '' })
    expect(read).toEqual({ detail: 'stationId が無い' })
  })

  it('columns が配列でない応答は捨てる', () => {
    const read = readWaveHistory({ ...RESPONSE, columns: null })
    expect(read).toEqual({ detail: 'columns が配列ではない' })
  })

  it('列の成分が 3 つでなければ、その応答ごと捨てる', () => {
    const read = readWaveHistory({
      ...RESPONSE,
      columns: [{ min: [0, 0], max: [1, 1, 1], minMembers: 3 }],
    })
    expect(read).toEqual({ detail: '列の min / max を読めない' })
  })

  it('列の成分が数として読めなければ、その応答ごと捨てる', () => {
    const read = readWaveHistory({
      ...RESPONSE,
      columns: [{ min: [0, 0, null], max: [1, 1, 1], minMembers: 3 }],
    })
    expect(read).toEqual({ detail: '列の min / max を読めない' })
  })

  it('記録が欠けている応答も読める（欠けたことは欄で分かる）', () => {
    const read = readWaveHistory({
      ...RESPONSE,
      filesMissing: 3,
      hasAnyValue: false,
      columns: [null, null, null],
      peakGal: 0,
    })
    if (!('value' in read)) throw new Error('読めるはず')
    expect(read.value.filesMissing).toBe(3)
    expect(read.value.hasAnyValue).toBe(false)
  })
})

describe('fetchSeismoWaveHistory', () => {
  const RANGE = { fromMs: 1_000_000, toMs: 1_270_000 }

  it('列の形で取れる', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RESPONSE))
    const result = await fetchSeismoWaveHistory({
      baseUrl: 'http://host:50506',
      stationId: 'station-1',
      range: RANGE,
      columns: 600,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.history.columns).toHaveLength(3)
  })

  it('観測点・範囲・列数をクエリへ載せる', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: unknown) => jsonResponse(RESPONSE))
    await fetchSeismoWaveHistory({
      baseUrl: 'http://host:50506/',
      stationId: 'station-1',
      range: RANGE,
      columns: 600,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const url = String(fetchImpl.mock.calls[0]?.[0])
    // 末尾のスラッシュを落とす（二重スラッシュはホストが 404 を返す）。
    expect(url.startsWith('http://host:50506/waves?')).toBe(true)
    expect(url).toContain('station=station-1')
    expect(url).toContain('from=1000000')
    expect(url).toContain('to=1270000')
    expect(url).toContain('columns=600')
  })

  it('URL の形が正しくなければ、通信する前に弾く', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RESPONSE))
    const result = await fetchSeismoWaveHistory({
      baseUrl: 'host:50506',
      stationId: 'station-1',
      range: RANGE,
      columns: 600,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.kind).toBe('bad-request')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('範囲が上限を超えていれば、通信する前に弾く', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RESPONSE))
    const result = await fetchSeismoWaveHistory({
      baseUrl: 'http://host:50506',
      stationId: 'station-1',
      range: { fromMs: 0, toMs: 11 * 60 * 1000 },
      columns: 600,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.kind).toBe('bad-request')
    // **下流へ流さない。** 投げても 400 が返るだけだが、それは 1 往復した後。
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('範囲が逆さまなら、通信する前に弾く', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RESPONSE))
    const result = await fetchSeismoWaveHistory({
      baseUrl: 'http://host:50506',
      stationId: 'station-1',
      range: { fromMs: 1_270_000, toMs: 1_000_000 },
      columns: 600,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.kind).toBe('bad-request')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('列数が 0 以下なら、通信する前に弾く', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RESPONSE))
    const result = await fetchSeismoWaveHistory({
      baseUrl: 'http://host:50506',
      stationId: 'station-1',
      range: RANGE,
      columns: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.kind).toBe('bad-request')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('観測点が空なら、通信する前に弾く', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RESPONSE))
    const result = await fetchSeismoWaveHistory({
      baseUrl: 'http://host:50506',
      stationId: '',
      range: RANGE,
      columns: 600,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.kind).toBe('bad-request')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('HTTP が成功でなければ状態を返す', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'range-too-wide' }, 400))
    const result = await fetchSeismoWaveHistory({
      baseUrl: 'http://host:50506',
      stationId: 'station-1',
      range: RANGE,
      columns: 600,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual({ kind: 'http-error', status: 400 })
  })

  it('応答が返らなければ unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const result = await fetchSeismoWaveHistory({
      baseUrl: 'http://host:50506',
      stationId: 'station-1',
      range: RANGE,
      columns: 600,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.kind).toBe('unreachable')
  })

  it('形が違う応答は unreadable（記録が無いのと混ぜない）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hello: 'world' }))
    const result = await fetchSeismoWaveHistory({
      baseUrl: 'http://host:50506',
      stationId: 'station-1',
      range: RANGE,
      columns: 600,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.kind).toBe('unreadable')
  })

  it('既に落ちている signal を渡されたら取りに行かない', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const fetchImpl = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      // 実装は内側の AbortController を落としてから fetch を呼ぶので、
      // ここで落ちていることを確かめる（本物の fetch はこの signal を見て投げる）。
      if (init?.signal?.aborted === true) throw new DOMException('Aborted', 'AbortError')
      return jsonResponse(RESPONSE)
    })
    const result = await fetchSeismoWaveHistory({
      baseUrl: 'http://host:50506',
      stationId: 'station-1',
      range: RANGE,
      columns: 600,
      signal: ctrl.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.kind).toBe('unreachable')
  })
})
