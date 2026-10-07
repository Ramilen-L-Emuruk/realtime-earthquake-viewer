import { describe, expect, it } from 'vitest'

import { JMA_QUAKE_PAGE_SIZE, LIST_SETTLE_MS, UNREADABLE_SHADOW_MS, fetchQuakeHistory, jmaQuakeUrls } from './quakeHistory'

const HOUR = 3_600_000

/** P2PQuake の地震情報（code 551）1 件。 */
function item(originJst: string, name = '架空の震央'): unknown {
  return {
    code: 551,
    issue: { type: 'DetailScale' },
    earthquake: {
      time: originJst,
      hypocenter: { name, latitude: 34.3, longitude: 135.3, depth: 10, magnitude: 3.5 },
      maxScale: 20,
    },
  }
}

/** n 件ぶんの地震情報（1 分ずつずらす）。 */
function items(n: number, startJst = '2026/10/03 13:00:00'): unknown[] {
  const base = Date.parse(startJst.replace(/\//g, '-').replace(' ', 'T') + '+09:00')
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base + i * 60_000 + 9 * HOUR)
    const text = d.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '/')
    return item(text, `震央${i}`)
  })
}

// 2026-10-03 00:00 JST 〜 2026-10-04 23:59 JST
const FROM = Date.UTC(2026, 9, 2, 15, 0, 0)
const TO = Date.UTC(2026, 9, 4, 14, 59, 0)
const FETCHED_AT = Date.UTC(2026, 9, 7, 5, 0, 0)

function harness(pages: unknown[][]) {
  const urls: string[] = []
  const sleeps: number[] = []
  return {
    urls,
    sleeps,
    deps: {
      fetchJson: async (url: string) => {
        urls.push(url)
        return pages[urls.length - 1] ?? []
      },
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      now: () => FETCHED_AT,
    },
  }
}

describe('jmaQuakeUrls — 問い合わせの組み立て', () => {
  it('正: 日本時間の日付で、古い順・100 件ずつ', () => {
    const url = jmaQuakeUrls(FROM, TO)(0)
    expect(url).toBe('https://api.p2pquake.net/v2/jma/quake?limit=100&order=1&since_date=20261003&until_date=20261004')
    expect(jmaQuakeUrls(FROM, TO)(200)).toContain('&offset=200')
  })
})

describe('fetchQuakeHistory — 期間の地震情報を取る', () => {
  it('正: 100 件に満たないページで止め、期間を取りきれたとする', async () => {
    const h = harness([items(100), items(3, '2026/10/04 10:00:00')])
    const r = await fetchQuakeHistory({ fromMs: FROM, toMs: TO, ...h.deps })
    expect(h.urls).toHaveLength(2)
    expect(r.truncated).toBe(false)
    expect(r.quakes).toHaveLength(103)
    expect(r.covered(FROM, TO)).toBe(true)
  })

  it('正: 2 本目からは間を空ける（10 回/分の上限を超えない）', async () => {
    const h = harness([items(100), items(100, '2026/10/03 20:00:00'), []])
    await fetchQuakeHistory({ fromMs: FROM, toMs: TO, ...h.deps })
    expect(h.sleeps).toHaveLength(2)
    for (const ms of h.sleeps) expect(ms).toBeGreaterThanOrEqual(6000)
  })

  it('安全弁: ページの上限で切ったら、取れた最後の地震の時刻より後は取りきれたと言わない', async () => {
    const pages = Array.from({ length: 50 }, (_, p) => items(JMA_QUAKE_PAGE_SIZE, `2026/10/03 ${String(p % 24).padStart(2, '0')}:00:00`))
    const h = harness(pages)
    const r = await fetchQuakeHistory({ fromMs: FROM, toMs: TO, maxPages: 3, ...h.deps })
    expect(h.urls).toHaveLength(3)
    expect(r.truncated).toBe(true)
    const last = r.quakes[r.quakes.length - 1].originMs
    expect(r.covered(FROM, last)).toBe(true)
    expect(r.covered(FROM, last + 60_000)).toBe(false)
  })

  it('対照: 期間の外（前の日・取った時刻の直前）は取りきれたと言わない', async () => {
    const h = harness([items(3)])
    const r = await fetchQuakeHistory({ fromMs: FROM, toMs: FETCHED_AT, ...h.deps })
    expect(r.covered(FROM - HOUR, FROM + HOUR)).toBe(false)
    expect(r.covered(FROM, FETCHED_AT - LIST_SETTLE_MS - 1)).toBe(true)
    expect(r.covered(FROM, FETCHED_AT - LIST_SETTLE_MS + 60_000)).toBe(false)
  })

  it('安全弁: 取れなかったら、どの範囲も取りきれたと言わない（投げずに理由を返す）', async () => {
    const r = await fetchQuakeHistory({
      fromMs: FROM,
      toMs: TO,
      fetchJson: async () => {
        throw new Error('HTTP 429')
      },
      sleep: async () => {},
      now: () => FETCHED_AT,
    })
    expect(r.error).toContain('429')
    expect(r.quakes).toHaveLength(0)
    expect(r.covered(FROM, FROM + 1)).toBe(false)
  })

  it('安全弁: 読めなかった地震情報の時刻の後しばらくは、取りきれたと言わない', async () => {
    // 震源が壊れている（緯度が文字列）が、時刻は読める報。
    const broken = { code: 551, earthquake: { time: '2026/10/03 13:26:00', hypocenter: { latitude: 'x', longitude: 135 } } }
    const h = harness([[broken, ...items(2, '2026/10/03 18:00:00')]])
    const r = await fetchQuakeHistory({ fromMs: FROM, toMs: TO, ...h.deps })
    expect(r.unreadable).toBe(1)
    const at = Date.UTC(2026, 9, 3, 4, 26, 0)
    expect(r.covered(at + 60_000, at + 16 * 60_000)).toBe(false)
    // 対照: 離れた時刻なら取りきれたと言える。
    expect(r.covered(at + UNREADABLE_SHADOW_MS + 60_000, at + UNREADABLE_SHADOW_MS + 16 * 60_000)).toBe(true)
  })

  it('安全弁: 時刻すら読めない地震情報があれば、どの範囲も取りきれたと言わない', async () => {
    const h = harness([[{ code: 551, earthquake: { time: '???', hypocenter: {} } }]])
    const r = await fetchQuakeHistory({ fromMs: FROM, toMs: TO, ...h.deps })
    expect(r.covered(FROM, FROM + 60_000)).toBe(false)
  })

  it('対照: 震源未確定の報（震度速報）は壊れていないので、取りきれた範囲を狭めない', async () => {
    const unsettled = { code: 551, earthquake: { time: '2026/10/03 13:26:00', hypocenter: { latitude: -200, longitude: -200 } } }
    const h = harness([[unsettled]])
    const r = await fetchQuakeHistory({ fromMs: FROM, toMs: TO, ...h.deps })
    const at = Date.UTC(2026, 9, 3, 4, 26, 0)
    expect(r.covered(at + 60_000, at + 16 * 60_000)).toBe(true)
  })

  it('正: 同じ地震の報は 1 件にまとめ、地震情報でないものは数えない', async () => {
    const dup = [item('2026/10/03 13:26:00', 'A'), item('2026/10/03 13:26:00', 'A'), { code: 552 }]
    const h = harness([dup])
    const r = await fetchQuakeHistory({ fromMs: FROM, toMs: TO, ...h.deps })
    expect(r.quakes).toHaveLength(1)
    expect(r.unreadable).toBe(0)
  })
})
