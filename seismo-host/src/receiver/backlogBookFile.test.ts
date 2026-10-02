import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BacklogBookState } from './backlogBook'
import { BacklogBookWriter, readBacklogBookFile } from './backlogBookFile'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seismo-backlog-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const STATE: BacklogBookState = {
  version: 1,
  streams: [{ boardKey: 'mac:a0b76525ead0', bootId: '34b6e78f', sensorId: 'i2c0-68', nextSeq: 120, address: '192.168.0.25' }],
  gaps: [{
    boardKey: 'mac:a0b76525ead0', bootId: '34b6e78f', sensorId: 'i2c0-68', address: '192.168.0.25',
    from: 30, to: 90, foundAtMs: 1_000,
  }],
}

describe('backlogBookFile', () => {
  it('書いたものを次の起動で読み戻せる', async () => {
    const path = join(dir, 'backlog-book.json')
    expect(await new BacklogBookWriter(path).save(STATE)).toBeNull()
    expect(await readBacklogBookFile(path)).toEqual({ state: STATE, problem: null })
  })

  it('ファイルが無ければ、問題なしで空', async () => {
    expect(await readBacklogBookFile(join(dir, 'missing.json'))).toEqual({ state: null, problem: null })
  })

  it('形が合わなければ「無かった」と混ぜずに理由を返す', async () => {
    const path = join(dir, 'broken.json')
    writeFileSync(path, '{"version":1}')
    const got = await readBacklogBookFile(path)
    expect(got.state).toBeNull()
    expect(got.problem).not.toBeNull()
  })

  it('置き場所のディレクトリが無ければ作る', async () => {
    const path = join(dir, 'data', 'nested', 'backlog-book.json')
    expect(await new BacklogBookWriter(path).save(STATE)).toBeNull()
    expect((await readBacklogBookFile(path)).state).toEqual(STATE)
  })

  it('続けて書いても、最後に渡したものが残る', async () => {
    const path = join(dir, 'backlog-book.json')
    const writer = new BacklogBookWriter(path)
    const later: BacklogBookState = { ...STATE, gaps: [] }
    await Promise.all([writer.save(STATE), writer.save(later)])
    expect((await readBacklogBookFile(path)).state).toEqual(later)
  })
})
