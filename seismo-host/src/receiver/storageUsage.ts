// 保存先の容量を測る係。ドライブの空きと全体・種類ごとの使用量・あと何日もつか・少なくなったときの警告。
//
// **なぜ要るか。** 保存は自動では消さない方針（`mseedStore.ts`・`waveArchive.ts`）で、ドライブが埋まると
// 保存だけが止まる。止まった後に書き込み失敗の件数（`MseedHealth.writeErrors`）で知るのでは遅い。
//
// **測り方**
// - ドライブの空き・全体は `statfs` を `diskIntervalMs`（既定 60 秒）ごと。軽い
// - 種類ごとの使用量は置き場所を辿って大きさを足す。ファイルが数千本あるので `walkIntervalMs`（既定 10 分）
//   ごと、`YIELD_EVERY` 本ごとにイベントループへ譲る（受信を止めない）
// - **種類ごとに同じドライブかを `stat().dev` で見分ける。** 環境変数で置き場所を別々のドライブへ分けた
//   構成では、ドライブごとに空きと日数を出す
// - あと何日もつかは、そのドライブに載っている種類の合計の増え方で空きを割る。増え方は直近
//   `RATE_WINDOW_MS`（24 時間）の標本の最古と最新の差。**標本の幅が `MIN_RATE_SPAN_MS`（1 時間）に満たない
//   間は出さない**（起動直後の数分で割ると、要約の作り直しの一瞬の伸びを 1 日へ引き延ばす）
// - **複製（`storageMigration.ts`）で書いた分は増え方から引く**（`excludeBytes`）。引かないと、複製中は
//   数百 GB を数時間で書くので「あと 0 日」と出る

import { readdir, stat, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { StorageDirs, StorageKind } from './hostSettings'

const DISK_INTERVAL_MS_DEFAULT = 60_000
const WALK_INTERVAL_MS_DEFAULT = 10 * 60_000
const YIELD_EVERY = 200
export const RATE_WINDOW_MS = 24 * 3_600_000
export const MIN_RATE_SPAN_MS = 3_600_000
/** これを下回ったら警告する（技術判断）。 */
export const LOW_DAYS_LEFT = 7
export const LOW_FREE_RATIO = 0.05

export interface DiskSpace {
  readonly freeBytes: number
  readonly totalBytes: number
}

export interface KindUsage {
  readonly kind: StorageKind
  readonly path: string
  readonly bytes: number
  readonly files: number
}

export interface DriveUsage {
  /** このドライブに載っている種類。 */
  readonly kinds: readonly StorageKind[]
  readonly freeBytes: number
  readonly totalBytes: number
  /** 1 日あたりの増え方。測れていない・増えていないときは `null`。 */
  readonly growthBytesPerDay: number | null
  /** 空きを増え方で割った日数。`growthBytesPerDay` が `null` なら `null`。 */
  readonly daysLeft: number | null
  readonly warning: 'low-days' | 'low-free' | null
}

export interface StorageUsageStatus {
  /** 種類ごとの使用量。**まだ一度も数え終えていなければ `null`。** */
  readonly kinds: readonly KindUsage[] | null
  readonly countedAtMs: number | null
  readonly drives: readonly DriveUsage[]
  /** 直近に測れなかった理由（ドライブ・辿り）。**素の理由だけ**（画面が「容量を測れない: 」を前に付ける）。 */
  readonly lastError: string | null
}

export interface StorageUsageOptions {
  readonly dirs: StorageDirs
  readonly now?: () => number
  readonly diskIntervalMs?: number
  readonly walkIntervalMs?: number
  /** 複製で書いた累計のバイト数（増え方から引く）。 */
  readonly excludeBytes?: () => number
  /** 差し替えられるのはテストのため。 */
  readonly statfs?: (path: string) => Promise<DiskSpace>
  readonly deviceOf?: (path: string) => Promise<number | null>
  readonly walk?: (path: string) => Promise<{ bytes: number; files: number }>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

async function defaultStatfs(path: string): Promise<DiskSpace> {
  const s = await statfs(path)
  return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }
}

/**
 * その置き場所が載るドライブ。**置き場所がまだ無ければ（書く前）、上へ辿って最初にあるフォルダで見る** ——
 * 無いからと外すと、保存先の 4 つが同じドライブなのに別々のドライブに見える。どこまで辿っても無ければ `null`。
 */
async function defaultDeviceOf(path: string): Promise<number | null> {
  let p = path
  for (;;) {
    try {
      return (await stat(p)).dev
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const parent = dirname(p)
    if (parent === p) return null
    p = parent
  }
}

/** 置き場所の下のファイルの大きさを足す。**無い置き場所は 0。** 辿っている間に消えたファイルは数えない。 */
export async function walkSize(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  let visited = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(p)
      } else if (e.isFile()) {
        try {
          bytes += (await stat(p)).size
          files += 1
        } catch (error) {
          if (!isMissing(error)) throw error
        }
      }
      visited += 1
      if (visited % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r))
    }
  }
  return { bytes, files }
}

interface Sample {
  readonly atMs: number
  readonly bytes: number
}

/** 標本から 1 日あたりの増え方を出す（純関数）。幅が足りない・増えていないなら `null`。 */
export function growthPerDay(samples: readonly Sample[]): number | null {
  if (samples.length < 2) return null
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const span = last.atMs - first.atMs
  if (span < MIN_RATE_SPAN_MS) return null
  const grown = last.bytes - first.bytes
  if (grown <= 0) return null
  return (grown / span) * 86_400_000
}

/** 空き・全体・増え方から警告を決める（純関数）。 */
export function driveWarning(
  freeBytes: number,
  totalBytes: number,
  daysLeft: number | null,
): DriveUsage['warning'] {
  if (totalBytes > 0 && freeBytes / totalBytes < LOW_FREE_RATIO) return 'low-free'
  if (daysLeft !== null && daysLeft < LOW_DAYS_LEFT) return 'low-days'
  return null
}

export class StorageUsage {
  private readonly opts: StorageUsageOptions
  private readonly now: () => number
  private readonly statfs: NonNullable<StorageUsageOptions['statfs']>
  private readonly deviceOf: NonNullable<StorageUsageOptions['deviceOf']>
  private readonly walk: NonNullable<StorageUsageOptions['walk']>
  private kinds: KindUsage[] | null = null
  private countedAtMs: number | null = null
  /** ドライブ（`dev` を文字列にしたもの）ごとの、そこに載る種類と空き。 */
  private groups = new Map<string, { kinds: StorageKind[]; space: DiskSpace | null }>()
  private readonly samples = new Map<string, Sample[]>()
  private diskError: string | null = null
  private countError: string | null = null
  private walking = false
  private timers: ReturnType<typeof setInterval>[] = []

  constructor(options: StorageUsageOptions) {
    this.opts = options
    this.now = options.now ?? Date.now
    this.statfs = options.statfs ?? defaultStatfs
    this.deviceOf = options.deviceOf ?? defaultDeviceOf
    this.walk = options.walk ?? walkSize
  }

  start(): void {
    if (this.timers.length > 0) return
    void this.measureDisks()
    void this.count()
    const disk = setInterval(() => void this.measureDisks(), this.opts.diskIntervalMs ?? DISK_INTERVAL_MS_DEFAULT)
    const walk = setInterval(() => void this.count(), this.opts.walkIntervalMs ?? WALK_INTERVAL_MS_DEFAULT)
    disk.unref?.()
    walk.unref?.()
    this.timers = [disk, walk]
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  private entries(): [StorageKind, string][] {
    const d = this.opts.dirs
    return [
      ['raw', d.raw],
      ['wave', d.wave],
      ['events', d.events],
      ['summary', d.summary],
    ]
  }

  /** 置き場所がまだ無ければ、上へ辿って最初にあるフォルダで空きを測る（`defaultDeviceOf` と同じ理由）。 */
  private async statfsNearest(path: string): Promise<DiskSpace> {
    let p = path
    for (;;) {
      try {
        return await this.statfs(p)
      } catch (error) {
        const parent = dirname(p)
        if (!isMissing(error) || parent === p) throw error
        p = parent
      }
    }
  }

  /** ドライブの空き・全体を測り直す。**投げない。** */
  async measureDisks(): Promise<void> {
    try {
      const next = new Map<string, { kinds: StorageKind[]; space: DiskSpace | null }>()
      const unseen: string[] = []
      for (const [kind, path] of this.entries()) {
        const dev = await this.deviceOf(path)
        if (dev === null) {
          // 上へ辿っても在るフォルダが無い（ドライブごと見えない）。黙って飛ばすと、空きの警告も出ないまま表が空になる。
          unseen.push(path)
          continue
        }
        const key = String(dev)
        const g = next.get(key) ?? { kinds: [], space: null }
        g.kinds.push(kind)
        if (g.space === null) g.space = await this.statfsNearest(path)
        next.set(key, g)
      }
      this.groups = next
      this.diskError = unseen.length === 0 ? null : `置き場所のドライブが見つからない: ${unseen.join('、')}`
    } catch (error) {
      this.diskError = messageOf(error)
    }
  }

  /** 種類ごとの使用量を数え直す。**投げない。** 前の回が終わっていなければ何もしない。 */
  async count(): Promise<void> {
    if (this.walking) return
    this.walking = true
    try {
      const kinds: KindUsage[] = []
      for (const [kind, path] of this.entries()) {
        const { bytes, files } = await this.walk(path)
        kinds.push({ kind, path, bytes, files })
      }
      this.kinds = kinds
      this.countedAtMs = this.now()
      if (this.groups.size === 0) await this.measureDisks()
      this.addSamples()
      this.countError = null
    } catch (error) {
      this.countError = messageOf(error)
    } finally {
      this.walking = false
    }
  }

  private addSamples(): void {
    if (this.kinds === null || this.countedAtMs === null) return
    const excluded = this.opts.excludeBytes?.() ?? 0
    const atMs = this.countedAtMs
    for (const [key, g] of this.groups) {
      let bytes = 0
      for (const k of this.kinds) if (g.kinds.includes(k.kind)) bytes += k.bytes
      // 複製した分は、複製先（今の保存先）のドライブにしか載らない。今の保存先は全種類を持つドライブ。
      if (g.kinds.length === this.kinds.length) bytes -= excluded
      const list = this.samples.get(key) ?? []
      list.push({ atMs, bytes })
      while (list.length > 2 && atMs - list[0]!.atMs > RATE_WINDOW_MS) list.shift()
      this.samples.set(key, list)
    }
    for (const key of [...this.samples.keys()]) if (!this.groups.has(key)) this.samples.delete(key)
  }

  snapshot(): StorageUsageStatus {
    const drives: DriveUsage[] = []
    for (const [key, g] of this.groups) {
      if (g.space === null) continue
      const growth = growthPerDay(this.samples.get(key) ?? [])
      const daysLeft = growth === null ? null : g.space.freeBytes / growth
      drives.push({
        kinds: g.kinds,
        freeBytes: g.space.freeBytes,
        totalBytes: g.space.totalBytes,
        growthBytesPerDay: growth,
        daysLeft,
        warning: driveWarning(g.space.freeBytes, g.space.totalBytes, daysLeft),
      })
    }
    return { kinds: this.kinds, countedAtMs: this.countedAtMs, drives, lastError: [this.diskError, this.countError].filter((e) => e !== null).join(' / ') || null }
  }
}
