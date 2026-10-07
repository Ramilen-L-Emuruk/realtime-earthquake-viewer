// 保存してある観測点の合成波形を、いまの検出へ流し直して揺れの記録を起こす（#618）。
//
//   控えの波形 ──→ 計測震度相当（IntensityStream）──┐
//              └─→ 検出（QuakeDetector）──→ 揺れ ──→ 帳面（ShakeEventBook）──→ 版を書く
//                                                        ↑
//                                          その期間の地震情報（先に取っておく）
//
// **部品はライブと同じものを使う**（`stationDetection.ts`・`sensorFusion.ts`）。流し直しで起こした記録と
// ライブで書いた記録は同じ形になる —— 出どころの印は持たせない（2026-10-07 ユーザー承認）。
//
// **時計は 2 つに分ける。** 照合の期限（15 分）と覚えておく長さは「流している波形の時刻」で進める
// （壁時計で測ると、何日分を流しても期限が来ない）。書いた時刻（`writtenAtMs`）だけは実際に書いた時刻。
//
// **観測点の位置とセンサーの顔ぶれは、その時刻に効いていた設定から引く**（`observerAt`・`sensorsAt`）。
// いまの設定で過去を照らすと、移設の前の揺れを移設後の位置で照合してしまう。
//
// **既に記録がある揺れは、版を 1 つも書かない。** ライブで書いた記録（照合の結果を含む）を優先する。
//
// **投げない**（1 件の失敗で流し直し全体を止めない）。数えて `finish()` で返す。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { STEP_SEC_DEFAULT } from '../../../src/utils/knet/intensityCommon'
import { IntensityStream } from '../intensity/intensityStream'
import { normalizeIntensity } from '../receiver/intensityPipeline'
import { jstHour, jstHourStartMs } from '../receiver/jstTime'
import { decodeWaveFile, resolveRevisions, waveFileName } from '../receiver/waveArchive'
import type { ArchivedWaveChunk } from '../receiver/waveArchive'
import type { P2pReferenceQuake } from './p2pQuake'
import { DETECTOR_VERSION, QuakeDetector } from './quakeDetector'
import type { DetectedShake } from './quakeDetector'
import type { ObserverPoint } from './quakeMatch'
import type { ShakeEventRecord, ShakeSensorRef, ShakeVerdict } from './shakeEvent'
import { MATCH_DEADLINE_MS, ShakeEventBook } from './shakeEventBook'

/** 流し直す 1 まとまり（`ArchivedWaveChunk` の一部。gal は直流を引いた変動分）。 */
export interface RedetectChunk {
  readonly firstSampleMs: number
  readonly msPerSample: number
  readonly gal: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>]
}

export interface RedetectorOptions {
  readonly stationId: string
  /** その時刻の観測点の位置。無ければ照合できない（揺れは揺れ方で決めるか `unchecked`）。 */
  readonly observerAt: (atMs: number) => ObserverPoint | null
  /** その時刻に観測点へ割り当てられていた、有効なセンサー（記録へ残す）。 */
  readonly sensorsAt: (atMs: number) => readonly ShakeSensorRef[]
  /** その期間の地震情報（先に取っておく）。 */
  readonly quakes: readonly P2pReferenceQuake[]
  /** 地震情報を `[fromMs, toMs]` の間ぶん漏れなく取れているか。取れていない範囲の合わない揺れは `unchecked`。 */
  readonly quakesCovered: (fromMs: number, toMs: number) => boolean
  /** その揺れの記録が既にあるか（あれば書かない）。 */
  readonly exists: (rec: Pick<ShakeEventRecord, 'id' | 'startMs'>) => boolean
  /**
   * これより前に始まった揺れは記録しない（助走のために範囲の頭より前から流すので）。
   * 省けば、流したぶんすべてを記録する。
   */
  readonly recordFromMs?: number
  /** 版を書く。書けたかを返す。 */
  readonly save: (rec: ShakeEventRecord) => boolean
  /** 実際に書いた時刻（`writtenAtMs`）。 */
  readonly wallNow: () => number
  /** 計測震度相当を出す間隔（秒）。省けばライブと同じ。 */
  readonly stepSec?: number
}

export interface RedetectSummary {
  /** 切れた揺れの数（既に記録があったものを含む）。 */
  readonly shakes: number
  /** 版を 1 つ以上書けた揺れの数。 */
  readonly written: number
  /** 既に記録があったので書かなかった揺れの数。 */
  readonly skippedExisting: number
  /** 助走の間（範囲の頭より前）に始まったので記録しなかった揺れの数。 */
  readonly beforeRange: number
  /** 書けなかった版の数。 */
  readonly saveFailures: number
  /** 書いた揺れの、最後の判定ごとの数。 */
  readonly verdicts: Readonly<Partial<Record<ShakeVerdict, number>>>
  /** 波形の途切れなどで、引き金を作り直した回数。 */
  readonly resets: number
  /** 刻みが読めず捨てたまとまりの数。 */
  readonly droppedChunks: number
  /** 計測震度相当を出せなかった区間の数（流し込みが投げた）。 */
  readonly intensityFailures: number
  /** 検出・照合の途中で受け止めた想定外の例外の数（その回の揺れ・まとまりは記録できていない）。 */
  readonly failures: number
  /** 直近の想定外の例外の文面。 */
  readonly lastFailure: string | null
}

const HOUR_MS = 3_600_000

/** 1 時間ぶんのファイルを読んだ結果。 */
export type HourRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'read'; readonly chunks: readonly ArchivedWaveChunk[]; readonly skippedBytes: number }

/** その時（`hourStartMs`）のファイルを読む（差し替えはテストのため）。 */
export type HourReader = (hourStartMs: number) => Promise<HourRead>

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 控えの置き場所から、その観測点のその時のファイルを読む（`waveArchive.ts` の形のまま）。 */
export function archiveHourReader(dir: string, stationId: string): HourReader {
  return async (hourStartMs) => {
    const key = jstHour(hourStartMs)
    if (key === null) return { kind: 'failed', error: `時刻を時の鍵にできない: ${hourStartMs}` }
    let buf: Buffer
    try {
      buf = await readFile(join(dir, waveFileName(stationId, key)))
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return { kind: 'missing' }
      return { kind: 'failed', error: messageOf(error) }
    }
    const decoded = decodeWaveFile(buf, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
    return { kind: 'read', chunks: decoded.chunks, skippedBytes: decoded.skippedBytes }
  }
}

/** 控えを読んだ様子（`archiveChunks` が数える）。 */
export interface ArchiveReadTally {
  /** 読もうとした時の数。 */
  hours: number
  /** ファイルが無かった時の数（記録されていない時間。ホストが止まっていた等）。 */
  hoursMissing: number
  /** ファイルを開けなかった時の数。 */
  hoursFailed: number
  /**
   * ファイルを途中で打ち切って読んだ時の数（頭の目印が合わない・知らない版・末尾が 1 まとまりに満たない）。
   * **いま書いている時のファイルは除く**（末尾が書きかけなのは普通）。
   */
  hoursTruncated: number
  /** 打ち切って読まなかったバイト数の合計（いま書いている時を除く）。 */
  skippedBytes: number
  /** 流したまとまりの数。 */
  chunks: number
  /** 前のまとまりと重なって捨てたまとまりの数（同じ区間が控えへ 2 度入っている分）。 */
  overlapped: number
  /** 直近の開けなかった理由。 */
  lastFailure: string | null
}

export function emptyArchiveReadTally(): ArchiveReadTally {
  return {
    hours: 0,
    hoursMissing: 0,
    hoursFailed: 0,
    hoursTruncated: 0,
    skippedBytes: 0,
    chunks: 0,
    overlapped: 0,
    lastFailure: null,
  }
}

/**
 * 控えから `[fromMs, toMs]` に掛かるまとまりを、時刻順に重なりなく出す。
 *
 * **1 時間ずつ、その時のファイルだけを開く。** まとまりは頭が属する時のファイルへ丸ごと入るので、こう読めば
 * 各まとまりは 1 度だけ現れ、ファイルごとに「無かった・開けなかった・途中で打ち切った」を正確に数えられる。
 * それでも前のまとまりの末尾より前に始まるもの（同じ区間が 2 度書かれた分）は捨てる —— 重ねて流すと、
 * 検出器が時刻の巻き戻りとして引き金を作り直す。
 *
 * `openHourFromMs` 以降の時は「いま書いている」とみなし、末尾の打ち切りを数えない。
 */
export async function* archiveChunks(params: {
  readonly readHour: HourReader
  readonly fromMs: number
  readonly toMs: number
  readonly tally: ArchiveReadTally
  readonly openHourFromMs?: number
}): AsyncGenerator<RedetectChunk> {
  const { readHour, fromMs, toMs, tally } = params
  const first = jstHourStartMs(fromMs)
  if (first === null || !(toMs >= fromMs)) return
  let lastEndMs = Number.NEGATIVE_INFINITY
  for (let h = first; h <= toMs; h += HOUR_MS) {
    tally.hours++
    const r = await readHour(h)
    if (r.kind === 'missing') {
      tally.hoursMissing++
      continue
    }
    if (r.kind === 'failed') {
      tally.hoursFailed++
      tally.lastFailure = r.error
      continue
    }
    const open = params.openHourFromMs !== undefined && h >= params.openHourFromMs
    if (r.skippedBytes > 0 && !open) {
      tally.hoursTruncated++
      tally.skippedBytes += r.skippedBytes
    }
    // **作り直した分をライブの分より優先する**（控えの読み返しと同じ解き方。`resolveRevisions` は
    // 書いた順＝ファイルの順で渡す）。その後で並べ直す（同じ区間が後から書き足された分がファイルの後ろにいる）。
    // 時ごとに解いて足りるのは、合成のまとまりが時の境目をまたがないから（目盛りの 300 ms が 1 時間を割り切る。
    // `sensorFusion.ts` の STATION_GRID_MS × STATION_CHUNK_POINTS）。これを変えるなら、時をまたいで集めてから解くこと。
    const sorted = resolveRevisions(r.chunks).sort((a, b) => a.firstSampleMs - b.firstSampleMs)
    for (const c of sorted) {
      const endMs = c.firstSampleMs + c.gal[0].length * c.msPerSample
      if (endMs <= fromMs || c.firstSampleMs > toMs) continue
      if (c.firstSampleMs < lastEndMs - c.msPerSample / 2) {
        tally.overlapped++
        continue
      }
      lastEndMs = endMs
      tally.chunks++
      yield c
    }
  }
}

/** 計測震度相当の流し込みを続けてよい、前のまとまりの末尾からのずれ（刻みに対する割合）。 */
const CONTINUOUS_TOLERANCE = 0.5
/** 刻みが変わったとみなす割合。 */
const RATE_TOLERANCE = 0.05

interface IntensityRun {
  readonly stream: IntensityStream
  readonly msPerSample: number
  /** 流し込んだサンプルの数（次のまとまりの位置）。 */
  pushed: number
  /** 次に来るはずのサンプルの時刻。 */
  nextMs: number
}

export class Redetector {
  private readonly opts: RedetectorOptions
  private readonly detector = new QuakeDetector()
  private readonly book: ShakeEventBook
  /** 流している波形の時刻（帳面の時計）。 */
  private clockMs = Number.NEGATIVE_INFINITY
  private run: IntensityRun | null = null
  private shakes = 0
  private beforeRange = 0
  private saveFailures = 0
  private intensityFailures = 0
  private failures = 0
  private lastFailure: string | null = null
  private readonly skipped = new Set<string>()
  private readonly written = new Set<string>()
  private readonly latest = new Map<string, ShakeEventRecord>()

  constructor(options: RedetectorOptions) {
    this.opts = options
    this.book = new ShakeEventBook({
      save: (rec) => this.emit(rec),
      publish: () => {},
      // 帳面は観測点の位置を時刻なしで訊くので、流している波形の時刻で引く（揺れが閉じた直後・照合の時点）。
      observerOf: () => options.observerAt(this.clockMs),
      feedCovered: options.quakesCovered,
      now: () => this.clockMs,
      detectorVersion: DETECTOR_VERSION,
    })
    this.guard('照合の準備', () => {
      for (const q of options.quakes) this.book.addQuake(q)
    })
  }

  /** 1 まとまり流す。**時刻順に渡すこと**（ライブの検出と同じ前提）。 */
  push(chunk: RedetectChunk): void {
    const n = chunk.gal[0].length
    if (n === 0) return
    const endMs = chunk.firstSampleMs + n * chunk.msPerSample
    if (endMs > this.clockMs) this.clockMs = endMs
    // **計測震度相当を先に覚える** —— 揺れを記録するとき、その区間の最大を引くので。
    this.noteIntensity(chunk)
    const closed = this.guard('検出', () => this.detector.push(chunk)) ?? []
    for (const shake of closed) this.record(shake)
    this.guard('照合の期限', () => this.book.tick())
  }

  /** 流し終える。開いている揺れを閉じ、照合の期限まで進めて、すべての揺れの判定を決める。 */
  finish(): RedetectSummary {
    const closed = this.guard('検出の締めくくり', () => this.detector.flush()) ?? []
    for (const shake of closed) this.record(shake)
    // 期限まで波形が無くても、照合待ちのまま残さない。
    if (Number.isFinite(this.clockMs)) this.clockMs += MATCH_DEADLINE_MS
    this.guard('照合の期限', () => this.book.tick())
    const verdicts: Partial<Record<ShakeVerdict, number>> = {}
    for (const rec of this.latest.values()) verdicts[rec.verdict] = (verdicts[rec.verdict] ?? 0) + 1
    return {
      shakes: this.shakes,
      written: this.written.size,
      skippedExisting: this.skipped.size,
      beforeRange: this.beforeRange,
      saveFailures: this.saveFailures,
      verdicts,
      resets: this.detector.resets,
      droppedChunks: this.detector.droppedChunks,
      intensityFailures: this.intensityFailures,
      failures: this.failures,
      lastFailure: this.lastFailure,
    }
  }

  /** 投げない契約を守る。受け止めた例外は数えて `finish()` で返す。 */
  private guard<T>(where: string, fn: () => T): T | null {
    try {
      return fn()
    } catch (error) {
      this.failures++
      this.lastFailure = `${where}: ${messageOf(error)}`
      return null
    }
  }

  private record(shake: DetectedShake): void {
    this.shakes++
    if (this.opts.recordFromMs !== undefined && shake.trigger.onMs < this.opts.recordFromMs) {
      this.beforeRange++
      return
    }
    this.guard('記録', () => this.book.addShake(this.opts.stationId, shake, this.opts.sensorsAt(shake.trigger.onMs)))
  }

  private emit(rec: ShakeEventRecord): void {
    if (this.skipped.has(rec.id)) return
    if (rec.rev === 1 && this.opts.exists(rec)) {
      this.skipped.add(rec.id)
      return
    }
    const out: ShakeEventRecord = { ...rec, writtenAtMs: this.opts.wallNow() }
    if (this.opts.save(out)) {
      this.written.add(rec.id)
      this.latest.set(rec.id, out)
    } else {
      this.saveFailures++
    }
  }

  /**
   * 合成波形から計測震度相当を出して帳面へ覚えさせる（`sensorFusion.ts` と同じ部品・同じ時刻の戻し方）。
   * **途切れたら流し込みを作り直す** —— 位置を詰めて繋ぐと、届いていない時間を挟んだ窓で値を出す。
   */
  private noteIntensity(chunk: RedetectChunk): void {
    let run = this.run
    const continuous =
      run !== null &&
      Math.abs(chunk.msPerSample - run.msPerSample) <= run.msPerSample * RATE_TOLERANCE &&
      Math.abs(chunk.firstSampleMs - run.nextMs) <= run.msPerSample * CONTINUOUS_TOLERANCE
    if (!continuous) {
      try {
        run = {
          stream: new IntensityStream({ sampleRateHz: 1000 / chunk.msPerSample, stepSec: this.opts.stepSec ?? STEP_SEC_DEFAULT }),
          msPerSample: chunk.msPerSample,
          pushed: 0,
          nextMs: chunk.firstSampleMs,
        }
      } catch {
        // 作れないのは刻みがおかしいときだけ。その区間の計測震度相当は出さない（検出は続ける）。
        this.intensityFailures++
        this.run = null
        return
      }
      this.run = run
    }
    if (run === null) return
    const n = chunk.gal[0].length
    const firstIndex = run.pushed
    try {
      const points = run.stream.push(firstIndex, Array.from(chunk.gal[0]), Array.from(chunk.gal[1]), Array.from(chunk.gal[2]))
      for (const p of points) {
        const intensity = normalizeIntensity(p.intensity).value
        const atMs = chunk.firstSampleMs + (p.endSampleIndex - firstIndex) * chunk.msPerSample
        this.book.noteStationReading(this.opts.stationId, atMs, intensity)
      }
    } catch {
      this.intensityFailures++
      this.run = null
      return
    }
    run.pushed += n
    run.nextMs = chunk.firstSampleMs + n * chunk.msPerSample
  }
}
