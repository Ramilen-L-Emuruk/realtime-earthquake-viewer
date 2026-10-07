import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ShakeEventRecord } from './shakeEvent'
import {
  eventFileName,
  eventFilePath,
  jstMonth,
  monthsBetween,
  readEventRange,
  ShakeEventStore,
  startMsFromFileName,
} from './shakeEventStore'

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

const T = Date.UTC(2026, 9, 3, 4, 27, 0)

describe('monthsBetween / jstMonth', () => {
  it('日本時間で月を決める（UTC の 9/30 15:00 は日本時間の 10 月）', () => {
    expect(jstMonth(Date.UTC(2026, 8, 30, 15, 0))).toBe('2026-10')
    expect(jstMonth(Date.UTC(2026, 8, 30, 14, 59))).toBe('2026-09')
  })

  it('範囲に掛かる月を古い順に並べる（年をまたぐ）', () => {
    expect(monthsBetween(Date.UTC(2026, 10, 20), Date.UTC(2027, 1, 2))).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
  })
})

describe('eventFileName', () => {
  it('ふつうの id はそのまま名前にする', () => {
    expect(eventFileName('station-1-1759465588000')).toBe('station-1-1759465588000.json')
  })

  it('置き場所を外れる文字・Windows で書けない文字・英数字以外は逃がす', () => {
    // 観測点の ID は管理コンソールから自由に付けられる。
    expect(eventFileName('../a/b:c*書斎-1')).toBe('%2E.%2Fa%2Fb%3Ac%2A%E6%9B%B8%E6%96%8E-1.json')
    expect(eventFileName('.hidden-1')).toBe('%2Ehidden-1.json')
  })

  it('日本時間の始まりの月のディレクトリへ置く', () => {
    expect(eventFilePath('/d', { id: 'a-1', startMs: Date.UTC(2026, 8, 30, 15, 0) })).toBe(join('/d', '2026-10', 'a-1.json'))
  })
})

describe('ShakeEventStore / readEventRange', () => {
  it('揺れごとに 1 本で持ち、版が進んだら置き換える', async () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    expect(store.save(rec('a', T, 1, 'pending'))).toBe(true)
    expect(store.save(rec('b', T + 60_000, 1, 'pending'))).toBe(true)
    expect(store.save(rec('a', T, 2, 'quake'))).toBe(true)

    expect(readdirSync(join(dir, '2026-10')).sort()).toEqual(['a.json', 'b.json'])
    const { events, unreadableFiles } = await readEventRange({ dir, fromMs: T - 1, toMs: T + 3_600_000 })
    expect(events.map((e) => [e.id, e.rev, e.verdict])).toEqual([
      ['a', 2, 'quake'],
      ['b', 1, 'pending'],
    ])
    expect(unreadableFiles).toEqual([])
    expect(store.written).toBe(3)
  })

  it('古い版で新しい版を上書きしない（失敗として数え、新しい版を残す）', () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    store.save(rec('a', T, 3, 'quake'))
    expect(store.save(rec('a', T, 2, 'pending'))).toBe(false)
    expect(store.writeErrors).toBe(1)
    expect(store.lastWriteError).toContain('版 2')
    const kept = JSON.parse(readFileSync(eventFilePath(dir, { id: 'a', startMs: T }), 'utf8')) as ShakeEventRecord
    expect(kept.rev).toBe(3)
  })

  it('同じ版の書き直しは通す（対照）', () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    store.save(rec('a', T, 2, 'pending'))
    expect(store.save(rec('a', T, 2, 'quake'))).toBe(true)
  })

  it('読めない前の版は、新しい版で置き換える（版は毎回まるごとの写し）', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '2026-10'), { recursive: true })
    writeFileSync(eventFilePath(dir, { id: 'a', startMs: T }), '{こわれた')
    const store = new ShakeEventStore({ dir })
    expect(store.save(rec('a', T, 1, 'pending'))).toBe(true)
  })

  it('一時ファイルを残さず、読み手も一時ファイルを読まない', async () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    store.save(rec('a', T, 1, 'pending'))
    expect(existsSync(`${eventFilePath(dir, { id: 'a', startMs: T })}.tmp`)).toBe(false)
    // 書き込みの途中で落ちた形を作る。
    writeFileSync(join(dir, '2026-10', 'b.json.tmp'), '{途中')
    const r = await readEventRange({ dir, fromMs: T - 1, toMs: T + 1 })
    expect(r.events.map((e) => e.id)).toEqual(['a'])
    expect(r.unreadableFiles).toEqual([])
  })

  it('範囲の外の揺れは返さない。壊れたファイルは名前を添えて飛ばす', async () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    store.save(rec('a', T, 1, 'pending'))
    store.save(rec('c', T + 86_400_000, 1, 'pending'))
    writeFileSync(join(dir, '2026-10', 'x.json'), '{こわれた')
    writeFileSync(join(dir, '2026-10', 'y.json'), '{"id":"y"}')
    const { events, unreadableFiles } = await readEventRange({ dir, fromMs: T, toMs: T + 3_600_000 })
    expect(events.map((e) => e.id)).toEqual(['a'])
    expect(unreadableFiles).toEqual(['2026-10/x.json', '2026-10/y.json'])
  })

  it('正: 名前で範囲の外と分かるファイルは開かない（壊れていても読めなかったに数えない）', async () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    store.save(rec(`s-${T}`, T, 1, 'pending'))
    // 名前は範囲の外（1 日後）を名乗る。開けば壊れているが、開かないので数えない。
    writeFileSync(join(dir, '2026-10', `s-${T + 86_400_000}.json`), '{こわれた')
    const r = await readEventRange({ dir, fromMs: T, toMs: T + 3_600_000 })
    expect(r.events.map((e) => e.id)).toEqual([`s-${T}`])
    expect(r.unreadableFiles).toEqual([])
  })

  it('対照: 名前が範囲の中を名乗るファイルは開く（壊れていれば読めなかったに数える）', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, '2026-10'), { recursive: true })
    writeFileSync(join(dir, '2026-10', `s-${T + 60_000}.json`), '{こわれた')
    const r = await readEventRange({ dir, fromMs: T, toMs: T + 3_600_000 })
    expect(r.unreadableFiles).toEqual([`2026-10/s-${T + 60_000}.json`])
  })

  it('正: 名前は丸めで右端を名乗っても、中身が端の内側で始まっていれば返す（id は始まりを整数へ丸める）', async () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    // 始まり T+0.6 の id は `s-<T+1>`（`initialRecord` の `toFixed(0)`）。範囲の右端を T+1 にすると、
    // 名前は外を名乗るが中身は内側にある。
    const r = rec(`s-${T + 1}`, T + 0.6, 1, 'pending')
    store.save(r)
    const got = await readEventRange({ dir, fromMs: T - 60_000, toMs: T + 1 })
    expect(got.events.map((e) => e.id)).toEqual([`s-${T + 1}`])
  })

  it('対照: 中身も範囲の外なら返さない（名前の余裕は開くかどうかにだけ効く）', async () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    store.save(rec(`s-${T + 1}`, T + 1, 1, 'pending'))
    const got = await readEventRange({ dir, fromMs: T - 60_000, toMs: T + 1 })
    expect(got.events).toEqual([])
    expect(got.unreadableFiles).toEqual([])
  })

  it('安全弁: 余裕は 1 ミリ秒だけ。それより外を名乗るファイルは開かない', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, '2026-10'), { recursive: true })
    writeFileSync(join(dir, '2026-10', `s-${T + 2}.json`), '{こわれた')
    const r = await readEventRange({ dir, fromMs: T - 60_000, toMs: T + 1 })
    expect(r.unreadableFiles).toEqual([])
  })

  it('startMsFromFileName: 末尾の -<数字>.json を読む。読めなければ null（開いて確かめる）', () => {
    expect(startMsFromFileName(`station-1-${T}.json`)).toBe(T)
    expect(startMsFromFileName(`%3Cb%3E-${T}.json`)).toBe(T)
    expect(startMsFromFileName('x.json')).toBeNull()
  })

  it('記録が無い月は「揺れが無かった」として数えない', async () => {
    const dir = tempDir()
    const r = await readEventRange({ dir, fromMs: Date.UTC(2026, 0, 1), toMs: Date.UTC(2026, 2, 1) })
    expect(r).toEqual({ events: [], unreadableFiles: [] })
  })

  it('書けなくても投げずに数える', () => {
    const dir = tempDir()
    // ディレクトリを置くべき場所にファイルを置いて、書けなくする。
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x')
    const store = new ShakeEventStore({ dir: blocked })
    expect(store.save(rec('a', T, 1, 'pending'))).toBe(false)
    expect(store.writeErrors).toBe(1)
    expect(store.lastWriteError).not.toBeNull()
    expect(readFileSync(blocked, 'utf8')).toBe('x')
  })
})
