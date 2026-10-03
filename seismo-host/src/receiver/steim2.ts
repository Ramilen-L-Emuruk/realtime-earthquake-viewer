// Steim2 の符号化（SEED Manual v2.4 付録 B）。miniSEED のデータ部をこれで詰める。
//
// **正しさは出どころの違う復号器（`seisplotjs-seedcodec`）で確かめる**（`mseed3.test.ts`）。
// 自分で書いた復号器で戻すだけだと、同じ読み違いを両側に持っていても一致してしまう。
//
// 形: 64 バイトのフレームを並べる。各フレームは 32 ビット語 16 個で、語 0 が残り 15 語の
// 中身の種別（2 ビットずつ）。最初のフレームだけは語 1・2 に先頭値（X0）と末尾値（Xn）を置き、
// 差分は語 3 から始まる。**大きいバイト順。**
//
// **差分の初項は 0 にする**（前のレコードの末尾値に依らない）。1 本ずつ独立に読めるので、
// 1 本が壊れても前後へ波及しない。

/** 1 語へ詰める形。詰まる順に並べ、最初に収まったものを採る。 */
interface Packing {
  /** 1 語に入る差分の数。 */
  readonly count: number
  /** 差分 1 つのビット幅。 */
  readonly bits: number
  /** フレームの語 0 に書く種別。 */
  readonly nibble: 1 | 2 | 3
  /** 語の上位 2 ビットに書く副種別（種別 1 は持たない）。 */
  readonly dnib: number | null
}

const PACKINGS: readonly Packing[] = [
  { count: 7, bits: 4, nibble: 3, dnib: 0b10 },
  { count: 6, bits: 5, nibble: 3, dnib: 0b01 },
  { count: 5, bits: 6, nibble: 3, dnib: 0b00 },
  { count: 4, bits: 8, nibble: 1, dnib: null },
  { count: 3, bits: 10, nibble: 2, dnib: 0b11 },
  { count: 2, bits: 15, nibble: 2, dnib: 0b10 },
  { count: 1, bits: 30, nibble: 2, dnib: 0b01 },
]

const FRAME_BYTES = 64
const WORDS_PER_FRAME = 16

/**
 * Steim2 を復号する。**自分で書いた生データを読み返すため**（`mseed3Reader.ts`）。
 *
 * **末尾値（Xn）と照らす。** 合わなければ中身が壊れているので投げる —— CRC が合っていても、
 * 符号化器の不具合で書いた時点から壊れていた形はここでしか分からない。
 */
export function decodeSteim2(payload: Uint8Array, count: number): Int32Array {
  if (payload.byteLength % FRAME_BYTES !== 0) throw new RangeError(`長さが 64 の倍数でない: ${payload.byteLength}`)
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`件数が不正: ${count}`)
  const out = new Int32Array(count)
  if (count === 0) return out
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const x0 = view.getInt32(4, false)
  const xn = view.getInt32(8, false)
  let n = 0
  let last = 0
  const put = (diff: number, first: boolean): void => {
    if (n >= count) return
    last = first ? x0 : last + diff
    out[n++] = last
  }
  let firstDiff = true
  const frames = payload.byteLength / FRAME_BYTES
  for (let f = 0; f < frames && n < count; f++) {
    const base = f * FRAME_BYTES
    const nibbles = view.getUint32(base, false)
    for (let word = f === 0 ? 3 : 1; word < WORDS_PER_FRAME && n < count; word++) {
      const nib = (nibbles >>> (2 * (WORDS_PER_FRAME - 1 - word))) & 0b11
      if (nib === 0) continue
      const w = view.getUint32(base + word * 4, false)
      let packing: Packing | undefined
      if (nib === 1) packing = PACKINGS.find((p) => p.nibble === 1)
      else {
        const dnib = w >>> 30
        packing = PACKINGS.find((p) => p.nibble === nib && p.dnib === dnib)
      }
      if (packing === undefined) throw new RangeError(`知らない詰め方（種別 ${nib}）`)
      const mask = 2 ** packing.bits - 1
      const half = 2 ** (packing.bits - 1)
      for (let k = 0; k < packing.count; k++) {
        const shift = packing.bits * (packing.count - 1 - k)
        let v = Math.floor(w / 2 ** shift) & mask
        if (v >= half) v -= 2 ** packing.bits
        put(v, firstDiff)
        firstDiff = false
      }
    }
  }
  if (n !== count) throw new RangeError(`名乗る件数 ${count} に対して ${n} 件しか無い`)
  if (out[count - 1] !== xn) throw new RangeError(`末尾値が合わない（${out[count - 1]} と ${xn}）`)
  return out
}

export interface Steim2Block {
  /** 詰めたサンプルの数。**渡した数より少ないことがある**（フレームの上限・30 ビットに収まらない差分）。 */
  readonly sampleCount: number
  /** 詰めたデータ部。長さは 64 の倍数。 */
  readonly payload: Uint8Array
  /** 差分が 30 ビットに収まらずに止めた（フレームの上限で止めたのではない）。 */
  readonly blocked: boolean
}

function fits(v: number, bits: number): boolean {
  const lim = 2 ** (bits - 1)
  return v >= -lim && v < lim
}

/**
 * `samples` の先頭から、`maxFrames` フレームに収まるだけ詰める。
 *
 * **全部は詰めない。** 入りきらない分は呼び出し側が次のレコードへ回す。差分が 30 ビットに
 * 収まらない箇所でも止まる —— そこから始めれば先頭値（32 ビット）として書けるので、
 * どんな整数列でも次の本で続けられる。
 */
export function encodeSteim2(samples: Int32Array, maxFrames: number): Steim2Block {
  if (samples.length === 0) throw new RangeError('詰めるサンプルが無い')
  if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new RangeError(`フレーム数が不正: ${maxFrames}`)

  const out = new DataView(new ArrayBuffer(maxFrames * FRAME_BYTES))
  /** 次に詰めるサンプルの位置。 */
  let pos = 0
  /** 詰め終えたフレームの数。 */
  let frames = 0
  /** 差分が 30 ビットに収まらず止めた。 */
  let blocked = false

  const diffAt = (i: number): number => (i === 0 ? 0 : samples[i]! - samples[i - 1]!)

  while (frames < maxFrames && pos < samples.length && !blocked) {
    const base = frames * FRAME_BYTES
    let nibbles = 0
    let word = frames === 0 ? 3 : 1
    for (; word < WORDS_PER_FRAME && pos < samples.length; word++) {
      const remaining = samples.length - pos
      let chosen: Packing | null = null
      for (const p of PACKINGS) {
        if (p.count > remaining) continue
        let ok = true
        for (let k = 0; k < p.count; k++) {
          if (!fits(diffAt(pos + k), p.bits)) {
            ok = false
            break
          }
        }
        if (ok) {
          chosen = p
          break
        }
      }
      if (chosen === null) {
        blocked = true
        break
      }
      let w = chosen.dnib === null ? 0 : chosen.dnib * 2 ** 30
      const mask = 2 ** chosen.bits - 1
      for (let k = 0; k < chosen.count; k++) {
        // 負の差分は 2 の補数の下位ビットだけを残す（`&` は 32 ビットで働くので、30 ビット以下は欠けない）。
        w += (diffAt(pos + k) & mask) * 2 ** (chosen.bits * (chosen.count - 1 - k))
      }
      out.setUint32(base + word * 4, w >>> 0, false)
      nibbles = (nibbles | (chosen.nibble << (2 * (WORDS_PER_FRAME - 1 - word)))) >>> 0
      pos += chosen.count
    }
    // 語が 1 つも入らなかったフレームは出さない（止まった直後のフレームがそうなる）。
    if (word === (frames === 0 ? 3 : 1)) break
    out.setUint32(base, nibbles, false)
    frames += 1
  }

  out.setInt32(4, samples[0]!, false)
  out.setInt32(8, samples[pos - 1]!, false)
  return { sampleCount: pos, payload: new Uint8Array(out.buffer, 0, frames * FRAME_BYTES), blocked }
}
