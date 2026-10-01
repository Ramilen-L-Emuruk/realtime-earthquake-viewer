import { describe, expect, it } from 'vitest'

import { AckReplier, readAckEnabled } from './ackReplier'
import type { DatagramReply } from './udpReceiver'

/** 返した中身を控え、結果は指定どおりに返す口。 */
function recorder(result: Error | null = null): { reply: DatagramReply; sent: string[] } {
  const sent: string[] = []
  const reply: DatagramReply = (payload, onDone) => {
    sent.push(payload)
    onDone(result)
  }
  return { reply, sent }
}

const MAC_A = 'aabbccddee01'
const MAC_B = 'aabbccddee02'

describe('AckReplier', () => {
  it('宛名に MAC を書いた 1 行を返す', () => {
    const acks = new AckReplier({ enabled: true })
    const r = recorder()

    acks.offer(MAC_A, r.reply, 10_000)

    expect(r.sent).toEqual([`seismo-ack ${MAC_A}\n`])
    expect(acks.snapshot().sent).toBe(1)
  })

  // 正: 間隔の内側は返さない／対照: 間隔ちょうどで返す
  it('同じ基板には間隔の内側で返さず、間隔に達したら返す', () => {
    const acks = new AckReplier({ enabled: true, intervalMs: 1000 })
    const r = recorder()

    acks.offer(MAC_A, r.reply, 10_000)
    acks.offer(MAC_A, r.reply, 10_999)
    acks.offer(MAC_A, r.reply, 11_000)

    expect(r.sent).toHaveLength(2)
    expect(acks.snapshot()).toMatchObject({ sent: 2, throttled: 1 })
  })

  // 安全弁: 間引きは基板ごと。1 台の勢いで他の基板への返事が止まらない
  it('間引きは基板ごとに数える', () => {
    const acks = new AckReplier({ enabled: true })
    const r = recorder()

    acks.offer(MAC_A, r.reply, 10_000)
    acks.offer(MAC_B, r.reply, 10_001)

    expect(r.sent).toEqual([`seismo-ack ${MAC_A}\n`, `seismo-ack ${MAC_B}\n`])
  })

  it('時計が戻ったら返す側へ倒す（戻った幅だけ返事を止めない）', () => {
    const acks = new AckReplier({ enabled: true, intervalMs: 1000 })
    const r = recorder()

    acks.offer(MAC_A, r.reply, 10_000)
    acks.offer(MAC_A, r.reply, 5_000)

    expect(r.sent).toHaveLength(2)
  })

  it('止めてあれば 1 つも返さず、数えもしない', () => {
    const acks = new AckReplier({ enabled: false })
    const r = recorder()

    acks.offer(MAC_A, r.reply, 10_000)

    expect(r.sent).toEqual([])
    expect(acks.snapshot()).toEqual({
      enabled: false,
      sent: 0,
      failures: 0,
      throttled: 0,
      lastError: null,
    })
  })

  it('返せなかったら数え、理由を残す', () => {
    const acks = new AckReplier({ enabled: true })
    const r = recorder(new Error('EHOSTUNREACH'))

    acks.offer(MAC_A, r.reply, 10_000)

    expect(acks.snapshot()).toMatchObject({ sent: 0, failures: 1, lastError: 'EHOSTUNREACH' })
    expect(acks.failures).toBe(1)
  })

  it('返す口がその場で投げても外へ漏らさず、返せなかった 1 件として数える', () => {
    const acks = new AckReplier({ enabled: true })
    const reply: DatagramReply = () => {
      throw new Error('socket closed')
    }

    expect(() => acks.offer(MAC_A, reply, 10_000)).not.toThrow()
    expect(acks.snapshot()).toMatchObject({ failures: 1, lastError: 'socket closed' })
  })

  // 安全弁: 覚えが溢れても上限を超えず、溢れた基板にもいずれ返事は出る
  it('覚える基板の数に上限があり、溢れたら古いものから忘れる', () => {
    const acks = new AckReplier({ enabled: true, intervalMs: 1000, maxBoards: 2 })
    const r = recorder()

    acks.offer('m1', r.reply, 10_000)
    acks.offer('m2', r.reply, 10_001)
    acks.offer('m3', r.reply, 10_002)
    // m1 は忘れられているので、間隔の内側でももう一度返る（害は返事が 1 つ余計に出るだけ）
    acks.offer('m1', r.reply, 10_003)
    // m3 は覚えているので返らない
    acks.offer('m3', r.reply, 10_004)

    expect(r.sent.map((s) => s.trim())).toEqual([
      'seismo-ack m1',
      'seismo-ack m2',
      'seismo-ack m3',
      'seismo-ack m1',
    ])
  })
})

describe('readAckEnabled', () => {
  it('未設定・空・on は返す', () => {
    expect(readAckEnabled(undefined)).toBe(true)
    expect(readAckEnabled('')).toBe(true)
    expect(readAckEnabled('on')).toBe(true)
  })

  it('off は返さない', () => {
    expect(readAckEnabled('off')).toBe(false)
  })

  it('打ち間違いは黙って既定へ倒さず、起動を止める', () => {
    expect(() => readAckEnabled('of')).toThrow('SEISMO_ACK')
    expect(() => readAckEnabled('OFF')).toThrow('SEISMO_ACK')
    expect(() => readAckEnabled('0')).toThrow('SEISMO_ACK')
  })
})
