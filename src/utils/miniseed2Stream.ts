import { Mseed2Error, parseMseed2Record, type Mseed2Problem, type Mseed2Record } from './miniseed2'

/**
 * 連結された miniSEED 2 のレコード列を 1 本ずつ読む。公開観測点の保存庫（FDSN dataselect）が返す応答のためのもの
 * （`docs/public-waveform-design.md` §6）。SeedLink 側は 1 パケット 1 レコードで届くので通らない（`services/seedlinkSession.ts`）。
 *
 * **壊れたレコードは飛ばして続きを読む**（応答全体を捨てると、1 本の欠けで観測点ごと消える）。飛ばす幅は 512 バイト ——
 * 壊れたレコードからは長さを読めないので、2026-10-14 に受けた JP 網のレコード長（すべて 512）に合わせる。
 */

/** 読めずに飛ばしたレコード。呼び出し側が理由ごとに数えて記録へ残す。 */
export interface Mseed2Unreadable {
  readonly at: number
  readonly problem: Mseed2Problem
  readonly detail: string
}

export interface Mseed2StreamResult {
  readonly records: readonly Mseed2Record[]
  readonly unreadable: readonly Mseed2Unreadable[]
  /** 末尾に残った、1 本ぶんに満たないバイト数（途中で切れた応答）。 */
  readonly trailingBytes: number
}

/** 壊れたレコードを飛ばす幅（バイト）。これに満たない残りは途中で切れたものとして読まない。 */
const SKIP_BYTES = 512

export function splitMseed2Stream(bytes: Uint8Array): Mseed2StreamResult {
  const records: Mseed2Record[] = []
  const unreadable: Mseed2Unreadable[] = []
  let at = 0
  while (bytes.length - at >= SKIP_BYTES) {
    try {
      const record = parseMseed2Record(bytes.subarray(at))
      records.push(record)
      at += record.recordLength
    } catch (e) {
      // `parseMseed2Record` は読めないとき Mseed2Error だけを投げる（そう確かめてある）。それ以外は実装の誤りなので通す
      if (!(e instanceof Mseed2Error)) throw e
      unreadable.push({ at, problem: e.problem, detail: e.message })
      at += SKIP_BYTES
    }
  }
  return { records, unreadable, trailingBytes: bytes.length - at }
}

/**
 * 連結されたレコード列を、観測点ごとの生バイトへ分ける。**1 回の問い合わせに複数の観測点を並べた応答**を、
 * 観測点ごとの控えへ書き分けるためのもの（`hooks/usePublicQuakeWaves.ts`）。
 *
 * 読めたレコードはそのままの並びで観測点の束へ写す。読めなかった分は {@link splitMseed2Stream} と同じく
 * 理由つきで返し、どの観測点の束にも入れない（観測点を名乗る見出しが読めないため）。
 */
export function groupMseed2ByStation(bytes: Uint8Array): {
  readonly byStation: ReadonlyMap<string, Uint8Array>
  readonly unreadable: readonly Mseed2Unreadable[]
  readonly trailingBytes: number
} {
  const parts = new Map<string, Uint8Array[]>()
  const unreadable: Mseed2Unreadable[] = []
  let at = 0
  while (bytes.length - at >= SKIP_BYTES) {
    try {
      const record = parseMseed2Record(bytes.subarray(at))
      const list = parts.get(record.station) ?? []
      list.push(bytes.subarray(at, at + record.recordLength))
      parts.set(record.station, list)
      at += record.recordLength
    } catch (e) {
      if (!(e instanceof Mseed2Error)) throw e
      unreadable.push({ at, problem: e.problem, detail: e.message })
      at += SKIP_BYTES
    }
  }
  const byStation = new Map<string, Uint8Array>()
  for (const [station, list] of parts) {
    const out = new Uint8Array(list.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of list) {
      out.set(p, o)
      o += p.length
    }
    byStation.set(station, out)
  }
  return { byStation, unreadable, trailingBytes: bytes.length - at }
}
