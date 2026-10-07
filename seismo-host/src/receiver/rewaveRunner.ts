// 合成波形の作り直しを、1 度に 1 件ずつ回す（`rewaveScheduler.ts` が区間を決め、
// `stationRewave.ts` が作る）。
//
// 1 件の流れ:
// 1. 生データの書き手に溜めている分を吐き出させ、書き終えるまで待つ（`MseedRecorder.flushForRead`）。
//    **書けなかったら作り直さない** —— 書けなかったパケットが抜けた作り直しは、ライブより欠けが多い
//    波形でライブを覆ってしまう
// 2. 区間に掛かる時の本だけを読み（`readMseedRange`）、合成を作り直す
// 3. 「作り直し」の印を付けて控えへ足す（`WaveArchive.writeRevised`）
//
// **設定は区間の当時のものを履歴から引く**（`StationStore.configThrough`）。合成の顔ぶれ（駆動役・重み）は
// 設定で決まるので、いまの設定で過去の区間を作ると、ライブとは別の観測点の波形になりうる。
// **区間の中（助走を含む）で設定が変わっていたら作り直さない** —— 1 本の部品で 2 つの設定は流せない。
// 起動の記録は設定を変えないので、ホストの再起動をまたいだ区間も作り直せる。
//
// **投げない。** 作り直しは本筋の脇役なので、ここが失敗しても受信は止めない。理由を数えて外へ出す。

import type { StoredPacket } from './mseedPacketReader'
import { readMseedRange, RECORD_SPAN_MAX_MS } from './mseedPacketReader'
import type { RewaveJob, RewaveScheduler } from './rewaveScheduler'
import type { FusedWaveChunk } from './sensorFusion'
import type { StationConfig } from './stationConfig'
import { REWAVE_LEAD_MS, REWAVE_TAIL_MS, rewaveStation } from './stationRewave'
import type { RevisedWriteResult } from './waveArchive'

/** 作り直さなかった理由。**手当てが違うので分けて数える。** */
export type RewaveSkipReason =
  /** 区間の中（助走を含む）で観測点の設定が変わっていた。 */
  | 'config-changed'
  /** 観測点の設定の履歴を読めていない（設定ファイルが読めずに空の設定で動いている）。 */
  | 'config-unknown'
  /** 生データの書き手が溜めていた分を書き終えられなかった。 */
  | 'flush-failed'
  /** 区間の生データが 1 つも読めなかった（時の本が無い・開けない）。 */
  | 'no-raw'
  /** 作り直したが、区間に掛かる合成のまとまりが 1 つも出なかった。 */
  | 'empty'
  /** 控えへ書けなかったまとまりがあった。 */
  | 'write-failed'
  /** こちらの不具合（作り直しの途中で投げた）。 */
  | 'internal'

export type RewaveEvent =
  | {
      readonly kind: 'rewaved'
      readonly job: RewaveJob
      readonly chunks: number
      readonly fed: number
      readonly elapsedMs: number
      /**
       * 読んだ生データの壊れ（CRC が合わない・復号できない・中身を読めない記録）の数。**0 でなければ、
       * 作り直した分にもその欠けが残っている**（`readMseedRange`）。
       */
      readonly rawIssues: number
      /** 同じまとまりが 2 度入っていて 1 度だけ流した数（再起動をまたいだ取り戻しで起きる）。 */
      readonly duplicates: number
    }
  | { readonly kind: 'skipped'; readonly job: RewaveJob; readonly reason: RewaveSkipReason; readonly detail: string }

export interface RewaveRunnerDeps {
  readonly scheduler: RewaveScheduler
  /** その観測点の流れに、まだ片付いていない欠けがあるか。 */
  readonly hasPending: (stationId: string) => boolean
  /**
   * `[fromMs, toMs]` の間ずっと効いていた観測点の設定（`StationStore.configThrough`）。途中で変わって
   * いれば `'changed'`、履歴を読めていなければ `null`。
   */
  readonly configThrough: (fromMs: number, toMs: number) => StationConfig | 'changed' | null
  readonly flush: () => Promise<boolean>
  /**
   * `atMs` を含む時の生データの本を読む。**無ければ null**（その時は記録されていない）。
   * 投げてよい（読めなかったとして数える）。
   */
  readonly readHour: (atMs: number) => Promise<Uint8Array | null>
  readonly writeRevised: (stationId: string, chunks: readonly FusedWaveChunk[]) => Promise<RevisedWriteResult>
  readonly now: () => number
  /** 作り直しの途中で受信へ順番を譲る口（`setImmediate` を待つ）。 */
  readonly pause: () => Promise<void>
  readonly onEvent: (event: RewaveEvent) => void
}

export interface RewaveSnapshot {
  /** 作り直しを待っている観測点の数。 */
  readonly waiting: number
  /** いま作り直している最中か。 */
  readonly running: boolean
  /** 作り直して控えへ足した件数。 */
  readonly jobs: number
  /** 足した合成のまとまりの数。 */
  readonly chunks: number
  /** 作り直したときに読んだ生データの壊れの数の合計（{@link RewaveEvent} の `rawIssues`）。 */
  readonly rawIssues: number
  /** 理由ごとの、作り直さなかった（作り直せなかった）件数。**0 の理由は載せない。** */
  readonly skipped: Partial<Record<RewaveSkipReason, number>>
}

const HOUR_MS = 60 * 60 * 1000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class RewaveRunner {
  private readonly deps: RewaveRunnerDeps
  private running: Promise<void> | null = null
  private stopped = false
  private jobs = 0
  private chunks = 0
  private rawIssues = 0
  private readonly skipped = new Map<RewaveSkipReason, number>()

  constructor(deps: RewaveRunnerDeps) {
    this.deps = deps
  }

  /** 作り直してよい 1 件があれば始める。**毎秒呼ぶこと。** 作り直している最中なら何もしない。投げない。 */
  tick(): void {
    if (this.stopped || this.running !== null) return
    let job: RewaveJob | null
    try {
      job = this.deps.scheduler.take(this.deps.now(), this.deps.hasPending)
    } catch {
      this.count('internal')
      return
    }
    if (job === null) return
    this.running = this.run(job).finally(() => {
      this.running = null
    })
  }

  /** 新しく始めず、いま作り直している分が終わるのを待つ。 */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.running !== null) await this.running
  }

  snapshot(): RewaveSnapshot {
    const skipped: Partial<Record<RewaveSkipReason, number>> = {}
    for (const [reason, n] of this.skipped) if (n > 0) skipped[reason] = n
    return {
      waiting: this.deps.scheduler.waiting,
      running: this.running !== null,
      jobs: this.jobs,
      chunks: this.chunks,
      rawIssues: this.rawIssues,
      skipped,
    }
  }

  /** 1 件を作り直す。投げない。 */
  private async run(job: RewaveJob): Promise<void> {
    const startedMs = this.deps.now()
    try {
      const fromMs = job.fromMs - REWAVE_LEAD_MS
      const toMs = job.toMs + REWAVE_TAIL_MS
      const config = this.deps.configThrough(fromMs, toMs)
      if (config === 'changed') {
        this.skip(job, 'config-changed', '区間の中で観測点の設定が変わった')
        return
      }
      if (config === null) {
        this.skip(job, 'config-unknown', '観測点の設定の履歴を読めていない')
        return
      }
      if (!(await this.deps.flush())) {
        this.skip(job, 'flush-failed', '生データの書き手が溜めていた分を書き終えられなかった')
        return
      }
      const packets: StoredPacket[] = []
      let filesRead = 0
      let rawIssues = 0
      const failures: string[] = []
      // レコードは自分の先頭の時刻が属する時の本へ入るので、区間の手前の本も見る。
      const firstHour = Math.floor((fromMs - RECORD_SPAN_MAX_MS) / HOUR_MS) * HOUR_MS
      for (let at = firstHour; at < toMs; at += HOUR_MS) {
        let buf: Uint8Array | null
        try {
          buf = await this.deps.readHour(at)
        } catch (error) {
          failures.push(messageOf(error))
          continue
        }
        if (buf === null) continue
        filesRead += 1
        const read = readMseedRange(buf, fromMs, toMs)
        // 区間の端で切れたパケット（`incompletePackets`）は数えない —— 窓で切れば必ず出る。
        rawIssues += read.crcFailures + read.decodeFailures + read.unreadableLogs + read.unreadableWaveRecords
        for (const p of read.packets) packets.push(p)
      }
      if (filesRead === 0) {
        this.skip(job, 'no-raw', failures.length > 0 ? failures.join(' / ') : '区間の時の本が無い')
        return
      }
      const out = await rewaveStation(
        { stationId: job.stationId, fromMs: job.fromMs, toMs: job.toMs, packets, config },
        this.deps.pause,
      )
      if (out.chunks.length === 0) {
        this.skip(job, 'empty', `流したパケット ${out.fed}`)
        return
      }
      const written = await this.deps.writeRevised(job.stationId, out.chunks)
      this.jobs += 1
      this.chunks += written.written
      this.rawIssues += rawIssues
      if (written.lost + written.bad > 0) {
        this.skip(job, 'write-failed', `書けなかった ${written.lost}・形にできなかった ${written.bad}`)
        return
      }
      this.deps.onEvent({
        kind: 'rewaved',
        job,
        chunks: written.written,
        fed: out.fed,
        elapsedMs: this.deps.now() - startedMs,
        rawIssues,
        duplicates: out.duplicates,
      })
    } catch (error) {
      this.skip(job, 'internal', messageOf(error))
    }
  }

  private skip(job: RewaveJob, reason: RewaveSkipReason, detail: string): void {
    this.count(reason)
    try {
      this.deps.onEvent({ kind: 'skipped', job, reason, detail })
    } catch {
      // 数えてある。要約がそれを出す。
    }
  }

  private count(reason: RewaveSkipReason): void {
    this.skipped.set(reason, (this.skipped.get(reason) ?? 0) + 1)
  }
}
