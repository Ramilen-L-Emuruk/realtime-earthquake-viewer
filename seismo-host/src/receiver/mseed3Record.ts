// miniSEED 3 のレコードを 1 本組み立てる（FDSN miniSEED 3 の定義）。
//
// 形: 40 バイトの固定ヘッダ → 識別子（FDSN の Source Identifier）→ 拡張ヘッダ（JSON）→
// データ部（Steim2）。**ヘッダは小さいバイト順、Steim2 のデータ部は大きいバイト順。**
// CRC は CRC 欄を 0 にした記録全体の CRC-32C。
//
// **1 本を 512 バイトまでにする**（2026-10-03 決定）。1 本ずつが自分の先頭値・末尾値・CRC を
// 持つので、細かく切っても誤りは増えない —— 書きかけで落ちたときに失うのが 1 本だけになる。
// 代わりに 1 本ごとに約 100 バイトの見出しが付く（固定部 40・識別子 30・拡張ヘッダ 27 前後）。

import { crc32c } from './crc32c'
import type { Steim2Block } from './steim2'

export const MSEED3_MAX_RECORD_BYTES = 512

const FIXED_HEADER_BYTES = 40
const FRAME_BYTES = 64
const ENCODING_STEIM2 = 11
/** データの版。**生データなので 1**（後から作り直した版を区別するための欄）。 */
const PUBLICATION_VERSION = 1
/** 旗のビット 1: 時刻が疑わしい。 */
const FLAG_TIME_QUESTIONABLE = 0b10

/** ネットワーク。FDSN へ登録していない観測網なので `XX`。 */
const NETWORK = 'XX'

const STATION_RE = /^[A-Z0-9-]{1,8}$/
const LOCATION_RE = /^[A-Z0-9-]{0,8}$/
const CHANNEL_RE = /^[A-Z0-9]{3}$/
const MAC_RE = /^mac:([0-9a-f]{12})$/

/**
 * 識別子 `FDSN:XX_<MAC の下位 8 桁>_<センサー ID>_<帯域>_<種別>_<向き>` を作る。
 *
 * **観測点の設定の ID は使わない。** 基板を別の観測点へ移した日を境に、同じ名前が別の場所の
 * 波形を指すようになる（`../protocol/types.ts` が名前で引かないのと同じ理由）。
 * いつどの観測点にあったかは、観測点の設定の履歴の側で引く。
 *
 * 作れないとき（MAC を名乗らない版 1 の基板・規則に収まらない ID）は `null`。
 * **呼び出し側はそのパケットを miniSEED に入れず、別に残す** —— 黙って捨てない。
 */
export function mseed3SourceId(boardKey: string, sensorId: string, channel: string): string | null {
  const mac = MAC_RE.exec(boardKey)?.[1]
  if (mac === undefined) return null
  const station = mac.slice(-8).toUpperCase()
  const location = sensorId.toUpperCase()
  const cha = channel.toUpperCase()
  if (!STATION_RE.test(station)) return null
  // 規格は「--」だけをロケーションとして禁じている（空の印と紛れるため）。
  if (!LOCATION_RE.test(location) || location === '--') return null
  if (!CHANNEL_RE.test(cha)) return null
  return `FDSN:${NETWORK}_${station}_${location}_${cha[0]}_${cha[1]}_${cha[2]}`
}

/**
 * その識別子と拡張ヘッダの長さで 512 バイトに収まる、データ部の最大のフレーム数。
 * `extraHeaderBytes` は**最長になりうる長さ**を渡すこと（実際の長さで決めると、
 * 番号の桁が増えた瞬間に 512 バイトを超える）。
 */
export function framesForRecord(sourceId: string, extraHeaderBytes = 0): number {
  return Math.floor((MSEED3_MAX_RECORD_BYTES - FIXED_HEADER_BYTES - byteLengthOf(sourceId) - extraHeaderBytes) / FRAME_BYTES)
}

function byteLengthOf(s: string): number {
  return new TextEncoder().encode(s).byteLength
}

export interface Mseed3RecordInput {
  readonly sourceId: string
  /** 先頭サンプルの時刻（unix ミリ秒・端数可）。 */
  readonly startMs: number
  readonly sampleRateHz: number
  readonly block: Steim2Block
  /** 時刻が疑わしい（基板の時計が合う前の値）。旗のビット 1 を立てる。 */
  readonly timeQuestionable?: boolean
  /** 拡張ヘッダ（JSON の文字列）。無ければ 0 バイト。 */
  readonly extraHeaders?: string
}

interface TimeFields {
  readonly year: number
  readonly dayOfYear: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly nanosecond: number
}

/**
 * unix ミリ秒を、ヘッダの時刻の欄へ分ける。
 *
 * **ナノ秒は秒の端数だけから作る。** `startMs * 1e6` は 2^53 を超えて下の桁が落ちるので、
 * 秒までを整数で切り出してから残りを換算する。繰り上がり（端数が 999999999.5 ns 以上）は
 * 次の秒へ送る。
 */
function timeFieldsOf(startMs: number): TimeFields {
  let seconds = Math.floor(startMs / 1000)
  let nanosecond = Math.round((startMs - seconds * 1000) * 1e6)
  if (nanosecond >= 1e9) {
    seconds += 1
    nanosecond -= 1e9
  }
  const d = new Date(seconds * 1000)
  const year = d.getUTCFullYear()
  const dayOfYear = Math.floor((Date.UTC(year, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(year, 0, 1)) / 86_400_000) + 1
  return { year, dayOfYear, hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), nanosecond }
}

export function buildMseed3Record(input: Mseed3RecordInput): Uint8Array {
  const { sourceId, startMs, sampleRateHz, block } = input
  if (!Number.isFinite(startMs) || startMs < 0) throw new RangeError(`先頭の時刻が不正: ${startMs}`)
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) throw new RangeError(`刻みが不正: ${sampleRateHz}`)
  const sid = new TextEncoder().encode(sourceId)
  if (sid.byteLength === 0 || sid.byteLength > 255) throw new RangeError(`識別子の長さが不正: ${sid.byteLength}`)
  const extra = new TextEncoder().encode(input.extraHeaders ?? '')
  if (extra.byteLength > 0xffff) throw new RangeError(`拡張ヘッダが長すぎる: ${extra.byteLength}`)
  const total = FIXED_HEADER_BYTES + sid.byteLength + extra.byteLength + block.payload.byteLength
  if (total > MSEED3_MAX_RECORD_BYTES) throw new RangeError(`レコードが ${MSEED3_MAX_RECORD_BYTES} バイトを超える: ${total}`)

  const t = timeFieldsOf(startMs)
  const record = new Uint8Array(total)
  const view = new DataView(record.buffer)
  record[0] = 0x4d // 'M'
  record[1] = 0x53 // 'S'
  record[2] = 3
  record[3] = input.timeQuestionable === true ? FLAG_TIME_QUESTIONABLE : 0
  view.setUint32(4, t.nanosecond, true)
  view.setUint16(8, t.year, true)
  view.setUint16(10, t.dayOfYear, true)
  record[12] = t.hour
  record[13] = t.minute
  record[14] = t.second
  record[15] = ENCODING_STEIM2
  view.setFloat64(16, sampleRateHz, true)
  view.setUint32(24, block.sampleCount, true)
  // 28〜31 は CRC。0 のまま組み立ててから最後に書く。
  record[32] = PUBLICATION_VERSION
  record[33] = sid.byteLength
  view.setUint16(34, extra.byteLength, true)
  view.setUint32(36, block.payload.byteLength, true)
  record.set(sid, FIXED_HEADER_BYTES)
  record.set(extra, FIXED_HEADER_BYTES + sid.byteLength)
  record.set(block.payload, FIXED_HEADER_BYTES + sid.byteLength + extra.byteLength)
  view.setUint32(28, crc32c(record), true)
  return record
}
