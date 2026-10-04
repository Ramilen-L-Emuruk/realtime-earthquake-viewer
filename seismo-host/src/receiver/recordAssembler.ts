// 届いたパケットを、流れ（基板 × 起動 × センサー × 軸 × 届き方）ごとに溜め、miniSEED 3 の
// レコードへ切る。ファイルへ書くのは呼び出し側（この部品は I/O を持たない）。
//
// **切る条件**
// - 1 本が 512 バイトに達した（`mseed3Record.ts`）
// - 隣り合うサンプルの差が 30 ビットに収まらなかった（`steim2.ts`）
// - 番号が途切れた・刻みが変わった・時計が合う前と後が入れ替わった
// - 名乗る時刻が「レコードの先頭 ＋ 公称の刻み」から 2 サンプルを超えてずれた
// - データの時刻が次の正時を越えた（1 時間のファイルを跨ぐレコードを作らない）
// - 5 秒ぶん溜まった（データの長さで測る。届かないまま溜まっている分は `tick` が受け取った時刻で測る）
// - 締めくくり（`flushAll`）
//
// **時刻を外挿で済ませない。** レコードの先頭時刻は、その頭にあたるパケットが名乗る時刻から取る。
// 公称の刻みで外挿した時刻は、パケットが名乗る時刻から 10 秒で ±20 ms ずれる（実測）。
// パケットごとの時刻は見出しの側にも残すが、miniSEED だけを読んでも大きく外さないようにする。
//
// **取り戻した分は別の流れで溜める。** 基板が後から送り直した波形は、いま届いている分とは
// 時刻も番号も離れている。同じ流れへ混ぜると、取り戻すたびにいまのレコードが途切れる。
//
// **遅れて届いた・重なって届いたパケットも別の流れで溜める**（`late`）。番号がいまの流れより
// 前へ戻るパケットを同じ流れへ入れると、そこで切れたうえに、いまの流れの続きの番号まで
// 巻き戻されて、次に届く正しいパケットでもう一度切れる。捨てはしない（生データは全部残す）。

import type { SensorPacket } from '../protocol/types'
import { buildMseed3Record, framesForRecord, mseed3SourceId } from './mseed3Record'
import { encodeSteim2 } from './steim2'

/** 呼び出し側が渡す届き方。 */
export type RecordLane = 'live' | 'backlog'

/**
 * 流れの届き方。`late` は `live` で届いたが、番号がいまの流れより前へ戻っていたもの
 * （組み立ての中で振り分ける。呼び出し側は渡さない）。
 */
export type StreamLane = RecordLane | 'late'

/**
 * レコードを切った理由。**数えて `/status` へ出す** —— 1 本が 512 バイトまで埋まらない理由が
 * 見えないと、量が見込みより増えたときに原因を辿れない。
 */
export type RecordCutReason =
  /** 512 バイトに達した。 */
  | 'full'
  /** 隣り合うサンプルの差が 30 ビットに収まらなかった（Steim2 で続けて詰められない）。 */
  | 'value-jump'
  /** 番号が続きでない（取りこぼし。遅れて届いた分の流れでは、届く順の入れ替わりも）。 */
  | 'seq-gap'
  /** 刻みが変わった。 */
  | 'rate-change'
  /** 時計が合う前と後が入れ替わった。 */
  | 'clock-sync'
  /** 名乗る時刻が外挿から 2 サンプルを超えてずれた。 */
  | 'time-drift'
  /** 次の正時を越えた。 */
  | 'hour'
  /** データで 5 秒ぶん溜まった。 */
  | 'hold'
  /** 受け取ってから 5 秒経っても次が来なかった（`tick`）。 */
  | 'idle'
  /** 締めくくり（`flushAll`）。 */
  | 'flush'

export const RECORD_CUT_REASONS: readonly RecordCutReason[] = [
  'full',
  'value-jump',
  'seq-gap',
  'rate-change',
  'clock-sync',
  'time-drift',
  'hour',
  'hold',
  'idle',
  'flush',
]

export interface AssembledRecord {
  /** このレコードを切った理由。 */
  readonly cut: RecordCutReason
  readonly sourceId: string
  readonly lane: StreamLane
  /** 基板の起動 ID。**通し番号はこれと組で一意になる**（起動ごとに 0 へ戻るため）。 */
  readonly bootId: string
  /** 先頭サンプルの通し番号。 */
  readonly firstSeq: number
  /** 先頭サンプルの時刻（unix ミリ秒）。 */
  readonly startMs: number
  readonly sampleRateHz: number
  readonly sampleCount: number
  /** 基板の時計が合う前の値。 */
  readonly timeQuestionable: boolean
  /**
   * どの時間のファイルへ入れるかを決める時刻。**ふだんは先頭時刻と同じ。** 時計が合う前の
   * 値だけは受け取った時刻 —— 1970 年の時間のファイルを作らないため。
   */
  readonly fileAtMs: number
  readonly bytes: Uint8Array
}

/** パケットを丸ごと退けた理由。**呼び出し側はそのパケットを別に残す**（黙って捨てない）。 */
export type AssemblerRejection =
  /** 識別子を作れない（MAC を名乗らない版 1 の基板・規則に収まらないセンサー ID や軸名）。 */
  | 'no-source-id'
  /** 32 ビットの整数に収まらない値がある。 */
  | 'sample-out-of-range'
  /** 起動 ID が長すぎて、拡張ヘッダを入れると 512 バイトに収まらない（`MAX_BOOT_ID_LENGTH`）。 */
  | 'boot-id-too-long'

export interface PushResult {
  readonly records: readonly AssembledRecord[]
  readonly rejected: AssemblerRejection | null
}

export interface RecordAssemblerOptions {
  /** 溜めておく上限（ミリ秒）。 */
  readonly maxHoldMs?: number
  /** 何も来なくなった流れを帳面から外すまで（ミリ秒）。 */
  readonly forgetAfterMs?: number
}

/** 2026-10-03 決定: 512 バイトか 5 秒の早いほう。 */
const MAX_HOLD_MS_DEFAULT = 5_000
const FORGET_AFTER_MS_DEFAULT = 60_000

/**
 * 外挿とのずれをどこまで同じレコードに繋ぐか（サンプル数）。
 *
 * **半サンプルにしない。** 基板の刻みは公称から揺らいでいて、5 秒のレコードの中でも
 * 外挿とのずれは ±10 ms（1 サンプル）前後まで開く（実測）。半サンプルで切ると 1 秒ごとに
 * 切れて見出しの分だけ嵩が増える。2 サンプルを超えるのは時計の飛び（同期の取り直し）や
 * 基板の詰まりで、そこは切って先頭時刻を名乗り直させる。
 */
const TIME_TOLERANCE_SAMPLES = 2

/**
 * これより前の時刻は「時計が合う前」とみなす（2020-01-01 UTC）。基板は時計が合うまで
 * 起動からの経過ミリ秒を名乗る（版によっては合うまで送らない）。
 */
const SYNCED_FROM_MS = Date.UTC(2020, 0, 1)

/**
 * どの時間のファイルへ入れるかを決める時刻。**レコードとパケットの見出しで同じ関数を通す**
 * —— 別々に決めると、同じパケットのサンプルと見出しが別の時間のファイルへ分かれる。
 * 時計が合う前の値だけは受け取った時刻（1970 年の時間のファイルを作らない）。
 */
export function fileTimeOf(firstSampleMs: number, receivedAtMs: number): number {
  return firstSampleMs < SYNCED_FROM_MS ? receivedAtMs : firstSampleMs
}

const HOUR_MS = 3_600_000
const INT32_MIN = -(2 ** 31)
const INT32_MAX = 2 ** 31 - 1

/**
 * 起動 ID の長さの上限（文字数）。**これを超えるパケットは miniSEED に入れずに退ける。**
 *
 * 起動 ID はネットワーク越しに届く値で、読み取り（`parsePacket.ts`）は空でないことしか見ない。
 * 長さを縛らないと、拡張ヘッダだけで 512 バイトを食い、レコードを組み立てられない
 * （組み立てが投げると、受信の口ごとホストが落ちる）。実機の基板は 8 文字の 16 進を名乗る。
 */
const MAX_BOOT_ID_LENGTH = 32

function byteLengthOf(s: string): number {
  return new TextEncoder().encode(s).byteLength
}

/**
 * 拡張ヘッダ。**レコードの先頭サンプルの起動 ID と通し番号**、取り戻した分なら `r`、
 * 遅れて届いた分なら `l` の印。
 *
 * これがあれば、パケットごとの見出し（起動 ID・センサー・番号・件数）とレコードのサンプルを
 * 番号で 1 件ずつ突き合わせられる。時刻で寄せると、取り戻した分が重なったときに見分けられない。
 */
function extraHeadersOf(bootId: string, firstSeq: number, lane: StreamLane): string {
  if (lane === 'backlog') return JSON.stringify({ b: bootId, q: firstSeq, r: 1 })
  if (lane === 'late') return JSON.stringify({ b: bootId, q: firstSeq, l: 1 })
  return JSON.stringify({ b: bootId, q: firstSeq })
}

/** パケットの頭にあたる位置と、そのパケットが名乗った時刻・番号・受け取った時刻。 */
interface Anchor {
  readonly index: number
  readonly t: number
  readonly seq: number
  readonly rx: number
  /**
   * そのサンプルを運んだ**パケットが名乗った時刻**（パケットの途中から始まるときも、頭の時刻）。
   *
   * **どの時のファイルへ入れるかと、正時で切るかはこれで決める。** 外挿した先頭時刻（`t`）で
   * 決めると、正時を跨ぐパケットの途中で 512 バイトに達したとき、残りのレコードだけが次の時の
   * ファイルへ入る —— 同じパケットのサンプルと見出しが 2 つの時に分かれる（実データの 1 日で 1 件起きた）。
   */
  readonly packetT: number
}

interface Stream {
  readonly sourceId: string
  readonly lane: StreamLane
  readonly bootId: string
  rate: number
  questionable: boolean
  pending: number[]
  anchors: Anchor[]
  nextSeq: number | null
  lastRx: number
}

function isInt32(v: number): boolean {
  return Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX
}

/**
 * そのパケットを miniSEED に入れられない理由。入れられるなら `null`。
 *
 * **組み立て（`push`）と突き合わせ（`rawCompare.ts`）が同じ関数を通す** —— 別々に判定すると、
 * 退けたものを「入っているはず」と数えるか、その逆になる。
 */
export function assemblerRejectionOf(packet: SensorPacket): AssemblerRejection | null {
  if (packet.bootId.length > MAX_BOOT_ID_LENGTH) return 'boot-id-too-long'
  for (const ch of packet.channels) {
    if (mseed3SourceId(packet.boardKey, packet.sensorId, ch) === null) return 'no-source-id'
  }
  for (const row of packet.samples) {
    for (const v of row) if (!isInt32(v)) return 'sample-out-of-range'
  }
  return null
}

export class RecordAssembler {
  private readonly maxHoldMs: number
  private readonly forgetAfterMs: number
  private readonly streams = new Map<string, Stream>()
  private readonly cuts = new Map<RecordCutReason, number>()

  constructor(options: RecordAssemblerOptions = {}) {
    this.maxHoldMs = options.maxHoldMs ?? MAX_HOLD_MS_DEFAULT
    this.forgetAfterMs = options.forgetAfterMs ?? FORGET_AFTER_MS_DEFAULT
  }

  /** 切った理由ごとのレコードの本数（このプロセスで）。0 の理由も欠かさず返す。 */
  get cutCounts(): Readonly<Record<RecordCutReason, number>> {
    const out = {} as Record<RecordCutReason, number>
    for (const r of RECORD_CUT_REASONS) out[r] = this.cuts.get(r) ?? 0
    return out
  }

  /** 溜まっていてまだレコードにしていないサンプルの数（全軸の合計）。 */
  get pendingSamples(): number {
    let n = 0
    for (const s of this.streams.values()) n += s.pending.length
    return n
  }

  /** 帳面にある流れの数。 */
  get streamCount(): number {
    return this.streams.size
  }

  push(packet: SensorPacket, lane: RecordLane, receivedAtMs: number): PushResult {
    // **調べ終えてから触る。** 軸の一部だけを溜めると、その軸だけ値があって残りが無い時間ができる。
    const rejected = assemblerRejectionOf(packet)
    if (rejected !== null) return { records: [], rejected }
    // 上で作れることを確かめてある。
    const ids = packet.channels.map((ch) => mseed3SourceId(packet.boardKey, packet.sensorId, ch)!)

    const questionable = packet.firstSampleMs < SYNCED_FROM_MS
    const streamLane = this.laneFor(packet, lane, ids[0]!)
    const out: AssembledRecord[] = []
    ids.forEach((sourceId, j) => {
      const key = `${streamLane}|${packet.bootId}|${sourceId}`
      let s = this.streams.get(key)
      if (s === undefined) {
        s = {
          sourceId,
          lane: streamLane,
          bootId: packet.bootId,
          rate: packet.sampleRateHz,
          questionable,
          pending: [],
          anchors: [],
          nextSeq: null,
          lastRx: receivedAtMs,
        }
        this.streams.set(key, s)
      }
      const breaks = s.pending.length > 0 ? this.breakReason(s, packet, questionable) : null
      if (breaks !== null) this.drain(s, out, breaks)
      if (s.pending.length === 0) {
        s.rate = packet.sampleRateHz
        s.questionable = questionable
      }
      s.anchors.push({
        index: s.pending.length,
        t: packet.firstSampleMs,
        seq: packet.firstSeq,
        rx: receivedAtMs,
        packetT: packet.firstSampleMs,
      })
      for (const row of packet.samples) s.pending.push(row[j]!)
      s.nextSeq = packet.firstSeq + packet.samples.length
      s.lastRx = receivedAtMs
      this.emitFull(s, out)
      if (s.pending.length > 0 && (s.pending.length * 1000) / s.rate >= this.maxHoldMs) this.drain(s, out, 'hold')
    })
    return { records: out, rejected: null }
  }

  /**
   * 受け取ってから長く溜まっている分を書き出し、何も来なくなった流れを帳面から外す。
   * **定期的に呼ぶこと。** 基板が黙ると、溜まった分は次のパケットが来るまで出ていかない。
   */
  tick(nowMs: number): AssembledRecord[] {
    const out: AssembledRecord[] = []
    for (const [key, s] of this.streams) {
      // **溜め始めは、いまの先頭サンプルが入っていたパケットを受け取った時刻で測る。** 満杯で 1 本
      // 出したあとの残りは後から届いた分なので、最初に溜め始めた時刻で測ると、残りが溜まりきる前に
      // 半端なまま書き出される（実データの 1 日で、本数の半分がこれで切れていた）。
      if (s.pending.length > 0 && nowMs - s.anchors[0]!.rx >= this.maxHoldMs) this.drain(s, out, 'idle')
      if (s.pending.length === 0 && nowMs - s.lastRx >= this.forgetAfterMs) this.streams.delete(key)
    }
    return out
  }

  /** 溜めた分を全部出す（締めくくり）。 */
  flushAll(): AssembledRecord[] {
    const out: AssembledRecord[] = []
    for (const s of this.streams.values()) if (s.pending.length > 0) this.drain(s, out, 'flush')
    return out
  }

  /**
   * このパケットを溜める流れの届き方。**いま届いた分のうち、番号がいまの流れの続きより前へ
   * 戻るものは `late` へ回す。** 軸はどれも同じ番号で進むので、1 本目の軸の流れで決めれば足りる
   * （軸ごとに決めると、軸によって行き先が分かれうる）。
   */
  private laneFor(packet: SensorPacket, lane: RecordLane, firstSourceId: string): StreamLane {
    if (lane !== 'live') return lane
    const live = this.streams.get(`live|${packet.bootId}|${firstSourceId}`)
    return live?.nextSeq != null && packet.firstSeq < live.nextSeq ? 'late' : 'live'
  }

  /** このパケットを今のレコードへ繋げない理由。繋げるなら `null`。 */
  private breakReason(s: Stream, p: SensorPacket, questionable: boolean): RecordCutReason | null {
    if (p.firstSeq !== s.nextSeq) return 'seq-gap'
    if (p.sampleRateHz !== s.rate) return 'rate-change'
    // **この行はテストで切り離せない。** 合う前と後の境目（`SYNCED_FROM_MS`）がちょうど正時なので、
    // 下の正時の判定が同じところで先に切る（外挿とのずれの判定も、時計の飛びで先に効く）。
    // それでも残すのは、境目を正時でない値へ変えたときにここが止めるから。
    if (questionable !== s.questionable) return 'clock-sync'
    const period = 1000 / s.rate
    const head = s.anchors[0]!
    const predicted = head.t + s.pending.length * period
    if (Math.abs(p.firstSampleMs - predicted) > TIME_TOLERANCE_SAMPLES * period) return 'time-drift'
    // 時計が合う前の値は正時で切らない（時刻に意味が無い）。
    if (!questionable && Math.floor(p.firstSampleMs / HOUR_MS) !== Math.floor(head.packetT / HOUR_MS)) return 'hour'
    return null
  }

  /**
   * いまの先頭から作るレコードに入れられるフレーム数。**拡張ヘッダの実際の長さから毎回決める**
   * —— 決め打ちの取り置きにすると、番号の桁や起動 ID の長さが取り置きを超えた瞬間に
   * 512 バイトを超え、組み立てが投げる。起動 ID の長さは入口で縛ってあるので 1 以上になる。
   */
  private framesFor(s: Stream): number {
    const extra = extraHeadersOf(s.bootId, s.anchors[0]!.seq, s.lane)
    return framesForRecord(s.sourceId, byteLengthOf(extra))
  }

  /** 満杯になった分だけをレコードにする（残りは溜めたまま）。 */
  private emitFull(s: Stream, out: AssembledRecord[]): void {
    while (s.pending.length > 0) {
      const block = encodeSteim2(Int32Array.from(s.pending), this.framesFor(s))
      if (block.sampleCount >= s.pending.length) return
      out.push(this.record(s, block, block.blocked ? 'value-jump' : 'full'))
      this.consume(s, block.sampleCount)
    }
  }

  /**
   * 溜めた分を全部レコードにする。最後の 1 本は `reason` で切ったもの、それより前は
   * 入りきらずに分かれたもの（`full` か `value-jump`）として数える。
   */
  private drain(s: Stream, out: AssembledRecord[], reason: RecordCutReason): void {
    while (s.pending.length > 0) {
      const block = encodeSteim2(Int32Array.from(s.pending), this.framesFor(s))
      const split = block.sampleCount < s.pending.length
      out.push(this.record(s, block, split ? (block.blocked ? 'value-jump' : 'full') : reason))
      this.consume(s, block.sampleCount)
    }
  }

  private record(s: Stream, block: ReturnType<typeof encodeSteim2>, cut: RecordCutReason): AssembledRecord {
    this.cuts.set(cut, (this.cuts.get(cut) ?? 0) + 1)
    const head = s.anchors[0]!
    const startMs = head.t
    return {
      cut,
      sourceId: s.sourceId,
      lane: s.lane,
      bootId: s.bootId,
      firstSeq: head.seq,
      startMs,
      sampleRateHz: s.rate,
      sampleCount: block.sampleCount,
      timeQuestionable: s.questionable,
      fileAtMs: fileTimeOf(head.packetT, head.rx),
      bytes: buildMseed3Record({
        sourceId: s.sourceId,
        startMs,
        sampleRateHz: s.rate,
        block,
        timeQuestionable: s.questionable,
        extraHeaders: extraHeadersOf(s.bootId, head.seq, s.lane),
      }),
    }
  }

  /**
   * 先頭から n 件を捨て、残りの先頭の時刻と番号を決め直す。
   *
   * **残りの先頭はパケットの途中かもしれない。** そのときはそのパケットが名乗った時刻から
   * 刻みぶん進めた時刻を使う（外挿はパケット 1 つの中だけに留める）。受け取った時刻は
   * そのパケットのものを引き継ぐ。
   */
  private consume(s: Stream, n: number): void {
    s.pending = s.pending.slice(n)
    if (s.pending.length === 0) {
      s.anchors = []
      return
    }
    const period = 1000 / s.rate
    let base: Anchor | null = null
    const rest: Anchor[] = []
    for (const a of s.anchors) {
      if (a.index <= n) base = a
      else rest.push({ ...a, index: a.index - n })
    }
    // `consume` は溜めた分より少ない件数でしか呼ばれず、先頭の印は常に位置 0 にあるので、
    // `base` は必ず見つかる。
    const b = base!
    const offset = n - b.index
    s.anchors = [{ index: 0, t: b.t + offset * period, seq: b.seq + offset, rx: b.rx, packetT: b.packetT }, ...rest]
  }
}
