import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { StationConfigHistory } from './stationConfigHistory'
import type { StationConfig } from './stationConfigTypes'

const CONFIG_A: StationConfig = {
  stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
  boards: [],
}
const CONFIG_B: StationConfig = { stations: [], boards: [] }

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'station-history-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function lines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

describe('StationConfigHistory', () => {
  it('時刻・理由・警告・設定の全体を 1 行ずつ追記する（上書きしない）', () => {
    let now = 1_000
    const h = new StationConfigHistory({ dir, now: () => now })
    expect(h.record(CONFIG_A, 'startup', '読めない: ENOENT')).toBe(true)
    now = 2_000
    expect(h.record(CONFIG_B, 'changed', null)).toBe(true)

    expect(lines(join(dir, 'stations-history.ndjson'))).toEqual([
      { at: 1_000, reason: 'startup', warning: '読めない: ENOENT', config: CONFIG_A },
      { at: 2_000, reason: 'changed', warning: null, config: CONFIG_B },
    ])
  })

  it('作り直しても前の行を消さない（起動のたびに足していく）', () => {
    new StationConfigHistory({ dir, now: () => 1 }).record(CONFIG_A, 'startup', null)
    new StationConfigHistory({ dir, now: () => 2 }).record(CONFIG_B, 'startup', null)
    expect(lines(join(dir, 'stations-history.ndjson'))).toHaveLength(2)
  })

  it('置き場所が無ければ作る', () => {
    const nested = join(dir, 'a', 'b')
    const h = new StationConfigHistory({ dir: nested, now: () => 1 })
    expect(h.record(CONFIG_A, 'startup', null)).toBe(true)
    expect(lines(join(nested, 'stations-history.ndjson'))).toHaveLength(1)
  })

  it('書けなくても投げず、数えて理由を残す（設定の反映を止めない）', () => {
    // 置き場所のはずの名前にファイルを置いて、ディレクトリを作れなくする。
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x')
    const h = new StationConfigHistory({ dir: blocked, now: () => 1 })
    expect(h.record(CONFIG_A, 'changed', null)).toBe(false)
    expect(h.record(CONFIG_A, 'changed', null)).toBe(false)
    expect(h.writeFailures).toBe(2)
    expect(h.lastError).not.toBeNull()
  })

  it('書けた後は直前の失敗の文面を残したまま、回数だけ据え置く', () => {
    const sub = join(dir, 'later')
    writeFileSync(sub, 'x')
    const h = new StationConfigHistory({ dir: sub, now: () => 1 })
    h.record(CONFIG_A, 'changed', null)
    rmSync(sub)
    mkdirSync(sub)
    expect(h.record(CONFIG_A, 'changed', null)).toBe(true)
    expect(h.writeFailures).toBe(1)
    expect(h.recorded).toBe(1)
  })
})
