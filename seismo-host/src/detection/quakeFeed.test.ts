import { describe, expect, it } from 'vitest'

import { P2PQUAKE_HISTORY_URL, P2PQUAKE_WS_URL, QuakeFeed } from './quakeFeed'
import type { FeedSocket } from './quakeFeed'
import type { P2pReferenceQuake } from './p2pQuake'

class FakeSocket implements FeedSocket {
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  close(): void {
    this.closed = true
  }
}

const QUAKE_MSG = {
  code: 551,
  time: '2026/10/03 13:28:10.123',
  earthquake: {
    time: '2026/10/03 13:26:00',
    maxScale: 20,
    hypocenter: { name: '熊本県天草・芦北地方', latitude: 32.5, longitude: 130.5, depth: 0, magnitude: 3.5 },
  },
}

function setup(history: () => Promise<unknown>) {
  let now = 1_000_000
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const quakes: P2pReferenceQuake[] = []
  const logs: string[] = []
  const feed = new QuakeFeed({
    onQuake: (q) => quakes.push(q),
    now: () => now,
    log: (_, line) => logs.push(line),
    openSocket: (url) => {
      urls.push(url)
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    fetchHistory: async (url) => {
      urls.push(url)
      return history()
    },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => {},
  })
  return { feed, sockets, urls, timers, quakes, logs, advance: (ms: number) => (now += ms), now: () => now }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('QuakeFeed', () => {
  it('地震情報（551）を受け取って渡す。それ以外の種別は捨てる', async () => {
    const t = setup(async () => [])
    t.feed.start()
    t.sockets[0].onopen?.()
    await flush()
    t.sockets[0].onmessage?.({ data: JSON.stringify(QUAKE_MSG) })
    t.sockets[0].onmessage?.({ data: JSON.stringify({ code: 556 }) })
    t.sockets[0].onmessage?.({ data: '{こわれた' })
    expect(t.quakes.map((q) => q.name)).toEqual(['熊本県天草・芦北地方'])
    expect(t.feed.status().unreadableMessages).toBe(1)
    expect(t.urls).toEqual([P2PQUAKE_WS_URL, P2PQUAKE_HISTORY_URL])
  })

  it('繋がったら履歴を 1 回だけ引き、その中の地震情報も渡す', async () => {
    const t = setup(async () => [QUAKE_MSG])
    t.feed.start()
    t.sockets[0].onopen?.()
    await flush()
    expect(t.quakes).toHaveLength(1)
    expect(t.feed.status().historyFetches).toBe(1)
  })

  it('途切れていた間は covered が偽。繋ぎ直して履歴で埋まれば真に戻る', async () => {
    const t = setup(async () => [QUAKE_MSG])
    t.feed.start()
    t.sockets[0].onopen?.()
    await flush()
    const before = t.now()
    t.advance(1000)
    t.sockets[0].onclose?.()
    const cutAt = t.now()
    t.advance(10_000)
    expect(t.feed.covered(before, t.now())).toBe(false)
    // 繋ぎ直し（5 秒後に張り直す予約が入っている）
    expect(t.timers[0].ms).toBe(5_000)
    t.timers[0].fn()
    t.sockets[1].onopen?.()
    await flush()
    // 履歴が上限（50 件）に満たない → 途切れの間の報は全部入っている
    expect(t.feed.covered(cutAt, t.now())).toBe(true)
  })

  it('安全弁: 履歴を取れなければ途切れは埋まらず、covered は偽のまま', async () => {
    let fail = false
    const t = setup(async () => {
      if (fail) throw new Error('503')
      return []
    })
    t.feed.start()
    t.sockets[0].onopen?.()
    await flush()
    t.sockets[0].onclose?.()
    const cutAt = t.now()
    t.advance(10_000)
    fail = true
    t.timers[0].fn()
    t.sockets[1].onopen?.()
    await flush()
    expect(t.feed.covered(cutAt, t.now())).toBe(false)
    expect(t.feed.status().historyFailures).toBe(1)
    expect(t.logs.some((l) => l.includes('履歴を取れず'))).toBe(true)
  })

  it('履歴を取れなくても、閉じてから 6 時間を過ぎた途切れは忘れる', async () => {
    let fail = false
    const t = setup(async () => {
      if (fail) throw new Error('503')
      return []
    })
    t.feed.start()
    t.sockets[0].onopen?.()
    await flush()
    fail = true
    t.sockets[0].onclose?.()
    t.advance(10_000)
    t.timers[0].fn()
    t.sockets[1].onopen?.()
    await flush()
    expect(t.feed.status().openGaps).toHaveLength(1)
    t.advance(6 * 3_600_000)
    t.sockets[1].onclose?.()
    t.timers[1].fn()
    t.sockets[2].onopen?.()
    await flush()
    // 古い途切れは忘れ、いま閉じた途切れだけが残る
    expect(t.feed.status().openGaps).toHaveLength(1)
    expect(t.feed.status().historyFailures).toBe(2)
  })

  it('安全弁: 繋ぎ直しの間隔は倍々に延び、5 分で頭打ち（失敗し続けても 1 時間に十数回）', () => {
    const t = setup(async () => [])
    t.feed.start()
    for (let i = 0; i < 10; i++) {
      t.sockets[t.sockets.length - 1].onclose?.()
      t.timers[t.timers.length - 1].fn()
    }
    expect(t.timers.map((x) => x.ms)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000])
  })

  it('安全弁: 開いてはすぐ切れる状態でも繋ぎ直しの間隔は延び続け、履歴を 5 秒ごとに取りに行かない', async () => {
    const t = setup(async () => [])
    t.feed.start()
    for (let i = 0; i < 6; i++) {
      const s = t.sockets[t.sockets.length - 1]
      s.onopen?.()
      await flush()
      t.advance(1_000)
      s.onclose?.()
      t.timers[t.timers.length - 1].fn()
    }
    expect(t.timers.map((x) => x.ms)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000])
    expect(t.feed.status().historyFetches).toBe(6)
  })

  it('対照: しばらく（60 秒）繋がってから切れたら、間隔を 5 秒へ戻す', async () => {
    const t = setup(async () => [])
    t.feed.start()
    t.sockets[0].onclose?.() // 開く前に切れる → 次は 10 秒
    t.timers[0].fn()
    t.sockets[1].onopen?.()
    await flush()
    t.advance(60_000)
    t.sockets[1].onclose?.()
    expect(t.timers.map((x) => x.ms)).toEqual([5_000, 5_000])
  })

  it('安全弁: 履歴が配列で返らなければ失敗に数え、途切れは埋めない', async () => {
    const t = setup(async () => ({ error: 'rate limited' }))
    t.feed.start()
    t.sockets[0].onopen?.()
    await flush()
    expect(t.feed.status().historyFailures).toBe(1)
    expect(t.feed.status().openGaps).toHaveLength(1)
    expect(t.logs.some((l) => l.includes('配列で返らなかった'))).toBe(true)
  })

  it('ライブで届いた読めない地震情報は数える（震源未確定の報は数えない）', async () => {
    const t = setup(async () => [])
    t.feed.start()
    t.sockets[0].onopen?.()
    await flush()
    t.sockets[0].onmessage?.({ data: JSON.stringify({ code: 551, earthquake: { time: 'こわれた' } }) })
    t.sockets[0].onmessage?.({
      data: JSON.stringify({
        code: 551,
        earthquake: { time: '2026/10/03 13:26:00', hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: -1 } },
      }),
    })
    expect(t.feed.status().unreadableMessages).toBe(1)
    expect(t.quakes).toHaveLength(0)
  })

  it('起動から最初に繋がるまでも途切れとして数える', () => {
    const t = setup(async () => [])
    t.feed.start()
    expect(t.feed.covered(t.now(), t.now() + 1)).toBe(false)
  })
})
