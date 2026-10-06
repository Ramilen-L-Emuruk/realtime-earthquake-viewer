// 生データを miniSEED 3 で、日本時間の 1 時間ごとに 1 本へ残す。
//
// 置き場所は `<dir>/<日>/raw-<日>T<時>.mseed3`。中身は届いた順に足したレコード —— 波形（Steim2）と
// 受信の記録（テキストの `LOG` チャンネル）が混ざって並ぶ。**1 本で完結させる**:
// 「12 時台を見たい」ときに 12 時の 1 本だけ読めば、波形もパケットの区切りも読めなかった
// パケットも揃う。
//
// **どの時へ入れるかは呼び出し側が決める**（`fileTimeOf`。波形の時刻）。取り戻した分は過ぎた時の
// 本を開き直して足す。
//
// **消さない・上書きしない。** 既にある本へは追記する。
//
// **落ちない。** 保存が止まっても震度は出し続ける。ただし黙らない —— 失った件数と
// 流し口の異常を、呼び出し側が数えられる形で持つ（`waveArchive.ts` と同じ分担）。
//
// **既知の限界: `fsync` は掛けていない**（`waveArchive.ts` と同じ）。

import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Writable } from 'node:stream'

import { jstHour } from './jstTime'

/** 抱えたまま書き出せていない量の上限（本ごと）。**超えたら捨てる。** */
const MAX_PENDING_BYTES_DEFAULT = 8 * 1024 * 1024
/** 流し口が壊れてから開き直すまで。**毎回開き直すと、詰まったディスクを叩き続ける。** */
const REOPEN_INTERVAL_MS_DEFAULT = 5_000
/** `close()` 全体に掛ける上限。 */
const CLOSE_BUDGET_MS_DEFAULT = 30_000
/**
 * これだけ書かなかった本は閉じる。**過ぎた時の本を開きっぱなしにしない** —— 取り戻した分で
 * 開き直した本も、時が変わって書かなくなった本も、ここで片付く。
 */
const IDLE_CLOSE_MS_DEFAULT = 120_000

/** その時刻の本の置き場所。時刻として表せなければ `null`。 */
export function mseedFilePath(dir: string, atMs: number): string | null {
  const hourKey = jstHour(atMs)
  if (hourKey === null) return null
  return join(dir, hourKey.slice(0, 10), `raw-${hourKey}.mseed3`)
}

/** 保存できなかった理由。**数えるために分ける** —— 手当てが違う。 */
export type MseedUnsavedReason =
  /** 流し口を開けていない（開き直しの間隔を待っている最中を含む）。 */
  | 'no-stream'
  /** 書き出しが追いつかず、抱えた量が上限を超えた。 */
  | 'backpressure'
  /** 書き込みそのものが失敗した。 */
  | 'write-failed'
  /** 既に締めたあとに渡された。 */
  | 'closed'
  /** どの時の本へ入れるかを決める時刻が、時刻として表せない。**ディスクとは無関係。** */
  | 'bad-time'

export type MseedWriteResult = { readonly saved: true } | { readonly saved: false; readonly reason: MseedUnsavedReason }

export interface MseedStoreOptions {
  /** 書き出す先。無ければ作る。**作れなければ投げる。** */
  readonly dir: string
  /** いまの時刻（unix ミリ秒）。差し替えられるのはテストのため。 */
  readonly now?: () => number
  readonly maxPendingBytes?: number
  readonly reopenIntervalMs?: number
  readonly closeBudgetMs?: number
  readonly idleCloseMs?: number
  /** 流し口を開く。**差し替えられるのはテストのため**（壊れる・詰まる相手は本物のファイルでは作れない）。 */
  readonly openStream?: (path: string) => Writable
}

interface OpenBook {
  readonly key: string
  readonly stream: Writable
  pending: number
  broken: boolean
  lastWriteMs: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class MseedStore {
  private readonly dir: string
  private readonly now: () => number
  private readonly maxPendingBytes: number
  private readonly reopenIntervalMs: number
  private readonly closeBudgetMs: number
  private readonly idleCloseMs: number
  private readonly openStream: (path: string) => Writable

  private readonly books = new Map<string, OpenBook>()
  private readonly reopenAt = new Map<string, number>()
  private readonly closing = new Set<Promise<void>>()
  private closed = false

  private lostCount = 0
  private badTimeCount = 0
  private writeErrorCount = 0
  private slowCloseFlag = false
  private lastWriteErrorText: string | null = null

  constructor(options: MseedStoreOptions) {
    this.dir = options.dir
    this.now = options.now ?? Date.now
    this.maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_BYTES_DEFAULT
    this.reopenIntervalMs = options.reopenIntervalMs ?? REOPEN_INTERVAL_MS_DEFAULT
    this.closeBudgetMs = options.closeBudgetMs ?? CLOSE_BUDGET_MS_DEFAULT
    this.idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE_MS_DEFAULT
    this.openStream = options.openStream ?? ((path) => createWriteStream(path, { flags: 'a' }))
    // **作れなければここで投げる。** 黙って保存せずに走るのがいちばん悪い。
    mkdirSync(this.dir, { recursive: true })
  }

  /**
   * 書き出せずに失ったレコードの本数。
   *
   * **流し口を開けていない間に来た分も含む**（`no-stream`）。流し口が壊れた回数は
   * 開き直しの間隔ごとにしか増えないので、あれだけでは失われた量が桁で分からない。
   * 締めたあとに渡された分（`closed`）は含めない —— ディスクの異常ではないので。
   */
  get lostRecords(): number {
    return this.lostCount
  }

  /** 時刻として表せずに入れる本を決められなかったレコードの本数。**ディスクとは無関係。** */
  get badTimes(): number {
    return this.badTimeCount
  }

  /** 流し口が壊れた（開けなかった・書き込みが投げた・流し口が `error` を出した）回数。 */
  get writeErrors(): number {
    return this.writeErrorCount
  }

  /** 直近の書き込みの失敗の文面。 */
  get lastWriteError(): string | null {
    return this.lastWriteErrorText
  }

  /** いま開いている本の数。 */
  get openBooks(): number {
    return this.books.size
  }

  /** 書き出しは済んだのに、閉じ終わるのを待ちきれなかったか。 */
  get slowClose(): boolean {
    return this.slowCloseFlag
  }

  /**
   * レコードを 1 本、その時の本へ足す。**返すのは「流し口へ渡せたか」まで** —— 渡したあとで
   * 書き込みが失敗したら（ディスクが一杯・I/O エラー）、後から失ったレコードとして数える。
   */
  write(bytes: Uint8Array, fileAtMs: number): MseedWriteResult {
    return this.writeWith(bytes, fileAtMs, null)
  }

  /**
   * `write` と同じく 1 本足し、**流し口が書き終えたかまで待つ**。書き終えたら true。
   *
   * 取り戻した分のためにある（`mseedRecorder.ts` の `acceptRecovered`）—— 書けなかった分は基板へ
   * 訊き直せるので、渡せただけで欠けを閉じると、渡したあとの失敗の分を取り直す機会を捨てる。
   * 届いた分は取り直せないので、待たずに `write` で書く。
   *
   * 流し口が書き終えたことを知らせないまま詰まったら、この約束は解けない（呼び出し側が上限を置く）。
   */
  writeConfirmed(bytes: Uint8Array, fileAtMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const r = this.writeWith(bytes, fileAtMs, (error) => resolve(error === null))
      if (!r.saved) resolve(false)
    })
  }

  /** `onDone` は流し口へ渡せたときだけ、書き終えた（または失敗した）ところで 1 回呼ぶ。 */
  private writeWith(bytes: Uint8Array, fileAtMs: number, onDone: ((error: Error | null) => void) | null): MseedWriteResult {
    if (this.closed) return { saved: false, reason: 'closed' }
    const path = mseedFilePath(this.dir, fileAtMs)
    if (path === null) {
      this.badTimeCount += 1
      return { saved: false, reason: 'bad-time' }
    }
    const book = this.bookFor(path)
    if (book === null) {
      this.lostCount += 1
      return { saved: false, reason: 'no-stream' }
    }
    if (book.pending + bytes.byteLength > this.maxPendingBytes) {
      this.lostCount += 1
      return { saved: false, reason: 'backpressure' }
    }
    book.pending += bytes.byteLength
    book.lastWriteMs = this.now()
    // **抱えている量を負へ落とさない。** 壊れた本は抱え分をまとめて 0 にするので、
    // その後に届いたコールバックが素直に引くと負になり、上限の判定が二度と効かなくなる。
    const release = (): void => {
      book.pending = Math.max(0, book.pending - bytes.byteLength)
    }
    try {
      book.stream.write(bytes, (error) => {
        release()
        if (error) {
          this.lostCount += 1
          this.lastWriteErrorText = messageOf(error)
        }
        onDone?.(error ?? null)
      })
    } catch (error) {
      release()
      this.lostCount += 1
      this.lastWriteErrorText = messageOf(error)
      this.breakBook(book)
      return { saved: false, reason: 'write-failed' }
    }
    return { saved: true }
  }

  /** しばらく書かなかった本を閉じる。**定期的に呼ぶこと**（1 秒ごと程度）。 */
  tick(): void {
    if (this.closed) return
    const nowMs = this.now()
    for (const [key, book] of this.books) {
      if (nowMs - book.lastWriteMs >= this.idleCloseMs) {
        this.books.delete(key)
        this.retire(book)
      }
    }
  }

  /** 締めくくる。以後は `closed` で断る。 */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const [, book] of this.books) this.retire(book)
    this.books.clear()
    const budget = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), this.closeBudgetMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    const all = Promise.all([...this.closing]).then(() => 'done' as const)
    if ((await Promise.race([all, budget])) === 'timeout') this.slowCloseFlag = true
  }

  /** その置き場所の本。**無ければ開く。** 開けなければ `null`（次に開いてよい時刻まで待つ）。 */
  private bookFor(path: string): OpenBook | null {
    const current = this.books.get(path)
    if (current !== undefined && !current.broken) return current

    const nowMs = this.now()
    if (nowMs < (this.reopenAt.get(path) ?? 0)) return null

    let stream: Writable
    try {
      mkdirSync(dirname(path), { recursive: true })
      stream = this.openStream(path)
    } catch (error) {
      this.writeErrorCount += 1
      this.lastWriteErrorText = messageOf(error)
      this.reopenAt.set(path, nowMs + this.reopenIntervalMs)
      return null
    }
    const book: OpenBook = { key: path, stream, pending: 0, broken: false, lastWriteMs: nowMs }
    // **壊れたら本ごと捨てる。** `error` の後も書き続けると、渡した分が黙って消える。
    stream.on('error', (error) => {
      this.lastWriteErrorText = messageOf(error)
      this.breakBook(book)
    })
    this.books.set(path, book)
    this.reopenAt.delete(path)
    return book
  }

  /** 壊れた本を外し、開き直しの間隔を置く。**同じ本で二度数えない。** */
  private breakBook(book: OpenBook): void {
    if (book.broken) return
    book.broken = true
    this.writeErrorCount += 1
    if (book.pending > 0) book.pending = 0
    if (this.books.get(book.key) === book) this.books.delete(book.key)
    this.reopenAt.set(book.key, this.now() + this.reopenIntervalMs)
    this.retire(book)
  }

  /** 本を閉じる。**投げない** —— 閉じ損ねても受信は続ける。 */
  private retire(book: OpenBook): void {
    const done = new Promise<void>((resolve) => {
      try {
        book.stream.end(() => resolve())
      } catch {
        resolve()
      }
    })
    this.closing.add(done)
    void done.finally(() => this.closing.delete(done))
  }
}
