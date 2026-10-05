import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ShakeEventRecord } from './shakeEvent'
import { ShakeEventStore, eventFileName, jstMonth, monthsBetween, readEventRange } from './shakeEventStore'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'shake-events-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function rec(id: string, startMs: number, rev: number, verdict: ShakeEventRecord['verdict']): ShakeEventRecord {
  return {
    id,
    rev,
    writtenAtMs: startMs + rev,
    stationId: 'station-1',
    detectorVersion: 1,
    startMs,
    endMs: startMs + 5000,
    endReason: 'quiet',
    sMs: null,
    sSnr: null,
    pMs: null,
    pSnr: null,
    sMinusPSec: null,
    phaseWindow: 'picked',
    peakAccelGal: 3,
    peakHorizontalGal: 2.9,
    maxIntensity: 1.2,
    peakRatio: 4,
    baselineGal: 0.17,
    verticalRatio: 0.4,
    bandRatios: [0.2, 0.4, 1, 0.6, 0.4],
    shakeClass: 'quake-like',
    sensors: [],
    spatialConsistency: 'not-evaluated',
    verdict,
    matchedQuake: null,
  }
}

describe('monthsBetween / jstMonth', () => {
  it('日本時間で月を決める（UTC の 9/30 15:00 は日本時間の 10 月）', () => {
    expect(jstMonth(Date.UTC(2026, 8, 30, 15, 0))).toBe('2026-10')
    expect(jstMonth(Date.UTC(2026, 8, 30, 14, 59))).toBe('2026-09')
  })

  it('範囲に掛かる月を古い順に並べる（年をまたぐ）', () => {
    expect(monthsBetween(Date.UTC(2026, 10, 20), Date.UTC(2027, 1, 2))).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
  })
})

describe('ShakeEventStore / readEventRange', () => {
  it('追記した版を、id ごとに最後の版で読み返す', async () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    const t = Date.UTC(2026, 9, 3, 4, 27, 0)
    store.append(rec('a', t, 1, 'pending'))
    store.append(rec('b', t + 60_000, 1, 'pending'))
    store.append(rec('a', t, 2, 'quake'))
    const { events, unreadableLines } = await readEventRange({ dir, fromMs: t - 1, toMs: t + 3_600_000 })
    expect(events.map((e) => [e.id, e.rev, e.verdict])).toEqual([
      ['a', 2, 'quake'],
      ['b', 1, 'pending'],
    ])
    expect(unreadableLines).toBe(0)
    expect(store.written).toBe(3)
  })

  it('範囲の外の揺れは返さない。壊れた行は数えて飛ばす', async () => {
    const dir = tempDir()
    const t = Date.UTC(2026, 9, 3, 4, 27, 0)
    writeFileSync(
      join(dir, eventFileName('2026-10')),
      `${JSON.stringify(rec('a', t, 1, 'pending'))}\n{こわれた\n${JSON.stringify(rec('c', t + 86_400_000, 1, 'pending'))}\n`,
    )
    const { events, unreadableLines } = await readEventRange({ dir, fromMs: t, toMs: t + 3_600_000 })
    expect(events.map((e) => e.id)).toEqual(['a'])
    expect(unreadableLines).toBe(1)
  })

  it('ファイルが無い月は「揺れが無かった」として数えない', async () => {
    const dir = tempDir()
    const r = await readEventRange({ dir, fromMs: Date.UTC(2026, 0, 1), toMs: Date.UTC(2026, 2, 1) })
    expect(r).toEqual({ events: [], unreadableLines: 0, unreadableFiles: [] })
  })

  it('書けなくても投げずに数える', () => {
    const dir = tempDir()
    // ディレクトリを置くべき場所にファイルを置いて、書けなくする。
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x')
    const store = new ShakeEventStore({ dir: blocked })
    expect(store.append(rec('a', Date.UTC(2026, 9, 3), 1, 'pending'))).toBe(false)
    expect(store.writeErrors).toBe(1)
    expect(store.lastWriteError).not.toBeNull()
    expect(readFileSync(blocked, 'utf8')).toBe('x')
  })
})
