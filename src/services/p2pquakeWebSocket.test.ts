// 標準版（P2PQuake）のライブ接続の見張り。
//
// 重点は「繋がったまま黙った接続を張り直す」ことと、「静かなだけの時間に張り直さない」こと。
// P2PQuake は生存確認の合図を送らないので、平常でも長く黙る（実測の最長 386.5 秒）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { P2PQuakeWebSocket, P2P_SILENT_RECONNECT_MS } from './p2pquake'

/** 開いた接続を記録するだけの WebSocket の代役。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
  close() { this.closed = true }
  /** 相手から何かが届いた形（各地域のピア数）。 */
  receive() { this.onmessage?.({ data: JSON.stringify({ code: 555, time: '2026/10/06 18:00:00.000' }) }) }
}

const MINUTE = 60_000

describe('P2PQuakeWebSocket の黙った接続の見張り', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function connect() {
    const ws = new P2PQuakeWebSocket()
    const statuses: string[] = []
    ws.onStatusChange = s => statuses.push(s)
    ws.connect()
    FakeWebSocket.instances[0].onopen?.()
    return { ws, statuses }
  }

  // 正: 何も届かないまま上限を過ぎたら、古い接続を捨てて張り直す（onclose が届かなくても）。
  it('上限のあいだ何も届かなければ、onclose を待たずに張り直す', async () => {
    const { ws, statuses } = connect()
    const first = FakeWebSocket.instances[0]

    await vi.advanceTimersByTimeAsync(P2P_SILENT_RECONNECT_MS - MINUTE)
    expect(first.closed).toBe(false)

    await vi.advanceTimersByTimeAsync(MINUTE + 30_000)
    expect(first.closed).toBe(true)
    // 古い接続の onclose は外してあるので、後から届いても二重に張り直さない
    expect(first.onclose).toBeNull()
    expect(statuses).toContain('disconnected')

    await vi.advanceTimersByTimeAsync(3_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    ws.disconnect()
  })

  // 対照: 実測の最長（386.5 秒）より長く黙っても、上限の手前で何か届けば張り直さない。
  it('静かなだけの時間（7 分ごとに届く）では 1 時間経っても張り直さない', async () => {
    const { ws } = connect()
    const first = FakeWebSocket.instances[0]
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(7 * MINUTE)
      first.receive()
    }
    expect(first.closed).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(1)
    ws.disconnect()
  })

  // 正: 開く途中で止まった接続（onopen が来ない）も同じ見張りに掛かる。
  it('開かないまま止まった接続も上限で張り直す', async () => {
    const ws = new P2PQuakeWebSocket()
    ws.connect()
    const first = FakeWebSocket.instances[0]
    await vi.advanceTimersByTimeAsync(P2P_SILENT_RECONNECT_MS + 30_000 + 3_000)
    expect(first.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(2)
    ws.disconnect()
  })

  // 安全弁: 止めた接続は見張りも止まる（止めた後に勝手に繋ぎ直さない）。
  it('disconnect の後は見張りが発火しない', async () => {
    const { ws } = connect()
    ws.disconnect()
    await vi.advanceTimersByTimeAsync(P2P_SILENT_RECONNECT_MS * 2)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  // 安全弁: ブラウザが切断を知らせる通常の経路は従来どおり張り直す。
  it('onclose が届いたときは従来どおり張り直す', async () => {
    const { ws } = connect()
    FakeWebSocket.instances[0].onclose?.()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    ws.disconnect()
  })
})
