import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  COPY_ORDER,
  MIGRATION_FILE,
  StorageMigration,
  beginMigration,
  canonicalPath,
  readMigrationJournal,
} from './storageMigration'
import { STORAGE_KINDS } from './hostSettings'

let base: string
let from: string
let to: string

function put(root: string, rel: string, text: string): void {
  const p = join(root, ...rel.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}

function make(extra: Partial<ConstructorParameters<typeof StorageMigration>[0]> = {}): StorageMigration {
  return new StorageMigration({ to, bytesPerSec: 1e12, sleep: async () => {}, ...extra })
}

beforeEach(() => {
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
    await beginMigration(to, from, 1000)
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
    await beginMigration(to, from, 1000)
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
    await beginMigration(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    expect(m.snapshot()!.skippedExists).toBe(0)
    expect(m.snapshot()!.doneFiles).toBe(4)
  })

  it('途中で止めても、次の起動で帳面から続きを始める', async () => {
    await beginMigration(to, from, 1000)
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
    await beginMigration(to, from, 1000)
    const m = make({ freeBytesOf: async () => 10 })
    await m.load()
    expect(await m.pass()).toBe(false)
    expect(m.snapshot()!.blockedBySpace?.freeBytes).toBe(10)
    expect(existsSync(join(to, 'raw'))).toBe(false)
  })

  it('別の場所からの終わっていない帳面があれば、新しく始めない（消してよい物の記録を上書きしない）', async () => {
    await beginMigration(to, from, 1000)
    await expect(beginMigration(to, join(base, 'other'), 2000)).rejects.toThrow(/別の場所/)
    // 同じ複製元なら続きから（投げない）
    await beginMigration(to, from, 3000)
    expect((await readMigrationJournal(to))?.startedAtMs).toBe(1000)
  })

  it('帳面は新しい保存先の直下に置く', async () => {
    await beginMigration(to, from, 1000)
    expect(existsSync(join(to, MIGRATION_FILE))).toBe(true)
  })

  it('済んだ帳面は、同じ複製元でも続きとして使い回さず作り直す（行って戻って行き直したとき）', async () => {
    await beginMigration(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    expect((await readMigrationJournal(to))?.state).toBe('copied')
    await beginMigration(to, from, 9000)
    const j = await readMigrationJournal(to)
    expect(j?.state).toBe('copying')
    expect(j?.startedAtMs).toBe(9000)
    expect(j?.verified).toEqual({})
  })

  it('安全弁: 複製先へ書けなくても投げず、理由を残してやり直しを待つ（受信ごと落とさない）', async () => {
    await beginMigration(to, from, 1000)
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
    await beginMigration(from, from, 1000)
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
    await beginMigration(to, from, 1000)
    const m = make()
    await m.load()
    await expect(m.purge()).rejects.toThrow()
    expect(existsSync(join(from, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'))).toBe(true)
  })

  it('正: 照合を通ったファイルだけを消し、4 つの置き場所の外には触らない', async () => {
    await beginMigration(to, from, 1000)
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
    await beginMigration(to, from, 1000)
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
    await beginMigration(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    put(from, 'raw/2026-10-01/raw-2026-10-01T01.mseed3', 'LATE')
    await m.purge()
    expect(readFileSync(join(from, 'raw', '2026-10-01', 'raw-2026-10-01T01.mseed3'), 'utf8')).toBe('LATE')
  })

  it('安全弁: 複製先の中身が同じ大きさのまま変わっていたら消さない（大きさだけでなく SHA-256 も見る）', async () => {
    await beginMigration(to, from, 1000)
    const m = make()
    await m.load()
    await m.pass()
    writeFileSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'), 'RAWX')
    const r = await m.purge()
    expect(r.kept).toBe(1)
    expect(readFileSync(join(from, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3'), 'utf8')).toBe('RAW0')
  })

  it('途中で止まった削除（purging）は、次の起動でもう一度承認して続きから消せる', async () => {
    await beginMigration(to, from, 1000)
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
    await beginMigration(to, a, 1000)
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
    await beginMigration(to, from, 1000)
    // 一時ファイルの名前に中身のあるフォルダを置き、書き込み口を開けなくする（消せないので残るのはこれだけ）。
    mkdirSync(join(to, 'raw', '2026-10-01', 'raw-2026-10-01T00.mseed3.migrating', 'x'), { recursive: true })
    const m = make()
    await m.load()
    await m.pass()
    expect(existsSync(join(to, 'wave', 'wave-S1-2026-10-01T00.bin.migrating'))).toBe(false)
    expect(readFileSync(join(to, 'wave', 'wave-S1-2026-10-01T00.bin'), 'utf8')).toBe('WAVE0')
  })
})
