// 受信の記録（`LOG` チャンネル）を組み立てる。波形のレコード（`recordAssembler.ts`）が持たない
// 事実 —— パケットの区切り・名乗った時刻・受け取った時刻・換算係数など —— を、miniSEED 3 の
// テキストのレコードにして同じ時間のファイルへ入れる。この部品は I/O を持たない。
//
// **なぜ要るか。** 波形のレコードが持つのは先頭の時刻と公称の刻みだけで、そこから外挿した時刻は
// パケットが名乗る時刻から 10 秒で ±20 ms ずれる（実測）。受け取った時刻も残らない。評価台で
// 実機と同じ順・同じ区切りで流し直すにも、受信の遅れを後から調べるにも、パケットごとの記録が要る。
//
// **1 本 = 1 センサー × 1 起動 × 1 届き方の、ひと続きの区間。** 中身は JSON 1 つ:
//
//   { board, boot, sensor, lane, version, type, channels, ugPerLsb, fullScaleG, sampleRateHz,
//     source, ack, seq, time, received, arrival, overflow, packets: [[dq, c, dt, drx, dn, do], ...] }
//
// `seq`・`time`・`received`・`arrival`・`overflow` は先頭のパケットの値。`packets` の i 番目は、1 つ前の
// パケット（先頭は自分自身）からの差分で詰める（1 日 245 万パケットを素の値で持つと嵩が 3 倍になる）:
// - `dq`  番号の飛び。`q[i] = q[i-1] + c[i-1] + dq`（ふだん 0）
// - `c`   サンプル数
// - `dt`  名乗った時刻と外挿のずれ（ミリ秒）。`t[i] = t[i-1] + c[i-1] × 1000 / sampleRateHz + dt`
// - `drx` 受け取った時刻の差（ミリ秒）。`rx[i] = rx[i-1] + drx`。受け取った時刻が判らない区間は `null`
// - `dn`  受付番号の差。`n[i] = n[i-1] + dn`
// - `do`  FIFO があふれた回数の増え。`o[i] = o[i-1] + do`
//
// **受付番号（`arrival`）は、ホストがデータグラムを受け付けた順の通し番号**（起動ごとに 0 から、
// 読めなかったものも含めて 1 つずつ進む）。受け取った時刻はミリ秒までなので、同じミリ秒に届いた
// 別のセンサーのパケットの順はそれだけでは決まらない —— そして観測点の合成はその順でも結果が変わる。
// 流し直す側は「受け取った時刻 → 受付番号」の順で並べれば、実機が処理した順に戻せる。
//
// **1 本ずつで読める形にする**（差分の起点を前のレコードへ持ち越さない）。1 本が壊れても、
// ほかのレコードは単独で読める —— 波形のレコードと同じ考え方。
//
// **切る条件**
// - 固定の値（版・型番・軸・換算係数・刻み・送信元・返事の要否・受け取った時刻の有無）が変わった
// - 番号が戻った（`dq` が負になる。届き方を分けているので通常は起きない）
// - 次の正時を越えた（波形と同じく、パケットが名乗る時刻で測る）
// - 区間の長さが `maxHoldMs` に達した・パケット数が `maxPackets` に達した
// - 受け取ってから `maxHoldMs` 経っても次が来なかった（`tick`）
// - 締めくくり（`flushAll`）

import type { SensorPacket } from '../protocol/types'
import { MSEED3_HOST_LOG_SOURCE_ID, buildMseed3TextRecord, mseed3LogSourceId } from './mseed3Record'
import { fileTimeOf } from './recordAssembler'
import type { StreamLane } from './recordAssembler'

/** 書き出す 1 本。ファイルへ書くのは呼び出し側。 */
export interface LogRecord {
  /** どの時間のファイルへ入れるかを決める時刻（`fileTimeOf` と同じ規則）。 */
  readonly fileAtMs: number
  readonly bytes: Uint8Array
  /** この記録が覆うパケットの数（読めなかったパケットは 1）。 */
  readonly packetCount: number
}

export interface ReceivedPacket {
  readonly packet: SensorPacket
  /** 組み立てが決めた届き方（`PushResult.lane`）。 */
  readonly lane: StreamLane
  /** 受け取った時刻。判らなければ `null`（取り繕わない）。 */
  readonly rx: number | null
  /** 受付番号（ホストが受け付けた順の通し番号。冒頭のコメント）。 */
  readonly arrival: number
  /** 振り分けに使う時刻（`rx` が無ければいまの時刻）。 */
  readonly at: number
  readonly source: string
  readonly ackRequested: boolean
}

export interface ReceptionLogOptions {
  /** 1 本が覆う区間の上限（ミリ秒）。 */
  readonly maxHoldMs?: number
  /** 1 本に入れるパケット数の上限。 */
  readonly maxPackets?: number
  /** 何も来なくなった流れを帳面から外すまで（ミリ秒）。 */
  readonly forgetAfterMs?: number
}

/**
 * 30 秒。波形（5 秒）より長いのは、固定の値を 1 本ごとに繰り返す嵩を抑えるため。
 * 落ちたときに失うのは最後の 30 秒ぶんの区切りと受け取った時刻で、波形そのものは失わない。
 */
const MAX_HOLD_MS_DEFAULT = 30_000
/** 100 Hz・30 サンプルのパケットが 30 秒で 100 個。余裕を見て倍。 */
const MAX_PACKETS_DEFAULT = 200
const FORGET_AFTER_MS_DEFAULT = 60_000
const HOUR_MS = 3_600_000
/** これより前の時刻は「時計が合う前」（`recordAssembler.ts` と同じ境目）。 */
const SYNCED_FROM_MS = Date.UTC(2020, 0, 1)

/** 読めなかったパケット・識別子を作れないパケットの、記録へ残す形。 */
export interface UnreadablePacket {
  readonly rx: number | null
  /** 受付番号（`ReceivedPacket.arrival` と同じ通し番号）。 */
  readonly arrival: number
  /** 振り分けに使う時刻（読めたものは波形の時刻、読めなかったものは受け取った時刻）。 */
  readonly fileAtMs: number
  readonly source: string
  readonly lane: 'live' | 'backlog'
  /** なぜ波形に入れられなかったか（読み取りの失敗理由・組み立てで退けた理由・内部の異常）。 */
  readonly why: string
  /** 中身を丸ごと。 */
  readonly raw: string
}

/**
 * 読めなかったパケット 1 件を、ホストの受信の記録（`FDSN:XX_HOST__L_O_G`）のレコードにする。
 * **1 件 1 本**（めったに起きず、起きたときは 1 件ずつ中身を見たいので、まとめない）。
 */
export function unreadableRecord(u: UnreadablePacket): LogRecord {
  const body = { received: u.rx, arrival: u.arrival, source: u.source, lane: u.lane, why: u.why, raw: u.raw }
  return {
    fileAtMs: u.fileAtMs,
    packetCount: 1,
    bytes: buildMseed3TextRecord({
      sourceId: MSEED3_HOST_LOG_SOURCE_ID,
      startMs: u.fileAtMs,
      text: JSON.stringify(body),
      timeQuestionable: u.rx === null,
    }),
  }
}

/** 1 本の中の固定の値。**どれか 1 つでも変われば切る。** */
interface Constants {
  readonly version: 1 | 2
  readonly type: string
  readonly channels: readonly string[]
  readonly ugPerLsb: number
  readonly fullScaleG: number
  readonly sampleRateHz: number
  readonly source: string
  readonly ack: boolean
  readonly receivedKnown: boolean
  readonly questionable: boolean
}

interface Prev {
  readonly q: number
  readonly c: number
  readonly t: number
  readonly rx: number | null
  readonly n: number
  readonly o: number
}

interface LogStream {
  readonly sourceId: string
  readonly lane: StreamLane
  readonly boardKey: string
  readonly bootId: string
  readonly sensorId: string
  constants: Constants
  constantsKey: string
  head: Prev | null
  prev: Prev | null
  entries: (number | null)[][]
  /** 先頭のパケットで決めたファイルの時刻と、正時の判定に使う時刻。 */
  fileAtMs: number
  headPacketT: number
  /** 先頭のパケットを受け取った時刻（`tick` の待ちの起点）。 */
  headAt: number
  lastAt: number
}

function constantsOf(r: ReceivedPacket): Constants {
  const p = r.packet
  return {
    version: p.version,
    type: p.sensorType,
    channels: p.channels,
    ugPerLsb: p.ugPerLsb,
    fullScaleG: p.fullScaleG,
    sampleRateHz: p.sampleRateHz,
    source: r.source,
    ack: r.ackRequested,
    receivedKnown: r.rx !== null,
    questionable: p.firstSampleMs < SYNCED_FROM_MS,
  }
}

export class ReceptionLog {
  private readonly maxHoldMs: number
  private readonly maxPackets: number
  private readonly forgetAfterMs: number
  private readonly streams = new Map<string, LogStream>()

  constructor(options: ReceptionLogOptions = {}) {
    this.maxHoldMs = options.maxHoldMs ?? MAX_HOLD_MS_DEFAULT
    this.maxPackets = options.maxPackets ?? MAX_PACKETS_DEFAULT
    this.forgetAfterMs = options.forgetAfterMs ?? FORGET_AFTER_MS_DEFAULT
  }

  /** まだ書き出していないパケットの数。 */
  get bufferedPackets(): number {
    let n = 0
    for (const s of this.streams.values()) n += s.entries.length
    return n
  }

  /**
   * 波形へ入れたパケット 1 つを記録する。**識別子を作れるパケットだけを渡すこと**（組み立てが
   * 退けなかったもの）。書き出すべき記録ができたら返す。
   */
  push(r: ReceivedPacket): LogRecord[] {
    const p = r.packet
    // 組み立てが退けなかったパケットなら作れる（同じ規則の識別子）。
    const sourceId = mseed3LogSourceId(p.boardKey, p.sensorId)!
    const key = `${r.lane}|${p.boardKey}|${p.bootId}|${p.sensorId}`
    const constants = constantsOf(r)
    const constantsKey = JSON.stringify(constants)
    const out: LogRecord[] = []
    let s = this.streams.get(key)
    if (s === undefined) {
      s = {
        sourceId,
        lane: r.lane,
        boardKey: p.boardKey,
        bootId: p.bootId,
        sensorId: p.sensorId,
        constants,
        constantsKey,
        head: null,
        prev: null,
        entries: [],
        fileAtMs: 0,
        headPacketT: 0,
        headAt: r.at,
        lastAt: r.at,
      }
      this.streams.set(key, s)
    }
    if (s.entries.length > 0 && this.breaks(s, r, constantsKey)) this.drain(s, out)
    if (s.entries.length === 0) {
      s.constants = constants
      s.constantsKey = constantsKey
    }
    const cur: Prev = { q: p.firstSeq, c: p.samples.length, t: p.firstSampleMs, rx: r.rx, n: r.arrival, o: p.overflowCount }
    if (s.prev === null || s.head === null) {
      s.head = cur
      s.fileAtMs = fileTimeOf(p.firstSampleMs, r.at)
      s.headPacketT = p.firstSampleMs
      s.headAt = r.at
      s.entries.push([0, cur.c, 0, cur.rx === null ? null : 0, 0, 0])
    } else {
      const prev = s.prev
      const period = 1000 / s.constants.sampleRateHz
      s.entries.push([
        cur.q - (prev.q + prev.c),
        cur.c,
        cur.t - (prev.t + prev.c * period),
        cur.rx === null || prev.rx === null ? null : cur.rx - prev.rx,
        cur.n - prev.n,
        cur.o - prev.o,
      ])
    }
    s.prev = cur
    s.lastAt = r.at
    const span = cur.t + cur.c * (1000 / s.constants.sampleRateHz) - s.head!.t
    // **取り戻した分は溜めずにパケットごとに 1 本にする。** 書けたかをその場で確かめて欠けを外すため
    // （`mseedRecorder.ts` の `acceptRecovered`）。1 本ごとに先頭から書くので、1 本だけ書けなくても
    // 残りは単独で読める。
    if (r.lane === 'backlog' || s.entries.length >= this.maxPackets || span >= this.maxHoldMs) this.drain(s, out)
    return out
  }

  /** 受け取ってから長く溜まっている分を書き出し、何も来なくなった流れを外す。**毎秒呼ぶこと。** */
  tick(nowMs: number): LogRecord[] {
    const out: LogRecord[] = []
    for (const [key, s] of this.streams) {
      if (s.entries.length > 0 && nowMs - s.headAt >= this.maxHoldMs) this.drain(s, out)
      if (s.entries.length === 0 && nowMs - s.lastAt >= this.forgetAfterMs) this.streams.delete(key)
    }
    return out
  }

  /** 溜めた分を全部出す（締めくくり）。 */
  flushAll(): LogRecord[] {
    const out: LogRecord[] = []
    for (const s of this.streams.values()) if (s.entries.length > 0) this.drain(s, out)
    return out
  }

  /** このパケットを今の 1 本へ繋げないか。 */
  private breaks(s: LogStream, r: ReceivedPacket, constantsKey: string): boolean {
    if (constantsKey !== s.constantsKey) return true
    const p = r.packet
    const prev = s.prev!
    if (p.firstSeq < prev.q + prev.c) return true
    // 時計が合う前の値は正時で切らない（時刻に意味が無い。波形と同じ）。
    if (!s.constants.questionable && Math.floor(p.firstSampleMs / HOUR_MS) !== Math.floor(s.headPacketT / HOUR_MS)) return true
    return false
  }

  private drain(s: LogStream, out: LogRecord[]): void {
    const head = s.head!
    const c = s.constants
    const body = {
      board: s.boardKey,
      boot: s.bootId,
      sensor: s.sensorId,
      lane: s.lane,
      version: c.version,
      type: c.type,
      channels: c.channels,
      ugPerLsb: c.ugPerLsb,
      fullScaleG: c.fullScaleG,
      sampleRateHz: c.sampleRateHz,
      source: c.source,
      ack: c.ack,
      seq: head.q,
      time: head.t,
      received: head.rx,
      arrival: head.n,
      overflow: head.o,
      packets: s.entries,
    }
    out.push({
      fileAtMs: s.fileAtMs,
      packetCount: s.entries.length,
      bytes: buildMseed3TextRecord({
        sourceId: s.sourceId,
        startMs: head.t,
        text: JSON.stringify(body),
        timeQuestionable: c.questionable,
      }),
    })
    s.entries = []
    s.head = null
    s.prev = null
  }
}
