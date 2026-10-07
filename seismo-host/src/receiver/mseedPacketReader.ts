// miniSEED 3 の生データ（`mseedStore.ts` が書いた 1 時間 1 本）から、届いたパケットを組み立て直す。
// 評価台（`bench/`）がこれを通して、実機の受信と同じ順・同じ区切りで流し直す。
//
// **組み立て方**
// 1. 波形のレコードを、流れ（届き方 × 起動 × 識別子）ごとに「先頭の通し番号 → サンプル」の区間として持つ
//    （拡張ヘッダの起動 ID・先頭番号・届き方の印で引く。`recordAssembler.ts`）
// 2. 受信の記録（`LOG`）を開き、差分を足し直してパケットごとの番号・サンプル数・名乗った時刻・
//    受け取った時刻を戻す（`receptionLog.ts`）
// 3. パケットの番号の範囲を、軸ごとの区間から切り出してサンプルにする
//
// **合わないものは黙って捨てない。** 受信の記録にあるのにサンプルが揃わないパケット・読めない
// 受信の記録は数えて返す。波形はあるのに受信の記録に載っていないサンプル（落ちて最後の記録を
// 書けなかった区間）も数える —— 区切りは戻せないが、波形そのものは失っていない。

import type { SensorPacket } from '../protocol/types'
import { readMseed3Records, readMseed3RecordsWhere } from './mseed3Reader'
import type { Mseed3ReadResult, ParsedMseed3Record } from './mseed3Reader'
import { MSEED3_EXTRA_NAMESPACE, MSEED3_HOST_LOG_SOURCE_ID, mseed3SourceId } from './mseed3Record'
import type { StreamLane } from './recordAssembler'

const ENCODING_TEXT = 0
const ENCODING_STEIM2 = 11

/** 組み立て直した 1 パケットと、受け取ったときの事実。 */
export interface StoredPacket {
  readonly packet: SensorPacket
  readonly lane: StreamLane
  /** 受け取った時刻。記録に無ければ `null`。 */
  readonly rx: number | null
  /** 受付番号（ホストが受け付けた順の通し番号。`receptionLog.ts` 冒頭）。 */
  readonly arrival: number
  readonly source: string
  readonly ackRequested: boolean
}

/** 波形へ入れられなかったパケット（ホストの受信の記録）。 */
export interface StoredUnreadable {
  readonly rx: number | null
  readonly arrival: number
  readonly source: string
  readonly lane: 'live' | 'backlog'
  readonly why: string
  readonly raw: string
}

export interface MseedHourRead {
  /** **ファイルの中の並び順**（受け取った順に並べ替えるのは `orderByReceipt`）。 */
  readonly packets: readonly StoredPacket[]
  readonly unreadable: readonly StoredUnreadable[]
  readonly crcFailures: number
  readonly decodeFailures: number
  /** 末尾で読まなかったバイト数。**0 なら全部を最後まで読めた。** */
  readonly skippedBytes: number
  /** 中身を読めなかった受信の記録の本数（JSON として読めない・欄が欠けている）。 */
  readonly unreadableLogs: number
  /**
   * 起動 ID・先頭の番号を読めなかった波形のレコードの本数（拡張ヘッダにこの観測網の欄が無い・形が違う）。
   * 番号で受信の記録と対応させられないので組み立てには使えないが、黙って捨てずに数える。
   */
  readonly unreadableWaveRecords: number
  /** 受信の記録にあるのに、サンプルが揃わなかったパケットの数（組み立て直さずに飛ばした）。 */
  readonly incompletePackets: number
  /** 波形にあるのに、どのパケットにも属さなかったサンプルの数（全軸の合計）。 */
  readonly unclaimedSamples: number
}

interface Segment {
  readonly firstSeq: number
  readonly samples: Int32Array
  claimed: Uint8Array
}

function laneOfExtra(e: { r?: unknown; l?: unknown }): StreamLane {
  if (e.r === 1) return 'backlog'
  if (e.l === 1) return 'late'
  return 'live'
}

/** 波形のレコードの拡張ヘッダから、起動 ID・先頭番号・届き方。読めなければ `null`。 */
function waveKeyOf(r: ParsedMseed3Record): { boot: string; seq: number; lane: StreamLane } | null {
  if (r.extra === null || typeof r.extra !== 'object') return null
  const ns = (r.extra as Record<string, unknown>)[MSEED3_EXTRA_NAMESPACE]
  if (ns === null || typeof ns !== 'object') return null
  const e = ns as { b?: unknown; q?: unknown; r?: unknown; l?: unknown }
  if (typeof e.b !== 'string' || typeof e.q !== 'number' || !Number.isInteger(e.q)) return null
  return { boot: e.b, seq: e.q, lane: laneOfExtra(e) }
}

/** 波形のレコードの届き方（拡張ヘッダの印）。印を読めなければ `null`。 */
export function laneOfRecord(r: ParsedMseed3Record): StreamLane | null {
  return waveKeyOf(r)?.lane ?? null
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

interface LogBody {
  readonly board: string
  readonly boot: string
  readonly sensor: string
  readonly lane: StreamLane
  readonly version: 1 | 2
  readonly type: string
  readonly channels: readonly string[]
  readonly ugPerLsb: number
  readonly fullScaleG: number
  readonly sampleRateHz: number
  readonly source: string
  readonly ack: boolean
  readonly seq: number
  readonly time: number
  readonly received: number | null
  readonly arrival: number
  readonly overflow: number
  readonly packets: readonly (readonly (number | null)[])[]
}

/** 受信の記録の中身。欄が揃っていなければ `null`（読めなかったと数える）。 */
function logBodyOf(text: string): LogBody | null {
  let o: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return null
    o = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const lanes: readonly StreamLane[] = ['live', 'backlog', 'late']
  if (
    typeof o.board !== 'string' ||
    typeof o.boot !== 'string' ||
    typeof o.sensor !== 'string' ||
    !lanes.includes(o.lane as StreamLane) ||
    (o.version !== 1 && o.version !== 2) ||
    typeof o.type !== 'string' ||
    !Array.isArray(o.channels) ||
    !o.channels.every((c) => typeof c === 'string') ||
    !isFiniteNumber(o.ugPerLsb) ||
    !isFiniteNumber(o.fullScaleG) ||
    !isFiniteNumber(o.sampleRateHz) ||
    o.sampleRateHz <= 0 ||
    typeof o.source !== 'string' ||
    typeof o.ack !== 'boolean' ||
    !isFiniteNumber(o.seq) ||
    !isFiniteNumber(o.time) ||
    !(o.received === null || isFiniteNumber(o.received)) ||
    !isFiniteNumber(o.arrival) ||
    !isFiniteNumber(o.overflow) ||
    !Array.isArray(o.packets)
  ) {
    return null
  }
  for (const p of o.packets as unknown[]) {
    if (!Array.isArray(p) || p.length !== 6) return null
    const [dq, c, dt, drx, dn, dov] = p as unknown[]
    if (!isFiniteNumber(dq) || !isFiniteNumber(c) || c <= 0 || !Number.isInteger(c) || !isFiniteNumber(dt)) return null
    if (!(drx === null || isFiniteNumber(drx)) || !isFiniteNumber(dn) || !isFiniteNumber(dov)) return null
  }
  return o as unknown as LogBody
}

/** 区間の中から、番号 `seq` から `count` 件を切り出す。揃わなければ `null`。 */
function take(segments: readonly Segment[] | undefined, seq: number, count: number): Int32Array | null {
  if (segments === undefined) return null
  const out = new Int32Array(count)
  let got = 0
  // 区間は短いので素直に探す（1 時間の 1 軸で数百本）。番号は区間の中で連続している。
  for (const s of segments) {
    const end = s.firstSeq + s.samples.length
    const from = Math.max(seq + got, s.firstSeq)
    if (from !== seq + got || from >= end) continue
    const n = Math.min(count - got, end - from)
    out.set(s.samples.subarray(from - s.firstSeq, from - s.firstSeq + n), got)
    got += n
    if (got === count) return out
  }
  return null
}

/** 切り出した範囲に、どのパケットに属したかの印を付ける（属さなかったサンプルを数えるため）。 */
function claim(segments: readonly Segment[], seq: number, count: number): void {
  for (const s of segments) {
    const end = s.firstSeq + s.samples.length
    const from = Math.max(seq, s.firstSeq)
    const to = Math.min(seq + count, end)
    for (let i = from; i < to; i++) s.claimed[i - s.firstSeq] = 1
  }
}

/** 1 時間の 1 本を読む。**投げない。** */
export function readMseedHour(buf: Uint8Array): MseedHourRead {
  return assemblePackets(readMseed3Records(buf))
}

/**
 * レコードが覆いうる最長の長さ。受信の記録（`receptionLog.ts` の `MAX_HOLD_MS_DEFAULT`）が 30 秒、
 * 波形（`recordAssembler.ts` の `MAX_HOLD_MS_DEFAULT`）が 5 秒。**区間の手前でこれだけ広く拾う** ——
 * 先頭の時刻だけで切ると、区間の頭のパケットの受信の記録が手前のレコードにいて落ちる。
 */
export const RECORD_SPAN_MAX_MS = 35_000

/**
 * 1 本のうち、`[fromMs, toMs)` に掛かりうるレコードだけを読んでパケットに組み直す。**投げない。**
 *
 * 範囲の外のパケットも混ざって返る（レコードの単位で拾うため）。使う側が時刻で選ぶこと。
 * 区間の手前でレコードを切った分は、サンプルの揃わないパケット（`incompletePackets`）や
 * どこにも属さないサンプル（`unclaimedSamples`）として数えられうる —— 範囲の外の話なので、
 * 区間の中の欠けと取り違えないこと。
 */
export function readMseedRange(buf: Uint8Array, fromMs: number, toMs: number): MseedHourRead {
  return assemblePackets(readMseed3RecordsWhere(buf, (startMs) => startMs >= fromMs - RECORD_SPAN_MAX_MS && startMs < toMs))
}

function assemblePackets(read: Mseed3ReadResult): MseedHourRead {
  const segments = new Map<string, Segment[]>()
  const logs: string[] = []
  const unreadable: StoredUnreadable[] = []
  let unreadableLogs = 0
  let unreadableWaveRecords = 0

  for (const r of read.records) {
    if (r.encoding === ENCODING_STEIM2 && r.samples !== null) {
      const k = waveKeyOf(r)
      if (k === null) {
        unreadableWaveRecords += 1
        continue
      }
      const key = `${k.lane}|${k.boot}|${r.sourceId}`
      const list = segments.get(key) ?? []
      list.push({ firstSeq: k.seq, samples: r.samples, claimed: new Uint8Array(r.samples.length) })
      segments.set(key, list)
      continue
    }
    if (r.encoding !== ENCODING_TEXT || r.text === null) continue
    if (r.sourceId === MSEED3_HOST_LOG_SOURCE_ID) {
      try {
        const o = JSON.parse(r.text) as Record<string, unknown>
        if (!isFiniteNumber(o.arrival)) {
          unreadableLogs += 1
          continue
        }
        unreadable.push({
          rx: isFiniteNumber(o.received) ? o.received : null,
          arrival: o.arrival,
          source: String(o.source),
          lane: o.lane === 'backlog' ? 'backlog' : 'live',
          why: String(o.why),
          raw: String(o.raw),
        })
      } catch {
        unreadableLogs += 1
      }
      continue
    }
    logs.push(r.text)
  }
  for (const list of segments.values()) list.sort((a, b) => a.firstSeq - b.firstSeq)

  const packets: StoredPacket[] = []
  let incompletePackets = 0
  for (const text of logs) {
    const b = logBodyOf(text)
    if (b === null) {
      unreadableLogs += 1
      continue
    }
    const period = 1000 / b.sampleRateHz
    const ids = b.channels.map((ch) => mseed3SourceId(b.board, b.sensor, ch))
    let q = b.seq
    let t = b.time
    let rx = b.received
    let n = b.arrival
    let o = b.overflow
    let prevC = 0
    b.packets.forEach(([dq, c, dt, drx, dn, dov], i) => {
      if (i > 0) {
        q = q + prevC + dq!
        t = t + prevC * period + dt!
        rx = rx === null || drx === null ? null : rx + drx!
        n = n + dn!
        o = o + dov!
      }
      prevC = c!
      const columns = ids.map((id) => (id === null ? null : take(segments.get(`${b.lane}|${b.boot}|${id}`), q, c!)))
      if (columns.some((col) => col === null)) {
        incompletePackets += 1
        return
      }
      ids.forEach((id) => claim(segments.get(`${b.lane}|${b.boot}|${id!}`)!, q, c!))
      const samples: number[][] = Array.from({ length: c! }, (_, row) => columns.map((col) => col![row]!))
      packets.push({
        packet: {
          version: b.version,
          boardKey: b.board as SensorPacket['boardKey'],
          bootId: b.boot,
          sensorId: b.sensor,
          sensorType: b.type,
          channels: b.channels,
          ugPerLsb: b.ugPerLsb,
          fullScaleG: b.fullScaleG,
          sampleRateHz: b.sampleRateHz,
          firstSampleMs: t,
          firstSeq: q,
          overflowCount: o,
          samples,
        },
        lane: b.lane,
        rx,
        arrival: n,
        source: b.source,
        ackRequested: b.ack,
      })
    })
  }

  let unclaimedSamples = 0
  for (const list of segments.values()) {
    for (const s of list) for (const c of s.claimed) if (c === 0) unclaimedSamples += 1
  }

  return {
    packets,
    unreadable,
    crcFailures: read.crcFailures,
    decodeFailures: read.decodeFailures,
    skippedBytes: read.skippedBytes,
    unreadableLogs,
    unreadableWaveRecords,
    incompletePackets,
    unclaimedSamples,
  }
}

/**
 * 受け取った順に並べる（実機の受信の鎖へ流し直す順）。受け取った時刻が無いものは名乗った時刻で
 * 並べる。**同じ時刻なら受付番号で並べる** —— 受け取った時刻はミリ秒までなので、同じミリ秒に
 * 届いた別のセンサーのパケットの順はそれだけでは戻らず、観測点の合成はその順でも結果が変わる。
 * 受付番号はホストの起動ごとに 0 へ戻るが、起動をまたいで同じミリ秒になることは無い。
 */
export function orderByReceipt(packets: readonly StoredPacket[]): StoredPacket[] {
  return [...packets].sort(
    (a, b) => (a.rx ?? a.packet.firstSampleMs) - (b.rx ?? b.packet.firstSampleMs) || a.arrival - b.arrival,
  )
}
