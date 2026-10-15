// 公開観測点の SeedLink の 1 本を張る係（`docs/public-waveform-design.md` §5.2・§8）。接続部品は偽物に差し替える。
import { describe, expect, it } from 'vitest'
import type { SeedlinkClosed, SeedlinkHandlers, SeedlinkOptions } from './seedlink'
import { PublicWaveLink, REFUSED_STREAK, RETRY_BASE_MS, RETRY_MAX_MS, retryDelayMs, type PublicLinkDeps, type PublicLinkStatus } from './publicWaveLink'

function harness() {
  const opened: { options: SeedlinkOptions; handlers: SeedlinkHandlers; closed: boolean }[] = []
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  let clock = 1_000_000
  const deps: PublicLinkDeps = {
    connect: (options, handlers) => {
      const entry = { options, handlers, closed: false }
      opened.push(entry)
      return {
        close: () => {
          if (entry.closed) return
          entry.closed = true
          handlers.onClosed({ reason: 'closed-by-caller', detail: '', records: 0, unreadable: 0 })
        },
      }
    },
    webSocket: {} as typeof WebSocket,
    serverNow: () => clock,
    now: () => clock,
    random: () => 0.5,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimeout: (h) => {
      ;(h as { cleared: boolean }).cleared = true
    },
  }
  const statuses: PublicLinkStatus[] = []
  const link = new PublicWaveLink(deps, () => {}, (s) => statuses.push(s))
  const peerClose = (i: number, reason: SeedlinkClosed['reason'] = 'closed-by-peer') => {
    opened[i].closed = true
    opened[i].handlers.onClosed({ reason, detail: 'x', records: 0, unreadable: 0 })
  }
  const fireLastTimer = () => {
    const live = timers.filter((x) => !x.cleared)
    const t = live[live.length - 1]
    t.cleared = true
    t.fn()
  }
  return { link, opened, timers, statuses, peerClose, fireLastTimer, advance: (ms: number) => (clock += ms) }
}

const NEED = { active: true, spanSec: 120, stations: ['JMM', 'JYT'] }

describe('PublicWaveLink', () => {
  // 正: 要るときだけ繋ぎ、時間幅ぶん（＋余白）遡る。20 点を 1 本に載せる。
  it('要るときに 1 本繋ぎ、時間幅ぶん遡る', () => {
    const h = harness()
    h.link.setNeed(NEED)
    expect(h.opened).toHaveLength(1)
    expect(h.opened[0].options.request.stations).toEqual(['JMM', 'JYT'])
    expect(h.opened[0].options.request.startMs).toBeLessThanOrEqual(1_000_000 - 120_000)
    h.link.setNeed(NEED)
    expect(h.opened).toHaveLength(1)
  })

  // 対照: 要らなくなったら閉じ、繋ぎ直さない。
  it('要らなくなったら閉じて繋ぎ直さない', () => {
    const h = harness()
    h.link.setNeed(NEED)
    h.link.setNeed({ ...NEED, active: false })
    expect(h.opened[0].closed).toBe(true)
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(0)
    expect(h.link.getStatus().kind).toBe('idle')
  })

  // 正: 切れたら待ってから繋ぎ直す。待ちは倍々に伸び、上限で止まる。
  it('切れたら倍々に待って繋ぎ直す', () => {
    const h = harness()
    h.link.setNeed(NEED)
    h.opened[0].handlers.onStreaming()
    h.peerClose(0)
    expect(h.link.getStatus().kind).toBe('retrying')
    expect(h.timers[h.timers.length - 1].ms).toBe(RETRY_BASE_MS)
    h.fireLastTimer()
    expect(h.opened).toHaveLength(2)
    h.peerClose(1, 'stalled')
    expect(h.timers[h.timers.length - 1].ms).toBe(RETRY_BASE_MS * 2)
    expect(retryDelayMs(30, 0.5)).toBe(RETRY_MAX_MS)
  })

  // 安全弁: ゆらぎは ×0.5〜×1.5 に収める（全端末が同じ時刻に繋ぎ直さない）。
  it('待ちにゆらぎを足す', () => {
    expect(retryDelayMs(1, 0)).toBe(RETRY_BASE_MS / 2)
    expect(retryDelayMs(1, 1)).toBe(RETRY_BASE_MS * 1.5)
  })

  // 正: 流れ始める前に続けて切られたら「断られた」とみなす（仮の判定・§12）。
  it('流れ始める前に続けて切られたら断られたとみなす', () => {
    const h = harness()
    h.link.setNeed(NEED)
    for (let i = 0; i < REFUSED_STREAK; i += 1) {
      h.peerClose(i)
      if (i < REFUSED_STREAK - 1) {
        expect(h.link.getStatus().kind).toBe('retrying')
        h.fireLastTimer()
      }
    }
    expect(h.link.getStatus().kind).toBe('refused')
  })

  // 対照: 流れた後に切れたのは断られたとみなさない。流れ始めたら数え直す。
  it('流れた後に切れたのは断られたとみなさない', () => {
    const h = harness()
    h.link.setNeed(NEED)
    h.peerClose(0)
    h.fireLastTimer()
    h.opened[1].handlers.onStreaming()
    h.peerClose(1)
    expect(h.link.getStatus().kind).toBe('retrying')
  })

  // 安全弁: 待っている間に要らなくなったら、繋ぎ直しの予約を取り消す。
  it('待っている間に要らなくなったら繋ぎ直さない', () => {
    const h = harness()
    h.link.setNeed(NEED)
    h.peerClose(0)
    h.link.setNeed({ ...NEED, active: false })
    expect(h.timers.every((t) => t.cleared)).toBe(true)
  })

  // 正: 載せる観測点が変わったら繋ぎ直す（運用の区切りをまたいだとき）。
  it('載せる観測点が変わったら繋ぎ直す', () => {
    const h = harness()
    h.link.setNeed(NEED)
    h.link.setNeed({ ...NEED, stations: ['JMM'] })
    expect(h.opened).toHaveLength(2)
    expect(h.opened[1].options.request.stations).toEqual(['JMM'])
  })
})
