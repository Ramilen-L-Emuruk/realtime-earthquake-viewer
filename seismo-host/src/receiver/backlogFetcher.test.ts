import { describe, expect, it } from 'vitest'

import { BacklogBook, type StreamRef, streamKey } from './backlogBook'
import { type BacklogEvent, BacklogFetcher, type BacklogHttpResponse, splitBacklogPackets } from './backlogFetcher'

const S: StreamRef = { boardKey: 'mac:020000000001', bootId: '34b6e78f', sensorId: 'i2c0-68' }
const KEY = streamKey(S)
const ADDR = '192.0.2.41'

/** 基板が送るのと同じ形のパケット（ファームの `formatHead`・`formatLine`）。 */
function packet(q: number, c = 30, over: Partial<{ bid: string; sid: string; mac: string }> = {}): string {
  const head = JSON.stringify({
    v: 2, mac: over.mac ?? '020000000001', bid: over.bid ?? S.bootId, sid: over.sid ?? S.sensorId,
    st: 'MPU6050', ch: ['HN1', 'HN2', 'HN3'], ug: 61.0352, fs: 2, hz: 100,
    t: 1_790_941_894_294 + q * 10, q, c, o: 0, ack: 1,
  })
  let lines = ''
  for (let i = 0; i < c; i++) lines += `${500 + i},-428,17120\n`
  return `${head}\n${lines}`
}

function response(status: number, body: string, headers: Record<string, string> = {}): BacklogHttpResponse {
  return {
    status,
    header: (name) => headers[name] ?? null,
    text: async () => body,
  }
}

interface Harness {
  book: BacklogBook
  fetcher: BacklogFetcher
  urls: string[]
  written: Array<{ source: string; payload: string }>
  events: BacklogEvent[]
  clock: { now: number }
}

/**
 * `saved` は、そのまとまりを生データへその場で書けたか（`MseedRecorder.acceptRecovered` の戻り値）。
 * 既定はどれも書けた。
 */
function harness(
  reply: (url: string) => Promise<BacklogHttpResponse>,
  saved: (payload: string) => boolean | Promise<boolean> = () => true,
  timeoutMs = 3_000,
): Harness {
  const clock = { now: 0 }
  const book = new BacklogBook({
    settleMs: 2_000, retryBaseMs: 5_000, retryMaxMs: 60_000, giveUpAfterMs: 20 * 60_000,
    maxGaps: 100,
  })
  const urls: string[] = []
  const written: Array<{ source: string; payload: string }> = []
  const events: BacklogEvent[] = []
  const fetcher = new BacklogFetcher({
    book,
    get: async (url) => {
      urls.push(url)
      return reply(url)
    },
    keepRecovered: (source, payload) => {
      written.push({ source, payload })
      return Promise.resolve(saved(payload))
    },
    now: () => clock.now,
    timeoutMs,
    spacingMs: 250,
    idleMs: 1_000,
    onEvent: (e) => events.push(e),
  })
  return { book, fetcher, urls, written, events, clock }
}

/** `[30, 90)` が欠けた状態を作り、取りに行ける時刻まで進める。 */
function withGap(h: Harness): void {
  for (const q of [0, 90]) h.book.notePacket({ stream: S, firstSeq: q, count: 30, address: ADDR, atMs: 0 })
  h.clock.now = 10_000
}

describe('splitBacklogPackets', () => {
  it('ヘッダの行で区切り、送ったときの形のまま返す', () => {
    const a = packet(30, 2)
    const b = packet(32, 3)
    expect(splitBacklogPackets(a + b)).toEqual([a, b])
  })

  it('空の本文は 0 件', () => {
    expect(splitBacklogPackets('')).toEqual([])
  })
})

describe('BacklogFetcher', () => {
  it('正: 欠けた範囲を基板へ訊き、返ったパケットを生データへ印つきで書いて欠けから外す', async () => {
    const h = harness(async () =>
      response(200, packet(30) + packet(60), {
        'X-Backlog-Have': '0-120', 'X-Backlog-More': '0', 'X-Backlog-Next': '90',
      }),
    )
    withGap(h)
    expect(await h.fetcher.step()).toBe(true)
    expect(h.urls).toEqual([`http://${ADDR}/backlog?sid=i2c0-68&bid=34b6e78f&from=30&to=90`])
    expect(h.written.map((w) => w.payload)).toEqual([packet(30), packet(60)])
    expect(h.written[0]!.source).toBe(ADDR)
    const snap = h.fetcher.snapshot()
    expect(snap.pendingGaps).toBe(0)
    expect(snap.recoveredSamples).toBe(60)
    expect(snap.recoveredPackets).toBe(2)
    // 対照: 全部使えた答えでは「混ざった」と言わない。
    expect(h.events.map((e) => e.kind)).toEqual(['recovered'])
  })

  it('正: 生データへ書けなかったまとまりは欠けに残し、答え切った応答でも諦めずに間を空けて訊き直す', async () => {
    const h = harness(
      async () =>
        response(200, packet(30) + packet(60), {
          'X-Backlog-Have': '0-120', 'X-Backlog-More': '0', 'X-Backlog-Next': '90',
        }),
      (payload) => payload !== packet(60),
    )
    withGap(h)
    await h.fetcher.step()
    const snap = h.fetcher.snapshot()
    // 書けた [30, 60) だけを外し、書けなかった [60, 90) は欠けのまま。
    expect(snap.recoveredSamples).toBe(30)
    expect(snap.recoveredPackets).toBe(1)
    expect(snap.unsavedPackets).toBe(1)
    expect(snap.pendingSamples).toBe(30)
    expect(snap.unrecoverableSamples).toEqual({})
    expect(h.events).toEqual([
      { kind: 'recovered', key: KEY, address: ADDR, packets: 1, samples: 30 },
      { kind: 'unsaved', key: KEY, address: ADDR, packets: 1 },
    ])
    // **すぐには訊き直さない** —— 書けないのはディスクの側の事情で、続けて訊いても同じく書けない。
    expect(await h.fetcher.step()).toBe(false)
    // 間を空けたあとで、残った範囲だけを訊き直す。
    h.clock.now += 60_000
    expect(await h.fetcher.step()).toBe(true)
    expect(h.urls.at(-1)).toBe(`http://${ADDR}/backlog?sid=i2c0-68&bid=34b6e78f&from=60&to=90`)
  })

  it('安全弁: 書けなかった分があっても、基板がもう抱えていない古い範囲は従来どおり取り戻せないと数える', async () => {
    // 基板の輪は 45 番より古い分を上書きした。答えに入った 60 番のまとまりは書けなかった。
    const h = harness(
      async () =>
        response(200, packet(60), {
          'X-Backlog-Have': '45-120', 'X-Backlog-More': '0', 'X-Backlog-Next': '90',
        }),
      () => false,
    )
    withGap(h)
    await h.fetcher.step()
    const snap = h.fetcher.snapshot()
    expect(snap.unrecoverableSamples).toEqual({ 'not-held': 15 })
    // [45, 90) は書けなかった分を含めて欠けに残る。
    expect(snap.pendingSamples).toBe(45)
    expect(snap.recoveredSamples).toBe(0)
  })

  it('安全弁: 書き終わりの知らせが来ないまま時間切れになったら、書けなかったとして欠けに残す', async () => {
    // 流し口が詰まって知らせが来ない形。待ち続けると、取り戻しも終了の締めくくりも止まる。
    const h = harness(
      async () => response(200, packet(30), { 'X-Backlog-Have': '0-120', 'X-Backlog-More': '0', 'X-Backlog-Next': '90' }),
      () => new Promise<boolean>(() => {}),
      20,
    )
    withGap(h)
    await h.fetcher.step()
    expect(h.fetcher.snapshot().unsavedPackets).toBe(1)
    expect(h.fetcher.snapshot().recoveredSamples).toBe(0)
    expect(h.fetcher.snapshot().pendingSamples).toBe(60)
  })

  it('安全弁: 時間切れのあとで書き込みが遅れて成功したら、そこで欠けから外し、決着まで訊き直さない（同じまとまりを二度書かない）', async () => {
    let finish: (ok: boolean) => void = () => {}
    // 基板は訊かれた範囲を返す —— 3 回目の `from=60` には [60, 90) を返す。
    const h = harness(
      async (url) =>
        url.includes('from=60')
          ? response(200, packet(60), { 'X-Backlog-Have': '0-120', 'X-Backlog-More': '0', 'X-Backlog-Next': '90' })
          : response(200, packet(30), { 'X-Backlog-Have': '0-120', 'X-Backlog-More': '1', 'X-Backlog-Next': '60' }),
      (payload) => (payload === packet(30) ? new Promise<boolean>((resolve) => (finish = resolve)) : true),
      20,
    )
    withGap(h)
    expect(h.fetcher.snapshot().unsettledWriteSinceMs).toBeNull()
    await h.fetcher.step()
    expect(h.fetcher.snapshot().unsavedPackets).toBe(1)
    // 待ちきれなかった時刻を出す（止まっていることが外から見えるように）。
    expect(h.fetcher.snapshot().unsettledWriteSinceMs).toBe(10_000)
    // 決着していない書き込みがある間は、間を空けたあとでも次を訊かない。
    h.clock.now += 60_000
    expect(await h.fetcher.step()).toBe(false)
    expect(h.urls).toHaveLength(1)
    // 遅れて成功 → そのまとまりを欠けから外す。
    finish(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.fetcher.snapshot().unsettledWriteSinceMs).toBeNull()
    const snap = h.fetcher.snapshot()
    expect(snap.recoveredSamples).toBe(30)
    expect(snap.pendingSamples).toBe(30)
    expect(h.events.map((e) => e.kind)).toEqual(['unsaved', 'recovered'])
    // 決着したので、残りの [60, 90) を訊きに行く。同じまとまりは二度書いていない。
    expect(await h.fetcher.step()).toBe(true)
    expect(h.urls.at(-1)).toBe(`http://${ADDR}/backlog?sid=i2c0-68&bid=34b6e78f&from=60&to=90`)
    expect(h.written.filter((w) => w.payload === packet(30))).toHaveLength(1)
    expect(h.fetcher.snapshot().pendingSamples).toBe(0)
  })

  it('対照: 時間切れのあとで書き込みが遅れて失敗したら、欠けに残したまま、決着してから訊き直す', async () => {
    let finish: (ok: boolean) => void = () => {}
    let calls = 0
    const h = harness(
      async () => response(200, packet(30), { 'X-Backlog-Have': '0-120', 'X-Backlog-More': '1', 'X-Backlog-Next': '60' }),
      () => {
        calls += 1
        return calls === 1 ? new Promise<boolean>((resolve) => (finish = resolve)) : true
      },
      20,
    )
    withGap(h)
    await h.fetcher.step()
    finish(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.fetcher.snapshot().pendingSamples).toBe(60)
    expect(h.fetcher.snapshot().unsettledWriteSinceMs).toBeNull()
    h.clock.now += 60_000
    expect(await h.fetcher.step()).toBe(true)
    expect(h.urls).toHaveLength(2)
  })

  it('安全弁: 書き込みの口が（約束に反して）すぐ拒否しても、書けなかったとして欠けに残し、答えの残りの扱いまで済ませる', async () => {
    const h = harness(
      async () => response(200, packet(30), { 'X-Backlog-Have': '0-120', 'X-Backlog-More': '0', 'X-Backlog-Next': '90' }),
      () => Promise.reject(new Error('想定外')),
    )
    withGap(h)
    expect(await h.fetcher.step()).toBe(true)
    const snap = h.fetcher.snapshot()
    expect(snap.unsavedPackets).toBe(1)
    expect(snap.pendingSamples).toBe(60)
    expect(snap.failures).toEqual({})
    expect(h.events.map((e) => e.kind)).toEqual(['unsaved'])
  })

  it('正: 止めるとき、待ちきれなかった書き込みが決着するのを待ち、遅れて成功した分を欠けから外してから返る', async () => {
    let finish: (ok: boolean) => void = () => {}
    const h = harness(
      async () => response(200, packet(30), { 'X-Backlog-Have': '0-120', 'X-Backlog-More': '0', 'X-Backlog-Next': '90' }),
      () => new Promise<boolean>((resolve) => (finish = resolve)),
      50,
    )
    withGap(h)
    await h.fetcher.step()
    const stopping = h.fetcher.stop()
    setTimeout(() => finish(true), 5)
    await stopping
    expect(h.fetcher.snapshot().recoveredSamples).toBe(30)
    expect(h.fetcher.snapshot().unsettledWriteSinceMs).toBeNull()
  })

  it('安全弁: 止めるとき、書き込みが決着しなくても上限で返る（終了を止めない）', async () => {
    const h = harness(
      async () => response(200, packet(30), { 'X-Backlog-Have': '0-120', 'X-Backlog-More': '0', 'X-Backlog-Next': '90' }),
      () => new Promise<boolean>(() => {}),
      20,
    )
    withGap(h)
    await h.fetcher.step()
    await h.fetcher.stop()
    expect(h.fetcher.snapshot().recoveredSamples).toBe(0)
    expect(h.fetcher.snapshot().unsettledWriteSinceMs).toBe(10_000)
  })

  it('安全弁: 1 まとまりでも書けなかったら、同じ答えの残りは書かずに欠けに残す（詰まったディスクを叩き続けない）', async () => {
    const h = harness(
      async () =>
        response(200, packet(30) + packet(60), { 'X-Backlog-Have': '0-120', 'X-Backlog-More': '0', 'X-Backlog-Next': '90' }),
      () => false,
    )
    withGap(h)
    await h.fetcher.step()
    // 2 つ目は書こうとしていない。
    expect(h.written.map((w) => w.payload)).toEqual([packet(30)])
    expect(h.fetcher.snapshot().unsavedPackets).toBe(2)
    expect(h.fetcher.snapshot().pendingSamples).toBe(60)
  })

  it('対照: 欠けが無ければ何も訊かない', async () => {
    const h = harness(async () => response(200, ''))
    h.book.notePacket({ stream: S, firstSeq: 0, count: 30, address: ADDR, atMs: 0 })
    h.clock.now = 10_000
    expect(await h.fetcher.step()).toBe(false)
    expect(h.urls).toEqual([])
  })

  it('安全弁: 別の基板・別の起動・別のセンサーのパケットは書かない', async () => {
    const h = harness(async () =>
      response(200, packet(30, 30, { bid: 'deadbeef' }) + packet(30, 30, { sid: 'i2c0-69' }) +
        packet(30, 30, { mac: '020000000002' }), {
        'X-Backlog-Have': '0-120', 'X-Backlog-More': '0', 'X-Backlog-Next': '90',
      }),
    )
    withGap(h)
    await h.fetcher.step()
    expect(h.written).toEqual([])
    expect(h.fetcher.snapshot().foreignPackets).toBe(3)
    // **取り戻せなかったとは決めつけない** —— 基板が別物を返すのは異常で、あとで訊き直す。
    expect(h.fetcher.snapshot().pendingSamples).toBe(60)
    // **黙らせない** —— 毎回そう答える基板は、いずれ諦めに行き着く。
    expect(h.events).toEqual([
      { kind: 'suspect', key: KEY, address: ADDR, badPackets: 0, foreignPackets: 3 },
    ])
  })

  it('基板が 410（再起動していた）なら、その欠けは取り戻せない', async () => {
    const h = harness(async () => response(410, 'other boot\n'))
    withGap(h)
    await h.fetcher.step()
    expect(h.fetcher.snapshot().unrecoverableSamples).toEqual({ rebooted: 60 })
    expect(h.fetcher.snapshot().pendingGaps).toBe(0)
  })

  it('基板が 404（取り戻しの口を持たない古いファーム）なら、訊き直さない', async () => {
    const h = harness(async () => response(404, 'Not found'))
    withGap(h)
    await h.fetcher.step()
    expect(h.fetcher.snapshot().unrecoverableSamples).toEqual({ unsupported: 60 })
  })

  it('抱えている範囲より古い分は、取り戻せなかったに数える', async () => {
    const h = harness(async () =>
      response(200, packet(60), { 'X-Backlog-Have': '60-500', 'X-Backlog-More': '0', 'X-Backlog-Next': '90' }),
    )
    withGap(h)
    await h.fetcher.step()
    const snap = h.fetcher.snapshot()
    expect(snap.recoveredSamples).toBe(30)
    expect(snap.unrecoverableSamples).toEqual({ 'not-held': 30 })
    expect(snap.pendingGaps).toBe(0)
  })

  it('何も抱えていなければ（none）、全部を取り戻せなかったに数える', async () => {
    const h = harness(async () => response(200, '', { 'X-Backlog-Have': 'none', 'X-Backlog-More': '0', 'X-Backlog-Next': '30' }))
    withGap(h)
    await h.fetcher.step()
    expect(h.fetcher.snapshot().unrecoverableSamples).toEqual({ 'not-held': 60 })
  })

  it('打ち切られた（More: 1）なら、残りをすぐ訊き直す', async () => {
    let call = 0
    const h = harness(async () => {
      call += 1
      return call === 1
        ? response(200, packet(30), { 'X-Backlog-Have': '0-500', 'X-Backlog-More': '1', 'X-Backlog-Next': '60' })
        : response(200, packet(60), { 'X-Backlog-Have': '0-500', 'X-Backlog-More': '0', 'X-Backlog-Next': '90' })
    })
    withGap(h)
    await h.fetcher.step()
    expect(h.fetcher.snapshot().pendingSamples).toBe(30)
    await h.fetcher.step()
    expect(h.urls[1]).toBe(`http://${ADDR}/backlog?sid=i2c0-68&bid=34b6e78f&from=60&to=90`)
    expect(h.fetcher.snapshot().pendingGaps).toBe(0)
    expect(h.fetcher.snapshot().unrecoverableSamples).toEqual({})
  })

  it('繋がらなければ間を空けて訊き直す（取り戻せなかったとはしない）', async () => {
    const h = harness(async () => {
      throw new Error('connect ETIMEDOUT')
    })
    withGap(h)
    await h.fetcher.step()
    const snap = h.fetcher.snapshot()
    expect(snap.pendingSamples).toBe(60)
    expect(snap.failures).toEqual({ network: 1 })
    expect(await h.fetcher.step()).toBe(false)
    h.clock.now += 5_000
    expect(await h.fetcher.step()).toBe(true)
  })

  it('記録へ渡したパケットは、その場で取り戻し済みにする（書けたかは記録の側が数える）', async () => {
    const h = harness(async () =>
      response(200, packet(30) + packet(60), { 'X-Backlog-Have': '0-120', 'X-Backlog-More': '0', 'X-Backlog-Next': '90' }),
    )
    withGap(h)
    await h.fetcher.step()
    const snap = h.fetcher.snapshot()
    expect(h.written.map((w) => w.payload)).toEqual([packet(30), packet(60)])
    expect(snap.pendingSamples).toBe(0)
    expect(snap.recoveredPackets).toBe(2)
    expect(snap.unrecoverableSamples).toEqual({})
  })

  it('読めないパケットは数え、欠けは残して訊き直す', async () => {
    const h = harness(async () =>
      response(200, '{"v":2,"broken"\n1,2,3\n', { 'X-Backlog-Have': '0-120', 'X-Backlog-More': '0', 'X-Backlog-Next': '90' }),
    )
    withGap(h)
    await h.fetcher.step()
    expect(h.fetcher.snapshot().badPackets).toBe(1)
    expect(h.fetcher.snapshot().pendingSamples).toBe(60)
  })

  it('見出しが読めない応答は失敗として数え、訊き直す', async () => {
    const h = harness(async () => response(200, packet(30), { 'X-Backlog-More': '0' }))
    withGap(h)
    await h.fetcher.step()
    expect(h.fetcher.snapshot().failures).toEqual({ 'bad-reply': 1 })
    expect(h.fetcher.snapshot().pendingSamples).toBe(60)
  })

  it('5xx は失敗として数え、訊き直す', async () => {
    const h = harness(async () => response(500, 'oops'))
    withGap(h)
    await h.fetcher.step()
    expect(h.fetcher.snapshot().failures).toEqual({ 'http-500': 1 })
    expect(h.fetcher.snapshot().pendingSamples).toBe(60)
  })

  it('欠けた範囲より外へはみ出したパケットも、生データへはそのまま書く（欠けていた分だけ数える）', async () => {
    const h = harness(async () =>
      response(200, packet(0, 60), { 'X-Backlog-Have': '0-120', 'X-Backlog-More': '0', 'X-Backlog-Next': '60' }),
    )
    for (const q of [0, 60]) h.book.notePacket({ stream: S, firstSeq: q, count: 30, address: ADDR, atMs: 0 })
    h.clock.now = 10_000
    await h.fetcher.step()
    expect(h.written).toHaveLength(1)
    expect(h.fetcher.snapshot().recoveredSamples).toBe(30)
    expect(h.book.snapshot().pendingGaps).toBe(0)
  })

  it('取り戻しと取り戻せなかった件を、流れの鍵を添えて知らせる', async () => {
    const events: unknown[] = []
    const clock = { now: 10_000 }
    const book = new BacklogBook({
      settleMs: 2_000, retryBaseMs: 5_000, retryMaxMs: 60_000, giveUpAfterMs: 20 * 60_000,
      maxGaps: 100,
    })
    for (const q of [0, 90]) book.notePacket({ stream: S, firstSeq: q, count: 30, address: ADDR, atMs: 0 })
    const fetcher = new BacklogFetcher({
      book,
      get: async () => response(200, packet(60), { 'X-Backlog-Have': '60-500', 'X-Backlog-More': '0', 'X-Backlog-Next': '90' }),
      keepRecovered: async () => true,
      now: () => clock.now,
      timeoutMs: 3_000, spacingMs: 250, idleMs: 1_000,
      onEvent: (e) => events.push(e),
    })
    await fetcher.step()
    expect(events).toEqual([
      { kind: 'recovered', key: KEY, address: ADDR, packets: 1, samples: 30 },
      { kind: 'unrecoverable', key: KEY, address: ADDR, reason: 'not-held', samples: 30 },
    ])
  })

  it('安全弁: 知らせる口が投げても、取り戻しは止まらずに次の回を張る', async () => {
    const clock = { now: 10_000 }
    const book = new BacklogBook({
      settleMs: 2_000, retryBaseMs: 5_000, retryMaxMs: 60_000, giveUpAfterMs: 20 * 60_000,
      maxGaps: 100,
    })
    for (const q of [0, 90]) book.notePacket({ stream: S, firstSeq: q, count: 30, address: ADDR, atMs: 0 })
    let calls = 0
    const fetcher = new BacklogFetcher({
      book,
      get: async () => {
        calls += 1
        throw new Error('ECONNREFUSED')
      },
      keepRecovered: async () => true,
      now: () => clock.now,
      timeoutMs: 3_000, spacingMs: 1, idleMs: 1,
      onEvent: () => {
        throw new Error('EPIPE')
      },
    })
    fetcher.start()
    // 1 回目が投げても、次の回が張られて 2 回目を訊きに行く（失敗の待ちを越えるよう時計を進める）。
    await new Promise((r) => setTimeout(r, 20))
    clock.now += 120_000
    await new Promise((r) => setTimeout(r, 20))
    await fetcher.stop()
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(fetcher.snapshot().failures.internal).toBeGreaterThanOrEqual(1)
  })
})
