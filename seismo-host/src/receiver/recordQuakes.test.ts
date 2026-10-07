import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RECORD_QUAKES_RANGE_MAX_MS, RecordQuakes, type HttpGet } from './recordQuakes'

const JST = 9 * 3_600_000
const DAY = 24 * 3_600_000
/** 2026-10-01 0:00 JST */
const D1 = Date.UTC(2026, 9, 1) - JST

/** P2PQuake の地震情報 1 件（日本時間の `YYYY/MM/DD HH:mm:ss`）。 */
function p2pItem(ms: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const t = new Date(ms + JST)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const time = `${t.getUTCFullYear()}/${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`
  return {
    code: 551,
    earthquake: { time, maxScale: 30, hypocenter: { name: '千葉県北西部', latitude: 35.6, longitude: 140.1, depth: 40, magnitude: 4.2 } },
    ...extra,
  }
}

/** 震源リストの日別ページ（行は `hypocenterDailyRecord.ts` の形）。 */
function hypoPage(lines: string[]): string {
  return `<html><body><pre>\n${lines.join('\n')}\n</pre></body></html>`
}

interface Fake {
  readonly get: HttpGet
  readonly urls: string[]
  readonly headers: Record<string, string>[]
}

function fakeGet(routes: (url: string) => { status: number; body: string }): Fake {
  const urls: string[] = []
  const headers: Record<string, string>[] = []
  return {
    urls,
    headers,
    get: async (url, h) => {
      urls.push(url)
      headers.push({ ...h })
      return routes(url)
    },
  }
}

let dir: string
let nowMs: number
const slept: number[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'record-quakes-'))
  slept.length = 0
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function make(fake: Fake, apiKey: string | null = null): RecordQuakes {
  return new RecordQuakes({
    dir,
    get: fake.get,
    sleep: async (ms) => {
      slept.push(ms)
      nowMs += ms
    },
    now: () => nowMs,
    dmdataApiKey: apiKey,
  })
}

// 10/01 12:26 JST の地震（震源リストでは 12:26:12.3）
const Q1 = D1 + 12 * 3_600_000 + 26 * 60_000
const HYPO_ROW = '2026 10  1 12:26 12.3  35°36.5\'N 140° 6.2\'E   43     4.2  千葉県北西部'

describe('RecordQuakes', () => {
  it('初めての範囲は P2PQuake を 1 本・地震のある日の震源リストを 1 本ずつ取り、秒まで補う。2 回目は 1 本も投げない', async () => {
    nowMs = D1 + 5 * DAY
    const fake = fakeGet((url) => {
      if (url.startsWith('https://api.p2pquake.net/')) return { status: 200, body: JSON.stringify([p2pItem(Q1)]) }
      if (url.endsWith('/20261001.html')) return { status: 200, body: hypoPage([HYPO_ROW]) }
      return { status: 500, body: '' }
    })
    const rq = make(fake)
    const r = await rq.list(D1, D1 + 2 * DAY)
    expect(fake.urls).toEqual([
      'https://api.p2pquake.net/v2/jma/quake?limit=100&order=1&since_date=20260930&until_date=20261002',
      'https://www.data.jma.go.jp/eqev/data/daily_map/20261001.html',
    ])
    expect(r.quakes).toHaveLength(1)
    expect(r.quakes[0]).toMatchObject({ originSource: 'hypocenter-list', originMs: Q1 + 12_300, depthKm: 43, name: '千葉県北西部' })
    expect(r.failedDays).toEqual([])

    fake.urls.length = 0
    await rq.list(D1, D1 + 2 * DAY)
    expect(fake.urls).toEqual([])
    // 確定した日は、立て直したホストでも控えから読む
    await make(fake).list(D1, D1 + 2 * DAY)
    expect(fake.urls).toEqual([])
  })

  it('まだ確定していない日は 10 分で取り直す（パンするたびには取りに行かない）', async () => {
    nowMs = D1 + 12 * 3_600_000 + 50 * 60_000
    const fake = fakeGet((url) =>
      url.startsWith('https://api.p2pquake.net/') ? { status: 200, body: JSON.stringify([p2pItem(Q1)]) } : { status: 500, body: '' },
    )
    const rq = make(fake)
    await rq.list(D1, D1 + 12 * 3_600_000)
    expect(fake.urls).toHaveLength(1)
    nowMs += 5 * 60_000
    await rq.list(D1, D1 + 12 * 3_600_000)
    expect(fake.urls).toHaveLength(1)
    nowMs += 6 * 60_000
    await rq.list(D1, D1 + 12 * 3_600_000)
    expect(fake.urls).toHaveLength(2)
    // 震源リストは 2 日前までしか無いので、当日ぶんは取りに行かない
    expect(fake.urls.every((u) => u.startsWith('https://api.p2pquake.net/'))).toBe(true)
  })

  it('P2PQuake が取れなければその日を「取れていない日」にし、5 分は取り直さない', async () => {
    nowMs = D1 + 5 * DAY
    const fake = fakeGet(() => ({ status: 503, body: '' }))
    const rq = make(fake)
    const r = await rq.list(D1, D1 + DAY)
    expect(r.failedDays).toEqual(['2026-09-30', '2026-10-01'])
    expect(r.problem).toContain('503')
    const again = await rq.list(D1, D1 + DAY)
    expect(fake.urls).toHaveLength(1)
    // 待っている間も、取れていない日と理由はそのまま返す
    expect(again.failedDays).toEqual(['2026-09-30', '2026-10-01'])
    expect(again.problem).toContain('503')
  })

  it('震源リストに無い直近の地震は、API キーがあれば DMDATA の緊急地震速報で秒を補う', async () => {
    nowMs = Q1 + 3 * 3_600_000
    const fake = fakeGet((url) => {
      if (url.startsWith('https://api.p2pquake.net/')) return { status: 200, body: JSON.stringify([p2pItem(Q1)]) }
      if (url.startsWith('https://api.dmdata.jp/v2/gd/eew?')) {
        return {
          status: 200,
          body: JSON.stringify({
            items: [
              { eventId: '20261001122612', isCanceled: false, earthquake: { originTime: new Date(Q1 + 11_000).toISOString() } },
              { eventId: '20261001080000', isCanceled: true, earthquake: { originTime: new Date(Q1 + 20_000).toISOString() } },
            ],
          }),
        }
      }
      return { status: 404, body: '' }
    })
    const r = await make(fake, 'TEST-KEY').list(Q1 - 3_600_000, Q1 + 3_600_000)
    expect(r.quakes[0]).toMatchObject({ originSource: 'eew', originMs: Q1 + 11_000 })
    const dm = fake.urls.findIndex((u) => u.startsWith('https://api.dmdata.jp/'))
    expect(fake.urls[dm]).toBe('https://api.dmdata.jp/v2/gd/eew?datetime=2026-09-30%7E2026-10-02&limit=100')
    expect(fake.headers[dm]!.Authorization).toBe(`Basic ${Buffer.from('TEST-KEY:').toString('base64')}`)
    // 震源リストの日はまだ公開前なので取りに行かない
    expect(fake.urls.some((u) => u.includes('daily_map'))).toBe(false)
  })

  it('対照: API キーが無ければ DMDATA へは投げず、分の幅のまま返す', async () => {
    nowMs = Q1 + 3 * 3_600_000
    const fake = fakeGet((url) =>
      url.startsWith('https://api.p2pquake.net/') ? { status: 200, body: JSON.stringify([p2pItem(Q1)]) } : { status: 404, body: '' },
    )
    const r = await make(fake).list(Q1 - 3_600_000, Q1 + 3_600_000)
    expect(fake.urls.some((u) => u.includes('dmdata'))).toBe(false)
    expect(r.quakes[0]).toMatchObject({ originSource: 'quake-info', originPrecisionMs: 60_000 })
  })

  it('震源リストが 404（まだ載っていない）なら取れていない日にはせず、1 時間は取り直さない', async () => {
    nowMs = D1 + 3 * DAY
    const fake = fakeGet((url) =>
      url.startsWith('https://api.p2pquake.net/') ? { status: 200, body: JSON.stringify([p2pItem(Q1)]) } : { status: 404, body: '' },
    )
    const rq = make(fake)
    const r = await rq.list(D1, D1 + DAY)
    expect(r.failedDays).toEqual([])
    expect(r.quakes[0]!.originSource).toBe('quake-info')
    fake.urls.length = 0
    nowMs += 30 * 60_000
    await rq.list(D1, D1 + DAY)
    expect(fake.urls.filter((u) => u.includes('daily_map'))).toEqual([])
  })

  it('広すぎる範囲は 1 本も投げずに断る', async () => {
    nowMs = D1 + 30 * DAY
    const fake = fakeGet(() => ({ status: 200, body: '[]' }))
    const r = await make(fake).list(D1, D1 + RECORD_QUAKES_RANGE_MAX_MS + 1)
    expect(r.problem).toBe('range-too-wide')
    expect(fake.urls).toEqual([])
  })
})
