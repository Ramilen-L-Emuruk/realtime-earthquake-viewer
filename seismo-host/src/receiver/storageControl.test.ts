import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { EMPTY_HOST_SETTINGS, dirsUnder, resolveStorage } from './hostSettings'
import type { HostSettings } from './hostSettings'
import { StorageControl, openStorageAtStartup, storageBrief } from './storageControl'
import type { StorageMigration } from './storageMigration'
import type { StorageUsage, StorageUsageStatus } from './storageUsage'

const DEFAULT_ROOT = join(tmpdir(), 'ctl-default')
const NEW_ROOT = join(tmpdir(), 'ctl-new')
const GB = 1024 ** 3

describe('openStorageAtStartup', () => {
  it('正: 待っている変更を昇格させる。帳面を先に、設定を後に書く', async () => {
    const order: string[] = []
    const r = await openStorageAtStartup({
      env: {},
      settings: { dataRoot: null, pendingDataRoot: NEW_ROOT },
      settingsPath: 'host-settings.json',
      defaultRoot: DEFAULT_ROOT,
      nowMs: 1,
      canonical: async (p) => p,
      begin: async (to, from) => {
        order.push(`begin ${to} <- ${from}`)
      },
      write: (_p, s) => {
        order.push(`write ${s.dataRoot}`)
      },
    })
    expect(order).toEqual([`begin ${NEW_ROOT} <- ${DEFAULT_ROOT}`, `write ${NEW_ROOT}`])
    expect(r.resolved.dirs).toEqual(dirsUnder(NEW_ROOT))
    expect(r.settings).toEqual({ dataRoot: NEW_ROOT, pendingDataRoot: null })
    expect(r.problem).toBeNull()
  })

  it('安全弁: 帳面を始められなければ移さず、前の場所のまま動き、待っている変更は残す', async () => {
    let wrote = false
    const settings: HostSettings = { dataRoot: null, pendingDataRoot: NEW_ROOT }
    const r = await openStorageAtStartup({
      env: {},
      settings,
      settingsPath: 'host-settings.json',
      defaultRoot: DEFAULT_ROOT,
      nowMs: 1,
      canonical: async (p) => p,
      begin: async () => {
        throw new Error('別の場所からの帳面が残っている')
      },
      write: () => {
        wrote = true
      },
    })
    expect(r.resolved.dirs).toEqual(dirsUnder(DEFAULT_ROOT))
    expect(r.resolved.movedFrom).toBeNull()
    expect(r.settings).toEqual(settings)
    expect(wrote).toBe(false)
    expect(r.problem).toBe('別の場所からの帳面が残っている')
  })

  it('安全弁: 待っている変更が別名で今の保存先と同じ実体なら、移さず帳面も作らない', async () => {
    const alias = 'Z:\alias-of-default'
    let began = false
    let wrote = false
    const settings: HostSettings = { dataRoot: null, pendingDataRoot: alias }
    const r = await openStorageAtStartup({
      env: {},
      settings,
      settingsPath: 'host-settings.json',
      defaultRoot: DEFAULT_ROOT,
      nowMs: 1,
      canonical: async (p) => (p === alias ? DEFAULT_ROOT : p),
      begin: async () => {
        began = true
      },
      write: () => {
        wrote = true
      },
    })
    expect(began).toBe(false)
    expect(wrote).toBe(false)
    expect(r.resolved.dirs).toEqual(dirsUnder(DEFAULT_ROOT))
    expect(r.resolved.movedFrom).toBeNull()
    expect(r.problem).toMatch(/同じ場所か入れ子/)
  })

  it('対照: 変更が無ければ何も書かない', async () => {
    let calls = 0
    await openStorageAtStartup({
      env: {},
      settings: EMPTY_HOST_SETTINGS,
      settingsPath: 'x',
      defaultRoot: DEFAULT_ROOT,
      nowMs: 1,
      canonical: async (p) => p,
      begin: async () => {
        calls += 1
      },
      write: () => {
        calls += 1
      },
    })
    expect(calls).toBe(0)
  })
})

function usageWith(kinds: StorageUsageStatus['kinds']): StorageUsage {
  const status: StorageUsageStatus = { kinds, countedAtMs: kinds === null ? null : 1, drives: [], lastError: null }
  return { snapshot: () => status, count: async () => {} } as unknown as StorageUsage
}

function migration(state: 'copying' | 'copied' | null): StorageMigration {
  return {
    snapshot: () => (state === null ? null : { state, purgeable: state === 'copied' ? { files: 1, bytes: 2 } : null }),
    blocksNewMove: () => state === 'copying',
    purge: async () => ({ files: 1, bytes: 2, kept: 0 }),
  } as unknown as StorageMigration
}

function control(opts: {
  env?: Record<string, string>
  usage?: StorageUsage
  migration?: StorageMigration
  free?: number
  writable?: string | null
  canonical?: (path: string) => Promise<string>
  writeFails?: boolean
}) {
  const written: HostSettings[] = []
  const logs: string[] = []
  const resolved = resolveStorage({ env: opts.env ?? {}, settings: EMPTY_HOST_SETTINGS, defaultRoot: DEFAULT_ROOT })
  const c = new StorageControl({
    resolved,
    startupProblem: null,
    journalProblem: null,
    log: (line) => logs.push(line),
    canonical: opts.canonical ?? (async (p) => p),
    settings: EMPTY_HOST_SETTINGS,
    settingsPath: 'host-settings.json',
    currentRoot: DEFAULT_ROOT,
    usage: opts.usage ?? usageWith(null),
    migration: opts.migration ?? migration(null),
    probeWritable: async () => opts.writable ?? null,
    freeBytesOf: async () => opts.free ?? 100 * GB,
    writeSettings: (_p, s) => {
      if (opts.writeFails === true) throw new Error('EACCES')
      written.push(s)
    },
  })
  return { c, written, logs }
}

describe('StorageControl.setPending', () => {
  it('正: 受け付けたら次の起動で使う保存先として書く（今の保存先は変えない）', async () => {
    const { c, written } = control({})
    expect(await c.setPending(NEW_ROOT)).toEqual({ ok: true })
    expect(written).toEqual([{ dataRoot: null, pendingDataRoot: NEW_ROOT }])
    expect(c.get().pendingRoot).toBe(NEW_ROOT)
    expect(c.get().dirs).toEqual(dirsUnder(DEFAULT_ROOT))
  })

  it('入れ子・相対・書けない場所は受け付けず、何も書かない', async () => {
    const { c, written } = control({ writable: 'EACCES' })
    expect(await c.setPending(join(DEFAULT_ROOT, 'sub'))).toMatchObject({ ok: false, problem: 'nested' })
    expect(await c.setPending('relative')).toMatchObject({ ok: false, problem: 'not-absolute' })
    expect(await c.setPending(NEW_ROOT)).toMatchObject({ ok: false, problem: 'not-writable', detail: 'EACCES' })
    expect(written).toEqual([])
  })

  it('空きが今の使用量＋余裕に足りなければ受け付けない', async () => {
    const usage = usageWith([
      { kind: 'raw', path: 'r', bytes: 10 * GB, files: 1 },
      { kind: 'wave', path: 'w', bytes: 5 * GB, files: 1 },
      { kind: 'events', path: 'e', bytes: 0, files: 0 },
      { kind: 'summary', path: 's', bytes: 1 * GB, files: 1 },
    ])
    expect(await control({ usage, free: 16 * GB }).c.setPending(NEW_ROOT)).toMatchObject({
      ok: false,
      problem: 'not-enough-space',
    })
    expect(await control({ usage, free: 18 * GB }).c.setPending(NEW_ROOT)).toEqual({ ok: true })
  })

  it('安全弁: 環境変数で決めている・複製の途中なら受け付けない', async () => {
    expect(await control({ env: { SEISMO_RAW_DIR: 'X:\\r' } }).c.setPending(NEW_ROOT)).toMatchObject({
      ok: false,
      problem: 'locked',
    })
    expect(await control({ migration: migration('copying') }).c.setPending(NEW_ROOT)).toMatchObject({
      ok: false,
      problem: 'migrating',
    })
  })

  it('安全弁: 文字列で違って見えても、実体が同じ・入れ子なら受け付けない（短い名前・ジャンクション）', async () => {
    const alias = 'Z:\\alias-of-current'
    const canonical = async (p: string) => (p === alias ? DEFAULT_ROOT : p)
    expect(await control({ canonical }).c.setPending(alias)).toMatchObject({ ok: false, problem: 'same' })
    const inner = 'Z:\\alias-inside'
    const canonicalInner = async (p: string) => (p === inner ? join(DEFAULT_ROOT, 'sub') : p)
    expect(await control({ canonical: canonicalInner }).c.setPending(inner)).toMatchObject({ ok: false, problem: 'nested' })
    // 対照: 実体も別なら受け付ける
    expect(await control({ canonical }).c.setPending(NEW_ROOT)).toEqual({ ok: true })
  })

  it('設定ファイルを書けなければ投げずに理由を返す', async () => {
    expect(await control({ writeFails: true }).c.setPending(NEW_ROOT)).toMatchObject({ ok: false, problem: 'not-writable' })
    expect(await control({ writeFails: true }).c.setPending(null)).toMatchObject({ ok: false, problem: 'not-writable' })
  })

  it('null で待っている変更を取り消せる', async () => {
    const { c, written } = control({})
    await c.setPending(NEW_ROOT)
    expect(await c.setPending(null)).toEqual({ ok: true })
    expect(written.at(-1)).toEqual({ dataRoot: null, pendingDataRoot: null })
  })
})

describe('StorageControl.purgeOld', () => {
  it('安全弁: 複製が終わっていなければ消さない', async () => {
    expect(await control({ migration: migration('copying') }).c.purgeOld()).toEqual({ ok: false, reason: 'not-copied' })
    expect(await control({}).c.purgeOld()).toEqual({ ok: false, reason: 'not-copied' })
  })
  it('正: 複製が済んでいれば消す', async () => {
    expect(await control({ migration: migration('copied') }).c.purgeOld()).toEqual({ ok: true, files: 1, bytes: 2, kept: 0 })
  })
})

describe('storageBrief', () => {
  it('状態の口へはパスを載せない', () => {
    const { c } = control({})
    const brief = storageBrief(c.get())
    expect(JSON.stringify(brief)).not.toContain(DEFAULT_ROOT.replace(/\\/g, '\\\\'))
    expect(brief).not.toHaveProperty('dirs')
  })
})
