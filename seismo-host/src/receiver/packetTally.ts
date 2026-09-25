// 受け取ったパケットに何が起きたかを数える。
//
// **表を 2 つに分ける。** 読み取りに失敗したパケットは基板が判らない（ヘッダが読めて
// いないのだから当然）ので、そこは**送信元アドレス**で数える。通ったあとのものは
// **基板**で数える —— アドレスは DHCP で変わるので、そちらで数えると同じ基板が
// 別の行に分かれる。**鍵が 2 つあるのは実態**で、1 つの表へ寄せると「不明」という
// 巨大な行ができて、どの送り手が壊れているのか辿れなくなる。
//
// **分母も数える。** 「落とした 40 件」は、届いたのが 50 件なのか 5 万件なのかで
// 意味が正反対になる。届いた件数（`received`）と通した件数（`accepted`）を必ず持つ。
//
// **鍵は上限に達したら「その他」へ合算する。** 基板の名前も送信元アドレスも
// パケットと相手から来る値で、こちらで決められない。**捨てずに合算する**のは、
// 内訳を失っても**合計は正しいまま**にするため（止める側の `sourceRateLimit.ts` は
// 逆に古い枠を捨てる。あちらが守るのは総数ではなく「新しい相手を落とさないこと」）。
//
// **時計は持たない。** 窓の区切りは呼び出し側が `takeWindow()` を呼んだ時点で決まる。
import type { PacketParseFailure } from '../protocol/types'
import { MAX_STREAMS_DEFAULT } from '../timebase/segmenter'
import type { SegmentBreakReason } from '../timebase/segmenter'
import type { IntensitySkipReason, PacketDropReason } from './intensityPipeline'
import type { RawUnsavedReason } from './rawStore'

/**
 * 覚えていられる鍵の数。
 *
 * **`Segmenter` の流れの上限をそのまま読む。** 1 台につき 1 つの枠、が大きさの根拠なので、
 * 手書きの数字を持つとあちらを動かしたとき黙って取り残される。
 */
const MAX_KEYS_DEFAULT = MAX_STREAMS_DEFAULT

/**
 * 上限に達したあとの鍵をまとめる行の名前。
 *
 * **本物の鍵と衝突しない。** 基板の鍵は必ず `mac:` か `name:` で始まり、
 * 送信元は IPv4 アドレスなので、どちらもこの形にはならない。
 */
export const OVERFLOW_KEY = '(上限超過)'

/**
 * 並び順を宣言しつつ、数え落としを型で止める。
 *
 * **`readonly T[]` の列挙では足りない。** 理由の種類が増えたとき、配列に足し忘れても
 * 型検査は通り、**その理由だけが要約から黙って消える**。`Record<T, true>` なら
 * 欠けても余っても型エラーになる（キーの並び順はそのまま並び順として使う）。
 */
function orderOf<T extends string>(spec: Record<T, true>): readonly T[] {
  return Object.keys(spec) as T[]
}

const PARSE_FAILURE_ORDER = orderOf<PacketParseFailure>({
  empty: true,
  'header-unreadable': true,
  'unsupported-version': true,
  'header-field-invalid': true,
  'sample-count-mismatch': true,
  'sample-column-mismatch': true,
  'sample-not-integer': true,
})

const DROP_ORDER = orderOf<PacketDropReason>({
  'scale-out-of-range': true,
  duplicate: true,
  'stream-desync': true,
})

const BREAK_ORDER = orderOf<SegmentBreakReason>({
  'stream-start': true,
  'seq-gap': true,
  'seq-reset': true,
  overflow: true,
  'config-changed': true,
})

const RAW_UNSAVED_ORDER = orderOf<RawUnsavedReason>({
  'no-stream': true,
  backpressure: true,
  'write-failed': true,
  closed: true,
})

const SKIP_ORDER = orderOf<IntensitySkipReason>({
  'axis-count': true,
  'stream-rejected': true,
})

/** 送信元アドレス 1 つぶん。**読み取りに通る前の話。** */
export interface SourceCounts {
  /** 届いた件数。**速度の上限を掛ける前に数える**（掛けたあとだと分母が上限そのものになる）。 */
  readonly received: number
  /** 速度の上限で落とした件数。 */
  readonly rateLimited: number
  /** 読めなかった件数（理由別）。 */
  readonly parseFailed: ReadonlyMap<PacketParseFailure, number>
  /**
   * 生データを残せなかった件数（理由別）。
   *
   * **基板ではなく送信元で数える。** 保存は読み取りより前なので、誰の基板かはまだ判らない。
   */
  readonly rawUnsaved: ReadonlyMap<RawUnsavedReason, number>
}

/** 基板 1 つぶん。**読み取りに通ったあとの話。** */
export interface BoardCounts {
  /** 読み取りに通った件数。 */
  readonly accepted: number
  /** 出せた震度の件数。 */
  readonly readings: number
  /** 締めくくりを出せなかった区間の数。**0 が正常。** */
  readonly closeFailures: number
  /** 流れの枠の上限で閉じられた回数。 */
  readonly evicted: number
  /** 組み立てから先で落とした件数（理由別）。 */
  readonly dropped: ReadonlyMap<PacketDropReason, number>
  /** 区間が始まった回数（理由別）。 */
  readonly segmentsStarted: ReadonlyMap<SegmentBreakReason, number>
  /** 区間で震度を出せなかった回数（理由別）。 */
  readonly intensitySkipped: ReadonlyMap<IntensitySkipReason, number>
}

/** ある時点までの数え上げ。 */
export interface TallySnapshot {
  readonly sources: ReadonlyMap<string, SourceCounts>
  readonly boards: ReadonlyMap<string, BoardCounts>
}

/** 数える出来事 1 つ。 */
export type TallyEvent =
  /** データグラムが届いた。**速度の上限より前。** */
  | { readonly kind: 'received'; readonly source: string }
  /** 速度の上限で落とした。 */
  | { readonly kind: 'rate-limited'; readonly source: string }
  /** 読み取りに失敗した。 */
  | { readonly kind: 'parse-failed'; readonly source: string; readonly reason: PacketParseFailure }
  /** 生データを残せなかった。**読み取りより前なので送信元で数える。** */
  | { readonly kind: 'raw-unsaved'; readonly source: string; readonly reason: RawUnsavedReason }
  /** 読み取りに通った。 */
  | { readonly kind: 'accepted'; readonly board: string }
  /** 組み立てから先で落とした。 */
  | { readonly kind: 'dropped'; readonly board: string; readonly reason: PacketDropReason }
  /** 区間が始まった。 */
  | { readonly kind: 'segment-started'; readonly board: string; readonly reason: SegmentBreakReason }
  /** 区間で震度を出せない。 */
  | {
      readonly kind: 'intensity-skipped'
      readonly board: string
      readonly reason: IntensitySkipReason
    }
  /** 震度を 1 つ出した。 */
  | { readonly kind: 'reading'; readonly board: string }
  /** 締めくくりを出せなかった。 */
  | { readonly kind: 'close-failed'; readonly board: string }
  /** 流れの枠の上限で閉じられた。 */
  | { readonly kind: 'evicted'; readonly board: string }

interface MutableSource {
  received: number
  rateLimited: number
  readonly parseFailed: Map<PacketParseFailure, number>
  readonly rawUnsaved: Map<RawUnsavedReason, number>
}

interface MutableBoard {
  accepted: number
  readings: number
  closeFailures: number
  evicted: number
  readonly dropped: Map<PacketDropReason, number>
  readonly segmentsStarted: Map<SegmentBreakReason, number>
  readonly intensitySkipped: Map<IntensitySkipReason, number>
}

function bump<K>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

/**
 * 鍵を引く。**上限に達していたら「その他」の行へ倒す。**
 *
 * 既にある鍵は上限に関わらず引ける —— 上限は「新しい鍵を作るか」の判断で、
 * **一度数え始めた相手の内訳を途中から失わせない。**
 */
function entryOf<T>(table: Map<string, T>, key: string, maxKeys: number, make: () => T): T {
  const found = table.get(key)
  if (found !== undefined) return found
  const target = table.size >= maxKeys ? OVERFLOW_KEY : key
  const existing = table.get(target)
  if (existing !== undefined) return existing
  const created = make()
  table.set(target, created)
  return created
}

function newSource(): MutableSource {
  return { received: 0, rateLimited: 0, parseFailed: new Map(), rawUnsaved: new Map() }
}

function newBoard(): MutableBoard {
  return {
    accepted: 0,
    readings: 0,
    closeFailures: 0,
    evicted: 0,
    dropped: new Map(),
    segmentsStarted: new Map(),
    intensitySkipped: new Map(),
  }
}

/** 累計と窓のどちらにも使う入れ物。 */
class Buckets {
  readonly sources = new Map<string, MutableSource>()
  readonly boards = new Map<string, MutableBoard>()

  constructor(private readonly maxKeys: number) {}

  apply(event: TallyEvent): void {
    switch (event.kind) {
      case 'received':
        this.source(event.source).received += 1
        return
      case 'rate-limited':
        this.source(event.source).rateLimited += 1
        return
      case 'parse-failed':
        bump(this.source(event.source).parseFailed, event.reason)
        return
      case 'raw-unsaved':
        bump(this.source(event.source).rawUnsaved, event.reason)
        return
      case 'accepted':
        this.board(event.board).accepted += 1
        return
      case 'reading':
        this.board(event.board).readings += 1
        return
      case 'close-failed':
        this.board(event.board).closeFailures += 1
        return
      case 'evicted':
        this.board(event.board).evicted += 1
        return
      case 'dropped':
        bump(this.board(event.board).dropped, event.reason)
        return
      case 'segment-started':
        bump(this.board(event.board).segmentsStarted, event.reason)
        return
      case 'intensity-skipped':
        bump(this.board(event.board).intensitySkipped, event.reason)
        return
      default:
        // **種類を足して分岐を書き忘れたときに止まるのはここだけ。**
        // 黙って無視する作りだと、その出来事は要約にも状態の口にも一切現れない。
        return assertNever(event)
    }
  }

  private source(key: string): MutableSource {
    return entryOf(this.sources, key, this.maxKeys, newSource)
  }

  private board(key: string): MutableBoard {
    return entryOf(this.boards, key, this.maxKeys, newBoard)
  }
}

function assertNever(value: never): never {
  throw new Error(`数え方を決めていない出来事: ${JSON.stringify(value)}`)
}

function freezeSource(m: MutableSource): SourceCounts {
  return {
    received: m.received,
    rateLimited: m.rateLimited,
    parseFailed: new Map(m.parseFailed),
    rawUnsaved: new Map(m.rawUnsaved),
  }
}

function freezeBoard(m: MutableBoard): BoardCounts {
  return {
    accepted: m.accepted,
    readings: m.readings,
    closeFailures: m.closeFailures,
    evicted: m.evicted,
    dropped: new Map(m.dropped),
    segmentsStarted: new Map(m.segmentsStarted),
    intensitySkipped: new Map(m.intensitySkipped),
  }
}

function freeze(buckets: Buckets): TallySnapshot {
  const sources = new Map<string, SourceCounts>()
  for (const [key, value] of buckets.sources) sources.set(key, freezeSource(value))
  const boards = new Map<string, BoardCounts>()
  for (const [key, value] of buckets.boards) boards.set(key, freezeBoard(value))
  return { sources, boards }
}

export interface PacketTallyOptions {
  /** 覚えていられる鍵の数（表ごと）。既定 64。 */
  readonly maxKeys?: number
}

/**
 * 数え上げ。**累計と「前回の要約から」の 2 本を同時に進める。**
 *
 * 呼び出し側に 2 度書かせない —— 片方を書き忘れると、数字が静かに食い違う。
 */
export class PacketTally {
  private readonly total: Buckets
  private window: Buckets
  private readonly maxKeys: number

  constructor(options: PacketTallyOptions = {}) {
    this.maxKeys = options.maxKeys ?? MAX_KEYS_DEFAULT
    this.total = new Buckets(this.maxKeys)
    this.window = new Buckets(this.maxKeys)
  }

  record(event: TallyEvent): void {
    this.total.apply(event)
    this.window.apply(event)
  }

  /** 起動してからの累計。**窓は空にしない。** */
  snapshotTotal(): TallySnapshot {
    return freeze(this.total)
  }

  /** 前回この関数を呼んでからの分を返し、窓を空にする。 */
  takeWindow(): TallySnapshot {
    const taken = freeze(this.window)
    this.window = new Buckets(this.maxKeys)
    return taken
  }
}

/** 鍵の並び。**「その他」は必ず最後。** 残りは名前順で、続けて出す要約の行が揃う。 */
function sortedKeys(keys: Iterable<string>): string[] {
  const list = [...keys]
  list.sort((a, b) => {
    if (a === OVERFLOW_KEY) return 1
    if (b === OVERFLOW_KEY) return -1
    return a.localeCompare(b)
  })
  return list
}

/** `理由=件数` を並べる。0 件の理由は出さない（行が読めなくなる）。 */
function parts<K extends string>(counts: ReadonlyMap<K, number>, order: readonly K[]): string[] {
  const out: string[] = []
  for (const key of order) {
    const n = counts.get(key)
    if (n !== undefined && n > 0) out.push(`${key}=${n}`)
  }
  // **並び順に無い理由も落とさない。** 型では止めてあるけれど、型を通らない経路
  // （JSON から組み直す等）で入ってきたものまで黙らせる理由は無い。
  for (const [key, n] of counts) {
    if (n > 0 && !order.includes(key)) out.push(`${key}=${n}`)
  }
  return out
}

function group(label: string, items: readonly string[]): string {
  return items.length === 0 ? '' : ` ${label}: ${items.join(' ')}`
}

/**
 * 要約の行を組む。**出す先は呼び出し側が決める**（いまは標準出力、4-4 で状態の口）。
 *
 * 何も起きていなければ空の配列を返す。「届いていない」と言うかどうかは、
 * 窓の区切りを知っている呼び出し側の判断。
 */
export function formatTally(snapshot: TallySnapshot): string[] {
  const lines: string[] = []
  for (const key of sortedKeys(snapshot.sources.keys())) {
    const s = snapshot.sources.get(key)
    if (s === undefined) continue
    const rate = s.rateLimited > 0 ? ` 上限で落とした=${s.rateLimited}` : ''
    lines.push(
      `送信元 ${key} 届いた=${s.received}${rate}` +
        group('読めず', parts(s.parseFailed, PARSE_FAILURE_ORDER)) +
        group('残せず', parts(s.rawUnsaved, RAW_UNSAVED_ORDER)),
    )
  }
  for (const key of sortedKeys(snapshot.boards.keys())) {
    const b = snapshot.boards.get(key)
    if (b === undefined) continue
    const close = b.closeFailures > 0 ? ` 締めくくり失敗=${b.closeFailures}` : ''
    const evict = b.evicted > 0 ? ` 枠の上限で閉じた=${b.evicted}` : ''
    lines.push(
      `基板 ${key} 通した=${b.accepted} 震度=${b.readings}${close}${evict}` +
        group('落とした', parts(b.dropped, DROP_ORDER)) +
        group('切れ目', parts(b.segmentsStarted, BREAK_ORDER)) +
        group('震度なし', parts(b.intensitySkipped, SKIP_ORDER)),
    )
  }
  return lines
}
