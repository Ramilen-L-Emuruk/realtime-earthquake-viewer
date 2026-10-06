import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MseedStore, mseedFilePath } from './mseedStore'

/** 2026-10-01 12:30 JST（03:30 UTC）。 */
const T = Date.UTC(2026, 9, 1, 3, 30, 0)
const HOUR = 3_600_000

let dir: string
let now = T

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mseed-store-'))
  now = T
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function bytes(fill: number, n = 64): Uint8Array {
  return new Uint8Array(n).fill(fill)
}

function store(over: Partial<ConstructorParameters<typeof MseedStore>[0]> = {}): MseedStore {
  return new MseedStore({ dir, now: () => now, ...over })
}

describe('mseedFilePath', () => {
  it('日本時間の日のディレクトリの下に、時ごとの 1 本を置く', () => {
    expect(mseedFilePath('/x', T)).toBe(join('/x', '2026-10-01', 'raw-2026-10-01T12.mseed3'))
  })

  it('時刻として表せない値には名前を作らない', () => {
    expect(mseedFilePath('/x', Number.NaN)).toBeNull()
  })
})

describe('MseedStore', () => {
  it('レコードを、その時の本へ届いた順に足していく', async () => {
    const s = store()
    expect(s.write(bytes(1), T)).toEqual({ saved: true })
    expect(s.write(bytes(2), T + 60_000)).toEqual({ saved: true })
    await s.close()
    const buf = readFileSync(mseedFilePath(dir, T)!)
    expect(buf.length).toBe(128)
    expect(buf[0]).toBe(1)
    expect(buf[64]).toBe(2)
  })

  it('時が違えば別の本へ書く（過ぎた時の本も開き直して足す）', async () => {
    const s = store()
    s.write(bytes(1), T)
    s.write(bytes(2), T + HOUR)
    // 取り戻した分は、波形の時刻の時へ戻って書く。
    s.write(bytes(3), T + 10)
    await s.close()
    expect(readFileSync(mseedFilePath(dir, T)!).length).toBe(128)
    expect(readFileSync(mseedFilePath(dir, T + HOUR)!).length).toBe(64)
  })

  it('既にある本へは追記する（上書きしない）', async () => {
    const a = store()
    a.write(bytes(1), T)
    await a.close()
    const b = store()
    b.write(bytes(2), T)
    await b.close()
    expect(readFileSync(mseedFilePath(dir, T)!).length).toBe(128)
  })

  it('締めたあとは断る（失ったとは数えない）', async () => {
    const s = store()
    await s.close()
    expect(s.write(bytes(1), T)).toEqual({ saved: false, reason: 'closed' })
    expect(s.lostRecords).toBe(0)
  })

  it('時刻として表せない値は、ディスクと別の理由で数える', () => {
    const s = store()
    expect(s.write(bytes(1), Number.NaN)).toEqual({ saved: false, reason: 'bad-time' })
    expect(s.badTimes).toBe(1)
    expect(s.lostRecords).toBe(0)
  })

  it('開けなければ失ったと数え、間隔を置いてから開き直す', () => {
    let opens = 0
    const s = store({
      openStream: () => {
        opens += 1
        throw new Error('EACCES')
      },
    })
    expect(s.write(bytes(1), T)).toEqual({ saved: false, reason: 'no-stream' })
    expect(s.write(bytes(1), T)).toEqual({ saved: false, reason: 'no-stream' })
    expect(opens).toBe(1)
    now += 5_000
    s.write(bytes(1), T)
    expect(opens).toBe(2)
    expect(s.lostRecords).toBe(3)
    expect(s.writeErrors).toBe(2)
    expect(s.lastWriteError).toContain('EACCES')
  })

  it('書き出しが詰まって抱えた量が上限を超えたら捨てて数える', () => {
    const stuck = new Writable({ write: () => {} })
    const s = store({ maxPendingBytes: 100, openStream: () => stuck })
    expect(s.write(bytes(1), T)).toEqual({ saved: true })
    expect(s.write(bytes(2), T)).toEqual({ saved: false, reason: 'backpressure' })
    expect(s.lostRecords).toBe(1)
  })

  it('正: 書き終わりを待つ書き方は、流し口が書き終えてから true を返す', async () => {
    const s = store()
    await expect(s.writeConfirmed(bytes(7), T)).resolves.toBe(true)
    await s.close()
    expect(readFileSync(mseedFilePath(dir, T)!)[0]).toBe(7)
  })

  it('正: 流し口へ渡したあとで書き込みが失敗したら false を返し、失ったと数える', async () => {
    // 渡すこと自体は通る（その場では分からない）—— ディスクが一杯・I/O エラーはこの形で届く。
    const failing = new Writable({ write: (_chunk, _enc, cb) => cb(new Error('ENOSPC')) })
    failing.on('error', () => {})
    const s = store({ openStream: () => failing })
    await expect(s.writeConfirmed(bytes(1), T)).resolves.toBe(false)
    expect(s.lostRecords).toBe(1)
  })

  it('対照: その場で分かる失敗（締めたあと）でも false を返す', async () => {
    const s = store()
    await s.close()
    await expect(s.writeConfirmed(bytes(1), T)).resolves.toBe(false)
  })

  it('安全弁: 書き終わりを待たない書き方は従来どおり、渡せた時点で saved を返す', () => {
    const stuck = new Writable({ write: () => {} })
    const s = store({ openStream: () => stuck })
    expect(s.write(bytes(1), T)).toEqual({ saved: true })
  })

  it('しばらく書かなかった本は閉じる', async () => {
    const s = store({ idleCloseMs: 120_000 })
    s.write(bytes(1), T)
    expect(s.openBooks).toBe(1)
    now += 119_999
    s.tick()
    expect(s.openBooks).toBe(1)
    now += 1
    s.tick()
    expect(s.openBooks).toBe(0)
    await s.close()
  })
})
