// 生データを miniSEED 3 で、日本時間の 1 時間ごとに残す。
//
// **1 時間に 3 本。** 置き場所は `<dir>/<日>/` の下。
// - `raw-<時>.mseed3` —— レコード（`recordAssembler.ts` が組み立てたもの）を届いた順に足す
// - `raw-<時>.packets.ndjson.gz` —— パケットごとの見出し（受け取った時刻・送信元・先頭行そのまま・取り戻した印）
// - `raw-<時>.unreadable.ndjson` —— 読めなかったパケット（miniSEED に入れられないもの）
//
// **どの時へ入れるかは波形の時刻で決める**（`fileTimeOf`）。取り戻した分は過ぎた時の本を開き直して足す ——
// 「12 時台を見たい」ときに 12 時の 3 本だけ読めば足りるようにするため。
//
// **見出しは 5 秒ぶんずつ gzip のかたまりにして足す。** かたまりが連なった gzip は 1 本として読めて、
// 途中で落ちても最後に書けたかたまりまでは読める。1 行ずつ素で書くと 1 日数百 MB になり、
// 1 本の gzip を開いたまま書き続けると、落ちたときに閉じていない末尾が丸ごと読めなくなる。
//
// **消さない・上書きしない。** 既にある本へは追記する。
//
// **落ちない。** 保存が止まっても震度は出し続ける。ただし黙らない —— 失った件数と
// 流し口の異常を、呼び出し側が数えられる形で持つ（`waveArchive.ts` と同じ分担）。
//
// **既知の限界: `fsync` は掛けていない**（`rawStore.ts`・`waveArchive.ts` と同じ）。

import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Writable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import { jstHour } from './jstTime'
import type { AssembledRecord } from './recordAssembler'

export type MseedBookKind = 'mseed' | 'packets' | 'unreadable'

const SUFFIX: Readonly<Record<MseedBookKind, string>> = {
  mseed: '.mseed3',
  packets: '.packets.ndjson.gz',
  unreadable: '.unreadable.ndjson',
}

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
/** 見出しを溜めておく長さ（2026-10-03 決定のレコードの上限と揃える）。 */
const PACKET_FLUSH_MS_DEFAULT = 5_000
/** 見出しを溜めておく行数の上限。**時間を待たずに書き出す**（溜めすぎてメモリが膨らまないように）。 */
const MAX_BUFFERED_LINES_DEFAULT = 20_000

/** その時刻の本の置き場所。時刻として表せなければ `null`。 */
export function mseedFilePath(dir: string, kind: MseedBookKind, atMs: number): string | null {
  const hourKey = jstHour(atMs)
  if (hourKey === null) return null
  return join(dir, hourKey.slice(0, 10), `raw-${hourKey}${SUFFIX[kind]}`)
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

/** パケットの見出し 1 行。 */
export interface PacketNote {
  /** 受け取った時刻。判らなければ `null`（取り繕わない）。 */
  readonly rx: number | null
  readonly src: string
  /** パケットの先頭行（JSON）を**そのまま**。項目が増えても取りこぼさない。 */
  readonly header: string
  readonly via?: 'backlog'
}

/** 読めなかったパケット 1 件。 */
export interface UnreadableNote {
  readonly rx: number | null
  readonly src: string
  /** 中身を丸ごと。 */
  readonly raw: string
  readonly via?: 'backlog'
  /** なぜ miniSEED に入れられなかったか（読み取りの失敗理由・組み立てで退けた理由）。 */
  readonly why: string
}

export interface MseedStoreOptions {
  /** 書き出す先。無ければ作る。**作れなければ投げる。** */
  readonly dir: string
  /** いまの時刻（unix ミリ秒）。差し替えられるのはテストのため。 */
  readonly now?: () => number
  readonly maxPendingBytes?: number
  readonly reopenIntervalMs?: number
  readonly closeBudgetMs?: number
  readonly idleCloseMs?: number
  readonly packetFlushMs?: number
  readonly maxBufferedLines?: number
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

interface PacketBatch {
  readonly atMs: number
  readonly lines: string[]
  readonly sinceMs: number
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
  private readonly packetFlushMs: number
  private readonly maxBufferedLines: number
  private readonly openStream: (path: string) => Writable

  private readonly books = new Map<string, OpenBook>()
  private readonly reopenAt = new Map<string, number>()
  /** 時ごとに溜めている見出し（鍵は本の置き場所）。 */
  private readonly batches = new Map<string, PacketBatch>()
  private readonly closing = new Set<Promise<void>>()
  private closed = false

  private recordsWrittenCount = 0
  private packetsWrittenCount = 0
  private unreadableWrittenCount = 0
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
    this.packetFlushMs = options.packetFlushMs ?? PACKET_FLUSH_MS_DEFAULT
    this.maxBufferedLines = options.maxBufferedLines ?? MAX_BUFFERED_LINES_DEFAULT
    this.openStream = options.openStream ?? ((path) => createWriteStream(path, { flags: 'a' }))
    // **作れなければここで投げる。** 黙って保存せずに走るのがいちばん悪い。
    mkdirSync(this.dir, { recursive: true })
  }

  /** 流し口へ渡せたレコードの本数。**「保存が動いている」ことを外から確かめる欄。** */
  get recordsWritten(): number {
    return this.recordsWrittenCount
  }

  /** 流し口へ渡せた見出しの行数。 */
  get packetsWritten(): number {
    return this.packetsWrittenCount
  }

  /** 流し口へ渡せた、読めなかったパケットの件数。 */
  get unreadableWritten(): number {
    return this.unreadableWrittenCount
  }

  /**
   * 書き出せずに失った件数（レコード・見出しの行・読めなかったパケットの合計）。
   *
   * **流し口を開けていない間に来た分も含む**（`no-stream`）。流し口が壊れた回数は
   * 開き直しの間隔ごとにしか増えないので、あれだけでは失われた量が桁で分からない。
   * 締めたあとに渡された分（`closed`）は含めない —— ディスクの異常ではないので（`rawStore.ts` と同じ）。
   */
  get lostRecords(): number {
    return this.lostCount
  }

  /** 時刻として表せずに入れる本を決められなかった件数。**ディスクとは無関係。** */
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

  /** まだ書き出していない見出しの行数。 */
  get bufferedPackets(): number {
    let n = 0
    for (const b of this.batches.values()) n += b.lines.length
    return n
  }

  writeRecord(record: AssembledRecord): MseedWriteResult {
    const result = this.append('mseed', record.fileAtMs, record.bytes, 1)
    if (result.saved) this.recordsWrittenCount += 1
    return result
  }

  /** 見出しを 1 行溜める。**書き出すのは `tick` か締めくくり**（行数の上限に達したらその場で）。 */
  notePacket(note: PacketNote, fileAtMs: number): MseedWriteResult {
    if (this.closed) return { saved: false, reason: 'closed' }
    const path = mseedFilePath(this.dir, 'packets', fileAtMs)
    if (path === null) {
      this.badTimeCount += 1
      return { saved: false, reason: 'bad-time' }
    }
    const line = JSON.stringify(
      note.via === undefined
        ? { rx: note.rx, src: note.src, h: note.header }
        : { rx: note.rx, src: note.src, h: note.header, via: note.via },
    )
    let batch = this.batches.get(path)
    if (batch === undefined) {
      batch = { atMs: fileAtMs, lines: [], sinceMs: this.now() }
      this.batches.set(path, batch)
    }
    batch.lines.push(line)
    if (batch.lines.length >= this.maxBufferedLines) this.flushBatch(path, batch)
    return { saved: true }
  }

  writeUnreadable(note: UnreadableNote, atMs: number): MseedWriteResult {
    const body = note.via === undefined
      ? { rx: note.rx, src: note.src, raw: note.raw, why: note.why }
      : { rx: note.rx, src: note.src, raw: note.raw, via: note.via, why: note.why }
    const result = this.append('unreadable', atMs, Buffer.from(`${JSON.stringify(body)}\n`), 1)
    if (result.saved) this.unreadableWrittenCount += 1
    return result
  }

  /**
   * 溜めた見出しのうち古くなったかたまりを書き出し、しばらく書かなかった本を閉じる。
   * **定期的に呼ぶこと**（1 秒ごと程度）。
   */
  tick(): void {
    if (this.closed) return
    const nowMs = this.now()
    for (const [path, batch] of this.batches) {
      if (nowMs - batch.sinceMs >= this.packetFlushMs) this.flushBatch(path, batch)
    }
    for (const [key, book] of this.books) {
      if (nowMs - book.lastWriteMs >= this.idleCloseMs) {
        this.books.delete(key)
        this.retire(book)
      }
    }
  }

  /** 締めくくる。**溜めた見出しも書き出す。** 以後は `closed` で断る。 */
  async close(): Promise<void> {
    if (this.closed) return
    for (const [path, batch] of this.batches) this.flushBatch(path, batch)
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

  private flushBatch(path: string, batch: PacketBatch): void {
    this.batches.delete(path)
    if (batch.lines.length === 0) return
    const gz = gzipSync(`${batch.lines.join('\n')}\n`)
    const result = this.append('packets', batch.atMs, gz, batch.lines.length)
    if (result.saved) this.packetsWrittenCount += batch.lines.length
  }

  /**
   * 本へ足す。`count` は失ったときに数える件数（見出しのかたまりは行数）。
   */
  private append(kind: MseedBookKind, atMs: number, bytes: Uint8Array, count: number): MseedWriteResult {
    if (this.closed) return { saved: false, reason: 'closed' }
    const path = mseedFilePath(this.dir, kind, atMs)
    if (path === null) {
      this.badTimeCount += count
      return { saved: false, reason: 'bad-time' }
    }
    const book = this.bookFor(path)
    if (book === null) {
      this.lostCount += count
      return { saved: false, reason: 'no-stream' }
    }
    if (book.pending + bytes.byteLength > this.maxPendingBytes) {
      this.lostCount += count
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
          this.lostCount += count
          this.lastWriteErrorText = messageOf(error)
        }
      })
    } catch (error) {
      release()
      this.lostCount += count
      this.lastWriteErrorText = messageOf(error)
      this.breakBook(book)
      return { saved: false, reason: 'write-failed' }
    }
    return { saved: true }
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
