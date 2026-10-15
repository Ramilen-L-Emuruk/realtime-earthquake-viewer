import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { steim2Record, walk } from '../test-utils/mseed2Fixture'
import { connectSeedlink, type SeedlinkClosed, type SeedlinkHandlers } from './seedlink'
import { SeedlinkSession } from './seedlinkSession'

/** 送った命令を覚え、受信・開く・閉じるを手で起こせる偽の WebSocket */
class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static last: FakeSocket | null = null
  readyState = FakeSocket.CONNECTING
  binaryType = 'blob'
  sent: string[] = []
  closeCalls = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: { type: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.last = this
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closeCalls++
    this.readyState = FakeSocket.CLOSED
  }
  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  receive(data: string | ArrayBuffer) {
    this.onmessage?.({ data })
  }
  peerClose(code: number) {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code, reason: '' })
  }
}

function packet(seq: string, record: Uint8Array): ArrayBuffer {
  const b = new Uint8Array(520)
  b.set(new TextEncoder().encode(`SL${seq}`), 0)
  b.set(record.subarray(0, 512), 8)
  return b.buffer
}

function handlers() {
  const closed: SeedlinkClosed[] = []
  const h: SeedlinkHandlers & { records: number; unreadable: string[]; streaming: number; closed: SeedlinkClosed[] } = {
    records: 0,
    unreadable: [],
    streaming: 0,
    closed,
    onRecord() {
      h.records++
    },
    onUnreadable(problem) {
      h.unreadable.push(problem)
    },
    onStreaming() {
      h.streaming++
    },
    onClosed(c) {
      closed.push(c)
    },
  }
  return h
}

const OPTIONS = {
  url: 'wss://example.invalid/seedlink',
  request: { network: 'JP', stations: ['JMN'], startMs: Date.UTC(2026, 9, 13, 11, 40) },
  openTimeoutMs: 10_000,
  replyTimeoutMs: 5_000,
  stallTimeoutMs: 60_000,
  webSocket: FakeSocket as unknown as typeof WebSocket,
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.last = null
})
afterEach(() => {
  vi.useRealTimers()
})

/** 開いて STATION・TIME に OK を返し、END まで進めた偽の接続 */
function streamingSocket(h = handlers()) {
  connectSeedlink(OPTIONS, h)
  const ws = FakeSocket.last!
  ws.open()
  ws.receive('OK\r\n')
  ws.receive('OK\r\n')
  return { ws, h }
}

describe('connectSeedlink', () => {
  it('副プロトコル SeedLink3.1 で開き、命令を 1 つずつ応答を待って送り、レコードを読んで渡す', () => {
    const h = handlers()
    connectSeedlink(OPTIONS, h)
    const ws = FakeSocket.last!
    expect(ws.protocols).toEqual(['SeedLink3.1'])
    expect(ws.binaryType).toBe('arraybuffer')
    ws.open()
    expect(ws.sent).toEqual(['STATION JMN JP\r\n'])
    ws.receive('OK\r\n')
    expect(ws.sent[ws.sent.length - 1]).toBe('TIME 2026,10,13,11,40,0\r\n')
    ws.receive('OK\r\n')
    expect(ws.sent[ws.sent.length - 1]).toBe('END\r\n')
    // END を送っただけでは「流れ始めた」と言わない
    expect(h.streaming).toBe(0)
    ws.receive(packet('000001', steim2Record(walk(100, 1, 50)).bytes))
    expect(h.records).toBe(1)
    expect(h.streaming).toBe(1)
    expect(h.closed).toEqual([])
  })

  it('開かないまま期限が来たら open-timeout で閉じる', () => {
    const h = handlers()
    connectSeedlink(OPTIONS, h)
    vi.advanceTimersByTime(10_000)
    expect(h.closed.map((c) => c.reason)).toEqual(['open-timeout'])
    expect(FakeSocket.last!.closeCalls).toBe(1)
  })

  it('命令への応答が期限までに来なければ reply-timeout で閉じる', () => {
    const h = handlers()
    connectSeedlink(OPTIONS, h)
    FakeSocket.last!.open()
    vi.advanceTimersByTime(4_999)
    expect(h.closed).toEqual([])
    vi.advanceTimersByTime(1)
    expect(h.closed[0]).toMatchObject({ reason: 'reply-timeout' })
  })

  it('読めるレコードが届くたびに途切れの見張りを張り直し、期限のあいだ来なければ stalled で閉じる', () => {
    const { ws, h } = streamingSocket()
    vi.advanceTimersByTime(59_000)
    ws.receive(packet('000001', steim2Record(walk(50, 2, 50)).bytes))
    vi.advanceTimersByTime(59_000)
    expect(h.closed).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(h.closed[0]).toMatchObject({ reason: 'stalled', records: 1, unreadable: 0 })
  })

  it('読めないレコードだけが届き続けても、見張りは延ばさず stalled で閉じる', () => {
    const { ws, h } = streamingSocket()
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(15_000)
      ws.receive(packet(`00000${i}`, new Uint8Array(512)))
    }
    // 5 本 × 15 秒 = 75 秒。読めるものが 1 本も無いので 60 秒で閉じている
    expect(h.unreadable).toEqual(['bad-header', 'bad-header', 'bad-header'])
    expect(h.closed[0]).toMatchObject({ reason: 'stalled', records: 0, unreadable: 3 })
  })

  it('命令が断られたら refused、応答が手順から外れたら protocol-error で閉じる', () => {
    const a = handlers()
    connectSeedlink(OPTIONS, a)
    FakeSocket.last!.open()
    FakeSocket.last!.receive('ERROR\r\n')
    expect(a.closed[0]).toMatchObject({ reason: 'refused', detail: 'STATION JMN JP → ERROR' })
    const b = handlers()
    connectSeedlink(OPTIONS, b)
    FakeSocket.last!.open()
    FakeSocket.last!.receive('HELLO\r\n')
    expect(b.closed[0]).toMatchObject({ reason: 'protocol-error' })
  })

  it('読めないレコードは数えて渡し、接続は続ける', () => {
    const { ws, h } = streamingSocket()
    ws.receive(packet('000002', new Uint8Array(512)))
    expect(h.unreadable).toEqual(['bad-header'])
    expect(h.closed).toEqual([])
  })

  it('onRecord が投げたら handler-error で閉じる（同じ受信の残りを黙って失わない）', () => {
    const h = handlers()
    h.onRecord = () => {
      throw new Error('描けない')
    }
    const { ws } = streamingSocket(h)
    const rec = steim2Record(walk(50, 3, 50)).bytes
    const two = new Uint8Array(1040)
    two.set(new Uint8Array(packet('000001', rec)), 0)
    two.set(new Uint8Array(packet('000002', rec)), 520)
    ws.receive(two.buffer)
    expect(h.closed).toHaveLength(1)
    expect(h.closed[0]).toMatchObject({ reason: 'handler-error' })
    expect(h.closed[0]!.detail).toContain('000001')
  })

  it('始められなかったとき（命令の組み立てが投げた）も、onClosed で failed-to-start が届く', () => {
    const h = handlers()
    expect(() => connectSeedlink({ ...OPTIONS, request: { ...OPTIONS.request, stations: [] } }, h)).not.toThrow()
    expect(h.closed).toEqual([])
    vi.advanceTimersByTime(0)
    expect(h.closed.map((c) => c.reason)).toEqual(['failed-to-start'])
  })

  it('WebSocket の生成が投げたときも failed-to-start。待つ間に close() したら closed-by-caller の 1 回だけ', () => {
    const Throwing = class {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      constructor() {
        throw new Error('不正な URL')
      }
    } as unknown as typeof WebSocket
    const a = handlers()
    connectSeedlink({ ...OPTIONS, webSocket: Throwing }, a)
    expect(a.closed).toEqual([])
    vi.advanceTimersByTime(0)
    expect(a.closed).toHaveLength(1)
    expect(a.closed[0]).toMatchObject({ reason: 'failed-to-start' })
    expect(a.closed[0]!.detail).toContain('不正な URL')

    const b = handlers()
    const conn = connectSeedlink({ ...OPTIONS, webSocket: Throwing }, b)
    conn.close()
    vi.advanceTimersByTime(0)
    expect(b.closed.map((c) => c.reason)).toEqual(['closed-by-caller'])
  })

  it('onUnreadable が投げたら handler-error で閉じる（受信の残りを黙って失わない）', () => {
    const h = handlers()
    h.onUnreadable = () => {
      throw new Error('数えられない')
    }
    const { ws } = streamingSocket(h)
    const two = new Uint8Array(1040)
    two.set(new Uint8Array(packet('000001', new Uint8Array(512))), 0)
    two.set(new Uint8Array(packet('000002', steim2Record(walk(50, 4, 50)).bytes)), 520)
    expect(() => ws.receive(two.buffer)).not.toThrow()
    expect(h.closed).toHaveLength(1)
    expect(h.closed[0]).toMatchObject({ reason: 'handler-error', records: 0, unreadable: 1 })
    expect(h.records).toBe(0)
  })

  it('onClosed が投げても飲み込まず、次の順番で投げ直す', () => {
    const h = handlers()
    h.onClosed = () => {
      throw new Error('後始末で失敗')
    }
    const conn = connectSeedlink(OPTIONS, h)
    expect(() => conn.close()).not.toThrow()
    expect(() => vi.advanceTimersByTime(0)).toThrow('後始末で失敗')
  })

  it('手順の側が想定外の例外を投げたら unexpected-exception で 1 回だけ閉じる（受信から漏らさない）', () => {
    const { ws, h } = streamingSocket()
    const spy = vi.spyOn(SeedlinkSession.prototype, 'feed').mockImplementation(() => {
      throw new TypeError('想定外')
    })
    try {
      expect(() => ws.receive(packet('000001', steim2Record(walk(50, 6, 50)).bytes))).not.toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(h.closed).toHaveLength(1)
    expect(h.closed[0]).toMatchObject({ reason: 'unexpected-exception' })
    expect(h.closed[0]!.detail).toContain('想定外')
  })

  it('連番が小文字の 16 進でも区切りとして読む', () => {
    const { ws, h } = streamingSocket()
    ws.receive(packet('00001a', steim2Record(walk(50, 5, 50)).bytes))
    expect(h.records).toBe(1)
    expect(h.unreadable).toEqual([])
  })

  it('送れなかったら closed-by-peer で閉じる', () => {
    const h = handlers()
    connectSeedlink(OPTIONS, h)
    const ws = FakeSocket.last!
    ws.send = () => {
      throw new Error('InvalidStateError')
    }
    ws.open()
    expect(h.closed[0]).toMatchObject({ reason: 'closed-by-peer' })
    expect(h.closed[0]!.detail).toContain('送れなかった')
  })

  it('相手が閉じたら closed-by-peer（開いたかと error の中身を残す）、こちらが閉じたら closed-by-caller。知らせは 1 回だけ', () => {
    const a = handlers()
    connectSeedlink(OPTIONS, a)
    FakeSocket.last!.onerror?.({ type: 'error' } as never)
    FakeSocket.last!.peerClose(1006)
    expect(a.closed).toEqual([{ reason: 'closed-by-peer', detail: 'code 1006・開く前・error: error', records: 0, unreadable: 0 }])

    const b = handlers()
    const conn = connectSeedlink(OPTIONS, b)
    conn.close()
    conn.close()
    vi.advanceTimersByTime(60_000)
    expect(b.closed.map((c) => c.reason)).toEqual(['closed-by-caller'])
  })

  it('閉じるときに ws.close が投げても、onClosed は届く', () => {
    const h = handlers()
    const conn = connectSeedlink(OPTIONS, h)
    FakeSocket.last!.close = () => {
      throw new Error('壊れた')
    }
    conn.close()
    expect(h.closed).toHaveLength(1)
    expect(h.closed[0]!.detail).toContain('閉じるときに失敗')
  })
})
