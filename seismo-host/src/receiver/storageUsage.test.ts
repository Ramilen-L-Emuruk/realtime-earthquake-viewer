import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { dirsUnder } from './hostSettings'
import {
  LOW_DAYS_LEFT,
  MIN_RATE_SPAN_MS,
  StorageUsage,
  driveWarning,
  growthPerDay,
  walkSize,
} from './storageUsage'

const HOUR = 3_600_000
const GB = 1024 ** 3

describe('growthPerDay', () => {
  it('正: 標本の幅が 1 時間以上あれば 1 日あたりへ引き延ばす', () => {
    expect(growthPerDay([{ atMs: 0, bytes: 0 }, { atMs: 2 * HOUR, bytes: GB }])).toBeCloseTo(12 * GB)
  })
  it('対照: 幅が 1 時間に満たなければ出さない', () => {
    expect(growthPerDay([{ atMs: 0, bytes: 0 }, { atMs: MIN_RATE_SPAN_MS - 1, bytes: GB }])).toBeNull()
  })
  it('安全弁: 減っている（人が消した）なら日数を出さない', () => {
    expect(growthPerDay([{ atMs: 0, bytes: GB }, { atMs: 2 * HOUR, bytes: 0 }])).toBeNull()
  })
})

describe('driveWarning', () => {
  it('空きが 5% を切ったら日数に関わらず警告', () => {
    expect(driveWarning(4, 100, 1000)).toBe('low-free')
  })
  it('日数が 7 日を切ったら警告', () => {
    expect(driveWarning(50, 100, LOW_DAYS_LEFT - 0.1)).toBe('low-days')
  })
  it('対照: どちらも足りていれば警告しない・日数が測れていなければ空きだけで見る', () => {
    expect(driveWarning(50, 100, LOW_DAYS_LEFT)).toBeNull()
    expect(driveWarning(50, 100, null)).toBeNull()
  })
})

describe('walkSize', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true })
    dir = null
  })
  it('入れ子のファイルまで足す・無い置き場所は 0', async () => {
    dir = mkdtempSync(join(tmpdir(), 'walk-'))
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'x'), 'abc')
    writeFileSync(join(dir, 'a', 'b', 'y'), '12345')
    expect(await walkSize(dir)).toEqual({ bytes: 8, files: 2 })
    expect(await walkSize(join(dir, 'none'))).toEqual({ bytes: 0, files: 0 })
  })
})

describe('StorageUsage', () => {
  const dirs = dirsUnder(join(tmpdir(), 'usage-root'))

  function make(opts: { sizes: () => Record<string, number>; now: () => number; exclude?: () => number; devs?: Record<string, number> }) {
    return new StorageUsage({
      dirs,
      now: opts.now,
      excludeBytes: opts.exclude,
      statfs: async () => ({ freeBytes: 10 * GB, totalBytes: 100 * GB }),
      deviceOf: async (p) => opts.devs?.[p] ?? 1,
      walk: async (p) => ({ bytes: opts.sizes()[p] ?? 0, files: 1 }),
    })
  }

  it('数え終えるまでは種類ごとの使用量が null', async () => {
    const u = make({ sizes: () => ({}), now: () => 0 })
    expect(u.snapshot().kinds).toBeNull()
    await u.count()
    expect(u.snapshot().kinds?.map((k) => k.kind)).toEqual(['raw', 'wave', 'events', 'summary'])
  })

  it('正: 1 日 1 GB 増えて空き 10 GB なら、あと 10 日', async () => {
    let t = 0
    let raw = 0
    const u = make({ sizes: () => ({ [dirs.raw]: raw }), now: () => t })
    await u.count()
    t = 24 * HOUR
    raw = GB
    await u.count()
    const d = u.snapshot().drives[0]!
    expect(d.daysLeft).toBeCloseTo(10)
    expect(d.warning).toBeNull()
  })

  it('安全弁: 複製で書いた分は増え方から引く（引かないと複製中に「あと 0 日」と出る）', async () => {
    let t = 0
    let raw = 0
    let copied = 0
    const u = make({ sizes: () => ({ [dirs.raw]: raw }), now: () => t, exclude: () => copied })
    await u.count()
    t = 2 * HOUR
    raw = 50 * GB
    copied = 50 * GB
    await u.count()
    expect(u.snapshot().drives[0]!.daysLeft).toBeNull()
  })

  it('別のドライブに分けた置き場所はドライブごとに出す', async () => {
    const u = make({
      sizes: () => ({}),
      now: () => 0,
      devs: { [dirs.raw]: 2, [dirs.wave]: 1, [dirs.events]: 1, [dirs.summary]: 1 },
    })
    await u.measureDisks()
    expect(u.snapshot().drives.map((d) => d.kinds)).toEqual([['raw'], ['wave', 'events', 'summary']])
  })

  it('まだ作られていない置き場所も、上のフォルダで同じドライブと見る（4 つが 1 つのドライブに並ぶ）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'usage-real-'))
    try {
      const u = new StorageUsage({ dirs: dirsUnder(join(root, 'not-yet')) })
      await u.measureDisks()
      const drives = u.snapshot().drives
      expect(drives).toHaveLength(1)
      expect(drives[0]!.kinds).toEqual(['raw', 'wave', 'events', 'summary'])
      expect(drives[0]!.totalBytes).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('測れなかったら理由を残し、次に測れたら消す', async () => {
    let fail = true
    const u = new StorageUsage({
      dirs,
      statfs: async () => {
        if (fail) throw new Error('EIO')
        return { freeBytes: 1, totalBytes: 2 }
      },
      deviceOf: async () => 1,
      walk: async () => ({ bytes: 0, files: 0 }),
    })
    await u.measureDisks()
    expect(u.snapshot().lastError).toMatch(/EIO/)
    fail = false
    await u.measureDisks()
    expect(u.snapshot().lastError).toBeNull()
  })
})
