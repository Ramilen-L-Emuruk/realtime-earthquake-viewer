// 公開観測点の SeedLink の 1 本を張り、切れたら繋ぎ直す係（`docs/public-waveform-design.md` §5.2・§8）。
//
// **繋ぐのは要るときだけ**（既定は波形を出すときだけ、設定で繋ぎっぱなし。§0）。要らなくなったら閉じる。
// **最初から 20 点を載せる**（選び直しで繋ぎ直さない。§0）。**時間幅ぶん遡る**（`TIME`。§0）——繋ぎ直しでも
// 同じだけ遡るので重なって届くが、入れ物（`utils/publicWaveBuffer.ts`）は同じ時刻を同じ場所へ置くので崩れない。
//
// **繋ぎ直しの待ちは倍々に伸ばし、ゆらぎを足す**（§5.2）。EarthScope が止まったとき、全端末が同じ時刻に繋ぎ直さないため。
//
// **断られたことを見分ける。** 同じ IP から 5 本を超えると断られる（§2）が、**どう断られるかは測っていない**（§11）。
// いまは「命令が断られた（`ERROR`）」か「流れ始める前に切られた」が続いたら断られたとみなす（仮。測ってから合わせる。§12）。

import { connectSeedlink, EARTHSCOPE_SEEDLINK_URL, type SeedlinkClosed, type SeedlinkConnection, type SeedlinkHandlers, type SeedlinkOptions } from './seedlink'
import type { Mseed2Record } from '../utils/miniseed2'
import { createLogThrottle, log } from '../utils/logger'
import { PUBLIC_NETWORK } from '../utils/publicStations'

/** 開くまでの期限（ms）。 */
const OPEN_TIMEOUT_MS = 15_000
/** 命令 1 つへの応答の期限（ms）。 */
const REPLY_TIMEOUT_MS = 15_000
/**
 * 読めるレコードが 1 本も届かない時間がこれを超えたら止まったとみなす（ms）。静かなとき 1 成分のレコードは約 21 秒おきに届き、
 * 20 点 × 3 成分なら 1 秒に数本は来る（§3.2）。**揺れている間の届き方は測っていない**（§12「途絶と黙りの長さ」）。仮に 90 秒。
 */
const STALL_TIMEOUT_MS = 90_000
/** 遡るときに時間幅へ足す余白（ms）。レコードは約 21 秒ぶんのまとまりなので、その分だけ手前から。 */
const BACKFILL_PAD_MS = 30_000
/** 繋ぎ直しの待ちの最初（ms）と上限（ms）。 */
export const RETRY_BASE_MS = 2_000
export const RETRY_MAX_MS = 5 * 60_000
/** 断られたとみなすまでに続けて断られる回数。 */
export const REFUSED_STREAK = 2

export type PublicLinkStatus =
  /** 要らないので繋いでいない */
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'streaming' }
  /** 切れたので待ってから繋ぎ直す */
  | { readonly kind: 'retrying'; readonly retryAtMs: number; readonly lastClose: string }
  /** 続けて断られている（接続数の上限とみなす）。待ってから繋ぎ直す */
  | { readonly kind: 'refused'; readonly retryAtMs: number; readonly lastClose: string }

export interface PublicLinkNeed {
  readonly active: boolean
  /** 遡る長さ（秒）。設定の時間幅。 */
  readonly spanSec: number
  /** 載せる観測点（運用中の全部。最初から 20 点。§0）。 */
  readonly stations: readonly string[]
}

export interface PublicLinkDeps {
  readonly connect: (options: SeedlinkOptions, handlers: SeedlinkHandlers) => SeedlinkConnection
  readonly webSocket: typeof WebSocket
  /** 遡る起点を決める時計（`serverNow`）。 */
  readonly serverNow: () => number
  /** 待ちを測る時計（`performance.now()` か `Date.now()`）。 */
  readonly now: () => number
  readonly random: () => number
  readonly setTimeout: (fn: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

export const defaultPublicLinkDeps = (): PublicLinkDeps => ({
  connect: connectSeedlink,
  webSocket: globalThis.WebSocket,
  serverNow: () => Date.now(),
  now: () => Date.now(),
  random: Math.random,
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
})

/** 繋ぎ直しまでの待ち（ms）。`attempt` は続けて失敗した回数（1 始まり）。ゆらぎは ×0.5〜×1.5。 */
export function retryDelayMs(attempt: number, random: number): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1))
  return Math.round(base * (0.5 + Math.min(1, Math.max(0, random))))
}

/** 断られたとみなす閉じ方か。**仮の判定**（§11 の測り方で断られ方を確かめてから合わせる）。 */
export function looksRefused(closed: SeedlinkClosed, streamed: boolean): boolean {
  if (closed.reason === 'refused') return true
  return !streamed && (closed.reason === 'closed-by-peer' || closed.reason === 'stalled')
}

/** 記録は種類ごとに 1 分に 1 回まで。 */
const logThrottles = new Map<string, (emit: () => void) => void>()
function throttled(kind: string, emit: () => void): void {
  let t = logThrottles.get(kind)
  if (t === undefined) {
    t = createLogThrottle(60_000)
    logThrottles.set(kind, t)
  }
  t(emit)
}

export class PublicWaveLink {
  private need: PublicLinkNeed = { active: false, spanSec: 0, stations: [] }
  private conn: SeedlinkConnection | null = null
  private retryTimer: unknown = null
  private failures = 0
  private refusedStreak = 0
  private status: PublicLinkStatus = { kind: 'idle' }
  private disposed = false

  constructor(
    private readonly deps: PublicLinkDeps,
    private readonly onRecord: (record: Mseed2Record) => void,
    private readonly onStatus: (status: PublicLinkStatus) => void,
  ) {}

  /** 要るかどうか・遡る長さ・載せる観測点を渡す。要るなら繋ぎ、要らなくなったら閉じる。 */
  setNeed(need: PublicLinkNeed): void {
    if (this.disposed) return
    const stationsChanged = need.stations.join(',') !== this.need.stations.join(',')
    this.need = need
    if (!need.active || need.stations.length === 0) {
      this.stop()
      return
    }
    // 載せる観測点が変わったときだけ繋ぎ直す（運用の区切りをまたいだとき。ふだんは変わらない）。
    if (stationsChanged && this.conn !== null) {
      this.conn.close()
      return
    }
    if (this.conn === null && this.retryTimer === null) this.open()
  }

  getStatus(): PublicLinkStatus {
    return this.status
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }

  private setStatus(status: PublicLinkStatus): void {
    this.status = status
    this.onStatus(status)
  }

  private stop(): void {
    if (this.retryTimer !== null) {
      this.deps.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const conn = this.conn
    this.conn = null
    conn?.close()
    this.failures = 0
    this.refusedStreak = 0
    if (this.status.kind !== 'idle') this.setStatus({ kind: 'idle' })
  }

  private open(): void {
    this.retryTimer = null
    if (this.disposed || !this.need.active) return
    let streamed = false
    const startMs = this.deps.serverNow() - this.need.spanSec * 1000 - BACKFILL_PAD_MS
    this.setStatus({ kind: 'connecting' })
    const self = this
    const conn = this.deps.connect(
      {
        url: EARTHSCOPE_SEEDLINK_URL,
        request: { network: PUBLIC_NETWORK, stations: this.need.stations, startMs },
        openTimeoutMs: OPEN_TIMEOUT_MS,
        replyTimeoutMs: REPLY_TIMEOUT_MS,
        stallTimeoutMs: STALL_TIMEOUT_MS,
        webSocket: this.deps.webSocket,
      },
      {
        onRecord: (record) => self.onRecord(record),
        onUnreadable: (problem, detail) => {
          throttled('unreadable', () => log.warn(`[public-wave] 読めないレコード（${problem}）: ${detail}`))
        },
        onStreaming: () => {
          streamed = true
          self.failures = 0
          self.refusedStreak = 0
          self.setStatus({ kind: 'streaming' })
        },
        onClosed: (closed) => self.onClosed(conn, closed, streamed),
      },
    )
    // `connect` の中から同期で閉じる知らせが来ることがある（`failed-to-start` は次の順番へ回すので来ない）。
    if (this.status.kind === 'connecting') this.conn = conn
  }

  private onClosed(conn: SeedlinkConnection, closed: SeedlinkClosed, streamed: boolean): void {
    if (this.conn === conn) this.conn = null
    if (closed.reason === 'closed-by-caller') {
      // 観測点が変わって閉じたときは、すぐ繋ぎ直す。
      if (!this.disposed && this.need.active && this.retryTimer === null && this.conn === null) this.open()
      return
    }
    if (this.disposed || !this.need.active) return
    this.failures += 1
    this.refusedStreak = looksRefused(closed, streamed) ? this.refusedStreak + 1 : 0
    const lastClose = `${closed.reason}: ${closed.detail}`
    throttled(closed.reason, () => log.warn(`[public-wave] SeedLink が切れた（${lastClose}・受けたレコード ${closed.records}）`))
    const delay = retryDelayMs(this.failures, this.deps.random())
    const retryAtMs = this.deps.now() + delay
    this.setStatus(
      this.refusedStreak >= REFUSED_STREAK ? { kind: 'refused', retryAtMs, lastClose } : { kind: 'retrying', retryAtMs, lastClose },
    )
    this.retryTimer = this.deps.setTimeout(() => this.open(), delay)
  }
}
