// 公開観測点の SeedLink を、同じブラウザのタブどうしで 1 本にまとめる係（`docs/public-waveform-design.md` §0・§5.2）。
//
// **同じ IP からの同時接続は 5 本まで**（§2）。タブごとに繋ぐと、同じ端末で開いたタブの数だけ 1 本ずつ使う。
// そこで **Web Locks で 1 つのタブを繋ぎ役に決め**、繋ぎ役が受けたレコードを BroadcastChannel でほかのタブへ配る
// （2026-10-15 ユーザー承認）。繋ぎ役のタブが閉じるとロックが外れ、次のタブが繋ぎ役になって時間幅ぶん遡って繋ぎ直す。
//
// **繋ぐかどうかは全タブの「要る」を合わせて決める。** 繋ぎ役は自分が要らなくても、ほかのタブが要るなら繋ぐ。
// 各タブは要るかどうかを定期的に知らせ、知らせが途絶えたタブは要らないものとして扱う（閉じたタブが繋ぎっぱなしに
// させないため）。
//
// **後から開いたタブには、繋ぎ役が控えている直近の分を渡す**（時間幅のいちばん長いぶん）。渡さないと、そのタブだけ
// 次のレコード（約 21 秒後）まで絵が空く。
//
// **Web Locks か BroadcastChannel が無いブラウザでは、まとめずに自分で繋ぐ。**

import type { Mseed2Record } from '../utils/miniseed2'
import { MAX_WAVE_SPAN_SEC } from '../utils/waveSpan'
import type { PublicLinkNeed, PublicLinkStatus } from './publicWaveLink'

export const SHARE_CHANNEL_NAME = 'yuremado-public-wave'
export const SHARE_LOCK_NAME = 'yuremado-public-wave-link'
/** 「要る」の知らせの間隔（ms）。 */
export const NEED_HEARTBEAT_MS = 10_000
/** 知らせがこれより途絶えたタブは要らないものとして扱う（ms）。 */
export const NEED_EXPIRE_MS = 30_000
/** 繋ぎ役が控える長さ（ms）。時間幅のいちばん長いぶんに、レコード 1 本ぶん（約 21 秒）の余白を足す。 */
export const BACKLOG_KEEP_MS = MAX_WAVE_SPAN_SEC * 1000 + 30_000

type ShareMessage =
  | { readonly t: 'need'; readonly tabId: string; readonly active: boolean; readonly spanSec: number }
  | { readonly t: 'record'; readonly rec: Mseed2Record }
  | { readonly t: 'status'; readonly status: PublicLinkStatus }
  | { readonly t: 'backlog-request'; readonly tabId: string }
  | { readonly t: 'backlog'; readonly to: string; readonly recs: readonly Mseed2Record[] }

/** 繋ぎ役が使う 1 本（`PublicWaveLink`）の口。 */
export interface LinkLike {
  setNeed(need: PublicLinkNeed): void
  getStatus(): PublicLinkStatus
  dispose(): void
}

export interface ShareChannel {
  postMessage(message: unknown): void
  onmessage: ((ev: { data: unknown }) => void) | null
  close(): void
}

export interface PublicShareDeps {
  /** Web Locks（`navigator.locks`）。無ければ `null`。 */
  readonly locks: { request(name: string, cb: () => Promise<void>): Promise<unknown> } | null
  /** BroadcastChannel を作る。作れなければ `null`。 */
  readonly openChannel: (name: string) => ShareChannel | null
  readonly makeLink: (onRecord: (rec: Mseed2Record) => void, onStatus: (s: PublicLinkStatus) => void) => LinkLike
  readonly now: () => number
  readonly setInterval: (fn: () => void, ms: number) => unknown
  readonly clearInterval: (h: unknown) => void
  readonly tabId: string
}

interface TabNeed {
  readonly active: boolean
  readonly spanSec: number
  readonly at: number
}

/** レコードの末尾の時刻（ms）。 */
function recordEndMs(rec: Mseed2Record): number {
  return rec.startMs + (rec.samples.length * 1000) / rec.sampleRate
}

export class PublicWaveShare {
  private readonly channel: ShareChannel | null
  private link: LinkLike | null = null
  private leader = false
  private releaseLock: (() => void) | null = null
  private disposed = false
  private own: { active: boolean; spanSec: number; stations: readonly string[] } = { active: false, spanSec: 0, stations: [] }
  private readonly others = new Map<string, TabNeed>()
  private backlog: Mseed2Record[] = []
  private readonly heartbeat: unknown
  private status: PublicLinkStatus = { kind: 'idle' }

  constructor(
    private readonly deps: PublicShareDeps,
    private readonly onRecord: (rec: Mseed2Record) => void,
    private readonly onStatus: (s: PublicLinkStatus) => void,
  ) {
    this.channel = deps.locks === null ? null : deps.openChannel(SHARE_CHANNEL_NAME)
    if (this.channel === null) {
      // まとめられないので自分で繋ぐ。
      this.becomeLeader()
    } else {
      this.channel.onmessage = (ev) => this.onMessage(ev.data as ShareMessage)
      void deps.locks!.request(SHARE_LOCK_NAME, () => {
        if (this.disposed) return Promise.resolve()
        this.becomeLeader()
        return new Promise<void>((resolve) => {
          this.releaseLock = resolve
        })
      })
      this.post({ t: 'backlog-request', tabId: deps.tabId })
    }
    this.heartbeat = deps.setInterval(() => this.tick(), NEED_HEARTBEAT_MS)
  }

  /** このタブが要るか・時間幅・載せる観測点（運用中の全部）。 */
  setNeed(active: boolean, spanSec: number, stations: readonly string[]): void {
    if (this.disposed) return
    this.own = { active, spanSec, stations }
    this.post({ t: 'need', tabId: this.deps.tabId, active, spanSec })
    this.apply()
  }

  isLeader(): boolean {
    return this.leader
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.deps.clearInterval(this.heartbeat)
    if (this.channel !== null) {
      // 要らなくなったことを知らせてから閉じる（繋ぎ役が待たずに閉じられるよう）。
      this.post({ t: 'need', tabId: this.deps.tabId, active: false, spanSec: 0 })
      this.channel.onmessage = null
      this.channel.close()
    }
    this.link?.dispose()
    this.link = null
    this.releaseLock?.()
  }

  private post(message: ShareMessage): void {
    try {
      this.channel?.postMessage(message)
    } catch {
      // 送れなくても自分の受信は続ける（ほかのタブは次の知らせで追いつく）。
    }
  }

  private becomeLeader(): void {
    if (this.disposed || this.leader) return
    this.leader = true
    this.link = this.deps.makeLink(
      (rec) => {
        this.keep(rec)
        this.onRecord(rec)
        this.post({ t: 'record', rec })
      },
      (status) => {
        this.status = status
        this.onStatus(status)
        this.post({ t: 'status', status })
      },
    )
    this.apply()
  }

  private keep(rec: Mseed2Record): void {
    this.backlog.push(rec)
    const cutoff = recordEndMs(rec) - BACKLOG_KEEP_MS
    if (this.backlog.length > 0 && recordEndMs(this.backlog[0]) < cutoff) {
      this.backlog = this.backlog.filter((r) => recordEndMs(r) >= cutoff)
    }
  }

  /** 全タブの「要る」を合わせ、繋ぎ役なら 1 本へ渡す。 */
  private apply(): void {
    if (!this.leader || this.link === null) return
    const now = this.deps.now()
    let active = this.own.active
    let spanSec = this.own.active ? this.own.spanSec : 0
    for (const [tabId, need] of this.others) {
      if (now - need.at > NEED_EXPIRE_MS) {
        this.others.delete(tabId)
        continue
      }
      if (need.active) {
        active = true
        spanSec = Math.max(spanSec, need.spanSec)
      }
    }
    this.link.setNeed({ active, spanSec, stations: this.own.stations })
  }

  private tick(): void {
    this.post({ t: 'need', tabId: this.deps.tabId, active: this.own.active, spanSec: this.own.spanSec })
    this.apply()
  }

  private onMessage(msg: ShareMessage): void {
    if (this.disposed || msg === null || typeof msg !== 'object') return
    switch (msg.t) {
      case 'need':
        this.others.set(msg.tabId, { active: msg.active, spanSec: msg.spanSec, at: this.deps.now() })
        this.apply()
        break
      case 'record':
        if (!this.leader) this.onRecord(msg.rec)
        break
      case 'status':
        if (!this.leader) {
          this.status = msg.status
          this.onStatus(msg.status)
        }
        break
      case 'backlog-request':
        if (this.leader) {
          this.post({ t: 'backlog', to: msg.tabId, recs: this.backlog })
          this.post({ t: 'status', status: this.status })
        }
        break
      case 'backlog':
        if (!this.leader && msg.to === this.deps.tabId) for (const rec of msg.recs) this.onRecord(rec)
        break
    }
  }
}
