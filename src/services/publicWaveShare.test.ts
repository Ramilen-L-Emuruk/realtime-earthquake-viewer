// 公開観測点の SeedLink をタブどうしで 1 本にまとめる係。ロックと BroadcastChannel は偽物（同じ「ブラウザ」の中のタブを並べる）。
import { describe, expect, it } from 'vitest'
import type { Mseed2Record } from '../utils/miniseed2'
import type { PublicLinkNeed, PublicLinkStatus } from './publicWaveLink'
import { NEED_EXPIRE_MS, NEED_HEARTBEAT_MS, PublicWaveShare, type LinkLike, type PublicShareDeps, type ShareChannel } from './publicWaveShare'

function browser() {
  const channels = new Set<ShareChannel>()
  let lockHeld = false
  const waiters: (() => void)[] = []
  let clock = 0
  const intervals: { fn: () => void; cleared: boolean }[] = []
  const links: { needs: PublicLinkNeed[]; disposed: boolean; emit: (rec: Mseed2Record) => void; status: (s: PublicLinkStatus) => void }[] = []

  const locks: PublicShareDeps['locks'] = {
    request: (_name, cb) =>
      new Promise((resolve) => {
        const run = () => {
          lockHeld = true
          void cb().then(() => {
            lockHeld = false
            resolve(undefined)
            waiters.shift()?.()
          })
        }
        if (!lockHeld) run()
        else waiters.push(run)
      }),
  }
  const openChannel = (): ShareChannel => {
    const ch: ShareChannel = {
      onmessage: null,
      postMessage: (data) => {
        // 送った本人には届かない（BroadcastChannel と同じ）。構造化複製の代わりに JSON を通す。
        for (const other of channels) if (other !== ch) other.onmessage?.({ data: structuredClone(data) })
      },
      close: () => {
        channels.delete(ch)
      },
    }
    channels.add(ch)
    return ch
  }
  const tab = (tabId: string) => {
    const got: Mseed2Record[] = []
    const statuses: PublicLinkStatus[] = []
    const deps: PublicShareDeps = {
      locks,
      openChannel,
      makeLink: (onRecord, onStatus) => {
        const l = { needs: [] as PublicLinkNeed[], disposed: false, emit: onRecord, status: onStatus }
        links.push(l)
        const link: LinkLike = {
          setNeed: (n) => l.needs.push(n),
          getStatus: () => ({ kind: 'idle' }),
          dispose: () => {
            l.disposed = true
          },
        }
        return link
      },
      now: () => clock,
      setInterval: (fn) => {
        const t = { fn, cleared: false }
        intervals.push(t)
        return t
      },
      clearInterval: (h) => {
        ;(h as { cleared: boolean }).cleared = true
      },
      tabId,
    }
    const share = new PublicWaveShare(deps, (r) => got.push(r), (s) => statuses.push(s))
    return { share, got, statuses }
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const tickAll = (ms: number) => {
    clock += ms
    for (const t of intervals) if (!t.cleared) t.fn()
  }
  return { tab, links, flush, tickAll }
}

const rec = (startMs: number): Mseed2Record => ({
  network: 'JP',
  station: 'JMM',
  location: '',
  channel: 'BHZ',
  quality: 'D',
  startMs,
  sampleRate: 20,
  samples: new Int32Array([1, 2, 3]),
  recordLength: 512,
})

describe('PublicWaveShare', () => {
  // 正: 2 つ目のタブは繋がず、1 つ目が受けた分を受け取る。
  it('繋ぐのは 1 タブだけで、受けた分をほかのタブへ配る', async () => {
    const b = browser()
    const a = b.tab('a')
    await b.flush()
    const c = b.tab('c')
    await b.flush()
    expect(b.links).toHaveLength(1)
    expect(a.share.isLeader()).toBe(true)
    expect(c.share.isLeader()).toBe(false)
    b.links[0].emit(rec(1000))
    expect(a.got).toHaveLength(1)
    expect(c.got).toHaveLength(1)
  })

  // 正: 繋ぎ役が要らなくても、ほかのタブが要るなら繋ぐ。遡る長さは要るタブの最大。
  it('ほかのタブが要るなら繋ぎ役は繋ぐ', async () => {
    const b = browser()
    const a = b.tab('a')
    await b.flush()
    const c = b.tab('c')
    await b.flush()
    a.share.setNeed(false, 60, ['JMM'])
    c.share.setNeed(true, 180, ['JMM'])
    const last = b.links[0].needs[b.links[0].needs.length - 1]
    expect(last).toEqual({ active: true, spanSec: 180, stations: ['JMM'] })
  })

  // 安全弁: 知らせが途絶えたタブ（閉じた・固まった）は要らないものとして扱い、繋ぎっぱなしにしない。
  it('知らせが途絶えたタブは要らないものとして扱う', async () => {
    const b = browser()
    const a = b.tab('a')
    await b.flush()
    const c = b.tab('c')
    await b.flush()
    a.share.setNeed(false, 60, ['JMM'])
    c.share.setNeed(true, 60, ['JMM'])
    // c の知らせが止まった（c のタイマーだけ止める代わりに、閉じずに黙らせる）。
    c.share['own'] = { active: false, spanSec: 0, stations: [] }
    c.share['channel']!.postMessage = () => {}
    b.tickAll(NEED_EXPIRE_MS + NEED_HEARTBEAT_MS)
    const last = b.links[0].needs[b.links[0].needs.length - 1]
    expect(last.active).toBe(false)
  })

  // 正: 後から開いたタブには、繋ぎ役が控えている直近の分を渡す。
  it('後から開いたタブへ控えを渡す', async () => {
    const b = browser()
    const a = b.tab('a')
    await b.flush()
    b.links[0].emit(rec(1000))
    b.links[0].emit(rec(2000))
    const c = b.tab('c')
    await b.flush()
    expect(a.got).toHaveLength(2)
    expect(c.got.map((r) => r.startMs)).toEqual([1000, 2000])
  })

  // 正: 繋ぎ役が閉じたら次のタブが繋ぎ役になって繋ぐ。
  it('繋ぎ役が閉じたら次のタブが引き継ぐ', async () => {
    const b = browser()
    const a = b.tab('a')
    await b.flush()
    const c = b.tab('c')
    await b.flush()
    c.share.setNeed(true, 120, ['JMM'])
    a.share.dispose()
    await b.flush()
    await b.flush()
    expect(b.links[0].disposed).toBe(true)
    expect(c.share.isLeader()).toBe(true)
    expect(b.links).toHaveLength(2)
    expect(b.links[1].needs[b.links[1].needs.length - 1].active).toBe(true)
  })

  // 対照: ロックが使えないブラウザでは、まとめずに自分で繋ぐ。
  it('ロックが無ければ自分で繋ぐ', () => {
    const b = browser()
    const links: unknown[] = []
    const share = new PublicWaveShare(
      {
        locks: null,
        openChannel: () => null,
        makeLink: () => {
          links.push(1)
          return { setNeed: () => {}, getStatus: () => ({ kind: 'idle' }), dispose: () => {} }
        },
        now: () => 0,
        setInterval: () => 0,
        clearInterval: () => {},
        tabId: 'x',
      },
      () => {},
      () => {},
    )
    expect(share.isLeader()).toBe(true)
    expect(links).toHaveLength(1)
    void b
  })
})
