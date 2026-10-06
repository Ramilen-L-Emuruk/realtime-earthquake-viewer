// 自分で書いた miniSEED 3 の生データを読み返す（`mseed3Record.ts` の逆）。
//
// **壊れた先で止まらない。** 検査値（CRC-32C）が合わないレコードは採らずに数え、長さの欄を
// 信じて次へ進む。長さが足りない末尾（書いている最中・落ちた跡）と、目印が合わない位置では
// そこでやめる —— 長さの欄そのものが信用できないので、先へ進む手立てが無い。

import { crc32c } from './crc32c'
import { decodeSteim2 } from './steim2'

const FIXED_HEADER_BYTES = 40
const ENCODING_TEXT = 0
const ENCODING_STEIM2 = 11
const FLAG_TIME_QUESTIONABLE = 0b10
/** 壊れた UTF-8 を置換文字で黙って通さない（中身を取り違えたまま読むより、読めないと数える）。 */
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true })

export interface ParsedMseed3Record {
  readonly sourceId: string
  /** 先頭サンプルの時刻（unix ミリ秒・端数あり）。 */
  readonly startMs: number
  readonly sampleRateHz: number
  readonly sampleCount: number
  readonly encoding: number
  readonly timeQuestionable: boolean
  /** 拡張ヘッダ。無ければ `null`。JSON として読めなければ `undefined`。 */
  readonly extra: unknown
  /** 復号したサンプル。Steim2 以外・復号できなければ `null`。 */
  readonly samples: Int32Array | null
  /** テキストのレコード（受信の記録）の中身。テキスト以外・UTF-8 として読めなければ `null`。 */
  readonly text: string | null
  /** ファイルの中での位置（バイト）。 */
  readonly offset: number
}

export interface Mseed3ReadResult {
  readonly records: readonly ParsedMseed3Record[]
  /** 検査値が合わずに採らなかったレコードの数。 */
  readonly crcFailures: number
  /** 中身を復号できなかったレコードの数（検査値は合っていた）。 */
  readonly decodeFailures: number
  /** 末尾で読まなかったバイト数。**0 なら全部を最後まで読めた。** */
  readonly skippedBytes: number
}

function timeOf(view: DataView, at: number): number {
  const ns = view.getUint32(at + 4, true)
  const year = view.getUint16(at + 8, true)
  const doy = view.getUint16(at + 10, true)
  const hour = view.getUint8(at + 12)
  const minute = view.getUint8(at + 13)
  const second = view.getUint8(at + 14)
  return Date.UTC(year, 0, doy, hour, minute, second) + ns / 1e6
}

export function readMseed3Records(buf: Uint8Array): Mseed3ReadResult {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const records: ParsedMseed3Record[] = []
  let crcFailures = 0
  let decodeFailures = 0
  let pos = 0
  while (pos + FIXED_HEADER_BYTES <= buf.length) {
    if (buf[pos] !== 0x4d || buf[pos + 1] !== 0x53 || buf[pos + 2] !== 3) break
    const sidLen = buf[pos + 33]!
    const extraLen = view.getUint16(pos + 34, true)
    const payloadLen = view.getUint32(pos + 36, true)
    const total = FIXED_HEADER_BYTES + sidLen + extraLen + payloadLen
    if (pos + total > buf.length) break

    // **写しは自分で作る。** `buf` が Node の `Buffer` だと `slice` は写しを作らず元を指す ——
    // そこで検査値の欄を 0 にすると渡されたバッファを書き換え、検査も素通りの値で回ることになる。
    const copy = new Uint8Array(total)
    copy.set(buf.subarray(pos, pos + total))
    const want = view.getUint32(pos + 28, true)
    new DataView(copy.buffer).setUint32(28, 0, true)
    if (crc32c(copy) !== want) {
      crcFailures += 1
      pos += total
      continue
    }

    const sidStart = pos + FIXED_HEADER_BYTES
    const sourceId = new TextDecoder().decode(buf.subarray(sidStart, sidStart + sidLen))
    let extra: unknown = null
    if (extraLen > 0) {
      try {
        extra = JSON.parse(new TextDecoder().decode(buf.subarray(sidStart + sidLen, sidStart + sidLen + extraLen)))
      } catch {
        extra = undefined
      }
    }
    const encoding = buf[pos + 15]!
    const sampleCount = view.getUint32(pos + 24, true)
    const rate = view.getFloat64(pos + 16, true)
    const payloadStart = sidStart + sidLen + extraLen
    const payload = buf.subarray(payloadStart, payloadStart + payloadLen)
    let samples: Int32Array | null = null
    let text: string | null = null
    if (encoding === ENCODING_STEIM2) {
      try {
        samples = decodeSteim2(payload, sampleCount)
      } catch {
        decodeFailures += 1
      }
    } else if (encoding === ENCODING_TEXT) {
      try {
        text = UTF8_STRICT.decode(payload)
      } catch {
        decodeFailures += 1
      }
    }
    records.push({
      sourceId,
      startMs: timeOf(view, pos),
      // 負の値は刻みの秒数（規格）。生データは常に正（毎秒の件数）で書くが、読む側は両方受ける。
      sampleRateHz: rate > 0 ? rate : rate < 0 ? -1 / rate : 0,
      sampleCount,
      encoding,
      timeQuestionable: (buf[pos + 3]! & FLAG_TIME_QUESTIONABLE) !== 0,
      extra,
      samples,
      text,
      offset: pos,
    })
    pos += total
  }
  return { records, crcFailures, decodeFailures, skippedBytes: buf.length - pos }
}
