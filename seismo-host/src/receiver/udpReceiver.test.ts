import { createSocket } from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'

import { startUdpReceiver } from './udpReceiver'
import type { DatagramReply, DatagramSource, UdpReceiver } from './udpReceiver'

const LOOPBACK = '127.0.0.1'

const opened: UdpReceiver[] = []

afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close()
})

async function open(
  onDatagram: (payload: string, from: DatagramSource, reply: DatagramReply) => void,
  onError: (error: Error) => void = () => {},
): Promise<UdpReceiver> {
  // **ポート 0 で開ける。** 固定の番号だと、他のテストや実機の受信口と取り合う。
  const receiver = await startUdpReceiver({ port: 0, address: LOOPBACK, onDatagram, onError })
  opened.push(receiver)
  return receiver
}

/** 1 つ送って、受け手が呼ばれるまで待つ。 */
function send(port: number, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: 'udp4' })
    socket.send(payload, port, LOOPBACK, (error) => {
      socket.close()
      if (error) reject(error)
      else resolve()
    })
  })
}

/** 条件が満たされるまで待つ。届く順は OS 任せなので、回数ではなく中身で待つ。 */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`待っていたものが来ない: ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('startUdpReceiver', () => {
  it('届いたものを文字列で渡す', async () => {
    const got: string[] = []
    const r = await open((payload) => got.push(payload))
    await send(r.port, '{"v":2}\n1,2,3\n')
    await waitFor(() => got.length === 1, '1 つ目')
    expect(got[0]).toBe('{"v":2}\n1,2,3\n')
  })

  it('送り手のアドレスとポートを渡す', async () => {
    const from: DatagramSource[] = []
    const r = await open((_payload, f) => from.push(f))
    await send(r.port, 'x')
    await waitFor(() => from.length === 1, '送り手')
    expect(from[0].address).toBe(LOOPBACK)
    expect(from[0].port).toBeGreaterThan(0)
  })

  it('返す口は、送ってきたソケットへ届く', async () => {
    // **送り手のソケットで受ける。** 基板は送るのに使ったソケットでしか返事を待たないので、
    // ここが別のポートへ返していたら、基板には 1 つも届かない。
    const r = await open((payload, _from, reply) => {
      if (payload === 'ping') reply('seismo-ack aa\n', () => {})
    })
    const sender = createSocket({ type: 'udp4' })
    const got: string[] = []
    sender.on('message', (buffer) => got.push(buffer.toString('utf8')))
    try {
      await new Promise<void>((resolve) => sender.bind(0, LOOPBACK, () => resolve()))
      sender.send('ping', r.port, LOOPBACK)
      await waitFor(() => got.length === 1, '返事')
      expect(got[0]).toBe('seismo-ack aa\n')
    } finally {
      sender.close()
    }
  })

  it('閉じたあとに返そうとしても投げず、失敗を onDone へ渡す', async () => {
    // 箱に入れて持つ。素の `let` だと、コールバックの中での代入を型が追えず `null` のままと読む。
    const held: { reply: DatagramReply | null } = { reply: null }
    const r = await open((_payload, _from, reply) => {
      held.reply = reply
    })
    await send(r.port, 'x')
    await waitFor(() => held.reply !== null, '返す口')
    await r.close()
    opened.length = 0

    const results: (Error | null)[] = []
    expect(() => held.reply?.('late', (e) => results.push(e))).not.toThrow()
    await waitFor(() => results.length === 1, '失敗の知らせ')
    expect(results[0]).toBeInstanceOf(Error)
  })

  it('受け手が投げても待ち受けを続け、異常として渡す', async () => {
    const errors: Error[] = []
    const got: string[] = []
    const r = await open((payload) => {
      if (payload === 'boom') throw new Error('壊れた送り手')
      got.push(payload)
    }, (error) => errors.push(error))

    await send(r.port, 'boom')
    await waitFor(() => errors.length === 1, '異常')
    expect(errors[0].message).toBe('壊れた送り手')

    // **ここが肝。** 1 台の壊れた送り手で受信口が黙ると、他の基板まで映らなくなる。
    await send(r.port, 'ok')
    await waitFor(() => got.length === 1, '投げたあとの 1 つ')
    expect(got[0]).toBe('ok')
  })

  it('開けなかったら返る約束のほうが失敗する', async () => {
    const first = await open(() => {})
    // **開いたあとの異常と混ぜない。** 混ぜると、起動に失敗したプロセスが
    // 「動いているつもり」で走り続ける。
    await expect(
      startUdpReceiver({
        port: first.port,
        address: LOOPBACK,
        onDatagram: () => {},
        onError: () => {},
      }),
    ).rejects.toThrow()
  })

  it('閉じたあとは受け取らない', async () => {
    const got: string[] = []
    const r = await open((payload) => got.push(payload))
    const port = r.port
    await r.close()
    opened.length = 0
    await send(port, 'after-close')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(got).toEqual([])
  })

  it('二度閉じても投げない', async () => {
    const r = await open(() => {})
    await r.close()
    await expect(r.close()).resolves.toBeUndefined()
    opened.length = 0
  })
})
