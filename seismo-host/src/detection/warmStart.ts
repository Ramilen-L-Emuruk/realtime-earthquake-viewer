// 起動時に、控えの合成波形で地震検出の見張りを引き継ぐ（#617）。
//
//   起動 ──→ 観測点の最初の波形が届く ──→ 検出は待たせ、ライブを溜める（`stationDetection.ts`）
//                                              │
//        取り戻し・作り直しが片付く（最長 60 秒）─┘
//                                              ↓
//   控え ──→ 前のプロセスの最後の 10 分 → 作り直した欠け ──→ 本物の検出器 ──→ 溜めたライブ ──→ ライブを直に
//   控え ──→ 24 時間ぶん ──→ 別の引き金（裏で） ──→ 1 分ごとの比の最大を重ねる
//
// **なぜ待つのか。** 検出はライブの合成波形しか受けないので、ホストを起動し直すと引き金は空から作られ、
// 60 秒の助走の間は揺れを拾わない（`quakeTrigger.ts` の `warmupSec`）。止まっていた間の波形は基板から
// 取り戻せて（`backlogFetcher.ts`）、合成波形も作り直されて控えへ入る（`rewaveRunner.ts`・実機で起動から
// 2〜13 秒）。それを待ってから時刻順に流せば、途切れが無くなり、平常時の強さもそのまま続く。
// **待つのは最長 60 秒** —— 今の助走と同じ長さなので、電子レンジの干渉などで片付かなくても今より遅くはならない。
//
// **引き金の続きと 24 時間の最大を分ける。** 24 時間ぶんを流すと 1 観測点あたり 5〜7 秒かかる
// （手元の機械で 1 時間 200〜280 ms を実測）。その前に全部を流すと検出の始まりがそのぶん遅れるので、
// 見張りの続きに要る最後の 10 分（平常時の強さの時定数は 60 秒）だけを先に流し、24 時間の最大は裏で戻す。
//
// **前のプロセスの最後のサンプルを境にする**（2026-10-13 ユーザー承認）。境より前に始まった揺れは記録しない ——
// 前のプロセスが見ていた区間で、取りこぼしは `redetect.ts` が起こす。境より後（止まっていた間）に始まった揺れは
// 記録する。同じ id の記録が既にあれば書かない（#618 と同じ。`stationDetection.ts` の `exists`）。
//
// **投げない。** 控えを読めない・途中で例外が出たときは、溜めた分を空の検出器へ流して今までと同じ形へ戻し、
// 記録の口で知らせる。

import { STEP_SEC_DEFAULT } from '../../../src/utils/knet/intensityCommon'
import { jstHourStartMs } from '../receiver/jstTime'
import { ChunkIntensity } from './chunkIntensity'
import { TriggerDetector } from './quakeTrigger'
import { archiveChunks, emptyArchiveReadTally } from './redetect'
import type { ArchiveReadTally, HourReader } from './redetect'
import type { StationDetection } from './stationDetection'

/** 観測点の最初の波形から、片付いていても待つ長さ。欠けは最初のパケットで帳面へ載るが、合成波形はその後に出る。 */
export const WARM_MIN_HOLD_MS = 5_000
/** 片付かなくても待ちを解く長さ（引き金の助走 `warmupSec` と同じ）。 */
export const WARM_MAX_HOLD_MS = 60_000
/** 引き金の続きのために流す、前のプロセスの末尾の長さ（平常時の強さの時定数 60 秒に余裕を見る）。 */
export const WARM_TAIL_MS = 10 * 60_000
/** 比の最大を戻す範囲（`quakeTrigger.ts` が覚える 24 時間）。 */
export const WARM_PEAK_LOOKBACK_MS = 24 * 3_600_000
/** これだけ流すごとにイベントループへ譲る（受信を止めないため）。 */
const YIELD_EVERY_CHUNKS = 500

const HOUR_MS = 3_600_000

/** 前のプロセスの最後のサンプルを探した結果（{@link findBoundary}）。 */
export type BoundaryResult =
  | { readonly kind: 'found'; readonly boundaryMs: number }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly error: string }

/**
 * 前のプロセスがライブで受けた最後のサンプルの末尾（データの時刻）。`beforeMs`（起動してから届いた最初のライブの
 * 時刻）より前の、**作り直した印の無い**まとまりの末尾の最大を、新しい時から 1 時間ずつ遡って探す。
 *
 * - **作り直した分は数えない** —— 欠けを埋めた分は前のプロセスの検出が見ていない（境を後ろへずらすと、
 *   止まっていた間の揺れを記録しなくなる）
 * - 見つかった時で止める（それより古い時に、より新しいライブの分は無い）
 * - 開けない時に当たったら `failed`（その時に最後の分があったかを確かめられない）
 */
export async function findBoundary(readHour: HourReader, beforeMs: number, lookbackMs: number): Promise<BoundaryResult> {
  const last = jstHourStartMs(beforeMs)
  const first = jstHourStartMs(beforeMs - lookbackMs)
  if (last === null || first === null) return { kind: 'failed', error: `時刻を時の頭へ丸められない: ${beforeMs}` }
  for (let h = last; h >= first; h -= HOUR_MS) {
    const r = await readHour(h)
    if (r.kind === 'missing') continue
    if (r.kind === 'failed') return { kind: 'failed', error: r.error }
    let best = Number.NEGATIVE_INFINITY
    for (const c of r.chunks) {
      if (c.revised || c.firstSampleMs >= beforeMs) continue
      best = Math.max(best, c.firstSampleMs + c.gal[0].length * c.msPerSample)
    }
    if (best > beforeMs - lookbackMs) return { kind: 'found', boundaryMs: Math.min(best, beforeMs) }
  }
  return { kind: 'none' }
}

/** 流し込みの相手（`StationDetection` の起動時の口だけ）。 */
export type WarmStartTarget = Pick<
  StationDetection,
  'heldStations' | 'beginWarm' | 'setRecordFloor' | 'pushWarmChunk' | 'noteWarmIntensity' | 'finishWarm' | 'mergePeaks' | 'notePeaks'
>

export interface WarmStarterOptions {
  readonly detection: WarmStartTarget
  /** 観測点の控えの読み手（`redetect.ts` の `archiveHourReader`）。 */
  readonly readHour: (stationId: string) => HourReader
  /** 取り戻し待ちの欠け・作り直し待ち・作り直し中がどれも無いか。 */
  readonly settled: () => boolean
  /** ホストの時計。 */
  readonly now: () => number
  /** イベントループへ譲る。 */
  readonly pause: () => Promise<void>
  readonly log: (level: 'log' | 'warn' | 'error', key: string, line: string) => void
}

interface PeakJob {
  readonly stationId: string
  readonly fromMs: number
  readonly toMs: number
  readonly openHourFromMs: number | undefined
}

/** 回している 1 件の打ち切りの印（止めた・時間切れになった）。 */
interface JobToken {
  cancelled: boolean
}

/**
 * 1 件の流し込みの上限（ホストの時計・ミリ秒）。手元の機械で、24 時間ぶんの控えを流して 7.9 秒・末尾の 10 分は
 * 1 秒弱だった。控えの読みが返らない（ディスクが詰まった等）と、1 件が回し役を握ったまま他の観測点も
 * 24 時間の最大も回らなくなるので、これを超えたら打ち切って次へ進む。
 */
export const WARM_JOB_TIMEOUT_MS = 120_000

/** 流した控えの中・溜めたライブとの継ぎ目にこれを超える途切れがあれば、見張りはそこで助走からやり直している（`maxGapMs`）。 */
const LIVE_SEAM_GAP_MS = 1_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 読めなかった時・打ち切った時があれば、その様子を添える文。 */
function tallyNote(t: ArchiveReadTally): string {
  const notes: string[] = []
  if (t.hoursFailed > 0) notes.push(`開けなかった時 ${t.hoursFailed}（${t.lastFailure ?? ''}）`)
  if (t.hoursTruncated > 0) notes.push(`途中で打ち切って読んだ時 ${t.hoursTruncated}`)
  return notes.length === 0 ? '' : `・${notes.join('・')}`
}

/** 時刻を ISO で。壊れた値でも投げない（記録の口から例外を出さないため）。 */
function isoOf(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms)
}

/**
 * 起動時の流し込みを回す係。`tick()` を定期的に呼ぶ（1 秒ごと）。**1 度に 1 件だけ回す**（観測点の流し込みを
 * 先に、24 時間の最大は後に）。1 件は {@link WARM_JOB_TIMEOUT_MS} で打ち切る。投げない。
 *
 * **記録の鍵は結末で分ける**（`warm-ok:`・`warm-cold:`・`warm-fail:`・`warm-peaks:`）。呼び出し側は鍵ごとに間引くので、
 * 1 つにすると成功の行が枠を使い、同じ観測点の失敗の行が抑えられる。
 */
export class WarmStarter {
  private readonly opts: WarmStarterOptions
  private current: Promise<void> | null = null
  private stopped = false
  private readonly peakJobs: PeakJob[] = []
  private settledFailureLogged = false
  /** 回している 1 件を待たずに手放す口（止めるとき、詰まった読みの時間切れまで締めくくりを待たせないため）。 */
  private releaseCurrent: (() => void) | null = null

  constructor(options: WarmStarterOptions) {
    this.opts = options
  }

  tick(): void {
    if (this.stopped || this.current !== null) return
    const now = this.opts.now()
    let settled: boolean | null = null
    for (const h of this.opts.detection.heldStations()) {
      const waitedMs = now - h.heldSinceMs
      if (waitedMs < WARM_MIN_HOLD_MS) continue
      if (waitedMs < WARM_MAX_HOLD_MS) {
        settled ??= this.isSettled()
        if (!settled) continue
      }
      const settledNow = settled ?? false
      this.start(
        (token) => this.runWarm(h.stationId, h.firstSampleMs, waitedMs, settledNow, token),
        () => this.onWarmTimeout(h.stationId),
        `warm-fail:${h.stationId}`,
      )
      return
    }
    const job = this.peakJobs.shift()
    if (job !== undefined) {
      this.start(
        (token) => this.runPeaks(job, token),
        () => this.onPeaksTimeout(job.stationId),
        `warm-peaks:${job.stationId}`,
      )
    }
  }

  /** 回せるものが無くなるまで回し、終わるのを待つ（テストと締めくくりのため）。 */
  async idle(): Promise<void> {
    for (;;) {
      if (this.current === null) this.tick()
      if (this.current === null) return
      await this.current
    }
  }

  /**
   * 止める。回している 1 件は待たずに手放す（流し込み中なら `finishWarm` を呼ばずに降り、締めくくりの `flushAll` が
   * 溜めた分を流す）。**詰まった控えの読みを待たない** —— 待つと、時間切れ（2 分）まで締めくくり全体が止まる。
   * 裏に残った仕事は印（`stopped`）と流し込みの段階の確かめで、後から検出を書き換えない。
   */
  async stop(): Promise<void> {
    this.stopped = true
    this.releaseCurrent?.()
    if (this.current !== null) await this.current
  }

  /**
   * 1 件を回す。**例外は受け止めて記録する**（`tick` は戻り値を待たないので、ここで受けないと誰にも拾われない）。
   * 時間切れになったら印を立てて回し役を手放す（回していた側は次の区切りで降りる）。
   */
  private start(run: (token: JobToken) => Promise<void>, onTimeout: () => void, failKey: string): void {
    const token: JobToken = { cancelled: false }
    let timer: ReturnType<typeof setTimeout> | null = null
    const body = run(token).catch((error: unknown) => {
      this.safeLog('error', failKey, `[detect] 起動時の流し込みで例外を受け止めた: ${messageOf(error)}`)
    })
    const timeout = new Promise<void>((resolve) => {
      this.releaseCurrent = () => {
        token.cancelled = true
        resolve()
      }
      timer = setTimeout(() => {
        if (token.cancelled) {
          resolve()
          return
        }
        token.cancelled = true
        try {
          onTimeout()
        } catch (error) {
          this.safeLog('error', failKey, `[detect] 起動時の流し込みの時間切れの後始末で例外を受け止めた: ${messageOf(error)}`)
        }
        resolve()
      }, WARM_JOB_TIMEOUT_MS)
      // 時間切れの見張りだけでプロセスを生かしておかない（締めくくりを待たせない）。
      ;(timer as { unref?: () => void }).unref?.()
    })
    this.current = Promise.race([body, timeout]).finally(() => {
      if (timer !== null) clearTimeout(timer)
      token.cancelled = true
      this.releaseCurrent = null
      this.current = null
    })
  }

  private onWarmTimeout(stationId: string): void {
    const secs = WARM_JOB_TIMEOUT_MS / 1000
    if (!this.opts.detection.finishWarm(stationId, { kind: 'cold', reason: 'timed-out', detail: `${secs} 秒` })) {
      this.noteAbandoned(stationId, `${secs} 秒の時間切れより前`)
      return
    }
    this.safeLog('error', `warm-fail:${stationId}`, `[detect] ${stationId} 起動時の流し込みが ${secs} 秒で終わらず、ここから空の見張りへ切り替えた`)
  }

  private onPeaksTimeout(stationId: string): void {
    this.safeLog('warn', `warm-peaks:${stationId}`, `[detect] ${stationId} 比の 24 時間の最大を ${WARM_JOB_TIMEOUT_MS / 1000} 秒で戻しきれず、戻すのをやめた`)
    this.opts.detection.notePeaks(stationId, 'failed')
  }

  private isSettled(): boolean {
    try {
      return this.opts.settled()
    } catch (error) {
      // 投げ続けても待ちは最長 60 秒で解けるが、黙ると「片付くのを待っていない」ことに気づけない。1 度だけ出す。
      if (!this.settledFailureLogged) {
        this.settledFailureLogged = true
        this.safeLog('warn', 'warm-settled', `[detect] 起動時の待ちで、取り戻し・作り直しの様子を読めなかった（最長 60 秒待つ）: ${messageOf(error)}`)
      }
      return false
    }
  }

  /** 記録の口が投げても止まらない。 */
  private safeLog(level: 'log' | 'warn' | 'error', key: string, line: string): void {
    try {
      this.opts.log(level, key, line)
    } catch {
      // 記録の口そのものが壊れているなら、出す先が無い。
    }
  }

  /** 流し込みを空の見張りで終える。既に終わっていた（打ち切られていた）ら、そのことを残す。 */
  private finishCold(
    stationId: string,
    reason: 'no-archive' | 'read-failed' | 'failed',
    detail: string | null,
    level: 'log' | 'warn' | 'error',
    line: string,
  ): void {
    this.safeLog(level, `${level === 'log' ? 'warm-cold' : 'warm-fail'}:${stationId}`, line)
    if (!this.opts.detection.finishWarm(stationId, { kind: 'cold', reason, detail })) this.noteAbandoned(stationId, '結末を残す前')
  }

  /** 流し込み中でなくなっていた（溜めた分が上限を超えた・観測点を設定から外した・時間切れ）ことを残す。 */
  private noteAbandoned(stationId: string, where: string): void {
    this.safeLog(
      'warn',
      `warm-fail:${stationId}`,
      `[detect] ${stationId} 起動時の流し込みは${where}に打ち切られていた（溜めた分の上限・設定の変更・時間切れのどれか）`,
    )
  }

  private async runWarm(stationId: string, firstSampleMs: number, waitedMs: number, settled: boolean, token: JobToken): Promise<void> {
    const d = this.opts.detection
    if (!d.beginWarm(stationId)) return
    const readHour = this.opts.readHour(stationId)
    const head = `[detect] ${stationId}`
    const aborted = (): boolean => this.stopped || token.cancelled
    try {
      const boundary = await findBoundary(readHour, firstSampleMs, WARM_PEAK_LOOKBACK_MS)
      if (aborted()) return
      if (boundary.kind === 'failed') {
        this.finishCold(stationId, 'read-failed', boundary.error, 'warn', `${head} 起動時に控えを読めず、空から見張りを始める（助走 60 秒）: ${boundary.error}`)
        return
      }
      if (boundary.kind === 'none') {
        this.finishCold(stationId, 'no-archive', null, 'log', `${head} 控えの 24 時間に前の波形が無いので、空から見張りを始める（助走 60 秒）`)
        return
      }
      const boundaryMs = boundary.boundaryMs
      d.setRecordFloor(stationId, boundaryMs)
      const openHourFromMs = jstHourStartMs(firstSampleMs) ?? undefined
      const tally = emptyArchiveReadTally()
      // 境より後（止まっていた間）の揺れの最大計測震度相当のため。境より前の揺れは記録しないので要らない。
      const intensity = new ChunkIntensity({
        stepSec: STEP_SEC_DEFAULT,
        onPoint: (atMs, value) => {
          if (atMs >= boundaryMs) d.noteWarmIntensity(stationId, atMs, value)
        },
      })
      let pushed = 0
      let firstReplayedMs: number | null = null
      let lastEndMs: number | null = null
      let longestGapMs = 0
      for await (const c of archiveChunks({ readHour, fromMs: boundaryMs - WARM_TAIL_MS, toMs: firstSampleMs, tally, openHourFromMs })) {
        if (aborted()) return
        const endMs = c.firstSampleMs + c.gal[0].length * c.msPerSample
        // **溜めたライブと重ねない。** 作り直しの余白（`rewaveScheduler.ts` の `padMs`）は最初のライブの後ろへ
        // はみ出すので、それを含むまとまりは流さない（その後ろの数百ミリ秒は引き金の途切れの許容 1 秒に収まる）。
        if (endMs > firstSampleMs + c.msPerSample / 2) continue
        intensity.push(c)
        if (!d.pushWarmChunk(stationId, c)) {
          this.noteAbandoned(stationId, `控えを ${pushed} まとまり流したところで`)
          return
        }
        firstReplayedMs ??= c.firstSampleMs
        if (lastEndMs !== null) longestGapMs = Math.max(longestGapMs, c.firstSampleMs - lastEndMs)
        lastEndMs = endMs
        if (++pushed % YIELD_EVERY_CHUNKS === 0) await this.opts.pause()
      }
      if (aborted()) return
      if (lastEndMs === null || firstReplayedMs === null) {
        this.finishCold(
          stationId,
          'no-archive',
          '末尾の 10 分に流せるまとまりが無い',
          'warn',
          `${head} 控えの末尾に流せる波形が無く、空から見張りを始める（助走 60 秒）${tallyNote(tally)}`,
        )
        return
      }
      longestGapMs = Math.max(longestGapMs, firstSampleMs - lastEndMs)
      const outcome = { kind: 'warm' as const, hoursFailed: tally.hoursFailed, hoursTruncated: tally.hoursTruncated, longestGapMs }
      if (!d.finishWarm(stationId, outcome)) {
        this.noteAbandoned(stationId, '溜めたライブへ繋ぐ前')
        return
      }
      // **穴や読めなかった時が残ったら、引き継いだと言い切らない**（警告で出し、結末にも内訳を残す）。
      const seamBroken = longestGapMs > LIVE_SEAM_GAP_MS
      const incomplete = tally.hoursFailed > 0 || tally.hoursTruncated > 0 || seamBroken
      const tailSec = Math.round((firstSampleMs - firstReplayedMs) / 1000)
      this.safeLog(
        incomplete ? 'warn' : 'log',
        `${incomplete ? 'warm-fail' : 'warm-ok'}:${stationId}`,
        `${head} 起動前の波形を控えから流して見張りを引き継いだ（${tailSec} 秒ぶん・${pushed} まとまり・` +
          `待ち ${(waitedMs / 1000).toFixed(0)} 秒${settled ? '' : '（取り戻し・作り直しが片付く前に解いた）'}・前の最後のサンプル ${isoOf(boundaryMs)}` +
          `${seamBroken ? `・途切れが残った（最長 ${(longestGapMs / 1000).toFixed(1)} 秒。そこから助走をやり直す）` : ''}` +
          `${intensity.failures > 0 ? `・計測震度相当を出せなかった区間 ${intensity.failures}` : ''}${tallyNote(tally)}）`,
      )
      this.peakJobs.push({ stationId, fromMs: firstSampleMs - WARM_PEAK_LOOKBACK_MS, toMs: boundaryMs, openHourFromMs })
    } catch (error) {
      // 打ち切った後の例外は、結末を既に残してある（時間切れ・締めくくり）ので黙って降りる。
      if (aborted()) return
      const message = messageOf(error)
      this.finishCold(stationId, 'failed', message, 'error', `${head} 起動時の流し込みの途中で失敗し、ここから空の見張りへ切り替える: ${message}`)
    }
  }

  private async runPeaks(job: PeakJob, token: JobToken): Promise<void> {
    const d = this.opts.detection
    const key = `warm-peaks:${job.stationId}`
    const head = `[detect] ${job.stationId}`
    const trigger = new TriggerDetector()
    const tally = emptyArchiveReadTally()
    try {
      let n = 0
      for await (const c of archiveChunks({
        readHour: this.opts.readHour(job.stationId),
        fromMs: job.fromMs,
        toMs: job.toMs,
        tally,
        openHourFromMs: job.openHourFromMs,
      })) {
        if (this.stopped || token.cancelled) return
        trigger.push(c)
        if (++n % YIELD_EVERY_CHUNKS === 0) await this.opts.pause()
      }
    } catch (error) {
      // 打ち切った後の例外は、結末を既に残してあるので黙って降りる（同じ鍵で二重に出さない）。
      if (this.stopped || token.cancelled) return
      this.safeLog('warn', key, `${head} 比の 24 時間の最大を控えから戻せなかった: ${messageOf(error)}`)
      d.notePeaks(job.stationId, 'failed')
      return
    }
    if (this.stopped || token.cancelled) return
    // **開けなかった・途中で打ち切った時があれば、戻せたのは一部**（`partial`）。ファイルの無い時は記録が無いだけ。
    const complete = tally.hoursFailed === 0 && tally.hoursTruncated === 0
    if (!d.mergePeaks(job.stationId, trigger, complete)) {
      this.safeLog('warn', key, `${head} 比の 24 時間の最大を戻す先の検出器が無かった（観測点を設定から外した等）`)
      return
    }
    this.safeLog(
      complete ? 'log' : 'warn',
      key,
      `${head} 比の 24 時間の最大を控えから戻した（${tally.chunks} まとまり${complete ? '' : '・一部の時を除いて'}${tallyNote(tally)}）`,
    )
  }
}
