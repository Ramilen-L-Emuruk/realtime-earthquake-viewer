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
      settings: { dataRoot: null, pendingDataRoot: NEW_ROOT, pendingFrom: null },
      settingsPath: 'host-settings.json',
      defaultRoot: DEFAULT_ROOT,
      nowMs: 1,
      canonical: async (p) => p,
      exists: async () => true,
      begin: async (to, from) => {
        order.push(`begin ${to} <- ${from}`)
      },
      write: (_p, s) => {
        order.push(`write ${s.dataRoot}`)
      },
    })
    expect(order).toEqual([`begin ${NEW_ROOT} <- ${DEFAULT_ROOT}`, `write ${NEW_ROOT}`])
    expect(r.resolved.dirs).toEqual(dirsUnder(NEW_ROOT))
    expect(r.settings).toEqual({ dataRoot: NEW_ROOT, pendingDataRoot: null, pendingFrom: null })
    expect(r.problem).toBeNull()
  })

  it('安全弁: 帳面を始められなければ移さず、前の場所のまま動き、待っている変更は残す', async () => {
    let wrote = false
    const settings: HostSettings = { dataRoot: null, pendingDataRoot: NEW_ROOT, pendingFrom: null }
    const r = await openStorageAtStartup({
      env: {},
      settings,
      settingsPath: 'host-settings.json',
      defaultRoot: DEFAULT_ROOT,
      nowMs: 1,
      canonical: async (p) => p,
      exists: async () => true,
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
    const settings: HostSettings = { dataRoot: null, pendingDataRoot: alias, pendingFrom: null }
    const r = await openStorageAtStartup({
      env: {},
      settings,
      settingsPath: 'host-settings.json',
      defaultRoot: DEFAULT_ROOT,
      nowMs: 1,
      canonical: async (p) => (p === alias ? DEFAULT_ROOT : p),
      exists: async () => true,
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

  it('正: 保存先を選んだ時の場所（pendingFrom）から複製する（プログラムを移して既定の保存先が変わっても）', async () => {
    const chosenFrom = join(tmpdir(), 'ctl-old-default')
    const began: string[] = []
    const r = await openStorageAtStartup({
      env: {},
      settings: { dataRoot: null, pendingDataRoot: NEW_ROOT, pendingFrom: chosenFrom },
      settingsPath: 'host-settings.json',
      defaultRoot: DEFAULT_ROOT,
      nowMs: 1,
      canonical: async (p) => p,
      exists: async () => true,
      begin: async (to, from) => {
        began.push(`${to} <- ${from}`)
      },
      write: () => {},
    })
    expect(began).toEqual([`${NEW_ROOT} <- ${chosenFrom}`])
    expect(r.resolved.movedFrom).toBe(chosenFrom)
    expect(r.settings).toEqual({ dataRoot: NEW_ROOT, pendingDataRoot: null, pendingFrom: null })
    expect(r.problem).toBeNull()
  })

  it('安全弁: 前の保存先が見つからなければ移さず、帳面も作らず、待っている変更は残す', async () => {
    const chosenFrom = join(tmpdir(), 'ctl-old-default')
    let began = false
    let wrote = false
    const settings: HostSettings = { dataRoot: null, pendingDataRoot: NEW_ROOT, pendingFrom: chosenFrom }
    const r = await openStorageAtStartup({
      env: {},
      settings,
      settingsPath: 'host-settings.json',
      defaultRoot: DEFAULT_ROOT,
      nowMs: 1,
      canonical: async (p) => p,
      exists: async (p) => p !== chosenFrom,
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
    expect(r.settings).toEqual(settings)
    expect(r.problem).toBe(`前の保存先（${chosenFrom}）が見つからないので、移さなかった`)
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
      exists: async () => true,
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
    abandon: async () => state === 'copying',
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
  it('正: 受け付けたら次の起動で使う保存先と、いまの保存先（複製元）を書く（今の保存先は変えない）', async () => {
    const { c, written } = control({})
    expect(await c.setPending(NEW_ROOT)).toEqual({ ok: true })
    expect(written).toEqual([{ dataRoot: null, pendingDataRoot: NEW_ROOT, pendingFrom: DEFAULT_ROOT }])
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
    // 別名は実行している OS で絶対パスに見えるものにする（`Z:\…` は Linux の CI で相対パスとして先に弾かれる）
    const alias = join(tmpdir(), 'alias-of-current')
    const canonical = async (p: string) => (p === alias ? DEFAULT_ROOT : p)
    expect(await control({ canonical }).c.setPending(alias)).toMatchObject({ ok: false, problem: 'same' })
    const inner = join(tmpdir(), 'alias-inside')
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
    expect(written.at(-1)).toEqual({ dataRoot: null, pendingDataRoot: null, pendingFrom: null })
  })
})

describe('StorageControl.purgeOld', () => {
  it('安全弁: 複製が終わっていなければ消さない', async () => {
    expect(await control({ migration: migration('copying') }).c.purgeOld()).toEqual({ ok: false, reason: 'not-copied' })
    expect(await control({}).c.purgeOld()).toEqual({ ok: false, reason: 'not-copied' })
  })
  it('正: 複製が済んでいれば、消し終わるのを待たずに受け付けて裏で消す', async () => {
    let finish: () => void = () => {}
    let started = 0
    const m = {
      ...migration('copied'),
      purge: () => {
        started += 1
        return new Promise<{ files: number; bytes: number; kept: number }>((resolve) => {
          finish = () => resolve({ files: 1, bytes: 2, kept: 0 })
        })
      },
    } as unknown as StorageMigration
    let counted = 0
    const usage = { ...usageWith(null), count: async () => void (counted += 1) } as unknown as StorageUsage
    const { c } = control({ migration: m, usage })
    expect(await c.purgeOld()).toEqual({ ok: true })
    expect(started).toBe(1)
    // 対照: 消している最中の 2 度目は断る（裏の削除を重ねない）
    expect(await c.purgeOld()).toEqual({ ok: false, reason: 'busy' })
    finish()
    await c.purgeSettled()
    // 消し終えたら使用量を数え直す
    expect(counted).toBe(1)
  })

  it('安全弁: 裏の削除が投げても受信ごと落とさず、ログに残して次の承認を受け付ける', async () => {
    const m = {
      ...migration('copied'),
      purge: async () => {
        throw new Error('EBUSY')
      },
    } as unknown as StorageMigration
    const { c, logs } = control({ migration: m })
    expect(await c.purgeOld()).toEqual({ ok: true })
    await c.purgeSettled()
    expect(logs.some((l) => l.includes('EBUSY'))).toBe(true)
    expect(await c.purgeOld()).toEqual({ ok: true })
    await c.purgeSettled()
  })
})

describe('StorageControl.abandonMigration', () => {
  it('正: 係が受け付ければやめる', async () => {
    expect(await control({ migration: migration('copying') }).c.abandonMigration()).toEqual({ ok: true })
  })
  it('対照: 係が断れば not-missing', async () => {
    expect(await control({ migration: migration('copied') }).c.abandonMigration()).toEqual({ ok: false, reason: 'not-missing' })
  })
  it('安全弁: 係が投げても落とさず、理由をログへ残す', async () => {
    const m = {
      ...migration('copying'),
      abandon: async () => {
        throw new Error('EACCES')
      },
    } as unknown as StorageMigration
    const { c, logs } = control({ migration: m })
    expect(await c.abandonMigration()).toMatchObject({ ok: false, reason: 'failed', detail: 'EACCES' })
    expect(logs.some((l) => l.includes('EACCES'))).toBe(true)
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
