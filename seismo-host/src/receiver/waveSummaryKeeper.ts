// 要約（`waveSummary.ts`）を最新に保つ係。一定の間隔で元のファイルを数え上げ、要約が控えている大きさと
// 元のファイルの大きさが違うもの（まだ無い・後から伸びた）を作り直す。
//
// **作るのは呼び出し側が渡す `run`（ふつうは別スレッド・`waveSummaryWorkerRunner.ts`）。** この係は
// 「どれをいつ作るか」だけを決める —— 決め方をテストで固定でき、重い処理は受信のイベントループに乗らない。
//
// **決め方**
// - 新しい時から先に作る（いま見たいのは新しい時。初めて動かしたときの過去分の作成は後回しでよい）
// - **いまの時は、前に作ってから `currentHourIntervalMs` が経つまで作り直さない**（いまの時の生データは
//   受信のたびに伸びるので、毎回作り直すと休みなく回り続ける）
// - 1 回の見回りで作るのは `maxJobsPerTick` 本まで。**過去分の作成が何百本あっても、次の見回りで
//   いまの時を拾い直せるように**
// - 作れなかったものは `failureRetryMs` 待ってから作り直す（読めないファイルを毎分叩き続けない）
// - 見回りが重なったら後のほうは何もしない（前の見回りがまだ作っている）
//
// **元のファイルが消えた要約は捨てる**（2026-10-08 ユーザー承認）。人が元を消すのは、そのデータが要らない・
// 誤っていると判断したとき（時計が合う前の 1970 年の合成波形を消した実例）。要約だけ残ると、管理コンソールの
// チャンネルの一覧（要約の置き場所から作る）に元の無い時が出続ける。**捨てないのは次の 3 つのとき** ——
// どれも「無い」のではなく「見えていない」かもしれない回で、そこで捨てると作り直せない要約まで失う。
// - 元の一覧を作れなかった置き場所があった回
// - 要約の置き場所を読み損ねた回
// - その種類（生データ・合成波形）の元が 1 本も見つからなかった回（置き場所の付け替え・ドライブの外れ）

import { jstHourStartMs } from './jstTime'
import {
  listSummaryFiles,
  listSummaryJobs,
  removeSummaryFiles,
  sourceSizeOf,
  summarizedSourceBytes,
  type ListResult,
  type SummaryJob,
  type SummaryJobResult,
  type SummaryListResult,
} from './waveSummaryFiles'

const CURRENT_HOUR_INTERVAL_MS_DEFAULT = 60_000
const MAX_JOBS_PER_TICK_DEFAULT = 30
const FAILURE_RETRY_MS_DEFAULT = 10 * 60_000

export interface WaveSummaryKeeperOptions {
  readonly rawDir: string
  readonly waveDir: string
  readonly summaryDir: string
  readonly run: (job: SummaryJob) => Promise<SummaryJobResult>
  readonly now?: () => number
  readonly currentHourIntervalMs?: number
  readonly maxJobsPerTick?: number
  readonly failureRetryMs?: number
  /** 差し替えられるのはテストのため。 */
  readonly list?: (dirs: { rawDir: string; waveDir: string; summaryDir: string }) => Promise<ListResult>
  readonly sizeOf?: (path: string) => Promise<number | null>
  readonly summarizedBytes?: (summaryPath: string) => Promise<number | null>
  readonly listSummaries?: (summaryDir: string) => Promise<SummaryListResult>
  readonly removeSummary?: (files: readonly string[]) => Promise<void>
  /** 元の無い要約を捨てたとき・捨てられなかったときの 1 行。 */
  readonly log?: (line: string) => void
}

/** 状態の口（`/status`）へ出すもの。 */
export interface WaveSummaryKeeperStatus {
  readonly dir: string
  /** 直近の見回りで数えた元のファイルの数。 */
  readonly sources: number
  /** そのうち要約が最新だったもの。 */
  readonly upToDate: number
  /** そのうち作り直しを待っているもの（いまの時の間隔待ち・失敗の待ちを含む）。 */
  readonly pending: number
  /** 作った要約の累計。 */
  readonly built: number
  /** 作れなかった回数の累計。**0 でなければ `lastError` を見ること。** */
  readonly failed: number
  /** 元のファイルが消えたので捨てた要約の累計（名前の元の数）。 */
  readonly removed: number
  /** 一覧を作れなかった・大きさを読めなかった・元の消えた要約を捨てられなかった回数の累計。 */
  readonly scanErrors: number
  readonly lastError: string | null
  /** 直近に作った要約の時（`YYYY-MM-DDTHH`）と、作るのにかかった時間。 */
  readonly lastBuiltHour: string | null
  readonly lastBuildMs: number | null
  /** 直近の見回りを終えた時刻。**null のままなら、まだ一度も見回っていない。** */
  readonly lastScanAtMs: number | null
  readonly running: boolean
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class WaveSummaryKeeper {
  private readonly opts: WaveSummaryKeeperOptions
  private readonly now: () => number
  private readonly list: NonNullable<WaveSummaryKeeperOptions['list']>
  private readonly sizeOf: NonNullable<WaveSummaryKeeperOptions['sizeOf']>
  private readonly summarizedBytes: NonNullable<WaveSummaryKeeperOptions['summarizedBytes']>
  private readonly listSummaries: NonNullable<WaveSummaryKeeperOptions['listSummaries']>
  private readonly removeSummary: NonNullable<WaveSummaryKeeperOptions['removeSummary']>
  /** 要約が控えている元のファイルの大きさ（読んだもの・作ったもの）。`null` は「要約が無い」。 */
  private readonly known = new Map<string, number | null>()
  private readonly builtAt = new Map<string, number>()
  private readonly retryAt = new Map<string, number>()
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private sources = 0
  private upToDate = 0
  private pending = 0
  private built = 0
  private failed = 0
  private removed = 0
  private scanErrors = 0
  private lastError: string | null = null
  private lastBuiltHour: string | null = null
  private lastBuildMs: number | null = null
  private lastScanAtMs: number | null = null

  constructor(options: WaveSummaryKeeperOptions) {
    this.opts = options
    this.now = options.now ?? Date.now
    this.list = options.list ?? listSummaryJobs
    this.sizeOf = options.sizeOf ?? sourceSizeOf
    this.summarizedBytes = options.summarizedBytes ?? summarizedSourceBytes
    this.listSummaries = options.listSummaries ?? listSummaryFiles
    this.removeSummary = options.removeSummary ?? removeSummaryFiles
  }

  /** `intervalMs` ごとに見回る。最初の見回りは `firstDelayMs` 後（起動直後の忙しさを避ける）。 */
  start(intervalMs: number, firstDelayMs: number): void {
    if (this.timer !== null) return
    this.firstTimer = setTimeout(() => void this.tick(), firstDelayMs)
    this.firstTimer.unref?.()
    this.timer = setInterval(() => void this.tick(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.firstTimer !== null) clearTimeout(this.firstTimer)
    if (this.timer !== null) clearInterval(this.timer)
    this.firstTimer = null
    this.timer = null
  }

  snapshot(): WaveSummaryKeeperStatus {
    return {
      dir: this.opts.summaryDir,
      sources: this.sources,
      upToDate: this.upToDate,
      pending: this.pending,
      built: this.built,
      failed: this.failed,
      removed: this.removed,
      scanErrors: this.scanErrors,
      lastError: this.lastError,
      lastBuiltHour: this.lastBuiltHour,
      lastBuildMs: this.lastBuildMs,
      lastScanAtMs: this.lastScanAtMs,
      running: this.running,
    }
  }

  /** 1 回見回る。**投げない。** 前の見回りがまだ終わっていなければ何もしない。 */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.scanAndBuild()
    } catch (error) {
      // ここへ来るのは係そのものの取り違え。見回りは次の回に任せる。
      this.scanErrors += 1
      this.lastError = messageOf(error)
    } finally {
      this.running = false
      this.lastScanAtMs = this.now()
    }
  }

  private async scanAndBuild(): Promise<void> {
    const { rawDir, waveDir, summaryDir } = this.opts
    const listed = await this.list({ rawDir, waveDir, summaryDir })
    if (listed.errors.length > 0) {
      this.scanErrors += listed.errors.length
      this.lastError = listed.errors[0]!
    }

    const nowMs = this.now()
    const currentHour = jstHourStartMs(nowMs)
    const stale: { job: SummaryJob; size: number }[] = []
    const seen = new Set<string>()
    let upToDate = 0
    let sources = 0
    for (const job of listed.jobs) {
      let size: number | null
      try {
        size = await this.sizeOf(job.sourcePath)
      } catch (error) {
        seen.add(job.summaryPath)
        this.scanErrors += 1
        this.lastError = `${job.sourcePath} の大きさを読めず: ${messageOf(error)}`
        continue
      }
      // 数え上げた後に消えた（人が消した）。
      if (size === null) continue
      seen.add(job.summaryPath)
      sources += 1
      let known = this.known.get(job.summaryPath)
      if (known === undefined) {
        known = await this.summarizedBytes(job.summaryPath)
        this.known.set(job.summaryPath, known)
      }
      if (known === size) upToDate += 1
      else stale.push({ job, size })
    }

    // **元のファイルが消えた分の控えは捨てる**（人が古い生データを消すと、控えだけが動いている間ずっと残る）。
    // 一覧を作れなかった置き場所があった回は捨てない —— そこにあるファイルは「消えた」のではなく見えていないだけ。
    if (listed.errors.length === 0) {
      for (const map of [this.known, this.builtAt, this.retryAt]) {
        for (const path of map.keys()) if (!seen.has(path)) map.delete(path)
      }
      await this.removeOrphans(listed.jobs, seen)
    }

    const due = stale.filter(({ job }) => {
      if ((this.retryAt.get(job.summaryPath) ?? 0) > nowMs) return false
      if (job.hourStartMs === currentHour) {
        const at = this.builtAt.get(job.summaryPath)
        if (at !== undefined && nowMs - at < (this.opts.currentHourIntervalMs ?? CURRENT_HOUR_INTERVAL_MS_DEFAULT)) return false
      }
      return true
    })
    due.sort((a, b) => b.job.hourStartMs - a.job.hourStartMs)

    let done = 0
    for (const { job, size } of due.slice(0, this.opts.maxJobsPerTick ?? MAX_JOBS_PER_TICK_DEFAULT)) {
      let result: SummaryJobResult
      try {
        result = await this.opts.run(job)
      } catch (error) {
        result = { ok: false, error: messageOf(error) }
      }
      if (result.ok) {
        this.known.set(job.summaryPath, result.sourceBytes)
        this.builtAt.set(job.summaryPath, this.now())
        this.retryAt.delete(job.summaryPath)
        this.built += 1
        this.lastBuiltHour = job.hourKey
        this.lastBuildMs = result.ms
        // **作っている間に元のファイルが伸びていれば、まだ最新ではない**（次の見回りで作り直す）。
        if (result.sourceBytes === size) done += 1
      } else {
        this.failed += 1
        this.lastError = `${job.sourcePath} の要約を作れず: ${result.error}`
        this.retryAt.set(job.summaryPath, this.now() + (this.opts.failureRetryMs ?? FAILURE_RETRY_MS_DEFAULT))
      }
    }

    this.sources = sources
    this.upToDate = upToDate + done
    this.pending = stale.length - done
  }

  /**
   * 元のファイルが消えた要約を捨てる（冒頭の「元のファイルが消えた要約は捨てる」）。呼ぶのは元の一覧を
   * 作れた回だけ。`seen` は大きさを確かめられた元（読み損ねたものも含む）の要約の名前。
   */
  private async removeOrphans(jobs: readonly SummaryJob[], seen: ReadonlySet<string>): Promise<void> {
    // **投げない。** 捨てる側の取り違えで、同じ回の要約作り（主の仕事）まで止めない。
    let listed: SummaryListResult
    try {
      listed = await this.listSummaries(this.opts.summaryDir)
    } catch (error) {
      this.scanErrors += 1
      this.lastError = `要約の置き場所を数え上げられず: ${messageOf(error)}`
      return
    }
    if (listed.errors.length > 0) {
      this.scanErrors += listed.errors.length
      this.lastError = listed.errors[0]!
      return
    }
    // **その種類の元が 1 本も無い回は、その種類を捨てない**（置き場所の付け替え・ドライブの外れで全部を失わない）。
    const kindsWithSource = new Set(jobs.map((j) => j.kind))
    for (const summary of listed.summaries) {
      if (seen.has(summary.summaryPath) || !kindsWithSource.has(summary.kind)) continue
      try {
        await this.removeSummary(summary.files)
      } catch (error) {
        // ファイルを消す操作の失敗なので、状態の口だけでなくログにも出す（`lastError` は後の失敗で上書きされうる）。
        // 消せない限り次の見回りでもまた試すので、同じ要約の行は 1 分ごとに出る。
        const message = `${summary.summaryPath} の要約を捨てられず: ${messageOf(error)}`
        this.scanErrors += 1
        this.lastError = message
        this.opts.log?.(`[summary] ${message}`)
        continue
      }
      this.removed += 1
      this.opts.log?.(`[summary] 元のファイルが無くなった要約を捨てた: ${summary.summaryPath}`)
    }
  }
}
