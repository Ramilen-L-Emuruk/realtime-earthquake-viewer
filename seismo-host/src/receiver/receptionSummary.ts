// 生データの時のファイル 1 本の「どう届いたか」の要約。管理コンソールの「波形の記録」で、時間軸に
// 受信の記録の帯（取り戻した分・遅れて届いた分・時刻が疑わしい分・読めなかったパケット）を重ねる材料。
//
// **何日ぶんを重ねても重くならないよう、前もって作る**（波形の要約 `waveSummary.ts` と同じ係が、
// 同じ読み込みのついでに作る）。生データの時のファイルを開いて組み立て直すと 1 時間あたり 1 秒近くかかる。
//
// **拾うのはレコードが持っている印だけ。** 届き方は波形のレコードの拡張ヘッダ（`recordAssembler.ts`
// の `r`・`l`）、時刻の疑わしさは miniSEED の旗、読めなかったパケットはホストの受信の記録
// （`receptionLog.ts` の `unreadableRecord`）。パケットの組み立て直し（`mseedPacketReader.ts`）は要らない。
//
// **区間はセンサーごとに 1 本へ重ねる**（3 軸のレコードは同じ時刻を覆うので、軸ごとに持つと 3 倍になるだけ）。
// 1 秒より近い区間は繋ぐ（レコードの継ぎ目ごとに区間が割れると、1 時間で数百本になる）。

import type { ParsedMseed3Record } from './mseed3Reader'
import { MSEED3_HOST_LOG_SOURCE_ID } from './mseed3Record'
import { laneOfRecord } from './mseedPacketReader'

const ENCODING_TEXT = 0
const ENCODING_STEIM2 = 11
const FORMAT_VERSION = 1

/** これより近い区間は繋ぐ。 */
export const RECEPTION_MERGE_GAP_MS = 1000
/** 1 時間に残す、読めなかったパケットの件数の上限（件数そのものは全部数える）。 */
export const UNREADABLE_ITEMS_MAX = 500
/** 理由の文の長さの上限。 */
const WHY_MAX_CHARS = 200

export interface ReceptionSpan {
  readonly fromMs: number
  readonly toMs: number
}

export interface SensorReception {
  /** センサーの識別子（波形の識別子から向きを除いたもの: `FDSN:XX_<局>_<センサー>`）。 */
  readonly sensor: string
  /** 欠けを基板から取り戻した分。 */
  readonly backlog: ReceptionSpan[]
  /** 遅れて届いた分（区間を閉じたあとに届いた）。 */
  readonly late: ReceptionSpan[]
  /** 時刻が疑わしいと印の付いた分。 */
  readonly questionable: ReceptionSpan[]
}

export interface UnreadableEntry {
  /** 記録した時刻（受け取った時刻。判らなければ振り分けに使った時刻）。 */
  readonly atMs: number
  /** 受け取った時刻。判らなければ `null`。 */
  readonly rxMs: number | null
  readonly lane: 'live' | 'backlog'
  readonly why: string
}

export interface ReceptionSummary {
  /** 作ったときの元のファイルの大きさ（要約が古いかを見る）。 */
  readonly sourceBytes: number
  readonly sensors: SensorReception[]
  /** 読めなかったパケット。`items` は先頭から {@link UNREADABLE_ITEMS_MAX} 件まで。 */
  readonly unreadable: { readonly count: number; readonly items: UnreadableEntry[] }
  /** 中身を読めなかったホストの受信の記録の本数（読めなかったパケットの数に入っていない）。 */
  readonly unreadableLogs: number
}

/** 波形の識別子（`…_H_N_Z`）からセンサーの識別子（`…`）。 */
export function sensorOfSourceId(sourceId: string): string {
  return sourceId.replace(/_[A-Za-z0-9]_[A-Za-z0-9]_[A-Za-z0-9]$/, '')
}

/** 区間を並べて、近いものを繋ぐ。 */
export function mergeSpans(spans: readonly ReceptionSpan[], gapMs = RECEPTION_MERGE_GAP_MS): ReceptionSpan[] {
  const sorted = spans.filter((s) => Number.isFinite(s.fromMs) && Number.isFinite(s.toMs) && s.toMs >= s.fromMs).slice()
  sorted.sort((a, b) => a.fromMs - b.fromMs)
  const out: ReceptionSpan[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && s.fromMs - last.toMs <= gapMs) {
      out[out.length - 1] = { fromMs: last.fromMs, toMs: Math.max(last.toMs, s.toMs) }
    } else {
      out.push({ fromMs: s.fromMs, toMs: s.toMs })
    }
  }
  return out
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 読んだレコードから要約を作る。投げない。 */
export function summarizeReception(records: readonly ParsedMseed3Record[], sourceBytes: number): ReceptionSummary {
  const bySensor = new Map<string, { backlog: ReceptionSpan[]; late: ReceptionSpan[]; questionable: ReceptionSpan[] }>()
  const items: UnreadableEntry[] = []
  let count = 0
  let unreadableLogs = 0
  for (const r of records) {
    if (r.encoding === ENCODING_TEXT) {
      if (r.sourceId !== MSEED3_HOST_LOG_SOURCE_ID) continue
      if (r.text === null) {
        unreadableLogs += 1
        continue
      }
      let o: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(r.text)
        if (parsed === null || typeof parsed !== 'object') {
          unreadableLogs += 1
          continue
        }
        o = parsed as Record<string, unknown>
      } catch {
        unreadableLogs += 1
        continue
      }
      count += 1
      if (items.length < UNREADABLE_ITEMS_MAX) {
        items.push({
          atMs: r.startMs,
          rxMs: isFiniteNumber(o.received) ? o.received : null,
          lane: o.lane === 'backlog' ? 'backlog' : 'live',
          why: String(o.why ?? '').slice(0, WHY_MAX_CHARS),
        })
      }
      continue
    }
    if (r.encoding !== ENCODING_STEIM2 || !(r.sampleRateHz > 0)) continue
    const lane = laneOfRecord(r)
    if (lane !== 'backlog' && lane !== 'late' && !r.timeQuestionable) continue
    const sensor = sensorOfSourceId(r.sourceId)
    let entry = bySensor.get(sensor)
    if (entry === undefined) {
      entry = { backlog: [], late: [], questionable: [] }
      bySensor.set(sensor, entry)
    }
    const span = { fromMs: r.startMs, toMs: r.startMs + (r.sampleCount * 1000) / r.sampleRateHz }
    if (lane === 'backlog') entry.backlog.push(span)
    if (lane === 'late') entry.late.push(span)
    if (r.timeQuestionable) entry.questionable.push(span)
  }
  const sensors: SensorReception[] = [...bySensor.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sensor, e]) => ({
      sensor,
      backlog: mergeSpans(e.backlog),
      late: mergeSpans(e.late),
      questionable: mergeSpans(e.questionable),
    }))
  items.sort((a, b) => a.atMs - b.atMs)
  return { sourceBytes, sensors, unreadable: { count, items }, unreadableLogs }
}

/** 書く。 */
export function encodeReceptionSummary(summary: ReceptionSummary): string {
  return JSON.stringify({ version: FORMAT_VERSION, ...summary })
}

function isSpanList(v: unknown): v is ReceptionSpan[] {
  return Array.isArray(v) && v.every((s) => s !== null && typeof s === 'object' && isFiniteNumber((s as ReceptionSpan).fromMs) && isFiniteNumber((s as ReceptionSpan).toMs))
}

/**
 * 読む。**版・欄の形のどれかが合わなければ `null`**（作り直せばよい。部分的に信じると、帯が欠けて
 * 「何も起きていない」に見える）。投げない。
 */
export function decodeReceptionSummary(text: string): ReceptionSummary | null {
  let o: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return null
    o = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (o.version !== FORMAT_VERSION || !isFiniteNumber(o.sourceBytes) || !isFiniteNumber(o.unreadableLogs)) return null
  if (!Array.isArray(o.sensors)) return null
  const sensors: SensorReception[] = []
  for (const s of o.sensors as unknown[]) {
    if (s === null || typeof s !== 'object') return null
    const e = s as Record<string, unknown>
    if (typeof e.sensor !== 'string' || !isSpanList(e.backlog) || !isSpanList(e.late) || !isSpanList(e.questionable)) return null
    sensors.push({ sensor: e.sensor, backlog: e.backlog, late: e.late, questionable: e.questionable })
  }
  const u = o.unreadable as Record<string, unknown> | null | undefined
  if (u === null || typeof u !== 'object' || !isFiniteNumber(u.count) || !Array.isArray(u.items)) return null
  const items: UnreadableEntry[] = []
  for (const it of u.items as unknown[]) {
    if (it === null || typeof it !== 'object') return null
    const e = it as Record<string, unknown>
    if (!isFiniteNumber(e.atMs) || !(e.rxMs === null || isFiniteNumber(e.rxMs)) || typeof e.why !== 'string') return null
    if (e.lane !== 'live' && e.lane !== 'backlog') return null
    items.push({ atMs: e.atMs, rxMs: e.rxMs as number | null, lane: e.lane, why: e.why })
  }
  return { sourceBytes: o.sourceBytes, sensors, unreadable: { count: u.count, items }, unreadableLogs: o.unreadableLogs }
}
