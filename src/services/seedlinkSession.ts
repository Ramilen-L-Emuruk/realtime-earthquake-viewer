/**
 * SeedLink 3.1 の手順（命令の組み立てと、届いたバイト列の切り分け）。通信はしない純粋な部品で、
 * WebSocket の包みは `seedlink.ts` が持つ。
 *
 * 2026-10-14 に EarthScope（`wss://rtserve.earthscope.org/seedlink`・副プロトコル `SeedLink3.1`）で
 * 実際に通った手順（設計書 `docs/public-waveform-design.md` §3.2）:
 *
 * 1. 観測点ごとに `STATION <観測点> <網>` を送り、`OK` を待つ
 * 2. 続けて `TIME <年>,<月>,<日>,<時>,<分>,<秒>`（UTC・始めだけ）を送り、`OK` を待つ
 * 3. 最後に `END` を送る。**`END` には応答が無く**、そのまま `SL` ＋ 6 文字の連番 ＋ 512 バイトの
 *    レコードが続けて届く
 *
 * **`SELECT` は送らない**（`SELECT ??BH?.D` を付けると `OK` は返るのにレコードが 1 件も来なかった。
 * `JP` 網は `BH?` しか持たないので絞る必要もない）。**`TIME` は必ず送る** —— 付けない形
 * （いま届いた分から）は実測していない。`END` の後に `STATION` を足しても何も返らなかったので
 * （2026-10-15）、観測点を足すには繋ぎ直す。
 */

/** SeedLink のデータの 1 区切り: `SL` ＋ 連番 6 文字 ＋ miniSEED 512 バイト */
export const SEEDLINK_HEADER_BYTES = 8
export const SEEDLINK_RECORD_BYTES = 512
export const SEEDLINK_PACKET_BYTES = SEEDLINK_HEADER_BYTES + SEEDLINK_RECORD_BYTES

export interface SeedlinkRequest {
  network: string
  /** 観測点のコード（重複は呼び出し側で除いておく） */
  stations: readonly string[]
  /** どこから流してほしいか（UTC の epoch ミリ秒） */
  startMs: number
}

/** `TIME` 命令の時刻（UTC・秒まで。秒未満は切り捨てる —— 少し手前から受けて重なりは受け手が除く） */
export function seedlinkTime(ms: number): string {
  if (!Number.isFinite(ms)) throw new RangeError(`始めの時刻が不正: ${ms}`)
  const d = new Date(ms)
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].join(',')
}

/** 送る命令の列（`END` まで）。命令の名前・観測点のコードに使える文字だけを通す。 */
export function seedlinkCommands(req: SeedlinkRequest): string[] {
  if (!/^[A-Z0-9]{1,2}$/.test(req.network)) throw new RangeError(`網のコードが不正: ${req.network}`)
  if (req.stations.length === 0) throw new RangeError('観測点が 1 つも無い')
  const time = `TIME ${seedlinkTime(req.startMs)}`
  const out: string[] = []
  for (const s of req.stations) {
    if (!/^[A-Z0-9]{1,5}$/.test(s)) throw new RangeError(`観測点のコードが不正: ${s}`)
    out.push(`STATION ${s} ${req.network}`, time)
  }
  out.push('END')
  return out
}

export type SeedlinkEvent =
  /** 次の命令を送ってよい（`command` を送る） */
  | { type: 'send'; command: string }
  /** レコードが 1 本届いた（`record` は miniSEED 512 バイト） */
  | { type: 'packet'; sequence: string; record: Uint8Array }
  /** 命令が断られた（`ERROR` が返った。`END` の後に返ったときは `command` が `END`） */
  | { type: 'refused'; command: string; reply: string }
  /** 命令への応答が `OK` でも `ERROR` でもなかった（手順がずれた） */
  | { type: 'unexpected'; command: string; reply: string }
  /** 区切りとして読めないバイト列を読み飛ばした（次の正しい区切りから読み直す） */
  | { type: 'garbled'; droppedBytes: number; head: string }

/**
 * 区切りの頭（`SL` ＋ 16 進 6 桁）か。`incomplete` は届いた分だけでは決められない。
 * 仕様の連番は大文字だが、小文字を返す互換サーバーで全レコードを読み飛ばさないよう小文字も通す
 */
function headerAt(buf: Uint8Array, at: number): 'valid' | 'invalid' | 'incomplete' {
  for (let i = 0; i < SEEDLINK_HEADER_BYTES; i++) {
    if (at + i >= buf.length) return 'incomplete'
    const c = buf[at + i]!
    const ok =
      i === 0 ? c === 0x53 : i === 1 ? c === 0x4c : (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
    if (!ok) return 'invalid'
  }
  return 'valid'
}

/**
 * 手順を進める状態機械。`start()` で最初の命令を、`feed()` で届いたバイト列を渡すと、
 * することを順に返す。
 */
export class SeedlinkSession {
  private readonly commands: string[]
  private next = 0
  /** 応答を待っている命令（null なら待っていない） */
  private awaiting: string | null = null
  private streaming = false
  private pending = new Uint8Array(0)
  private replyText = ''
  private lastSequence: string | null = null

  constructor(req: SeedlinkRequest) {
    this.commands = seedlinkCommands(req)
  }

  /** `END` を送り終えた（以後はレコードを待つ） */
  get isStreaming(): boolean {
    return this.streaming
  }

  /** 最後に受けたレコードの連番（16 進 6 桁）。まだ無ければ null */
  get sequence(): string | null {
    return this.lastSequence
  }

  start(): SeedlinkEvent[] {
    if (this.next !== 0) throw new Error('start は 1 回だけ')
    return this.sendNext()
  }

  private sendNext(): SeedlinkEvent[] {
    const command = this.commands[this.next++]!
    if (command === 'END') {
      this.streaming = true
      this.awaiting = null
    } else {
      this.awaiting = command
    }
    return [{ type: 'send', command }]
  }

  feed(chunk: Uint8Array): SeedlinkEvent[] {
    return this.streaming ? this.feedStream(chunk) : this.feedReply(chunk)
  }

  private feedStream(chunk: Uint8Array): SeedlinkEvent[] {
    const merged = new Uint8Array(this.pending.length + chunk.length)
    merged.set(this.pending)
    merged.set(chunk, this.pending.length)
    const events: SeedlinkEvent[] = []
    let at = 0
    while (at < merged.length) {
      const state = headerAt(merged, at)
      if (state === 'incomplete') break
      if (state === 'invalid') {
        // 次の区切りの頭まで 1 バイトずつ進めて読み飛ばす（読めるところまで落とさない）。
        // レコードの中身が偶然「SL＋16 進 6 桁」に見えると、そこから 1 本ぶんを偽の区切りとして切り、
        // 後ろの本物を 1 本巻き込む。見出しの並びでそうなることはまず無く、起きるのも区切りを失った後の
        // 復帰時だけなので受け入れている（巻き込んだ分は読めないものとして数えられる）
        let skip = at + 1
        while (skip < merged.length && headerAt(merged, skip) === 'invalid') skip++
        const dropped = merged.subarray(at, skip)
        const text = latin1(dropped).trim()
        if (/^ERROR\b/.test(text)) events.push({ type: 'refused', command: 'END', reply: text })
        else events.push({ type: 'garbled', droppedBytes: dropped.length, head: latin1(dropped.subarray(0, 16)) })
        at = skip
        continue
      }
      if (merged.length - at < SEEDLINK_PACKET_BYTES) break
      const sequence = latin1(merged.subarray(at + 2, at + SEEDLINK_HEADER_BYTES))
      const record = merged.slice(at + SEEDLINK_HEADER_BYTES, at + SEEDLINK_PACKET_BYTES)
      this.lastSequence = sequence
      events.push({ type: 'packet', sequence, record })
      at += SEEDLINK_PACKET_BYTES
    }
    this.pending = merged.slice(at)
    return events
  }

  /** 応答は行（`\r\n` 区切り）で読む。1 回の受信に行が分かれて・まとめて届いても同じに扱う */
  private feedReply(chunk: Uint8Array): SeedlinkEvent[] {
    this.replyText += latin1(chunk)
    const events: SeedlinkEvent[] = []
    for (;;) {
      const nl = this.replyText.indexOf('\n')
      if (nl < 0) break
      const line = this.replyText.slice(0, nl).trim()
      this.replyText = this.replyText.slice(nl + 1)
      if (line === '') continue
      const command = this.awaiting
      if (command === null) {
        events.push({ type: 'unexpected', command: this.streaming ? 'END' : '', reply: line })
        break
      }
      if (line === 'OK') {
        events.push(...this.sendNext())
        // END を送った後に残った分はレコードとして読む
        if (this.streaming) {
          const rest = this.replyText
          this.replyText = ''
          if (rest.length > 0) events.push(...this.feedStream(fromLatin1(rest)))
          break
        }
        continue
      }
      this.awaiting = null
      events.push(line === 'ERROR' ? { type: 'refused', command, reply: line } : { type: 'unexpected', command, reply: line })
      break
    }
    return events
  }
}

function latin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return s
}

function fromLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}
