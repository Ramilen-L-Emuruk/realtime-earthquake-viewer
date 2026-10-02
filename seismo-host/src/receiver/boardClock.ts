// 基板ごとの時計のずれを測る。
//
// **基板の時計は、合っているように見えて黙ってずれる。** 2026-10-01 のファームは
// ソフトウェアの再起動のあと SNTP を始めておらず、3 枚の時計が 22 時間で 0.5〜1.3 秒
// 遅れた。状態ページは「合っている」と名乗り続け、パケットも届き続けたので、
// **気づけたのは観測点の合成が毎回いちばん遅れた基板を欠くようになってから**だった
// （合成は裏付けの到着を「データの時刻」で待つので、時計のずれがそのまま待ちを食う）。
//
// **測り方。** パケットを受け取った時刻（受け手の時計）から、そのパケットの末尾の
// サンプルが名乗る時刻（基板の時計）を引く。基板は FIFO を抜いた瞬間の時刻から逆算して
// 名乗るので、時計が合っていればこの差は「届くまでの時間」だけになる。届くまでの時間は
// 揺れる（Wi-Fi の再送・受け手の処理）が下には限りがあるので、**窓の中の最小値**を取れば
// 時計のずれに近い値が残る。正なら基板が遅れている。
//
// **受け手の時計が合っていることを前提にする。** ずれているのが受け手なら、全基板が
// 同じだけずれて見える（基板どうしの差は正しく残る）。

import type { BoardKey } from '../protocol/types'
import { epochPlausible } from '../timebase/segmenter'
import type { BoardClockOffset } from './boardClockVerdict'

/** 最小値を取る窓の長さ。**取り直しの間隔（ファームの 15 分）より十分短く、パケットが
 * 数百届く長さ。** 1 基板あたり毎秒 10 パケットなので 600 件の最小を取る。 */
export const CLOCK_WINDOW_MS_DEFAULT = 60_000

/** 覚えていられる基板の数。理由は `sensorHealth.ts` の `MAX_SENSORS_DEFAULT` と同じ。 */
const MAX_BOARDS_DEFAULT = 64

/**
 * 基板 1 枚ぶんの時計のずれ。欄の意味は `boardClockVerdict.ts` の `BoardClockOffset`。
 *
 * **途中の窓の最小値は出さない**（`offsetMs` は閉じた窓のものだけ）—— 件数が少ないうちは
 * 届くまでの時間の揺れがそのまま乗り、窓を閉じるたびに値が跳ねて見える。
 */
export interface BoardClockRow extends BoardClockOffset {
  readonly boardKey: BoardKey
}

export interface BoardClockSnapshot {
  /** 基板の鍵の順。 */
  readonly boards: readonly BoardClockRow[]
  /** 上限で押し出した数。 */
  readonly evictions: number
}

/** 末尾のサンプルの時刻を出すのに要るパケットの欄。**読むものだけを書く。** */
export interface PacketTiming {
  readonly firstSampleMs: number
  readonly sampleRateHz: number
  readonly samples: readonly unknown[]
}

/** パケットの末尾のサンプルが名乗る時刻。出せなければ null。 */
export function lastSampleMsOf(packet: PacketTiming): number | null {
  const n = packet.samples.length
  const hz = packet.sampleRateHz
  if (n === 0 || !Number.isFinite(hz) || hz <= 0) return null
  const last = packet.firstSampleMs + ((n - 1) * 1000) / hz
  return Number.isFinite(last) ? last : null
}

export interface BoardClockBookOptions {
  readonly windowMs?: number
  readonly maxBoards?: number
}

interface Entry {
  readonly boardKey: BoardKey
  windowStartMs: number
  windowMin: number
  windowPackets: number
  closedOffsetMs: number | null
  closedEndMs: number | null
  closedPackets: number
  lastPacketMs: number
}

export class BoardClockBook {
  private readonly windowMs: number
  private readonly maxBoards: number
  /** `Map` の挿入順が「いちばん長く届いていない順」になるよう、触れたら入れ直す。 */
  private readonly entries = new Map<BoardKey, Entry>()
  private evictedCount = 0

  constructor(options: BoardClockBookOptions = {}) {
    this.windowMs = options.windowMs ?? CLOCK_WINDOW_MS_DEFAULT
    this.maxBoards = options.maxBoards ?? MAX_BOARDS_DEFAULT
  }

  /**
   * パケットが 1 つ届いた。**読み取りに通った回だけ呼ぶ**（誰のものか判るのはそこから）。
   *
   * **時計が合う前の時刻（1970 年）を名乗るパケットは測らない。** その状態には区間の側の
   * 警告がある（`main.ts` の `buildTimebaseEpochWarning`）。ここで 56 年のずれとして
   * 出すと、同じ事実に警告が 2 つ付く。
   */
  note(boardKey: BoardKey, receivedAtMs: number, packet: PacketTiming): void {
    if (!Number.isFinite(receivedAtMs)) return
    if (!epochPlausible(packet.firstSampleMs)) return
    const last = lastSampleMsOf(packet)
    if (last === null) return
    const lag = receivedAtMs - last

    const entry = this.touch(boardKey)
    if (entry === undefined) {
      this.insert({
        boardKey,
        windowStartMs: receivedAtMs,
        windowMin: lag,
        windowPackets: 1,
        closedOffsetMs: null,
        closedEndMs: null,
        closedPackets: 0,
        lastPacketMs: receivedAtMs,
      })
      return
    }
    entry.lastPacketMs = receivedAtMs
    if (receivedAtMs >= entry.windowStartMs + this.windowMs) {
      // **このパケットが前の窓を閉じ、次の窓の 1 件目になる。** 間が空いて何窓ぶんも
      // 飛んでいても、閉じるのは手元の 1 窓だけ（空の窓を作らない）。
      entry.closedOffsetMs = entry.windowMin
      entry.closedEndMs = receivedAtMs
      entry.closedPackets = entry.windowPackets
      entry.windowStartMs = receivedAtMs
      entry.windowMin = lag
      entry.windowPackets = 1
      return
    }
    if (lag < entry.windowMin) entry.windowMin = lag
    entry.windowPackets++
  }

  snapshot(): BoardClockSnapshot {
    const boards = [...this.entries.values()]
      .map((e) => ({
        boardKey: e.boardKey,
        offsetMs: e.closedOffsetMs,
        windowEndMs: e.closedEndMs,
        packets: e.closedPackets,
        lastPacketMs: e.lastPacketMs,
      }))
      .sort((a, b) => (a.boardKey < b.boardKey ? -1 : a.boardKey > b.boardKey ? 1 : 0))
    return { boards, evictions: this.evictedCount }
  }

  /** 覚えがあれば挿入順を新しくして返す。**この順序が追い出しの根拠になる。** */
  private touch(boardKey: BoardKey): Entry | undefined {
    const found = this.entries.get(boardKey)
    if (found === undefined) return undefined
    this.entries.delete(boardKey)
    this.entries.set(boardKey, found)
    return found
  }

  private insert(entry: Entry): void {
    if (this.entries.size >= this.maxBoards) {
      // **いちばん長く届いていないものを押し出す。** 新しいほうを拒むと、基板を足した日から
      // その 1 枚が永久に映らない（`sensorHealth.ts` と同じ判断）。
      const oldest = this.entries.keys().next()
      if (!oldest.done) {
        this.entries.delete(oldest.value)
        this.evictedCount++
      }
    }
    this.entries.set(entry.boardKey, entry)
  }
}
