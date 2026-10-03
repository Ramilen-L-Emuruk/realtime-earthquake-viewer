// NDJSON の生データと、miniSEED 3 ＋パケットの見出しの生データを、1 時間ぶん突き合わせる。
//
// **並行して書いている間に、miniSEED 側だけで元のパケットを組み立て直せるかを確かめる。**
// 合っていれば NDJSON を止めてよい（#477）。照らすのは 4 つ ——
// 1. **同じパケットが両方にあるか。** 鍵は届き方（いま届いた分か取り戻した分か）とヘッダの先頭行。
//    取り戻した分は同じものが 2 度入りうるので、件数ごと数える
// 2. **サンプルが一致するか。** 見出しの基板・起動 ID・センサー・番号・件数から、miniSEED の
//    レコードを番号で引き直して照らす（レコードの拡張ヘッダが起動 ID と先頭の番号を持つ）
// 3. **レコードの先頭時刻が、そのサンプルを運んだパケットの時刻と合うか**
// 4. **読めなかったもの（読み取りの失敗・組み立てで退けたもの）の件数が合うか**
//
// **どの時の分かは書き出し側と同じ関数で決める**（`fileTimeOf`）。

import { parseSensorPacket } from '../protocol/parsePacket'
import type { SensorPacket } from '../protocol/types'
import { jstHourStartMs } from './jstTime'
import type { ParsedMseed3Record } from './mseed3Reader'
import { mseed3SourceId } from './mseed3Record'
import { assemblerRejectionOf, fileTimeOf } from './recordAssembler'

/** NDJSON の 1 行（`rawStore.ts` の封筒）。 */
export interface NdjsonEnvelope {
  readonly rx: number | null
  readonly src: string
  readonly raw: string
  readonly via?: string
}

/** パケットの見出し 1 行（`mseedStore.ts`）。 */
export interface PacketsLine {
  readonly rx: number | null
  readonly src: string
  readonly h: string
  readonly via?: string
}

/** 読めなかったパケット 1 行（`mseedStore.ts`）。 */
export interface UnreadableLine {
  readonly rx: number | null
  readonly src: string
  readonly raw: string
  readonly via?: string
  readonly why: string
}

export interface RawCompareInput {
  /** 照らす時の始まり（unix ミリ秒・日本時間の正時）。 */
  readonly hourStartMs: number
  /** NDJSON の行。**その時より広くてよい**（中で絞る）。 */
  readonly ndjson: Iterable<NdjsonEnvelope>
  readonly records: readonly ParsedMseed3Record[]
  readonly packets: readonly PacketsLine[]
  readonly unreadable: readonly UnreadableLine[]
}

export interface RawCompareResult {
  /** NDJSON にあった、その時の読めたパケット（miniSEED に入るはずのもの）。 */
  readonly ndjsonPackets: number
  /** 見出しにあったパケット。 */
  readonly mseedPackets: number
  /** 両方にあり、サンプル・受け取った時刻・送信元まで一致した数。 */
  readonly matched: number
  /** 両方にあるがサンプルなどが食い違った数。 */
  readonly mismatched: number
  readonly onlyInNdjson: number
  readonly onlyInMseed: number
  /** 先頭時刻がパケットの時刻と合わなかったレコードの数。 */
  readonly recordTimeMismatches: number
  /** 同じ番号に違う値が入っていた数（取り戻した分の重なりなど）。 */
  readonly sampleConflicts: number
  /** NDJSON にあった、その時の読めない・退けられるパケット。 */
  readonly ndjsonUnreadable: number
  readonly mseedUnreadable: number
  /** 受け取った時刻が無く、どの時の分か決められなかった NDJSON の行。 */
  readonly unplaceable: number
  /** 食い違いの例（10 件まで）。 */
  readonly examples: readonly string[]
}

/** 突き合わせの判定。`compare-raw.ts` の終了コードにそのまま使う。 */
export type RawCompareVerdict =
  /** 照らしたものが全部合った。 */
  | 0
  /** 食い違いがある。 */
  | 1
  /**
   * **照らすものが無かった**（NDJSON のファイルが見つからない・その時のパケットが両方とも 0 件）。
   * 何も照らしていないので、「合った」とは言えない。
   */
  | 2

export interface RawCompareVerdictInput {
  readonly result: RawCompareResult
  /** NDJSON のファイルが 1 本でも見つかったか。 */
  readonly ndjsonFound: boolean
  /** miniSEED の検査値が合わなかったレコード・復号できなかったレコードの数。 */
  readonly crcFailures: number
  readonly decodeFailures: number
}

/** 食い違いの件数。0 なら照らしたものは全部合っている。 */
export function discrepancyCount(input: RawCompareVerdictInput): number {
  const r = input.result
  return (
    r.mismatched +
    r.onlyInNdjson +
    r.onlyInMseed +
    r.recordTimeMismatches +
    r.sampleConflicts +
    Math.abs(r.ndjsonUnreadable - r.mseedUnreadable) +
    input.crcFailures +
    input.decodeFailures
  )
}

/**
 * 判定。**食い違いを先に見る** —— NDJSON が無くても miniSEED 側が壊れていれば、それは食い違い。
 * 食い違いが無くても、照らしたパケットが 0 件なら「合った」ではなく 2 を返す（並行運転の間に
 * 0 が続くことを、NDJSON を止めてよい根拠にするため。空振りで 0 が出ると根拠が崩れる）。
 */
export function rawCompareVerdict(input: RawCompareVerdictInput): RawCompareVerdict {
  if (discrepancyCount(input) > 0) return 1
  if (!input.ndjsonFound) return 2
  const r = input.result
  if (r.ndjsonPackets === 0 && r.mseedPackets === 0) return 2
  return 0
}

const MAX_EXAMPLES = 10
/** 先頭時刻の一致とみなす幅（ミリ秒）。ナノ秒への丸めと浮動小数の誤差だけを許す。 */
const TIME_EPSILON_MS = 0.001

function laneOf(via: string | undefined): 'live' | 'backlog' {
  return via === 'backlog' ? 'backlog' : 'live'
}

function headerOf(raw: string): string {
  const end = raw.indexOf('\n')
  return end < 0 ? raw : raw.slice(0, end)
}

interface PendingNd {
  readonly env: NdjsonEnvelope
  readonly packet: SensorPacket
}

export function compareRawHour(input: RawCompareInput): RawCompareResult {
  const { hourStartMs } = input
  const inHour = (ms: number): boolean => jstHourStartMs(ms) === hourStartMs
  const examples: string[] = []
  const note = (s: string): void => {
    if (examples.length < MAX_EXAMPLES) examples.push(s)
  }

  // 1. NDJSON をその時の分へ絞り、読めたものと読めない（退けられる）ものに分ける。
  const nd = new Map<string, PendingNd[]>()
  let ndjsonPackets = 0
  let ndjsonUnreadable = 0
  let unplaceable = 0
  // 番号 → パケット（時刻の照合に使う）。鍵は `識別子|起動 ID|届き方`。
  const packetBySeq = new Map<string, { readonly firstSeq: number; readonly count: number; readonly t: number; readonly hz: number }[]>()
  for (const env of input.ndjson) {
    const read = parseSensorPacket(env.raw)
    const rejected = read.ok ? assemblerRejectionOf(read.packet) : 'unreadable'
    if (env.rx === null) {
      unplaceable += 1
      continue
    }
    // 退避先の振り分けと同じ規則（`mseedRecorder.ts`）: 読めたものは波形の時刻、読めなかったものは受け取った時刻。
    if (!read.ok) {
      if (inHour(env.rx)) ndjsonUnreadable += 1
      continue
    }
    const p = read.packet
    if (rejected !== null) {
      if (inHour(fileTimeOf(p.firstSampleMs, env.rx))) ndjsonUnreadable += 1
      continue
    }
    if (!inHour(fileTimeOf(p.firstSampleMs, env.rx))) continue
    ndjsonPackets += 1
    const key = `${laneOf(env.via)}|${headerOf(env.raw)}`
    const list = nd.get(key)
    if (list === undefined) nd.set(key, [{ env, packet: p }])
    else list.push({ env, packet: p })
    for (const ch of p.channels) {
      const sid = mseed3SourceId(p.boardKey, p.sensorId, ch)!
      const k = `${sid}|${p.bootId}|${laneOf(env.via)}`
      const arr = packetBySeq.get(k)
      const entry = { firstSeq: p.firstSeq, count: p.samples.length, t: p.firstSampleMs, hz: p.sampleRateHz }
      if (arr === undefined) packetBySeq.set(k, [entry])
      else arr.push(entry)
    }
  }

  // 2. miniSEED のレコードから、番号 → 値の表を作る。
  const values = new Map<string, Map<number, number>>()
  let sampleConflicts = 0
  let recordTimeMismatches = 0
  for (const r of input.records) {
    const extra = r.extra as { b?: unknown; q?: unknown; r?: unknown } | null | undefined
    if (r.samples === null || extra === null || extra === undefined || typeof extra.b !== 'string' || typeof extra.q !== 'number') {
      note(`拡張ヘッダか中身を読めないレコード（${r.sourceId}・位置 ${r.offset}）`)
      continue
    }
    // 遅れて届いた分（`l`）は、見出しの側ではいま届いた分と区別していないので、同じ表へ入れる。
    // 重なって届いたパケットの値が違えば、下で番号の衝突として数える。
    const lane = extra.r === 1 ? 'backlog' : 'live'
    const k = `${r.sourceId}|${extra.b}|${lane}`
    let m = values.get(k)
    if (m === undefined) {
      m = new Map()
      values.set(k, m)
    }
    for (let i = 0; i < r.samples.length; i++) {
      const seq = extra.q + i
      const prev = m.get(seq)
      if (prev !== undefined && prev !== r.samples[i]) {
        sampleConflicts += 1
        note(`同じ番号に違う値（${k}・番号 ${seq}: ${prev} と ${r.samples[i]}）`)
      }
      m.set(seq, r.samples[i]!)
    }
    // 3. 先頭時刻を、その番号を運んだパケットの時刻と照らす（時計が合う前の値は除く）。
    if (!r.timeQuestionable) {
      const owner = packetBySeq.get(k)?.find((e) => extra.q as number >= e.firstSeq && (extra.q as number) < e.firstSeq + e.count)
      if (owner !== undefined) {
        const expected = owner.t + (((extra.q as number) - owner.firstSeq) * 1000) / owner.hz
        if (Math.abs(r.startMs - expected) > TIME_EPSILON_MS) {
          recordTimeMismatches += 1
          note(`先頭時刻が合わない（${k}・番号 ${extra.q}: ${r.startMs} と ${expected}）`)
        }
      }
    }
  }

  // 4. 見出しの各行から組み立て直し、NDJSON と照らす。
  let mseedPackets = 0
  let matched = 0
  let mismatched = 0
  let onlyInMseed = 0
  for (const line of input.packets) {
    mseedPackets += 1
    const key = `${laneOf(line.via)}|${line.h}`
    const list = nd.get(key)
    const counterpart = list?.shift()
    if (counterpart === undefined) {
      onlyInMseed += 1
      note(`見出しにだけある: ${line.h.slice(0, 120)}`)
      continue
    }
    const p = counterpart.packet
    const problems: string[] = []
    if (line.rx !== counterpart.env.rx) problems.push(`受け取った時刻 ${line.rx} と ${counterpart.env.rx}`)
    if (line.src !== counterpart.env.src) problems.push(`送信元 ${line.src} と ${counterpart.env.src}`)
    p.channels.forEach((ch, j) => {
      const sid = mseed3SourceId(p.boardKey, p.sensorId, ch)!
      const m = values.get(`${sid}|${p.bootId}|${laneOf(line.via)}`)
      for (let i = 0; i < p.samples.length; i++) {
        const got = m?.get(p.firstSeq + i)
        const want = p.samples[i]![j]!
        if (got !== want) {
          problems.push(`${ch} 番号 ${p.firstSeq + i}: miniSEED ${got} と NDJSON ${want}`)
          break
        }
      }
    })
    if (problems.length === 0) matched += 1
    else {
      mismatched += 1
      note(`食い違い（${p.boardKey} ${p.sensorId} 番号 ${p.firstSeq}）: ${problems.join(' / ')}`)
    }
  }
  let onlyInNdjson = 0
  for (const [, list] of nd) {
    for (const rest of list) {
      onlyInNdjson += 1
      note(`NDJSON にだけある: ${headerOf(rest.env.raw).slice(0, 120)}`)
    }
  }

  const mseedUnreadable = input.unreadable.filter((u) => u.rx !== null && inHour(u.rx)).length
  if (mseedUnreadable !== ndjsonUnreadable) note(`読めなかったものの件数が合わない（NDJSON ${ndjsonUnreadable}・miniSEED 側 ${mseedUnreadable}）`)

  return {
    ndjsonPackets,
    mseedPackets,
    matched,
    mismatched,
    onlyInNdjson,
    onlyInMseed,
    recordTimeMismatches,
    sampleConflicts,
    ndjsonUnreadable,
    mseedUnreadable,
    unplaceable,
    examples,
  }
}
