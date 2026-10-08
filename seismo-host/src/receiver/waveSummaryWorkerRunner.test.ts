import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import type { SummaryJob, SummaryJobResult } from './waveSummaryFiles'
import { SummaryWorkerRunner, type SummaryWorkerLike } from './waveSummaryWorkerRunner'

const JOB: SummaryJob = {
  kind: 'raw',
  sourcePath: 's',
  summaryPath: 'p',
  hourKey: '2026-10-07T12',
  hourStartMs: 0,
  stationKey: null,
}

const OK: SummaryJobResult = {
  ok: true,
  sourceBytes: 10,
  summaryBytes: 1,
  channels: 1,
  problems: { skippedBytes: 0, badRecords: 0 },
  outOfWindowSamples: 0,
  ms: 1,
}

/** 渡されたものを覚え、答えは外から返す偽の別スレッド。 */
class FakeWorker extends EventEmitter implements SummaryWorkerLike {
  readonly posted: { id: number; job: SummaryJob }[] = []
  terminated = false
  postMessage(msg: unknown): void {
    this.posted.push(msg as { id: number; job: SummaryJob })
  }
  async terminate(): Promise<number> {
    this.terminated = true
    return 0
  }
  unref(): void {}
  reply(result: SummaryJobResult): void {
    this.emit('message', { id: this.posted.at(-1)!.id, result })
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('SummaryWorkerRunner', () => {
  it('別スレッドへ渡し、返事をそのまま返す。別スレッドは使い回す', async () => {
    const workers: FakeWorker[] = []
    const runner = new SummaryWorkerRunner({ createWorker: () => (workers.push(new FakeWorker()), workers.at(-1)!) })
    const a = runner.run(JOB)
    await flush()
    workers[0]!.reply(OK)
    expect(await a).toEqual(OK)
    const b = runner.run(JOB)
    await flush()
    workers[0]!.reply(OK)
    await b
    expect(workers).toHaveLength(1)
    expect(workers[0]!.posted).toHaveLength(2)
  })

  it('重なって呼ばれても 1 件ずつ順に渡す', async () => {
    const w = new FakeWorker()
    const runner = new SummaryWorkerRunner({ createWorker: () => w })
    const a = runner.run(JOB)
    const b = runner.run(JOB)
    await flush()
    expect(w.posted).toHaveLength(1)
    w.reply(OK)
    await a
    await flush()
    expect(w.posted).toHaveLength(2)
    w.reply(OK)
    await b
  })

  it('別スレッドが落ちたら持っていた 1 件を失敗で返し、次で立て直す', async () => {
    const workers: FakeWorker[] = []
    const runner = new SummaryWorkerRunner({ createWorker: () => (workers.push(new FakeWorker()), workers.at(-1)!) })
    const a = runner.run(JOB)
    await flush()
    workers[0]!.emit('error', new Error('メモリが足りない'))
    const ra = await a
    expect(ra.ok).toBe(false)
    if (!ra.ok) expect(ra.error).toContain('メモリが足りない')
    const b = runner.run(JOB)
    await flush()
    expect(workers).toHaveLength(2)
    workers[1]!.reply(OK)
    expect(await b).toEqual(OK)
    expect(runner.restarts).toBe(1)
  })

  it('時間切れなら止めて失敗で返し、捨てた別スレッドの後からの知らせは次の 1 件を巻き込まない', async () => {
    const workers: FakeWorker[] = []
    const runner = new SummaryWorkerRunner({ timeoutMs: 5, createWorker: () => (workers.push(new FakeWorker()), workers.at(-1)!) })
    const r = await runner.run(JOB)
    expect(r.ok).toBe(false)
    expect(workers[0]!.terminated).toBe(true)

    const b = runner.run(JOB)
    await flush()
    // 捨てた別スレッドが今ごろ落ちた
    workers[0]!.emit('error', new Error('遅れて届いた'))
    workers[0]!.emit('exit', 1)
    workers[1]!.reply(OK)
    expect(await b).toEqual(OK)
  })

  it('止めたあとは失敗で返す', async () => {
    const w = new FakeWorker()
    const runner = new SummaryWorkerRunner({ createWorker: () => w })
    await runner.close()
    const r = await runner.run(JOB)
    expect(r.ok).toBe(false)
  })
})
