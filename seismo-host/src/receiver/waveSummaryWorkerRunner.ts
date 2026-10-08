// 要約を別スレッド（`waveSummaryWorker.ts`）で作る。要約の係（`waveSummaryKeeper.ts`）の `run` に渡す。
//
// **別スレッドにするのは、受信のイベントループを塞がないため。** 生データ 1 時間ぶんの要約に実測 1.4 秒
// かかり、受信の見張り（`loopStall.ts`）の閾値 1 秒を越える —— 同じスレッドで回すと、要約を作るたびに
// 「ホストが止まった」と記録し、UDP の受信バッファも溢れうる。
//
// - **1 本の別スレッドを使い回す。** 1 件ごとに立てると、そのたびに tsx の読み込みを払う
// - **1 件ずつ順に渡す**（係が順に呼ぶが、重なっても並べて待たせる）
// - **落ちたら次の 1 件で立て直す。** 落ちたときに持っていた 1 件は失敗として返す
// - **上限の時間を過ぎたら止めて失敗として返す**（壊れたファイルで回り続けるのを、受信側から見えなくしない）
// - プロセスの終了を引き止めない（`unref`）

import { Worker } from 'node:worker_threads'

import type { SummaryJob, SummaryJobResult } from './waveSummaryFiles'

const TIMEOUT_MS_DEFAULT = 120_000

/** 別スレッドとして要る口だけ（テストで差し替えるため）。 */
export interface SummaryWorkerLike {
  postMessage(msg: unknown): void
  on(event: 'message', listener: (msg: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
  unref(): void
}

export interface SummaryWorkerRunnerOptions {
  readonly timeoutMs?: number
  readonly createWorker?: () => SummaryWorkerLike
}

interface Pending {
  readonly id: number
  readonly resolve: (r: SummaryJobResult) => void
  readonly timer: ReturnType<typeof setTimeout>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class SummaryWorkerRunner {
  private readonly timeoutMs: number
  private readonly createWorker: () => SummaryWorkerLike
  private worker: SummaryWorkerLike | null = null
  private pending: Pending | null = null
  private nextId = 1
  private chain: Promise<unknown> = Promise.resolve()
  private restartCount = 0
  private closed = false

  constructor(options: SummaryWorkerRunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS_DEFAULT
    this.createWorker =
      options.createWorker ?? (() => new Worker(new URL('./waveSummaryWorker.ts', import.meta.url)) as unknown as SummaryWorkerLike)
  }

  /** 別スレッドを立て直した回数（落ちた・時間切れで止めた）。 */
  get restarts(): number {
    return this.restartCount
  }

  run(job: SummaryJob): Promise<SummaryJobResult> {
    const next = this.chain.then(() => this.runOne(job))
    this.chain = next.catch(() => undefined)
    return next
  }

  /** 止める。**以後の `run` は失敗で返す。** */
  async close(): Promise<void> {
    this.closed = true
    const w = this.worker
    this.worker = null
    this.settle({ ok: false, error: '要約を作る係を止めた' })
    if (w !== null) await w.terminate().catch(() => 0)
  }

  private runOne(job: SummaryJob): Promise<SummaryJobResult> {
    if (this.closed) return Promise.resolve({ ok: false, error: '要約を作る係を止めた' })
    let w: SummaryWorkerLike
    try {
      w = this.ensureWorker()
    } catch (error) {
      return Promise.resolve({ ok: false, error: `要約を作る係を立てられず: ${messageOf(error)}` })
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise<SummaryJobResult>((resolve) => {
      const timer = setTimeout(() => {
        this.settle({ ok: false, error: `${Math.round(this.timeoutMs / 1000)} 秒で作り終わらなかった` })
        this.discard()
      }, this.timeoutMs)
      timer.unref?.()
      this.pending = { id, resolve, timer }
      try {
        w.postMessage({ id, job })
      } catch (error) {
        this.settle({ ok: false, error: `要約を作る係へ渡せず: ${messageOf(error)}` })
        this.discard()
      }
    })
  }

  private ensureWorker(): SummaryWorkerLike {
    if (this.worker !== null) return this.worker
    const w = this.createWorker()
    w.unref()
    w.on('message', (msg) => {
      const m = msg as { id?: unknown; result?: unknown }
      if (this.pending === null || m.id !== this.pending.id) return
      this.settle(m.result as SummaryJobResult)
    })
    // **捨てた別スレッドからの知らせは無視する**（`discard` の後に届くと、次に立てた別スレッドが
    // 持っている 1 件を取り違えて失敗にしてしまう）。
    w.on('error', (error) => {
      if (this.worker !== w) return
      this.worker = null
      this.restartCount += 1
      this.settle({ ok: false, error: `要約を作る係が落ちた: ${messageOf(error)}` })
    })
    w.on('exit', (code) => {
      if (this.worker !== w) return
      this.worker = null
      this.restartCount += 1
      this.settle({ ok: false, error: `要約を作る係が終わった（終了コード ${code}）` })
    })
    this.worker = w
    return w
  }

  /** 持っている 1 件を返す。 */
  private settle(result: SummaryJobResult): void {
    const p = this.pending
    if (p === null) return
    this.pending = null
    clearTimeout(p.timer)
    p.resolve(result)
  }

  /** 時間切れ・渡せなかった別スレッドを捨てる（次の 1 件で立て直す）。 */
  private discard(): void {
    const w = this.worker
    this.worker = null
    if (w === null) return
    this.restartCount += 1
    void w.terminate().catch(() => 0)
  }
}
