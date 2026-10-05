// 気象庁の地震情報を P2PQuake から受け取る（REQUIREMENTS.md §6・§18。照合の入口）。
//
//   WebSocket（wss://api.p2pquake.net/v2/ws）を 1 本張り、地震情報（code 551）を `onQuake` へ渡す。
//   繋がるたびに `/v2/history?codes=551` を 1 回だけ引き、途切れていた間の分を埋める。
//
// **通信量**（CLAUDE.md「調査で外部 API を叩くとき」・data-sources-spec.md §3）:
//   - WebSocket は常に 1 本
//   - `/v2/history` は「繋がった回」だけ。繋ぎ直しの間隔は 5 秒から倍々に延ばし 5 分で頭打ち
//     → 途切れ続けても 1 時間に 15 回ほど。上限（60 回／分・IP ごと）に届かない
//   - **間隔を 5 秒へ戻すのは、繋がりが `STABLE_CONNECTION_MS` 続いてから切れたときだけ。**
//     繋がった瞬間に戻すと、開いてはすぐ切れる状態（相手が受け付けてすぐ閉じる等）で
//     5 秒ごとに繋ぎ直し、そのたびに履歴を取りに行く（1 時間に 700 回を超える）
//
// **途切れていた時間帯を覚える。** 照合（`shakeEventBook.ts`）は「地震情報が来なかった」と
// 「受け取れていなかった」を区別しなければならない —— 前者なら揺れは地震でなかったと言えるが、
// 後者では言えない。履歴で埋められた途切れは「埋まった」とみなす（ただし、履歴の最も古い報が
// 途切れの始まりより新しければ、その前は埋まっていない）。
//
// **投げない。** 受け手（ホスト）を止めないため。失敗は数えて記録に残す。

import { isUnsettledP2pQuake, parseP2pQuakeItem, parseP2pQuakeList, parseP2pTime } from './p2pQuake'
import type { P2pReferenceQuake } from './p2pQuake'

export const P2PQUAKE_WS_URL = 'wss://api.p2pquake.net/v2/ws'
export const P2PQUAKE_HISTORY_URL = 'https://api.p2pquake.net/v2/history?codes=551&limit=50'

const RECONNECT_MIN_MS = 5_000
const RECONNECT_MAX_MS = 5 * 60_000
/** この長さ繋がっていてから切れたら、繋ぎ直しの間隔を最短へ戻す。 */
const STABLE_CONNECTION_MS = 60_000
/** 途切れの記録を覚えておく長さ（照合の記憶 `MEMORY_MS` より長く）。 */
const GAP_MEMORY_MS = 6 * 3_600_000

/** 使う WebSocket の最小限の形（テストで差し替える）。 */
export interface FeedSocket {
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  close(): void
}

export interface QuakeFeedOptions {
  readonly onQuake: (quake: P2pReferenceQuake) => void
  readonly now: () => number
  readonly log: (level: 'log' | 'warn' | 'error', line: string) => void
  readonly openSocket?: (url: string) => FeedSocket
  readonly fetchHistory?: (url: string) => Promise<unknown>
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export interface QuakeFeedStatus {
  readonly connected: boolean
  readonly connectedSinceMs: number | null
  readonly reconnects: number
  readonly quakesReceived: number
  readonly historyFetches: number
  readonly historyFailures: number
  readonly unreadableMessages: number
  /** いま覚えている「埋まっていない途切れ」。 */
  readonly openGaps: readonly { readonly fromMs: number; readonly toMs: number | null }[]
}

interface Gap {
  fromMs: number
  /** 繋がり直した時刻。まだ途切れていれば null。 */
  toMs: number | null
}

export class QuakeFeed {
  private readonly opts: QuakeFeedOptions
  private socket: FeedSocket | null = null
  private timer: unknown = null
  private backoffMs = RECONNECT_MIN_MS
  private stopped = false
  private connectedSinceMs: number | null = null
  /** 埋まっていない途切れ。起動してから最初に繋がるまでも途切れとして数える。 */
  private gaps: Gap[]
  private reconnects = 0
  private quakesReceived = 0
  private historyFetches = 0
  private historyFailures = 0
  private unreadableMessages = 0

  constructor(options: QuakeFeedOptions) {
    this.opts = options
    this.gaps = [{ fromMs: options.now(), toMs: null }]
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) (this.opts.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>)
    this.timer = null
    this.socket?.close()
    this.socket = null
  }

  /** `[fromMs, toMs]` の間、地震情報を取りこぼしていないと言えるか。 */
  covered(fromMs: number, toMs: number): boolean {
    for (const g of this.gaps) {
      const gTo = g.toMs ?? Number.POSITIVE_INFINITY
      if (g.fromMs <= toMs && gTo >= fromMs) return false
    }
    return true
  }

  status(): QuakeFeedStatus {
    return {
      connected: this.connectedSinceMs !== null,
      connectedSinceMs: this.connectedSinceMs,
      reconnects: this.reconnects,
      quakesReceived: this.quakesReceived,
      historyFetches: this.historyFetches,
      historyFailures: this.historyFailures,
      unreadableMessages: this.unreadableMessages,
      openGaps: this.gaps.map((g) => ({ fromMs: g.fromMs, toMs: g.toMs })),
    }
  }

  private connect(): void {
    if (this.stopped) return
    let socket: FeedSocket
    try {
      socket = (this.opts.openSocket ?? defaultOpenSocket)(P2PQUAKE_WS_URL)
    } catch (error) {
      this.opts.log('warn', `[quake-feed] WebSocket を開けず: ${messageOf(error)}`)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      const nowMs = this.opts.now()
      this.connectedSinceMs = nowMs
      for (const g of this.gaps) if (g.toMs === null) g.toMs = nowMs
      void this.catchUp()
    }
    socket.onmessage = (ev) => this.handleMessage(ev.data)
    socket.onerror = () => {
      // 続けて onclose が来るので、ここでは何もしない（二重に繋ぎ直さない）。
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      if (this.connectedSinceMs !== null) {
        const nowMs = this.opts.now()
        if (nowMs - this.connectedSinceMs >= STABLE_CONNECTION_MS) this.backoffMs = RECONNECT_MIN_MS
        this.gaps.push({ fromMs: nowMs, toMs: null })
        this.connectedSinceMs = null
      }
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.reconnects++
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS)
    this.timer = (this.opts.setTimer ?? setTimeout)(() => {
      this.timer = null
      this.connect()
    }, delay)
  }

  private handleMessage(data: unknown): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : String(data))
    } catch {
      this.unreadableMessages++
      return
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { code?: unknown }).code !== 551) return
    const quake = parseP2pQuakeItem(parsed)
    if (quake === null) {
      // 履歴の読み取り（`parseP2pQuakeList`）と同じ分け方。震源未確定の報は数えない。
      if (!isUnsettledP2pQuake(parsed)) this.unreadableMessages++
      return
    }
    this.quakesReceived++
    this.opts.onQuake(quake)
  }

  /** 繋がった直後に履歴を 1 回引き、途切れていた間の地震情報を渡す。埋められた途切れを消す。 */
  private async catchUp(): Promise<void> {
    this.historyFetches++
    let raw: unknown
    try {
      raw = await (this.opts.fetchHistory ?? defaultFetchHistory)(P2PQUAKE_HISTORY_URL)
    } catch (error) {
      this.historyFailures++
      this.opts.log('warn', `[quake-feed] 履歴を取れず（途切れていた間は照合できない扱いのまま）: ${messageOf(error)}`)
      // 取れなくても古い途切れは忘れる（覚えておく長さは取れたときと同じ）。
      this.forgetOldGaps()
      return
    }
    if (!Array.isArray(raw)) {
      // 取れたが形が違う（エラーの本文が 200 で返った等）。「0 件だった」と区別するため失敗に数える。
      this.historyFailures++
      this.opts.log('warn', '[quake-feed] 履歴が配列で返らなかった（途切れていた間は照合できない扱いのまま）')
      this.forgetOldGaps()
      return
    }
    const { quakes, unreadable } = parseP2pQuakeList(raw)
    if (unreadable > 0) this.opts.log('warn', `[quake-feed] 履歴のうち ${unreadable} 件を読めず`)
    for (const q of quakes) this.opts.onQuake(q)
    // 履歴が遡れた範囲（最も古い報の時刻）より後に始まった途切れだけを「埋まった」とみなす。
    // 返ってきた件数が上限に届いていなければ、途切れの間に出た報は全部入っている。
    const oldest = oldestTime(raw)
    const complete = raw.length < 50
    this.gaps = this.gaps.filter((g) => {
      if (g.toMs === null) return true
      return !(complete || (oldest !== null && oldest <= g.fromMs))
    })
    this.forgetOldGaps()
  }

  /** 閉じてから `GAP_MEMORY_MS` を過ぎた途切れを忘れる。 */
  private forgetOldGaps(): void {
    const nowMs = this.opts.now()
    this.gaps = this.gaps.filter((g) => g.toMs === null || nowMs - g.toMs < GAP_MEMORY_MS)
  }
}

function oldestTime(raw: unknown): number | null {
  if (!Array.isArray(raw)) return null
  let oldest: number | null = null
  for (const item of raw) {
    const t = typeof item === 'object' && item !== null ? (item as { time?: unknown }).time : undefined
    if (typeof t !== 'string') continue
    // 履歴の各要素の `time` は受信時刻（`YYYY/MM/DD HH:mm:ss.SSS`）。秒より下は捨てて読む。
    const ms = parseP2pTime(t.slice(0, 19))
    if (ms !== null && (oldest === null || ms < oldest)) oldest = ms
  }
  return oldest
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultOpenSocket(url: string): FeedSocket {
  return new WebSocket(url) as unknown as FeedSocket
}

async function defaultFetchHistory(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as unknown
}
