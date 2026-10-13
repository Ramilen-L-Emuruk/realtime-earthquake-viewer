import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  COPY_ORDER,
  MIGRATION_FILE,
  ReadThrottle,
  StorageMigration,
  beginMigration,
  canonicalPath,
  readMigrationJournal,
  sameIdentity,
} from './storageMigration'
import { STORAGE_KINDS } from './hostSettings'

let base: string
let from: string
let to: string
let beginLogs: string[]

/** 帳面を始める。実行している OS の作法で比べ、置き換えのログは `beginLogs` に溜める。 */
function begin(dest: string, src: string, nowMs: number): Promise<void> {
  return beginMigration(dest, src, nowMs, { platform: process.platform, log: (l) => beginLogs.push(l) })
}

/** 待つと進む時計。`slept` は待った合計（速さの上限が効いたかを見る）。 */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: () => number } {
  let t = 0
  let total = 0
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms
      total += ms
    },
    slept: () => total,
  }
}

function put(root: string, rel: string, text: string): void {
  const p = join(root, ...rel.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}

function make(extra: Partial<ConstructorParameters<typeof StorageMigration>[0]> = {}): StorageMigration {
  return new StorageMigration({ to, bytesPerSec: 1e12, sleep: async () => {}, ...extra })
}

beforeEach(() => {
  beginLogs = []
  base = mkdtempSync(join(tmpdir(), 'migration-'))
  from = join(base, 'old')
  to = join(base, 'new')
  put(from, 'raw/2026-10-01/raw-2026-10-01T00.mseed3', 'RAW0')
  put(from, 'wave/wave-S1-2026-10-01T00.bin', 'WAVE0')
  put(from, 'events/2026-10/e1.json', '{"id":1}')
  put(from, 'summary/raw/2026-10-01/raw-2026-10-01T00.fine.wsum', 'SUM0')
  // 4 つの置き場所の外。複製も削除もしない。
  put(from, 'host-running.json', '{}')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('複製', () => {
  it('順番は要約 → 揺れの記録 → 合成波形 → 生データで、4 つの置き場所の顔ぶれと一致する', () => {
    expect(COPY_ORDER).toEqual(['summary', 'events', 'wave', 'raw'])
    expect([...COPY_ORDER].sort()).toEqual([...STORAGE_KINDS].sort())
  })

  it('正: 全部を複製して照合し、複製が済んだら copied になる', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    expect(m.isCopying()).toBe(true)
    expect(await m.pass()).toBe(true)
    expect(m.isCopying()).toBe(false)
    expect(readFileSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'), 'utf8')).toBe('RAW0')
    expect(readFileSync(join(to, 'events', '2026-10', 'e1.json'), 'utf8')).toBe('{"id":1}')
    expect(existsSync(join(to, 'host-running.json'))).toBe(false)
    const s = m.snapshot()!
    expect(s.state).toBe('copied')
    expect(s.doneFiles).toBe(4)
    expect(s.purgeable?.files).toBe(4)
    // 一時ファイルは残らない
    expect(existsSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3.migrating'))).toBe(false)
  })

  it('安全弁: 複製先に同じ名前の別物があれば上書きせず、古い場所でも消す対象から外す', async () => {
    // 切り替えた時に新しい保存先へ書き始めた分。
    put(to, 'wave/wave-S1-2026-10-01T00.bin', 'NEWER')
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    expect(readFileSync(join(to, 'wave', 'wave-S1-2026-10-01T00.bin'), 'utf8')).toBe('NEWER')
    const s = m.snapshot()!
    expect(s.skippedExists).toBe(1)
    expect(s.purgeable?.files).toBe(3)
    await m.purge()
    expect(readFileSync(join(from, 'wave', 'wave-S1-2026-10-01T00.bin'), 'utf8')).toBe('WAVE0')
  })

  it('対照: 前の起動で置いたが帳面に書く前に落ちた同じ中身は、済んだものとして数える', async () => {
    put(to, 'wave/wave-S1-2026-10-01T00.bin', 'WAVE0')
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    expect(m.snapshot()!.skippedExists).toBe(0)
    expect(m.snapshot()!.doneFiles).toBe(4)
  })

  it('途中で止めても、次の起動で帳面から続きを始める', async () => {
    await begin(to, from, 1000)
    const first = make()
    await first.load()
    first.stop()
    await first.pass()
    const j1 = await readMigrationJournal(to)
    expect(j1?.state).toBe('copying')
    const second = make()
    await second.load()
    await second.pass()
    expect(second.snapshot()!.state).toBe('copied')
    expect(second.snapshot()!.doneFiles).toBe(4)
  })

  it('空きが足りなければ 1 本も書かずに待ち、その量を出す', async () => {
    await begin(to, from, 1000)
    const m = make({ freeBytesOf: async () => 10 })
    await m.load()
    expect(await m.pass()).toBe(false)
    expect(m.snapshot()!.blockedBySpace?.freeBytes).toBe(10)
    expect(existsSync(join(to, 'raw'))).toBe(false)
  })

  it('別の場所からの終わっていない帳面があれば、新しく始めない（消してよい物の記録を上書きしない）', async () => {
    await begin(to, from, 1000)
    await expect(begin(to, join(base, 'other'), 2000)).rejects.toThrow(/別の場所/)
    // 同じ複製元なら続きから（投げない）
    await begin(to, from, 3000)
    expect((await readMigrationJournal(to))?.startedAtMs).toBe(1000)
  })

  it('帳面は新しい保存先の直下に置く', async () => {
    await begin(to, from, 1000)
    expect(existsSync(join(to, MIGRATION_FILE))).toBe(true)
  })

  it('済んだ帳面は、同じ複製元でも続きとして使い回さず作り直す（行って戻って行き直したとき）', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    expect((await readMigrationJournal(to))?.state).toBe('copied')
    await begin(to, from, 9000)
    const j = await readMigrationJournal(to)
    expect(j?.state).toBe('copying')
    expect(j?.startedAtMs).toBe(9000)
    expect(j?.verified).toEqual({})
  })

  it('安全弁: 複製先へ書けなくても投げず、理由を残してやり直しを待つ（受信ごと落とさない）', async () => {
    await begin(to, from, 1000)
    // 一時ファイルの名前にフォルダを置いて、書き込み口を開けなくする。
    mkdirSync(join(to, 'events', '2026-10', 'e1.json.migrating'), { recursive: true })
    const logs: string[] = []
    const m = make({ log: (l) => logs.push(l) })
    await m.load()
    expect(await m.pass()).toBe(false)
    const s = m.snapshot()!
    expect(s.state).toBe('copying')
    expect(s.lastError).toMatch(/e1\.json/)
    // 他のファイルは複製を進める
    expect(readFileSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'), 'utf8')).toBe('RAW0')
    // 3 回続けて書けなければ諦め、そのことをログへ出す（古い場所には残す）。
    await m.pass()
    expect(await m.pass()).toBe(true)
    expect(m.snapshot()!.skippedUnreadable).toBe(1)
    expect(logs.some((l) => l.includes('e1.json') && l.includes('諦めた'))).toBe(true)
  })

  it('安全弁: 複製元と複製先が同じ場所なら 1 本も照合済みにしない（消すと実体ごと消える）', async () => {
    await begin(from, from, 1000)
    const m = new StorageMigration({ to: from, bytesPerSec: 1e12, sleep: async () => {} })
    await m.load()
    expect(await m.pass()).toBe(false)
    const s = m.snapshot()!
    expect(s.doneFiles).toBe(0)
    expect(s.purgeable).toBeNull()
    expect(s.lastError).toMatch(/同じ場所か入れ子/)
  })
})

describe('古い場所を消す', () => {
  it('複製が終わる前は消せない', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await expect(m.purge()).rejects.toThrow()
    expect(existsSync(join(from, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'))).toBe(true)
  })

  it('正: 照合を通ったファイルだけを消し、4 つの置き場所の外には触らない', async () => {
    await begin(to, from, 1000)
    const m = make({ now: () => 5000 })
    await m.load()
    await m.pass()
    const r = await m.purge()
    expect(r).toEqual({ files: 4, bytes: 4 + 5 + 8 + 4, kept: 0 })
    expect(existsSync(join(from, 'raw'))).toBe(false)
    expect(existsSync(join(from, 'host-running.json'))).toBe(true)
    expect(m.snapshot()!.state).toBe('done')
    // 複製先は残る
    expect(readFileSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'), 'utf8')).toBe('RAW0')
  })

  it('安全弁: 複製の後で元か複製先の大きさが変わっていたら消さない', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    writeFileSync(join(to, 'events', '2026-10', 'e1.json'), '{}')
    rmSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'))
    const r = await m.purge()
    expect(r.kept).toBe(2)
    expect(existsSync(join(from, 'events', '2026-10', 'e1.json'))).toBe(true)
    expect(existsSync(join(from, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'))).toBe(true)
  })

  it('複製の後で古い場所に足されたファイルは、照合していないので消さない', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    put(from, 'raw/2026-10-01/raw-2026-10-01T01.mseed3', 'LATE')
    await m.purge()
    expect(readFileSync(join(from, 'raw', '2026-10-01', 'raw-2026-10-01T01.mseed3'), 'utf8')).toBe('LATE')
  })

  it('安全弁: 複製先の中身が同じ大きさのまま変わっていたら消さない（大きさだけでなく SHA-256 も見る）', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    writeFileSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'), 'RAWX')
    const r = await m.purge()
    expect(r.kept).toBe(1)
    expect(readFileSync(join(from, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'), 'utf8')).toBe('RAW0')
  })

  it('途中で止まった削除（purging）は、次の起動でもう一度承認して続きから消せる', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    // 1 本だけ消したところで落ちた形を作る。
    const j = (await readMigrationJournal(to))!
    writeFileSync(join(to, MIGRATION_FILE), JSON.stringify({ ...j, state: 'purging' }))
    rmSync(join(from, 'events', '2026-10', 'e1.json'))
    const again = make()
    await again.load()
    expect(again.snapshot()!.purgeable?.files).toBe(4)
    const r = await again.purge()
    expect(r).toMatchObject({ files: 3, kept: 0 })
    expect(again.snapshot()!.state).toBe('done')
    expect(existsSync(join(from, 'raw'))).toBe(false)
  })
})

describe('別名（ジャンクション）で同じ場所を指したとき', () => {
  /** `target` を指す別名を作る（Windows はジャンクション、他はシンボリックリンク）。 */
  function alias(target: string, name: string): string {
    const p = join(base, name)
    symlinkSync(target, p, process.platform === 'win32' ? 'junction' : 'dir')
    return p
  }

  it('canonicalPath は別名を解き、まだ無い部分は上を解いてから繋ぐ', async () => {
    mkdirSync(to, { recursive: true })
    const a = alias(to, 'alias-to')
    expect(await canonicalPath(a)).toBe(await canonicalPath(to))
    expect(await canonicalPath(join(a, 'raw', 'x'))).toBe(join(await canonicalPath(to), 'raw', 'x'))
  })

  it('安全弁: 複製元が複製先の別名なら 1 本も照合済みにしない', async () => {
    put(to, 'raw/2026-10-01/raw-2026-10-01T00.mseed3', 'RAW0')
    const a = alias(to, 'alias-to')
    await begin(to, a, 1000)
    const m = make()
    await m.load()
    expect(await m.pass()).toBe(false)
    expect(m.snapshot()!.doneFiles).toBe(0)
    expect(m.snapshot()!.lastError).toMatch(/同じ場所か入れ子/)
  })

  it('安全弁: 帳面が照合済みと言っていても、元と複製先が同じファイルなら消さない', async () => {
    put(to, 'raw/2026-10-01/raw-2026-10-01T00.mseed3', 'RAW0')
    const a = alias(to, 'alias-to')
    writeFileSync(
      join(to, MIGRATION_FILE),
      JSON.stringify({
        version: 1,
        from: a,
        startedAtMs: 1,
        state: 'copied',
        // 'RAW0' の SHA-256
        verified: { 'raw/2026-10-01/raw-2026-10-01T00.mseed3': { size: 4, sha256: 'c4e298f0a4173034951440eb694f487f20e159fcd36ce530761892dcb2e0db30' } },
        skipped: {},
        copiedAtMs: 2,
        purgedAtMs: null,
        purged: null,
      }),
    )
    const m = make()
    await m.load()
    const r = await m.purge()
    expect(r.files).toBe(0)
    expect(r.kept).toBe(1)
    expect(readFileSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'), 'utf8')).toBe('RAW0')
  })

  it('書きかけの一時ファイルを残さない（書けずに失敗したとき）', async () => {
    await begin(to, from, 1000)
    // 一時ファイルの名前に中身のあるフォルダを置き、書き込み口を開けなくする（消せないので残るのはこれだけ）。
    mkdirSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3.migrating', 'x'), { recursive: true })
    const m = make()
    await m.load()
    await m.pass()
    expect(existsSync(join(to, 'wave', 'wave-S1-2026-10-01T00.bin.migrating'))).toBe(false)
    expect(readFileSync(join(to, 'wave', 'wave-S1-2026-10-01T00.bin'), 'utf8')).toBe('WAVE0')
  })
})

describe('一時的に消せなかったものを承認し直す', () => {
  const RAW = join('raw', '2026-10-01', 'raw-2026-10-01T00.mseed3')

  /** 複製先のファイルをフォルダに替えて、読み直せなくする（一時的な失敗の代わり）。 */
  function breakDest(rel: string = RAW): void {
    rmSync(join(to, rel))
    mkdirSync(join(to, rel))
  }
  function healDest(): void {
    rmSync(join(to, RAW), { recursive: true })
    writeFileSync(join(to, RAW), 'RAW0')
  }

  it('正: 読み直せなかった分は削除の途中（purging）に留め、承認し直せば消す', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    breakDest()
    const r1 = await m.purge()
    expect(r1).toMatchObject({ files: 3, kept: 1 })
    const s1 = m.snapshot()!
    expect(s1.state).toBe('purging')
    // 承認し直せるのは、まだ消していない 1 本だけ（消した 3 本は数えない）。
    expect(s1.purgeable?.files).toBe(1)
    expect(s1.purgeable?.bytes).toBe(4)
    expect(existsSync(join(from, RAW))).toBe(true)
    healDest()
    const r2 = await m.purge()
    expect(r2).toMatchObject({ files: 1, kept: 0 })
    const s2 = m.snapshot()!
    expect(s2.state).toBe('done')
    // 2 回の承認で消した分を合わせて残す（画面の「N 件を削除した」）。
    expect(s2.purged).toEqual({ files: 4, bytes: 21, kept: 0 })
    expect(existsSync(join(from, RAW))).toBe(false)
  })

  it('対照: 中身が合わないものは何度承認しても消さず、それだけなら done になる', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    writeFileSync(join(to, RAW), 'RAWX')
    await m.purge()
    const s = m.snapshot()!
    expect(s.state).toBe('done')
    expect(s.purged).toEqual({ files: 3, bytes: 17, kept: 1 })
    expect(readFileSync(join(from, RAW), 'utf8')).toBe('RAW0')
  })

  it('安全弁: 複製先が無いものは消さず、承認し直す対象にもしない（何度試しても合わない）', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    rmSync(join(to, RAW))
    await m.purge()
    expect(m.snapshot()!.state).toBe('done')
    expect(existsSync(join(from, RAW))).toBe(true)
  })

  it('削除の結果は帳面に残り、次の起動でもまだ消していない分だけを承認し直せる', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    breakDest()
    await m.purge()
    const again = make()
    await again.load()
    expect(again.snapshot()!.state).toBe('purging')
    expect(again.snapshot()!.purgeable?.files).toBe(1)
  })

  it('読み直せなかったことはまとめて 1 行だけログに出す', async () => {
    await begin(to, from, 1000)
    const logs: string[] = []
    const m = make({ log: (l) => logs.push(l) })
    await m.load()
    await m.pass()
    breakDest()
    breakDest(join('events', '2026-10', 'e1.json'))
    logs.length = 0
    await m.purge()
    const kept = logs.filter((l) => l.includes('消さずに残した'))
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatch(/2 件/)
  })

  it('削除している間は、進み具合（済んだ件数 / 全体）を出す。終われば消える', async () => {
    await begin(to, from, 1000)
    const seen: Array<{ doneFiles: number; totalFiles: number } | null> = []
    const holder: { m: StorageMigration | null } = { m: null }
    const m = make({
      bytesPerSec: 1,
      sleep: async () => {
        seen.push(holder.m!.snapshot()!.purgeProgress)
      },
    })
    holder.m = m
    await m.load()
    await m.pass()
    seen.length = 0
    await m.purge()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((p) => p !== null && p.totalFiles === 4 && p.doneFiles >= 0 && p.doneFiles < 4)).toBe(true)
    expect(m.snapshot()!.purgeProgress).toBeNull()
  })

  it('削除の最中は承認し直せない（ボタンを出さない）', async () => {
    await begin(to, from, 1000)
    const purgeable: unknown[] = []
    const holder: { m: StorageMigration | null } = { m: null }
    const m = make({
      bytesPerSec: 1,
      sleep: async () => {
        purgeable.push(holder.m!.snapshot()!.purgeable)
      },
    })
    holder.m = m
    await m.load()
    await m.pass()
    purgeable.length = 0
    await m.purge()
    expect(purgeable.length).toBeGreaterThan(0)
    expect(purgeable.every((p) => p === null)).toBe(true)
  })

  it('止める合図で途中から抜け、続きは承認し直せる（purging のまま）', async () => {
    await begin(to, from, 1000)
    // 複製の段でも待つので、削除の段に入ってから最初に待ったところで止める。
    const holder: { m: StorageMigration | null; armed: boolean } = { m: null, armed: false }
    const m = make({
      bytesPerSec: 1,
      sleep: async () => {
        if (!holder.armed) return
        holder.armed = false
        holder.m!.stop()
      },
    })
    holder.m = m
    await m.load()
    await m.pass()
    holder.armed = true
    await m.purge()
    const s = m.snapshot()!
    expect(s.state).toBe('purging')
    expect(s.purgeable!.files).toBeGreaterThan(0)
  })

  it('安全弁: 承認し直しを待っている間は、別の保存先へ移す操作を止めない（止めたまま抜けられなくならない）', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    breakDest()
    await m.purge()
    expect(m.snapshot()!.state).toBe('purging')
    expect(m.blocksNewMove()).toBe(false)
  })
})

describe('保存先のフォルダそのものが見えないとき', () => {
  it('安全弁: いまの保存先が見えなければ 1 本も結果を残さず、前の保存先にも触らず、理由を出す', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    const away = join(base, 'away')
    renameSync(to, away)
    const r = await m.purge()
    expect(r.files).toBe(0)
    expect(existsSync(join(from, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'))).toBe(true)
    expect(m.snapshot()!.lastError).toMatch(/いまの保存先.*見つからない/)
    expect(m.snapshot()!.state).toBe('purging')
    expect(m.snapshot()!.purgeable?.files).toBe(4)
    // 帳面の保存で置き場所を作り直していない
    expect(existsSync(to)).toBe(false)
    renameSync(away, to)
    // 戻れば全部を承認し直せる（「合わない」「消した」と記録していない）
    const again = make()
    await again.load()
    expect(again.snapshot()!.purgeable?.files).toBe(4)
    await again.purge()
    expect(again.snapshot()!.state).toBe('done')
    expect(again.snapshot()!.purged).toEqual({ files: 4, bytes: 21, kept: 0 })
  })

  it('安全弁: 前の保存先が見えなければ「前から無かった」と記録しない', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    const away = join(base, 'away')
    renameSync(from, away)
    await m.purge()
    expect(m.snapshot()!.state).toBe('purging')
    expect(m.snapshot()!.purgeable?.files).toBe(4)
    expect(m.snapshot()!.lastError).toMatch(/前の保存先.*見つからない/)
  })

  it('対照: いまの保存先の種類ごとの置き場所だけが無いなら、その種類だけ結果を残さず、ほかは消す', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    rmSync(join(to, 'raw'), { recursive: true })
    await m.purge()
    const s = m.snapshot()!
    expect(s.state).toBe('purging')
    expect(s.purgeable?.files).toBe(1)
    expect(existsSync(join(from, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'))).toBe(true)
    expect(existsSync(join(from, 'events', '2026-10', 'e1.json'))).toBe(false)
  })

  it('残すものの件数は、前の回に「合わない」と決めた分も数える', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    writeFileSync(join(to, 'events', '2026-10', 'e1.json'), '{"id":2}')
    rmSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'))
    mkdirSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'))
    await m.purge()
    expect(m.snapshot()!.purged?.kept).toBe(2)
    rmSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'), { recursive: true })
    writeFileSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'), 'RAW0')
    await m.purge()
    expect(m.snapshot()!.state).toBe('done')
    expect(m.snapshot()!.purged?.kept).toBe(1)
  })
})

describe('複製をやめる', () => {
  it('正: 前の保存先が見つからない間はやめられ、複製中でなくなり、状態の口から消える', async () => {
    await begin(to, from, 1000)
    rmSync(from, { recursive: true })
    const m = make()
    await m.load()
    await m.pass()
    expect(m.snapshot()!.sourceMissing).toBe(true)
    expect(await m.abandon()).toBe(true)
    expect(m.isCopying()).toBe(false)
    expect(m.blocksNewMove()).toBe(false)
    expect(m.snapshot()).toBeNull()
    expect((await readMigrationJournal(to))?.state).toBe('abandoned')
  })

  it('対照: 前の保存先が見えている間はやめない', async () => {
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    m.stop()
    await m.pass()
    expect(m.snapshot()!.sourceMissing).toBe(false)
    expect(await m.abandon()).toBe(false)
    expect(m.isCopying()).toBe(true)
  })

  it('対照: 見つからなかった後で前の保存先が戻っていれば、押されてもやめない', async () => {
    await begin(to, from, 1000)
    const away = join(base, 'away')
    renameSync(from, away)
    const m = make()
    await m.load()
    await m.pass()
    expect(m.snapshot()!.sourceMissing).toBe(true)
    // 画面は直近の回の印を見て出している。押されるまでの間に戻った
    renameSync(away, from)
    expect(await m.abandon()).toBe(false)
    expect(m.isCopying()).toBe(true)
    expect(m.snapshot()!.sourceMissing).toBe(false)
    expect((await readMigrationJournal(to))?.state).toBe('copying')
  })

  it('安全弁: やめた記録を書けなければ投げ、複製中のまま残す（書けたら改めてやめられる）', async () => {
    await begin(to, from, 1000)
    rmSync(from, { recursive: true })
    const m = make()
    await m.load()
    await m.pass()
    // 帳面の場所をフォルダで塞ぎ、置き換えを失敗させる
    const journalPath = join(to, MIGRATION_FILE)
    rmSync(journalPath)
    mkdirSync(journalPath)
    writeFileSync(join(journalPath, 'x'), 'x')
    await expect(m.abandon()).rejects.toThrow()
    expect(m.isCopying()).toBe(true)
    expect(m.blocksNewMove()).toBe(true)
    expect(m.snapshot()!.sourceMissing).toBe(true)
    expect(m.snapshot()!.lastError).toMatch(/やめた記録を書けず/)
    rmSync(journalPath, { recursive: true })
    expect(await m.abandon()).toBe(true)
    expect((await readMigrationJournal(to))?.state).toBe('abandoned')
  })

  it('安全弁: やめてもどちらの場所のファイルにも触らず、やめた帳面の上には新しく始められる', async () => {
    put(to, 'raw/2026-10-01/raw-2026-10-01T00.mseed3', 'RAW0')
    await begin(to, from, 1000)
    const away = join(base, 'away')
    renameSync(from, away)
    const m = make()
    await m.load()
    await m.pass()
    await m.abandon()
    expect(readFileSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'), 'utf8')).toBe('RAW0')
    expect(existsSync(join(away, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'))).toBe(true)
    beginLogs = []
    await begin(to, join(base, 'other'), 5)
    expect((await readMigrationJournal(to))?.state).toBe('copying')
    expect(beginLogs).toEqual([])
  })
})

describe('速さの上限の貸し', () => {
  function clock() {
    let t = 0
    let slept = 0
    return {
      now: () => t,
      advance: (ms: number) => void (t += ms),
      sleep: async (ms: number) => {
        t += ms
        slept += ms
      },
      slept: () => slept,
    }
  }

  it('正: 遅い区間が続いた後でも、上限を大きく超えて読まない（貸しは 1 秒ぶんまで）', async () => {
    const c = clock()
    const th = new ReadThrottle(100, c.now, c.sleep)
    // 上限 100 B/s に対し、0.9 秒ごとに 1 バイトずつ（とても遅い）を 20 回。
    for (let i = 0; i < 20; i += 1) {
      await th.take(1)
      c.advance(900)
    }
    const before = c.slept()
    await th.take(1000)
    // 1000 バイトは上限なら 10 秒。貸し 1 秒を差し引いても 8 秒以上は待つ。
    expect(c.slept() - before).toBeGreaterThanOrEqual(8000)
  })

  it('対照: 間を置かずに読み始めたときも上限で待つ', async () => {
    const c = clock()
    const th = new ReadThrottle(100, c.now, c.sleep)
    await th.take(1000)
    expect(c.slept()).toBeGreaterThanOrEqual(9900)
  })

  it('安全弁: ちょうど上限の速さで読んでいる間は余計に待たない', async () => {
    const c = clock()
    const th = new ReadThrottle(100, c.now, c.sleep)
    for (let i = 0; i < 50; i += 1) {
      await th.take(10)
      c.advance(100)
    }
    expect(c.slept()).toBeLessThan(200)
  })
})

describe('読み直しにも速さの上限を掛ける', () => {
  it('正: 消す前の複製先の読み直しは、上限の速さで待つ', async () => {
    await begin(to, from, 1000)
    const fast = make()
    await fast.load()
    await fast.pass()
    const clock = fakeClock()
    // 21 バイトを 10 バイト/秒 → 2 秒ほど待つ。
    const m = make({ bytesPerSec: 10, now: clock.now, sleep: clock.sleep })
    await m.load()
    await m.purge()
    expect(clock.slept()).toBeGreaterThanOrEqual(1500)
    expect(m.snapshot()!.state).toBe('done')
  })

  it('正: 帳面を作り直したあとに複製先へ既にある分も、元と複製先の読み直しを上限の速さで待つ', async () => {
    for (const rel of [
      'raw/2026-10-01/raw-2026-10-01T00.mseed3',
      'wave/wave-S1-2026-10-01T00.bin',
      'events/2026-10/e1.json',
      'summary/raw/2026-10-01/raw-2026-10-01T00.fine.wsum',
    ]) {
      put(to, rel, readFileSync(join(from, ...rel.split('/')), 'utf8'))
    }
    await begin(to, from, 1000)
    const clock = fakeClock()
    const m = make({ bytesPerSec: 10, now: clock.now, sleep: clock.sleep })
    await m.load()
    await m.pass()
    // 元と複製先で 42 バイト → 4 秒ほど。
    expect(clock.slept()).toBeGreaterThanOrEqual(3500)
    expect(m.snapshot()!.doneFiles).toBe(4)
  })

  it('対照: 上限が十分に高ければ待たない', async () => {
    await begin(to, from, 1000)
    const clock = fakeClock()
    const m = make({ bytesPerSec: 1e12, now: clock.now, sleep: clock.sleep })
    await m.load()
    await m.pass()
    await m.purge()
    expect(clock.slept()).toBe(0)
    expect(m.snapshot()!.state).toBe('done')
  })
})

describe('帳面の複製元を比べる', () => {
  function journalFrom(src: string, state: 'copying' | 'copied' | 'purging'): void {
    mkdirSync(to, { recursive: true })
    writeFileSync(
      join(to, MIGRATION_FILE),
      JSON.stringify({ version: 1, from: src, startedAtMs: 1, state, verified: {}, skipped: {}, copiedAtMs: null, purgedAtMs: null, purged: null }),
    )
  }

  it('正: Windows の作法では、大文字・小文字と末尾の区切りだけが違う複製元は同じ場所（続きから）', async () => {
    journalFrom('C:\\Data\\Old', 'copying')
    await beginMigration(to, 'c:\\data\\OLD\\', 5, { platform: 'win32', log: () => {} })
    expect((await readMigrationJournal(to))?.startedAtMs).toBe(1)
  })

  it('対照: 区別する作法では、大文字・小文字が違えば別の場所（途中の帳面なので断る）', async () => {
    journalFrom(join(base, 'gone-a'), 'copying')
    await expect(beginMigration(to, join(base, 'GONE-A'), 5, { platform: 'linux', log: () => {} })).rejects.toThrow(
      /別の場所/,
    )
  })

  it('正: 別の場所からの済んだ帳面（copied・purging）は置き換え、そのことをログへ出す', async () => {
    for (const state of ['copied', 'purging'] as const) {
      journalFrom(join(base, 'elsewhere'), state)
      beginLogs = []
      await begin(to, from, 7)
      const j = await readMigrationJournal(to)
      expect(j?.from).toBe(from)
      expect(j?.state).toBe('copying')
      expect(beginLogs.some((l) => l.includes('elsewhere') && l.includes('置き換えた'))).toBe(true)
    }
  })

  it('安全弁: 別の場所からの複製の途中（copying）の帳面は置き換えない', async () => {
    journalFrom(join(base, 'elsewhere'), 'copying')
    await expect(begin(to, from, 7)).rejects.toThrow(/別の場所/)
    expect((await readMigrationJournal(to))?.from).toBe(join(base, 'elsewhere'))
  })

  it('正: 別名（ジャンクション）で指していても同じ複製元なら続きから', async () => {
    mkdirSync(from, { recursive: true })
    const a = join(base, 'alias-from')
    symlinkSync(from, a, process.platform === 'win32' ? 'junction' : 'dir')
    journalFrom(a, 'copying')
    await begin(to, from, 9)
    expect((await readMigrationJournal(to))?.startedAtMs).toBe(1)
  })
})

describe('同じ実体かどうか', () => {
  it('正: 同じドライブの同じファイル番号なら同じ', () => {
    expect(sameIdentity({ dev: 1n, ino: 5n }, { dev: 1n, ino: 5n })).toBe(true)
  })
  it('対照: ファイル番号が違えば別', () => {
    expect(sameIdentity({ dev: 1n, ino: 5n }, { dev: 1n, ino: 6n })).toBe(false)
  })
  it('安全弁: ファイル番号を持たない（0）なら判らない（同じとも別とも決めない）', () => {
    expect(sameIdentity({ dev: 1n, ino: 0n }, { dev: 1n, ino: 0n })).toBeNull()
  })
})

describe('複製元が見つからないとき', () => {
  it('安全弁: 複製元のフォルダそのものが無ければ copied にせず、理由を出して待つ', async () => {
    await begin(to, from, 1000)
    rmSync(from, { recursive: true })
    const m = make()
    await m.load()
    expect(await m.pass()).toBe(false)
    const s = m.snapshot()!
    expect(s.state).toBe('copying')
    expect(s.lastError).toMatch(/見つからない/)
  })

  it('対照: 4 つの置き場所の一部が無いだけなら、あるものを複製して copied になる', async () => {
    rmSync(join(from, 'events'), { recursive: true })
    await begin(to, from, 1000)
    const m = make()
    await m.load()
    expect(await m.pass()).toBe(true)
    expect(m.snapshot()!.doneFiles).toBe(3)
  })

  it('正: 複製元が戻れば、次の回で続きを複製する', async () => {
    await begin(to, from, 1000)
    const moved = join(base, 'away')
    renameSync(from, moved)
    const m = make()
    await m.load()
    expect(await m.pass()).toBe(false)
    renameSync(moved, from)
    expect(await m.pass()).toBe(true)
    expect(m.snapshot()!.doneFiles).toBe(4)
  })
})
