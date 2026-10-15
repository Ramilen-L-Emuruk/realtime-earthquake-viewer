import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDataselectUrl, fetchPublicWaveArchive } from './publicWaveArchive'

const RANGE = { fromMs: Date.UTC(2026, 9, 14, 11, 44, 0, 400), toMs: Date.UTC(2026, 9, 14, 11, 48, 30, 100) }

describe('buildDataselectUrl', () => {
  // 実測で通った形（scripts/measure-public-waveform.ts）に揃える: 秒まで・Z なし・nodata=404。
  it('網・観測点・成分・秒に丸めた範囲・nodata=404 を並べる', () => {
    expect(buildDataselectUrl({ stations: ['JMN', 'YOJ'], range: RANGE })).toBe(
      'https://service.earthscope.org/fdsnws/dataselect/1/query?net=JP&sta=JMN,YOJ&cha=BH%3F&starttime=2026-10-14T11%3A44%3A00&endtime=2026-10-14T11%3A48%3A31&nodata=404',
    )
  })
})

describe('fetchPublicWaveArchive', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const stub = (impl: () => Promise<Response>) => vi.stubGlobal('fetch', vi.fn(impl))

  it('200 は生バイトを返す', async () => {
    stub(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    const r = await fetchPublicWaveArchive({ stations: ['JMN'], range: RANGE })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(Array.from(r.bytes)).toEqual([1, 2, 3])
  })

  // 204・404 はどちらも「データが無い」（問い合わせ全体の不在は呼び出し側で再試行し、永続的な不在にはしない）。
  it('204・404 は no-data・それ以外の失敗は状態番号を返す', async () => {
    stub(async () => new Response(null, { status: 404 }))
    expect((await fetchPublicWaveArchive({ stations: ['JMN'], range: RANGE })).kind).toBe('no-data')
    stub(async () => new Response(null, { status: 204 }))
    expect((await fetchPublicWaveArchive({ stations: ['JMN'], range: RANGE })).kind).toBe('no-data')
    stub(async () => new Response(null, { status: 503 }))
    expect(await fetchPublicWaveArchive({ stations: ['JMN'], range: RANGE })).toEqual({ kind: 'http-error', status: 503 })
  })

  // 正: 同時の本数が埋まっているとき、急ぐ取得は先に並んだ急がない取得を追い越す。
  // 対照: 急がない取得どうしは来た順。門（1 秒 1 件）を通るので実時間で数秒かかる。
  it('急ぐ取得は同時の本数の待ち行列でも先取りを追い越す', { timeout: 20_000 }, async () => {
    const order: string[] = []
    const releases: (() => void)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        order.push(new URL(url).searchParams.get('sta') ?? '')
        return new Promise<Response>((resolve) => releases.push(() => resolve(new Response(null, { status: 404 }))))
      }),
    )
    const a = fetchPublicWaveArchive({ stations: ['A'], range: RANGE })
    const b = fetchPublicWaveArchive({ stations: ['B'], range: RANGE })
    await vi.waitFor(() => expect(order).toEqual(['A', 'B']), { timeout: 5_000 })
    const c = fetchPublicWaveArchive({ stations: ['C'], range: RANGE })
    const d = fetchPublicWaveArchive({ stations: ['D'], range: RANGE })
    const e = fetchPublicWaveArchive({ stations: ['E'], range: RANGE, urgent: true })
    releases.shift()!()
    await vi.waitFor(() => expect(order).toHaveLength(3), { timeout: 5_000 })
    expect(order[2]).toBe('E')
    releases.shift()!()
    await vi.waitFor(() => expect(order).toHaveLength(4), { timeout: 5_000 })
    expect(order[3]).toBe('C')
    while (releases.length > 0 || order.length < 5) {
      releases.shift()?.()
      await new Promise((r) => setTimeout(r, 50))
    }
    releases.forEach((r) => r())
    await Promise.all([a, b, c, d, e])
    expect(order).toEqual(['A', 'B', 'E', 'C', 'D'])
  })

  // 安全弁: 止めた取得は失敗に数えない（aborted で返す）。通信の失敗は unreachable。
  it('止めたら aborted・通信の失敗は unreachable', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    stub(async () => new Response(null, { status: 200 }))
    expect((await fetchPublicWaveArchive({ stations: ['JMN'], range: RANGE, signal: ctrl.signal })).kind).toBe('aborted')
    stub(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect((await fetchPublicWaveArchive({ stations: ['JMN'], range: RANGE })).kind).toBe('unreachable')
  })
})
