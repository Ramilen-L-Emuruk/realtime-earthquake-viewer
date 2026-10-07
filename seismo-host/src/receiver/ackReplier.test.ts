import { describe, expect, it } from 'vitest'

import { ACK_MAX_GAP_ENTRIES, AckReplier, readAckEnabled } from './ackReplier'
import type { GapStart } from './backlogBook'
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

const NO_GAPS = (): readonly GapStart[] => []

describe('AckReplier', () => {
  it('宛名に MAC を書いた 1 行を返す', () => {
    const acks = new AckReplier({ enabled: true })
    const r = recorder()

    acks.offer(MAC_A, NO_GAPS, r.reply, 10_000)

    expect(r.sent).toEqual([`seismo-ack ${MAC_A}\n`])
    expect(acks.snapshot().sent).toBe(1)
  })

  // 正: 間隔の内側は返さない／対照: 間隔ちょうどで返す
  it('同じ基板には間隔の内側で返さず、間隔に達したら返す', () => {
    const acks = new AckReplier({ enabled: true, intervalMs: 1000 })
    const r = recorder()

    acks.offer(MAC_A, NO_GAPS, r.reply, 10_000)
    acks.offer(MAC_A, NO_GAPS, r.reply, 10_999)
    acks.offer(MAC_A, NO_GAPS, r.reply, 11_000)

    expect(r.sent).toHaveLength(2)
    expect(acks.snapshot()).toMatchObject({ sent: 2, throttled: 1 })
  })

  // 安全弁: 間引きは基板ごと。1 台の勢いで他の基板への返事が止まらない
  it('間引きは基板ごとに数える', () => {
    const acks = new AckReplier({ enabled: true })
    const r = recorder()

    acks.offer(MAC_A, NO_GAPS, r.reply, 10_000)
    acks.offer(MAC_B, NO_GAPS, r.reply, 10_001)

    expect(r.sent).toEqual([`seismo-ack ${MAC_A}\n`, `seismo-ack ${MAC_B}\n`])
  })

  it('時計が戻ったら返す側へ倒す（戻った幅だけ返事を止めない）', () => {
    const acks = new AckReplier({ enabled: true, intervalMs: 1000 })
    const r = recorder()

    acks.offer(MAC_A, NO_GAPS, r.reply, 10_000)
    acks.offer(MAC_A, NO_GAPS, r.reply, 5_000)

    expect(r.sent).toHaveLength(2)
  })

  it('止めてあれば 1 つも返さず、数えもしない', () => {
    const acks = new AckReplier({ enabled: false })
    const r = recorder()

    acks.offer(MAC_A, NO_GAPS, r.reply, 10_000)

    expect(r.sent).toEqual([])
    expect(acks.snapshot()).toEqual({
      enabled: false,
      sent: 0,
      failures: 0,
      throttled: 0,
      withGaps: 0,
      gapLookupFailures: 0,
      gapEntriesRejected: 0,
      lastError: null,
    })
  })

  it('返せなかったら数え、理由を残す', () => {
    const acks = new AckReplier({ enabled: true })
    const r = recorder(new Error('EHOSTUNREACH'))

    acks.offer(MAC_A, NO_GAPS, r.reply, 10_000)

    expect(acks.snapshot()).toMatchObject({ sent: 0, failures: 1, lastError: 'EHOSTUNREACH' })
    expect(acks.failures).toBe(1)
  })

  it('返す口がその場で投げても外へ漏らさず、返せなかった 1 件として数える', () => {
    const acks = new AckReplier({ enabled: true })
    const reply: DatagramReply = () => {
      throw new Error('socket closed')
    }

    expect(() => acks.offer(MAC_A, NO_GAPS, reply, 10_000)).not.toThrow()
    expect(acks.snapshot()).toMatchObject({ failures: 1, lastError: 'socket closed' })
  })

  // 安全弁: 覚えが溢れても上限を超えず、溢れた基板にもいずれ返事は出る
  it('覚える基板の数に上限があり、溢れたら古いものから忘れる', () => {
    const acks = new AckReplier({ enabled: true, intervalMs: 1000, maxBoards: 2 })
    const r = recorder()

    acks.offer('m1', NO_GAPS, r.reply, 10_000)
    acks.offer('m2', NO_GAPS, r.reply, 10_001)
    acks.offer('m3', NO_GAPS, r.reply, 10_002)
    // m1 は忘れられているので、間隔の内側でももう一度返る（害は返事が 1 つ余計に出るだけ）
    acks.offer('m1', NO_GAPS, r.reply, 10_003)
    // m3 は覚えているので返らない
    acks.offer('m3', NO_GAPS, r.reply, 10_004)

    expect(r.sent.map((s) => s.trim())).toEqual([
      'seismo-ack m1',
      'seismo-ack m2',
      'seismo-ack m3',
      'seismo-ack m1',
    ])
  })
})

describe('AckReplier の gap=（取り戻し待ちの欠けを基板へ知らせる）', () => {
  it('正: 欠けがあれば、センサーごとの始まりを gap= に並べる', () => {
    const acks = new AckReplier({ enabled: true })
    const r = recorder()

    acks.offer(MAC_A, () => [{ sensorId: 'i2c0-68', from: 1200 }, { sensorId: 'i2c1-68', from: 4294967200 }], r.reply, 10_000)

    expect(r.sent).toEqual([`seismo-ack ${MAC_A} gap=i2c0-68:1200,i2c1-68:4294967200\n`])
    expect(acks.snapshot()).toMatchObject({ sent: 1, withGaps: 1 })
  })

  it('対照: 欠けが無ければ gap= を付けない', () => {
    const acks = new AckReplier({ enabled: true })
    const r = recorder()

    acks.offer(MAC_A, NO_GAPS, r.reply, 10_000)

    expect(r.sent).toEqual([`seismo-ack ${MAC_A}\n`])
  })

  it('安全弁: 間隔の内側で返さない回は、欠けを引きに行かない（パケットごとに帳面を走査しない）', () => {
    const acks = new AckReplier({ enabled: true, intervalMs: 1000 })
    const r = recorder()
    let calls = 0
    const gaps = (): readonly GapStart[] => {
      calls += 1
      return []
    }

    acks.offer(MAC_A, gaps, r.reply, 10_000)
    acks.offer(MAC_A, gaps, r.reply, 10_500)

    expect(calls).toBe(1)
  })

  it('安全弁: 区切り文字を含みうる名前・番号として読めない値は載せない（基板の読み取りを壊さない）', () => {
    const acks = new AckReplier({ enabled: true })
    const r = recorder()

    acks.offer(
      MAC_A,
      () => [
        { sensorId: 'i2c0:68', from: 1 },
        { sensorId: 'a,b', from: 2 },
        { sensorId: 'a b', from: 3 },
        { sensorId: '', from: 4 },
        { sensorId: 'i2c0-69', from: -1 },
        { sensorId: 'i2c0-69', from: 1.5 },
        { sensorId: 'i2c0-69', from: 2 ** 32 },
        { sensorId: 'i2c1-68', from: 7 },
      ],
      r.reply,
      10_000,
    )

    expect(r.sent).toEqual([`seismo-ack ${MAC_A} gap=i2c1-68:7\n`])
    expect(acks.snapshot().gapEntriesRejected).toBe(7)
  })

  it('安全弁: 載せられない名前は件数の枠を食わない（本物のセンサーが押し出されない）', () => {
    const acks = new AckReplier({ enabled: true })
    const r = recorder()
    const junk = Array.from({ length: ACK_MAX_GAP_ENTRIES + 2 }, (_, i) => ({ sensorId: `A:${i}`, from: i }))

    acks.offer(MAC_A, () => [...junk, { sensorId: 'i2c0-68', from: 30 }], r.reply, 10_000)

    expect(r.sent).toEqual([`seismo-ack ${MAC_A} gap=i2c0-68:30\n`])
  })

  it('対照: 件数の上限で切った分は「外した」に数えない（仕様どおりの打ち切り）', () => {
    const acks = new AckReplier({ enabled: true })
    const r = recorder()
    const many = Array.from({ length: ACK_MAX_GAP_ENTRIES + 3 }, (_, i) => ({ sensorId: `s${i}`, from: i }))

    acks.offer(MAC_A, () => many, r.reply, 10_000)

    expect(acks.snapshot().gapEntriesRejected).toBe(0)
  })

  it('安全弁: 載せるのは ACK_MAX_GAP_ENTRIES 件まで（基板の受け取りの入れ物に収める）', () => {
    const acks = new AckReplier({ enabled: true })
    const r = recorder()
    const many = Array.from({ length: ACK_MAX_GAP_ENTRIES + 3 }, (_, i) => ({ sensorId: `s${i}`, from: i }))

    acks.offer(MAC_A, () => many, r.reply, 10_000)

    const entries = r.sent[0]!.trim().split(' gap=')[1]!.split(',')
    expect(entries).toHaveLength(ACK_MAX_GAP_ENTRIES)
  })

  it('安全弁: 欠けの引き出しが投げても、gap= 無しの返事は返す（返事を止めると基板が再起動を始める）', () => {
    const acks = new AckReplier({ enabled: true })
    const r = recorder()

    acks.offer(MAC_A, () => {
      throw new Error('boom')
    }, r.reply, 10_000)

    expect(r.sent).toEqual([`seismo-ack ${MAC_A}\n`])
    expect(acks.snapshot()).toMatchObject({ sent: 1, gapLookupFailures: 1 })
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
