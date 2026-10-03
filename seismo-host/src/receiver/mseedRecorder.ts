// 届いたパケットを miniSEED 3 の生データとして残す（組み立て `recordAssembler.ts` ＋ 書き出し `mseedStore.ts`）。
//
// **`main.ts` からはこれを呼ぶだけにする。** あちらは「直接実行のときだけ走らせる」門の内側で
// テストが届かないので、「読めた → 組み立てる → 見出しを溜める → レコードを書く」「読めない・
// 退けた → 丸ごと別に残す」の振り分けをここへ集める。
//
// **1 件も黙って捨てない。** 読めなかったパケットも、組み立てで退けたパケットも、理由を付けて
// 中身ごと残す。書き出せなかった分は書き出し層が数える。

import { parseSensorPacket } from '../protocol/parsePacket'
import type { PacketParseResult } from '../protocol/types'
import { MseedStore } from './mseedStore'
import type { MseedStoreOptions } from './mseedStore'
import { RecordAssembler, fileTimeOf } from './recordAssembler'
import type { AssembledRecord, RecordCutReason, RecordLane } from './recordAssembler'

export interface MseedRecorderOptions extends MseedStoreOptions {
  readonly maxHoldMs?: number
}

/** `/status` と毎分の要約へ出す健全性。 */
export interface MseedHealth {
  readonly recordsWritten: number
  readonly packetsWritten: number
  readonly unreadableWritten: number
  readonly lostRecords: number
  readonly badTimes: number
  readonly writeErrors: number
  readonly lastWriteError: string | null
  readonly openBooks: number
  readonly slowClose: boolean
  /** まだレコードにしていないサンプルの数（全軸の合計）。 */
  readonly pendingSamples: number
  /** まだ書き出していない見出しの行数。 */
  readonly bufferedPackets: number
  /** 切った理由ごとのレコードの本数。 */
  readonly cuts: Readonly<Record<RecordCutReason, number>>
  /**
   * 組み立て・書き出しの途中で想定外の例外が出た回数。**0 が正常**（増えたらこちらの不具合）。
   * 受信は止めず、そのパケットは中身ごと読めないものの退避先へ残す。
   */
  readonly internalErrors: number
  readonly lastInternalError: string | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 先頭行（ヘッダの JSON）。**改行が無ければ全体**（読めたパケットには必ず改行がある）。 */
function headerLineOf(payload: string): string {
  const end = payload.indexOf('\n')
  return end < 0 ? payload : payload.slice(0, end)
}

export class MseedRecorder {
  private readonly assembler: RecordAssembler
  private readonly store: MseedStore
  private readonly now: () => number
  private internalErrorCount = 0
  private lastInternalErrorText: string | null = null

  constructor(options: MseedRecorderOptions) {
    this.now = options.now ?? Date.now
    this.assembler = new RecordAssembler({ maxHoldMs: options.maxHoldMs })
    this.store = new MseedStore(options)
  }

  /**
   * 1 データグラムを残す。**投げない。**
   *
   * **受信の口は例外を囲わない**（`main.ts`。投げたらホストごと落ちる側に倒してある）ので、
   * ここで受け止める。組み立ても書き出しも投げない作りだが、届く値はネットワーク越しで、
   * 想定外の形が 1 つ来ただけで震度まで止まる形は避ける。受け止めたら数えて、
   * そのパケットは中身ごと読めないものの退避先へ残す（黙って捨てない）。
   *
   * `parsed` は受信の処理が既に読んだ結果。渡されなければここで読む（取り戻した分）。
   * `receivedAtMs` が判らなければ `null` —— 記録には `null` のまま残し、振り分けだけいまの時刻で行う。
   */
  handle(source: string, payload: string, receivedAtMs: number | null, lane: RecordLane, parsed?: PacketParseResult): void {
    const via = lane === 'backlog' ? 'backlog' : undefined
    const rx = receivedAtMs !== null && Number.isFinite(receivedAtMs) ? receivedAtMs : null
    const at = rx ?? this.now()
    try {
      this.handleInner(source, payload, rx, at, lane, via, parsed)
    } catch (error) {
      this.noteInternalError(error)
      try {
        this.store.writeUnreadable({ rx, src: source, raw: payload, via, why: 'internal-error' }, at)
      } catch (again) {
        this.noteInternalError(again)
      }
    }
  }

  private handleInner(
    source: string,
    payload: string,
    rx: number | null,
    at: number,
    lane: RecordLane,
    via: 'backlog' | undefined,
    parsed: PacketParseResult | undefined,
  ): void {
    const read = parsed ?? parseSensorPacket(payload)
    if (!read.ok) {
      this.store.writeUnreadable({ rx, src: source, raw: payload, via, why: read.reason }, at)
      return
    }
    // **読めたパケットは、退けたものも含めて波形の時刻の時へ入れる**（`fileTimeOf`）。
    // 受け取った時刻で振り分けると、取り戻した分が何時間も後の時のファイルへ紛れ込む。
    // 読めなかったもの（上）は波形の時刻を持たないので、受け取った時刻で振り分ける。
    const fileAt = fileTimeOf(read.packet.firstSampleMs, at)
    const pushed = this.assembler.push(read.packet, lane, at)
    if (pushed.rejected !== null) {
      this.store.writeUnreadable({ rx, src: source, raw: payload, via, why: pushed.rejected }, fileAt)
      return
    }
    // **見出しとレコードは同じ時の本へ入れる**（`fileTimeOf` を両方で通す）。
    this.store.notePacket({ rx, src: source, header: headerLineOf(payload), via }, fileAt)
    this.writeAll(pushed.records)
  }

  /** 溜まったまま古くなった分を書き出す。**毎秒呼ぶこと。** 投げない（`handle` と同じ理由）。 */
  tick(nowMs: number): void {
    try {
      this.writeAll(this.assembler.tick(nowMs))
    } catch (error) {
      this.noteInternalError(error)
    }
    try {
      this.store.tick()
    } catch (error) {
      this.noteInternalError(error)
    }
  }

  /** 溜めた分を全部書き出してから閉じる。**書き出しで投げても閉じる**（閉じないと見出しが残らない）。 */
  async close(): Promise<void> {
    try {
      this.writeAll(this.assembler.flushAll())
    } catch (error) {
      this.noteInternalError(error)
    }
    await this.store.close()
  }

  private noteInternalError(error: unknown): void {
    this.internalErrorCount += 1
    this.lastInternalErrorText = messageOf(error)
  }

  health(): MseedHealth {
    return {
      recordsWritten: this.store.recordsWritten,
      packetsWritten: this.store.packetsWritten,
      unreadableWritten: this.store.unreadableWritten,
      lostRecords: this.store.lostRecords,
      badTimes: this.store.badTimes,
      writeErrors: this.store.writeErrors,
      lastWriteError: this.store.lastWriteError,
      openBooks: this.store.openBooks,
      slowClose: this.store.slowClose,
      pendingSamples: this.assembler.pendingSamples,
      bufferedPackets: this.store.bufferedPackets,
      cuts: this.assembler.cutCounts,
      internalErrors: this.internalErrorCount,
      lastInternalError: this.lastInternalErrorText,
    }
  }

  private writeAll(records: readonly AssembledRecord[]): void {
    for (const r of records) this.store.writeRecord(r)
  }
}
