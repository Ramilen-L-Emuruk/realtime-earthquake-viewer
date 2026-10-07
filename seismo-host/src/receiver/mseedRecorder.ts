// 届いたパケットを miniSEED 3 の生データとして残す（波形の組み立て `recordAssembler.ts`・
// 受信の記録 `receptionLog.ts` ＋ 書き出し `mseedStore.ts`）。
//
// **受け取ったパケットは、まずここへ渡す。** 読み取りもここで行い、その結果を呼び出し側へ返す ——
// 残す前に震度の処理へ流す形にすると、そちらで例外が出たときに生データが残らない。
// `main.ts` からはこれを呼ぶだけにする（あちらは「直接実行のときだけ走らせる」門の内側で、
// テストが届かない）。
//
// **1 件も黙って捨てない。** 読めなかったパケットも、組み立てで退けたパケットも、理由を付けて
// 中身ごとホストの受信の記録へ残す。書き出せなかった分は書き出し層が数える。
//
// **入口は届き方ごとに 2 つ。** いま届いた分（`accept`）は溜めてから書く。取り戻した分
// （`acceptRecovered`）は溜めずに書き、ディスクへ書き終えたかを返す —— 書けなければ、呼び出し側は
// その範囲を欠けに残して基板へ訊き直す（`backlogFetcher.ts`）。

import { parseSensorPacket } from '../protocol/parsePacket'
import type { PacketParseResult } from '../protocol/types'
import { MseedStore } from './mseedStore'
import type { MseedStoreOptions } from './mseedStore'
import { RecordAssembler, fileTimeOf } from './recordAssembler'
import type { AssembledRecord, RecordCutReason } from './recordAssembler'
import { ReceptionLog, unreadableRecord } from './receptionLog'
import type { LogRecord, UnreadablePacket } from './receptionLog'

export interface MseedRecorderOptions extends MseedStoreOptions {
  /** 波形のレコードに溜める上限（ミリ秒）。 */
  readonly maxHoldMs?: number
  /** 受信の記録 1 本が覆う区間の上限（ミリ秒）。 */
  readonly logHoldMs?: number
  /**
   * パケットを読む。**差し替えられるのはテストのため**（組み立ての途中で投げる形は、本物の
   * 読み取りの結果からは作れない）。
   */
  readonly parse?: (payload: string) => PacketParseResult
}

/** `/status` と毎分の要約へ出す健全性。 */
export interface MseedHealth {
  /** 書き出せた波形のレコードの本数。**「保存が動いている」ことを外から確かめる欄。** */
  readonly recordsWritten: number
  /** 受信の記録を書き出せたパケットの数。 */
  readonly packetsLogged: number
  /** 書き出せた、読めなかったパケット（波形へ入れられなかったもの）の件数。 */
  readonly unreadableWritten: number
  /** 書き出せずに失ったレコードの本数（波形・受信の記録・読めなかったパケットの合計）。 */
  readonly lostRecords: number
  readonly badTimes: number
  readonly writeErrors: number
  readonly lastWriteError: string | null
  readonly openBooks: number
  readonly slowClose: boolean
  /** まだレコードにしていないサンプルの数（全軸の合計）。 */
  readonly pendingSamples: number
  /** 受信の記録をまだ書き出していないパケットの数。 */
  readonly bufferedPackets: number
  /** 波形のレコードを切った理由ごとの本数。 */
  readonly cuts: Readonly<Record<RecordCutReason, number>>
  /**
   * 組み立て・書き出しの途中で想定外の例外が出た回数。**0 が正常**（増えたらこちらの不具合）。
   * 受信は止めず、そのパケットは中身ごと読めなかったパケットとして残す。
   */
  readonly internalErrors: number
  readonly lastInternalError: string | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class MseedRecorder {
  private readonly assembler: RecordAssembler
  private readonly log: ReceptionLog
  private readonly store: MseedStore
  private readonly now: () => number
  private readonly parse: (payload: string) => PacketParseResult
  private recordsWrittenCount = 0
  private packetsLoggedCount = 0
  private unreadableWrittenCount = 0
  private internalErrorCount = 0
  private lastInternalErrorText: string | null = null
  /** 次に受け付けるデータグラムの受付番号（`receptionLog.ts` 冒頭）。 */
  private nextArrival = 0

  constructor(options: MseedRecorderOptions) {
    this.now = options.now ?? Date.now
    this.parse = options.parse ?? parseSensorPacket
    this.assembler = new RecordAssembler({ maxHoldMs: options.maxHoldMs })
    this.log = new ReceptionLog({ maxHoldMs: options.logHoldMs })
    this.store = new MseedStore(options)
  }

  /**
   * いま届いた 1 データグラムを残し、読み取った結果を返す。**投げない。**
   *
   * **受信の口は例外を囲わない**（`main.ts`。投げたらホストごと落ちる側に倒してある）ので、
   * ここで受け止める。組み立ても書き出しも投げない作りだが、届く値はネットワーク越しで、
   * 想定外の形が 1 つ来ただけで震度まで止まる形は避ける。受け止めたら数えて、
   * そのパケットは中身ごと読めなかったパケットとして残す（黙って捨てない）。
   *
   * **取り戻した分はここへ渡さない**（`acceptRecovered`）。書けたかを返さないので、
   * ここを通すと書けなかった分の欠けを閉じてしまう。
   *
   * `receivedAtMs` が判らなければ `null` —— 記録には `null` のまま残し、振り分けだけいまの時刻で行う。
   */
  accept(source: string, payload: string, receivedAtMs: number | null): PacketParseResult {
    const read = this.parse(payload)
    const { rx, at, arrival } = this.receipt(receivedAtMs)
    try {
      this.keep(source, payload, read, rx, arrival, at)
    } catch (error) {
      this.noteInternalError(error)
      try {
        this.writeUnreadable({ rx, arrival, fileAtMs: at, source, lane: 'live', why: 'internal-error', raw: payload })
      } catch (again) {
        this.noteInternalError(again)
      }
    }
    return read
  }

  /**
   * 基板から取り戻した 1 データグラムを、溜めずに書き、**ディスクへ書き終えたら true**。投げない
   * （拒否もしない）。
   *
   * **false なら、呼び出し側はその範囲を欠けに残して訊き直す**（`backlogFetcher.ts`）。届いた分は
   * 取り直せないが、取り戻した分は基板がまだ抱えていれば取り直せる —— 書き終わりを待たずに欠けを
   * 閉じると、流し口へ渡したあとの失敗（ディスクが一杯・I/O エラー）の分を取り直す機会を捨てる
   * （2026-10-06 ユーザー承認）。
   *
   * 流し口が書き終えたことを知らせないまま詰まったら、この約束は解けない。上限は呼び出し側が置く。
   *
   * 読めなかった・組み立てで退けたパケットは、中身ごと書き終えたら true —— 訊き直しても同じ理由で
   * 退けるだけなので、残せた時点で取り戻したことにする。
   */
  async acceptRecovered(source: string, payload: string, receivedAtMs: number | null): Promise<boolean> {
    const read = this.parse(payload)
    const { rx, at, arrival } = this.receipt(receivedAtMs)
    try {
      return await this.keepRecovered(source, payload, read, rx, arrival, at)
    } catch (error) {
      this.noteInternalError(error)
      try {
        // 中身は読めなかったパケットとして残す（黙って捨てない）。
        await this.confirmUnreadable({ rx, arrival, fileAtMs: at, source, lane: 'backlog', why: 'internal-error', raw: payload })
      } catch (again) {
        this.noteInternalError(again)
      }
      // **「書けた」と答えない。** 波形は書けていないので、一時的な原因なら訊き直せば書ける。
      // 同じところで投げ続けても、取り戻しの側が間を倍々に空け、20 分で諦める。
      return false
    }
  }

  /** 受け取った時刻と受付番号を決める。**受付番号は呼ばれた順に 1 つずつ進める。** */
  private receipt(receivedAtMs: number | null): { rx: number | null; at: number; arrival: number } {
    const rx = receivedAtMs !== null && Number.isFinite(receivedAtMs) ? receivedAtMs : null
    const arrival = this.nextArrival
    this.nextArrival += 1
    return { rx, at: rx ?? this.now(), arrival }
  }

  /** いま届いた 1 データグラムを残す（溜めてから書く）。 */
  private keep(source: string, payload: string, read: PacketParseResult, rx: number | null, arrival: number, at: number): void {
    if (!read.ok) {
      // 読めなかったものは波形の時刻を持たないので、受け取った時刻で振り分ける。
      this.writeUnreadable({ rx, arrival, fileAtMs: at, source, lane: 'live', why: read.reason, raw: payload })
      return
    }
    const pushed = this.assembler.push(read.packet, 'live', at)
    if (pushed.rejected !== null) {
      // **読めたものは、退けたものも含めて波形の時刻の時へ入れる**（`fileTimeOf`）。
      this.writeUnreadable({
        rx,
        arrival,
        fileAtMs: fileTimeOf(read.packet.firstSampleMs, at),
        source,
        lane: 'live',
        why: pushed.rejected,
        raw: payload,
      })
      return
    }
    this.writeWave(pushed.records)
    this.writeLog(
      this.log.push({ packet: read.packet, lane: pushed.lane, rx, arrival, at, source, ackRequested: read.ackRequested }),
    )
  }

  /**
   * 取り戻した 1 データグラムを書き、**全部書き終えたら true**。
   *
   * **組み立てと受信の記録へ渡すのは、待つ前に済ませる**（どちらも取り戻した分はその場で切るので、
   * 待っている間に届いた分と混ざらない）。取り戻しの側は 1 まとまりずつ待ってから次を渡す。
   */
  private async keepRecovered(
    source: string,
    payload: string,
    read: PacketParseResult,
    rx: number | null,
    arrival: number,
    at: number,
  ): Promise<boolean> {
    if (!read.ok) {
      return this.confirmUnreadable({ rx, arrival, fileAtMs: at, source, lane: 'backlog', why: read.reason, raw: payload })
    }
    const pushed = this.assembler.push(read.packet, 'backlog', at)
    if (pushed.rejected !== null) {
      return this.confirmUnreadable({
        rx,
        arrival,
        fileAtMs: fileTimeOf(read.packet.firstSampleMs, at),
        source,
        lane: 'backlog',
        why: pushed.rejected,
        raw: payload,
      })
    }
    const logRecords = this.log.push({ packet: read.packet, lane: pushed.lane, rx, arrival, at, source, ackRequested: read.ackRequested })
    const waves = await Promise.all(
      pushed.records.map(async (r) => {
        const ok = await this.store.writeConfirmed(r.bytes, r.fileAtMs)
        if (ok) this.recordsWrittenCount += 1
        return ok
      }),
    )
    // **波形を全軸書き終えたときだけ受信の記録を書く。** 受信の記録だけが残ると、訊き直して
    // 書けた波形とあわせて同じパケットが 2 回組み上がる（読み手は受信の記録に載った回数だけ
    // パケットを組む。`mseedPacketReader.ts`）。書けた軸の波形だけが残るのは構わない ——
    // 同じ番号の区間が重なっても、組み上がるパケットは 1 つ。**ただしファイルにはその軸の波形が
    // 2 本残る**（訊き直して全軸を書き直すため。外の道具では重なって見える）。既知の限界として
    // 受け入れている（2026-10-06 承認。README「生のパケットを miniSEED 3 で時間ごとに残す」）。
    if (!waves.every(Boolean)) return false
    const logs = await Promise.all(
      logRecords.map(async (r) => {
        const ok = await this.store.writeConfirmed(r.bytes, r.fileAtMs)
        if (ok) this.packetsLoggedCount += r.packetCount
        return ok
      }),
    )
    return logs.every(Boolean)
  }

  /** 溜まったまま古くなった分を書き出す。**毎秒呼ぶこと。** 投げない（`accept` と同じ理由）。 */
  tick(nowMs: number): void {
    try {
      this.writeWave(this.assembler.tick(nowMs))
    } catch (error) {
      this.noteInternalError(error)
    }
    try {
      this.writeLog(this.log.tick(nowMs))
    } catch (error) {
      this.noteInternalError(error)
    }
    try {
      this.store.tick()
    } catch (error) {
      this.noteInternalError(error)
    }
  }

  /**
   * 溜めている波形と受信の記録をいま書き出し、**ディスクへ書き終えるまで待つ**。閉じない。投げない。
   * 全部書けたら true。
   *
   * **生データを読み直す前に呼ぶ**（`stationRewave.ts`）。受信の記録は最長 30 秒溜めてから書くので、
   * 呼ばずに読むと直近のパケットがファイルにまだ無い（波形はあっても受信の記録が無いパケットは
   * 組み上がらない。`mseedPacketReader.ts`）。
   *
   * 途中で吐き出したぶんレコードは短くなる（切れ目の理由は `flush`）。読み直すのは欠けを取り戻した
   * あとだけなので、頻度は欠けの数で頭打ちになる。**同じ流し口の先に積まれた書き込みは、ここで
   * 待つ書き込みより先に済む**（流し口は順に書く）ので、待ち終えた時点でそれまでの分も読める。
   */
  async flushForRead(): Promise<boolean> {
    let waves: readonly AssembledRecord[]
    let logs: readonly LogRecord[]
    try {
      waves = this.assembler.flushAll()
      logs = this.log.flushAll()
    } catch (error) {
      this.noteInternalError(error)
      return false
    }
    const wavesOk = await Promise.all(
      waves.map(async (r) => {
        const ok = await this.store.writeConfirmed(r.bytes, r.fileAtMs)
        if (ok) this.recordsWrittenCount += 1
        return ok
      }),
    )
    const logsOk = await Promise.all(
      logs.map(async (r) => {
        const ok = await this.store.writeConfirmed(r.bytes, r.fileAtMs)
        if (ok) this.packetsLoggedCount += r.packetCount
        return ok
      }),
    )
    return wavesOk.every(Boolean) && logsOk.every(Boolean)
  }

  /**
   * 溜めた分を全部書き出してから閉じる。**書き出しで投げても閉じる**（閉じないと最後の
   * レコードが流し口に残る）。
   */
  async close(): Promise<void> {
    try {
      this.writeWave(this.assembler.flushAll())
    } catch (error) {
      this.noteInternalError(error)
    }
    try {
      this.writeLog(this.log.flushAll())
    } catch (error) {
      this.noteInternalError(error)
    }
    await this.store.close()
  }

  health(): MseedHealth {
    return {
      recordsWritten: this.recordsWrittenCount,
      packetsLogged: this.packetsLoggedCount,
      unreadableWritten: this.unreadableWrittenCount,
      lostRecords: this.store.lostRecords,
      badTimes: this.store.badTimes,
      writeErrors: this.store.writeErrors,
      lastWriteError: this.store.lastWriteError,
      openBooks: this.store.openBooks,
      slowClose: this.store.slowClose,
      pendingSamples: this.assembler.pendingSamples,
      bufferedPackets: this.log.bufferedPackets,
      cuts: this.assembler.cutCounts,
      internalErrors: this.internalErrorCount,
      lastInternalError: this.lastInternalErrorText,
    }
  }

  private noteInternalError(error: unknown): void {
    this.internalErrorCount += 1
    this.lastInternalErrorText = messageOf(error)
  }

  private writeWave(records: readonly AssembledRecord[]): void {
    for (const r of records) if (this.store.write(r.bytes, r.fileAtMs).saved) this.recordsWrittenCount += 1
  }

  private writeLog(records: readonly LogRecord[]): void {
    for (const r of records) if (this.store.write(r.bytes, r.fileAtMs).saved) this.packetsLoggedCount += r.packetCount
  }

  private writeUnreadable(u: UnreadablePacket): void {
    const r = unreadableRecord(u)
    if (this.store.write(r.bytes, r.fileAtMs).saved) this.unreadableWrittenCount += 1
  }

  /** 読めなかったパケットを中身ごと書き、**書き終えたら true**。 */
  private async confirmUnreadable(u: UnreadablePacket): Promise<boolean> {
    const r = unreadableRecord(u)
    const ok = await this.store.writeConfirmed(r.bytes, r.fileAtMs)
    if (ok) this.unreadableWrittenCount += 1
    return ok
  }
}
