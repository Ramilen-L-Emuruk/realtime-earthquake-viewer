/**
 * miniSEED 2（SEED 2.4 のデータレコード）を 1 本読む。公開観測点の波形（EarthScope の SeedLink と
 * 保存庫が返すレコード）を描くためのもの。
 *
 * 2026-10-14 に受けた `JP` 網の 15,980 レコードは、すべて 512 バイト・Steim2・大きいバイト順だった。
 * **Steim1 も読む**（同じ網で混ざることはまず無いが、読めなければ黙って欠けになるので）。
 * それ以外の符号化は読まずに理由つきで断る —— 呼び出し側が数えて記録に残す。
 *
 * 参照: SEED Reference Manual v2.4（固定見出し §8、Blockette 1000・1001、付録 B の Steim 圧縮）。
 */

/** 読めなかった理由。呼び出し側が理由ごとに数えるため、文字列ではなく種類で返す。 */
export type Mseed2Problem =
  | 'too-short'
  | 'bad-header'
  | 'no-blockette-1000'
  | 'unsupported-encoding'
  | 'bad-sample-rate'
  | 'steim-check-failed'

export class Mseed2Error extends Error {
  readonly problem: Mseed2Problem
  constructor(problem: Mseed2Problem, message: string) {
    super(message)
    this.name = 'Mseed2Error'
    this.problem = problem
  }
}

export interface Mseed2Record {
  network: string
  station: string
  location: string
  channel: string
  /** 品質の印（`D`・`R`・`Q`・`M`） */
  quality: string
  /** 最初のサンプルの時刻（UTC の epoch ミリ秒。0.1 ms 刻み・マイクロ秒の補正を含むので小数になりうる） */
  startMs: number
  /** 見出しが名乗る採取率（Hz） */
  sampleRate: number
  /** カウント（感度で割る前の生の値） */
  samples: Int32Array
  /** レコードの長さ（バイト） */
  recordLength: number
}

const FIXED_HEADER_BYTES = 48
const STEIM1 = 10
const STEIM2 = 11
/** Blockette 1000・1001 の長さ */
const BLOCKETTE_MIN_BYTES = 8
/** 1 本のレコードにこれより多いブロケットは来ない（来たら並びが壊れている） */
const MAX_BLOCKETTES = 16
const FRAME_BYTES = 64
const WORDS_PER_FRAME = 16

function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = ''
  for (let i = from; i < to; i++) s += String.fromCharCode(bytes[i]!)
  return s.trim()
}

/** 見出しの採取率の係数と倍数（SEED 2.4 §8 の 10・11 番の欄）から Hz を出す。 */
export function sampleRateFrom(factor: number, multiplier: number): number {
  if (factor === 0 || multiplier === 0) return 0
  if (factor > 0) return multiplier > 0 ? factor * multiplier : -factor / multiplier
  return multiplier > 0 ? -multiplier / factor : 1 / (factor * multiplier)
}

/**
 * レコード 1 本を読む。`bytes` はレコードちょうどか、それより長くてもよい（先頭から読む）。
 * 読めなければ `Mseed2Error` を投げる（**それ以外の例外は投げない** —— 壊れた入力で確かめてある）。
 */
export function parseMseed2Record(bytes: Uint8Array): Mseed2Record {
  if (bytes.length < FIXED_HEADER_BYTES) throw new Mseed2Error('too-short', `レコードが短すぎる: ${bytes.length} バイト`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // 固定見出しのバイト順は年の欄で見分ける（SEED には印が無い。年が 1900〜2100 に入る向きを採る）
  let little = false
  let year = view.getUint16(20, false)
  if (year < 1900 || year > 2100) {
    little = true
    year = view.getUint16(20, true)
    if (year < 1900 || year > 2100) throw new Mseed2Error('bad-header', `年が読めない: ${view.getUint16(20, false)}`)
  }
  const u16 = (o: number) => view.getUint16(o, little)
  const i16 = (o: number) => view.getInt16(o, little)
  const quality = String.fromCharCode(bytes[6]!)
  const dayOfYear = u16(22)
  const hour = bytes[24]!
  const minute = bytes[25]!
  const second = bytes[26]!
  const ticks = u16(28) // 0.0001 秒
  // 秒の 60 は閏秒として通す（SEED が許す）。通日は年の日数まで
  if (dayOfYear < 1 || dayOfYear > daysInYear(year) || hour > 23 || minute > 59 || second > 60 || ticks > 9999) {
    throw new Mseed2Error('bad-header', `時刻が読めない: ${year}-${dayOfYear} ${hour}:${minute}:${second}.${ticks}`)
  }
  const sampleCount = u16(30)
  const sampleRate = sampleRateFrom(i16(32), i16(34))
  const activityFlags = bytes[36]!
  const timeCorrection = view.getInt32(40, little) // 0.0001 秒
  const dataOffset = u16(44)
  const firstBlockette = u16(46)

  // Blockette 1000（符号化・データ部のバイト順・レコード長）と 1001（マイクロ秒）を拾う
  let encoding = -1
  let dataLittle = little
  let recordLength = 0
  let microseconds = 0
  for (let at = firstBlockette, hops = 0; at !== 0; hops++) {
    // 1000・1001 はどちらも 8 バイト。見出しより前・末尾をはみ出す位置は壊れたレコード
    if (at < FIXED_HEADER_BYTES || at + BLOCKETTE_MIN_BYTES > bytes.length) {
      throw new Mseed2Error('bad-header', `ブロケットの位置が範囲の外: ${at}`)
    }
    if (hops >= MAX_BLOCKETTES) throw new Mseed2Error('bad-header', `ブロケットが ${MAX_BLOCKETTES} 個を超える`)
    const type = u16(at)
    const next = u16(at + 2)
    if (type === 1000) {
      encoding = bytes[at + 4]!
      dataLittle = bytes[at + 5] === 0
      const exponent = bytes[at + 6]!
      if (exponent < 7 || exponent > 16) throw new Mseed2Error('bad-header', `レコード長の指数が範囲の外: ${exponent}`)
      recordLength = 2 ** exponent
    } else if (type === 1001) {
      microseconds = view.getInt8(at + 5)
    }
    if (next !== 0 && next <= at) throw new Mseed2Error('bad-header', `ブロケットの並びが戻る: ${at} → ${next}`)
    at = next
  }
  if (encoding < 0) throw new Mseed2Error('no-blockette-1000', 'Blockette 1000 が無い')
  if (recordLength > bytes.length || recordLength < FIXED_HEADER_BYTES) {
    throw new Mseed2Error('too-short', `レコード長 ${recordLength} に対して ${bytes.length} バイトしか無い`)
  }
  if (sampleCount > 0 && !(sampleRate > 0)) throw new Mseed2Error('bad-sample-rate', `採取率が読めない: ${sampleRate}`)
  // サンプルが無いレコードはデータ部の位置を 0 にしてよい（SEED 2.4 §8）
  if (sampleCount > 0 && (dataOffset < FIXED_HEADER_BYTES || dataOffset > recordLength)) {
    throw new Mseed2Error('bad-header', `データ部の位置が範囲の外: ${dataOffset}`)
  }

  // 時刻の補正: 活動の印の 2 ビット目が立っていなければ、補正の欄はまだ足されていない（SEED 2.4 §8 の 12・16 番）
  const correctionMs = activityFlags & 0x02 ? 0 : timeCorrection / 10
  const startMs =
    Date.UTC(year, 0, 1, hour, minute, second) + (dayOfYear - 1) * 86_400_000 + ticks / 10 + correctionMs + microseconds / 1000

  const data = sampleCount > 0 ? bytes.subarray(dataOffset, recordLength) : new Uint8Array(0)
  let samples: Int32Array
  if (sampleCount === 0) samples = new Int32Array(0)
  else if (encoding === STEIM2) samples = decodeSteim(data, sampleCount, true, dataLittle)
  else if (encoding === STEIM1) samples = decodeSteim(data, sampleCount, false, dataLittle)
  else throw new Mseed2Error('unsupported-encoding', `読まない符号化: ${encoding}`)

  return {
    network: ascii(bytes, 18, 20),
    station: ascii(bytes, 8, 13),
    location: ascii(bytes, 13, 15),
    channel: ascii(bytes, 15, 18),
    quality,
    startMs,
    sampleRate,
    samples,
    recordLength,
  }
}

/** 下位 `bits` ビットを符号つきの整数として読む。 */
function signed(v: number, bits: number): number {
  const shift = 32 - bits
  return (v << shift) >> shift
}

/**
 * Steim1・Steim2 のデータ部を戻す（SEED 2.4 付録 B）。最初のフレームの語 1・2 が先頭値と末尾値で、
 * 末尾値と組み立てた最後のサンプルが合わなければ壊れたレコードとして断る。
 */
function decodeSteim(data: Uint8Array, count: number, steim2: boolean, little: boolean): Int32Array {
  const out = new Int32Array(count)
  if (count === 0) return out
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const word = (o: number) => view.getUint32(o, little)
  const diffs: number[] = []
  let first = 0
  let last = 0
  const frames = Math.floor(data.byteLength / FRAME_BYTES)
  for (let f = 0; f < frames && diffs.length < count; f++) {
    const base = f * FRAME_BYTES
    const nibbles = word(base)
    for (let w = 1; w < WORDS_PER_FRAME; w++) {
      const nibble = (nibbles >>> (2 * (WORDS_PER_FRAME - 1 - w))) & 3
      const v = word(base + w * 4)
      if (f === 0 && w === 1) {
        first = v | 0
        continue
      }
      if (f === 0 && w === 2) {
        last = v | 0
        continue
      }
      if (nibble === 0) continue
      if (!steim2) {
        if (nibble === 1) for (let k = 0; k < 4; k++) diffs.push(signed(v >>> (24 - 8 * k), 8))
        else if (nibble === 2) for (let k = 0; k < 2; k++) diffs.push(signed(v >>> (16 - 16 * k), 16))
        else diffs.push(v | 0)
        continue
      }
      const dnib = v >>> 30
      if (nibble === 1) {
        for (let k = 0; k < 4; k++) diffs.push(signed(v >>> (24 - 8 * k), 8))
      } else if (nibble === 2) {
        if (dnib === 1) diffs.push(signed(v, 30))
        else if (dnib === 2) for (let k = 0; k < 2; k++) diffs.push(signed(v >>> (15 - 15 * k), 15))
        else if (dnib === 3) for (let k = 0; k < 3; k++) diffs.push(signed(v >>> (20 - 10 * k), 10))
        else throw new Mseed2Error('steim-check-failed', `Steim2 の副種別が不正: ${dnib}`)
      } else {
        if (dnib === 0) for (let k = 0; k < 5; k++) diffs.push(signed(v >>> (24 - 6 * k), 6))
        else if (dnib === 1) for (let k = 0; k < 6; k++) diffs.push(signed(v >>> (25 - 5 * k), 5))
        else if (dnib === 2) for (let k = 0; k < 7; k++) diffs.push(signed(v >>> (24 - 4 * k), 4))
        else throw new Mseed2Error('steim-check-failed', `Steim2 の副種別が不正: ${dnib}`)
      }
    }
  }
  if (diffs.length < count) throw new Mseed2Error('steim-check-failed', `差分が ${diffs.length} 個しか無い（${count} 個のはず）`)
  // 最初の差分は前のレコードとの差なので使わない（先頭値から組み立てる）
  out[0] = first
  for (let i = 1; i < count; i++) out[i] = (out[i - 1]! + diffs[i]!) | 0
  if (out[count - 1] !== last) {
    throw new Mseed2Error('steim-check-failed', `末尾値が合わない: ${out[count - 1]}（見出しは ${last}）`)
  }
  return out
}
