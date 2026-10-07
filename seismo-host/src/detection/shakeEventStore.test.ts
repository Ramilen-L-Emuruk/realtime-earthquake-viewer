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

/** 絞り込まない読み返し（上限は画面が使う 500 件）。 */
const ALL = { limit: 500, stationId: null, hideLocal: false }

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
    const { events, unreadableFiles } = await readEventRange({ ...ALL, dir, fromMs: T - 1, toMs: T + 3_600_000 })
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
    const r = await readEventRange({ ...ALL, dir, fromMs: T - 1, toMs: T + 1 })
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
    const { events, unreadableFiles } = await readEventRange({ ...ALL, dir, fromMs: T, toMs: T + 3_600_000 })
    expect(events.map((e) => e.id)).toEqual(['a'])
    expect(unreadableFiles).toEqual(['2026-10/x.json', '2026-10/y.json'])
  })

  it('正: 名前で範囲の外と分かるファイルは開かない（壊れていても読めなかったに数えない）', async () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    store.save(rec(`s-${T}`, T, 1, 'pending'))
    // 名前は範囲の外（1 日後）を名乗る。開けば壊れているが、開かないので数えない。
    writeFileSync(join(dir, '2026-10', `s-${T + 86_400_000}.json`), '{こわれた')
    const r = await readEventRange({ ...ALL, dir, fromMs: T, toMs: T + 3_600_000 })
    expect(r.events.map((e) => e.id)).toEqual([`s-${T}`])
    expect(r.unreadableFiles).toEqual([])
  })

  it('対照: 名前が範囲の中を名乗るファイルは開く（壊れていれば読めなかったに数える）', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, '2026-10'), { recursive: true })
    writeFileSync(join(dir, '2026-10', `s-${T + 60_000}.json`), '{こわれた')
    const r = await readEventRange({ ...ALL, dir, fromMs: T, toMs: T + 3_600_000 })
    expect(r.unreadableFiles).toEqual([`2026-10/s-${T + 60_000}.json`])
  })

  it('正: 名前は丸めで右端を名乗っても、中身が端の内側で始まっていれば返す（id は始まりを整数へ丸める）', async () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    // 始まり T+0.6 の id は `s-<T+1>`（`initialRecord` の `toFixed(0)`）。範囲の右端を T+1 にすると、
    // 名前は外を名乗るが中身は内側にある。
    const r = rec(`s-${T + 1}`, T + 0.6, 1, 'pending')
    store.save(r)
    const got = await readEventRange({ ...ALL, dir, fromMs: T - 60_000, toMs: T + 1 })
    expect(got.events.map((e) => e.id)).toEqual([`s-${T + 1}`])
  })

  it('対照: 中身も範囲の外なら返さない（名前の余裕は開くかどうかにだけ効く）', async () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    store.save(rec(`s-${T + 1}`, T + 1, 1, 'pending'))
    const got = await readEventRange({ ...ALL, dir, fromMs: T - 60_000, toMs: T + 1 })
    expect(got.events).toEqual([])
    expect(got.unreadableFiles).toEqual([])
  })

  it('安全弁: 余裕は 1 ミリ秒だけ。それより外を名乗るファイルは開かない', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, '2026-10'), { recursive: true })
    writeFileSync(join(dir, '2026-10', `s-${T + 2}.json`), '{こわれた')
    const r = await readEventRange({ ...ALL, dir, fromMs: T - 60_000, toMs: T + 1 })
    expect(r.unreadableFiles).toEqual([])
  })

  it('startMsFromFileName: 末尾の -<数字>.json を読む。読めなければ null（開いて確かめる）', () => {
    expect(startMsFromFileName(`station-1-${T}.json`)).toBe(T)
    expect(startMsFromFileName(`%3Cb%3E-${T}.json`)).toBe(T)
    expect(startMsFromFileName('x.json')).toBeNull()
  })

  it('記録が無い月は「揺れが無かった」として数えない', async () => {
    const dir = tempDir()
    const r = await readEventRange({ ...ALL, dir, fromMs: Date.UTC(2026, 0, 1), toMs: Date.UTC(2026, 2, 1) })
    expect(r).toEqual({ events: [], unreadableFiles: [], truncated: false, coveredFromMs: Date.UTC(2026, 0, 1) })
  })

  it('置き場所そのものが無ければ空（まだ 1 件も記録していない）', async () => {
    const r = await readEventRange({ ...ALL, dir: join(tempDir(), 'none'), fromMs: T - 1, toMs: T + 1 })
    expect(r).toEqual({ events: [], unreadableFiles: [], truncated: false, coveredFromMs: T - 1 })
  })
})

describe('readEventRange の区切り（#620・2026-10-07 ユーザー承認: 新しいほうから件数で区切る）', () => {
  /** 1 分おきに n 件（始まりは整数のミリ秒）。 */
  function saveMinutes(dir: string, n: number, stationOf: (i: number) => string = () => 'station-1'): number[] {
    const store = new ShakeEventStore({ dir })
    const starts: number[] = []
    for (let i = 0; i < n; i++) {
      const at = T + i * 60_000
      store.save({ ...rec(`${stationOf(i)}-${at}`, at, 1, 'pending'), stationId: stationOf(i) })
      starts.push(at)
    }
    return starts
  }

  it('正: 上限を超える範囲は新しいほうから上限まで返し、残りがあることと見終えた範囲の頭を添える', async () => {
    const dir = tempDir()
    const starts = saveMinutes(dir, 10)
    const r = await readEventRange({ ...ALL, dir, fromMs: T - 1, toMs: T + 3_600_000, limit: 4 })
    // 返すのは古い順（これまでの形のまま）。
    expect(r.events.map((e) => e.startMs)).toEqual(starts.slice(6))
    expect(r.truncated).toBe(true)
    // 見終えた範囲の頭は、区切った記録の始まりから 1 ミリ秒手前（名前の丸めを見込む）。
    expect(r.coveredFromMs).toBe(starts[6] - 1)
  })

  it('正: 見終えた範囲の頭を次の終わりにすれば、続きを漏れなく読める（重なりは同じ id で揃う）', async () => {
    const dir = tempDir()
    const starts = saveMinutes(dir, 10)
    const seen = new Set<string>()
    let toMs = T + 3_600_000
    for (let guard = 0; guard < 10; guard++) {
      const r = await readEventRange({ ...ALL, dir, fromMs: T - 1, toMs, limit: 3 })
      for (const e of r.events) seen.add(e.id)
      if (!r.truncated) break
      toMs = r.coveredFromMs
    }
    expect([...seen].sort()).toEqual(starts.map((s) => `station-1-${s}`).sort())
  })

  it('対照: 上限に届かなければ区切らない（見終えた範囲の頭は範囲の頭）', async () => {
    const dir = tempDir()
    saveMinutes(dir, 3)
    const r = await readEventRange({ ...ALL, dir, fromMs: T - 1, toMs: T + 3_600_000, limit: 3 })
    expect(r.events).toHaveLength(3)
    expect(r.truncated).toBe(false)
    expect(r.coveredFromMs).toBe(T - 1)
  })

  it('安全弁: 同じ始まり（丸めの ±1 ms）の記録は区切りで分けない（上限を少し超えても返す）', async () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    store.save({ ...rec(`station-1-${T}`, T, 1, 'pending'), stationId: 'station-1' })
    store.save({ ...rec(`station-2-${T + 1}`, T + 0.6, 1, 'pending'), stationId: 'station-2' })
    store.save({ ...rec(`station-3-${T + 60_000}`, T + 60_000, 1, 'pending'), stationId: 'station-3' })
    store.save({ ...rec(`station-4-${T - 60_000}`, T - 60_000, 1, 'pending'), stationId: 'station-4' })
    const r = await readEventRange({ ...ALL, dir, fromMs: T - 3_600_000, toMs: T + 3_600_000, limit: 2 })
    expect(r.events.map((e) => e.stationId).sort()).toEqual(['station-1', 'station-2', 'station-3'])
    expect(r.truncated).toBe(true)
    // 上限に届いたのは名前 T+1 の記録。頭はその 1 ミリ秒手前（T）—— 返さなかった記録の名前は T−1 以下なので、
    // 中身の始まりは T−0.5 より前にある。
    expect(r.coveredFromMs).toBe(T)
  })

  it('正: 観測点と生活振動らしいものの除外は、数える前に掛ける', async () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    for (let i = 0; i < 6; i++) {
      const at = T + i * 60_000
      const stationId = i % 2 === 0 ? 'station-1' : 'station-2'
      store.save({ ...rec(`${stationId}-${at}`, at, 1, i === 4 ? 'local-like' : 'pending'), stationId })
    }
    const byStation = await readEventRange({ ...ALL, dir, fromMs: T - 1, toMs: T + 3_600_000, limit: 2, stationId: 'station-1' })
    expect(byStation.events.map((e) => e.startMs)).toEqual([T + 2 * 60_000, T + 4 * 60_000])
    const hidden = await readEventRange({ ...ALL, dir, fromMs: T - 1, toMs: T + 3_600_000, limit: 2, stationId: 'station-1', hideLocal: true })
    expect(hidden.events.map((e) => e.startMs)).toEqual([T, T + 2 * 60_000])
    expect(hidden.truncated).toBe(false)
  })

  it('正: 観測点で絞った件数で区切り、続きを読めば絞った記録を漏れなく読める', async () => {
    const dir = tempDir()
    saveMinutes(dir, 9, (i) => (i % 3 === 0 ? 'station-1' : 'station-2'))
    const first = await readEventRange({ ...ALL, dir, fromMs: T - 1, toMs: T + 3_600_000, limit: 2, stationId: 'station-1' })
    expect(first.events.map((e) => e.startMs)).toEqual([T + 3 * 60_000, T + 6 * 60_000])
    expect(first.truncated).toBe(true)
    const rest = await readEventRange({ ...ALL, dir, fromMs: T - 1, toMs: first.coveredFromMs, limit: 2, stationId: 'station-1' })
    expect(rest.events.map((e) => e.startMs)).toEqual([T])
    expect(rest.truncated).toBe(false)
  })

  it('安全弁: 置き場所そのものを一覧できなければ投げる（「揺れが無かった」にしない。受け手は 500 を返す）', async () => {
    const blocked = join(tempDir(), 'blocked')
    writeFileSync(blocked, 'x')
    await expect(readEventRange({ ...ALL, dir: blocked, fromMs: T - 1, toMs: T + 1 })).rejects.toThrow()
  })

  it('正: 範囲の上限は置かない（何年ぶんでも、開くのは返す分だけ）', async () => {
    const dir = tempDir()
    saveMinutes(dir, 5)
    // 古い月に壊れたファイルを置く。区切りより古いので開かず、読めなかったにも数えない。
    mkdirSync(join(dir, '2020-01'), { recursive: true })
    writeFileSync(join(dir, '2020-01', `station-1-${Date.UTC(2020, 0, 5)}.json`), '{こわれた')
    const r = await readEventRange({ ...ALL, dir, fromMs: 0, toMs: Date.UTC(2100, 0, 1), limit: 2 })
    expect(r.events).toHaveLength(2)
    expect(r.truncated).toBe(true)
    expect(r.unreadableFiles).toEqual([])
  })

  it('正: 区切りに届いたら、それより古い月は一覧もしない（蓄積した年数で重くならない）', async () => {
    const dir = tempDir()
    saveMinutes(dir, 5)
    // 一覧すれば「一覧できなかった月」に数わる形（ディレクトリの代わりにファイル）を、古い月に置く。
    writeFileSync(join(dir, '2020-01'), 'x')
    const cut = await readEventRange({ ...ALL, dir, fromMs: 0, toMs: T + 3_600_000, limit: 2 })
    expect(cut.truncated).toBe(true)
    expect(cut.unreadableFiles).toEqual([])
  })

  it('対照: 区切りに届かなければ古い月まで一覧する（一覧できなければそう数える）', async () => {
    const dir = tempDir()
    saveMinutes(dir, 5)
    writeFileSync(join(dir, '2020-01'), 'x')
    const all = await readEventRange({ ...ALL, dir, fromMs: 0, toMs: T + 3_600_000, limit: 500 })
    expect(all.truncated).toBe(false)
    expect(all.unreadableFiles).toEqual(['2020-01'])
  })

  it('安全弁: 月の境目をまたぐ同じ始まり（丸めの ±1 ms）も区切りで分けない', async () => {
    const dir = tempDir()
    const store = new ShakeEventStore({ dir })
    // 日本時間 11/01 0 時ちょうどの記録（11 月）と、その 0.4 ms 前の記録（10 月・名前は 0 時へ丸まる）。
    const B = Date.UTC(2026, 9, 31, 15, 0)
    store.save({ ...rec(`station-1-${B}`, B, 1, 'pending'), stationId: 'station-1' })
    store.save({ ...rec(`station-2-${B}`, B - 0.4, 1, 'pending'), stationId: 'station-2' })
    store.save({ ...rec(`station-3-${B - 60_000}`, B - 60_000, 1, 'pending'), stationId: 'station-3' })
    const r = await readEventRange({ ...ALL, dir, fromMs: B - 3_600_000, toMs: B + 3_600_000, limit: 1 })
    expect(r.events.map((e) => e.stationId).sort()).toEqual(['station-1', 'station-2'])
    expect(r.truncated).toBe(true)
  })

  it('対照: 区切りより新しい壊れたファイルは読めなかったに数える', async () => {
    const dir = tempDir()
    saveMinutes(dir, 5)
    writeFileSync(join(dir, '2026-10', `station-1-${T + 10 * 60_000}.json`), '{こわれた')
    const r = await readEventRange({ ...ALL, dir, fromMs: T - 1, toMs: T + 3_600_000, limit: 2 })
    expect(r.unreadableFiles).toEqual([`2026-10/station-1-${T + 10 * 60_000}.json`])
    // 読めなかったものは数えない（返した件数は上限まで埋まる）。
    expect(r.events).toHaveLength(2)
  })

  it('安全弁: 名前から始まりを読めないファイルは必ず開き、中身の始まりで並べる', async () => {
    const dir = tempDir()
    saveMinutes(dir, 3)
    writeFileSync(join(dir, '2026-10', 'odd.json'), JSON.stringify({ ...rec('odd', T + 30 * 60_000, 1, 'pending') }))
    const r = await readEventRange({ ...ALL, dir, fromMs: T - 1, toMs: T + 3_600_000, limit: 1 })
    expect(r.events.map((e) => e.id)).toEqual(['odd'])
    expect(r.truncated).toBe(true)
    expect(r.coveredFromMs).toBe(T + 30 * 60_000 - 1)
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
