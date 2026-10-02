import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HostLifeMark, buildPreviousRunLines, parseLifeMark } from './hostLifeMark'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seismo-life-'))
  path = join(dir, 'host-running.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// 2026-10-02 11:30:00 JST と 13:41:00 JST。
const STARTED = Date.UTC(2026, 9, 2, 2, 30, 0)
const ALIVE = Date.UTC(2026, 9, 2, 4, 41, 0)

describe('parseLifeMark', () => {
  it('書いた形を読み戻せる', () => {
    expect(parseLifeMark(JSON.stringify({ pid: 12, startedAtMs: STARTED, lastAliveMs: ALIVE }))).toEqual({
      pid: 12,
      startedAtMs: STARTED,
      lastAliveMs: ALIVE,
    })
  })

  it('壊れた中身・欠けた欄・数でない値は読めないとして null を返す', () => {
    expect(parseLifeMark('{')).toBeNull()
    expect(parseLifeMark(JSON.stringify({ pid: 12, startedAtMs: STARTED }))).toBeNull()
    expect(parseLifeMark(JSON.stringify({ pid: 12, startedAtMs: 'x', lastAliveMs: ALIVE }))).toBeNull()
    expect(parseLifeMark('null')).toBeNull()
  })
})

describe('buildPreviousRunLines', () => {
  it('前回の印が無ければ何も言わない（前回は正常に終わっている）', () => {
    expect(buildPreviousRunLines({ kind: 'none' })).toEqual([])
  })

  it('前回の印が残っていたら、終了の記録が無いまま止まったと、起動と最後に生きていた時刻を添えて言う', () => {
    const lines = buildPreviousRunLines({
      kind: 'unclean',
      mark: { pid: 12, startedAtMs: STARTED, lastAliveMs: ALIVE },
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[host]')
    expect(lines[0]).toContain('2026-10-02 11:30:00')
    expect(lines[0]).toContain('2026-10-02 13:41:00')
  })

  it('印を読めなかったときは、正常に終わったかが分からないと言う（黙らない）', () => {
    const lines = buildPreviousRunLines({ kind: 'unreadable', detail: 'Unexpected end of JSON input' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('分からない')
  })
})

describe('HostLifeMark', () => {
  it('印が無いところから始めると前回は none で、今回の印を書く', async () => {
    const mark = new HostLifeMark(path)
    const begun = await mark.begin(42, STARTED)
    expect(begun.previous).toEqual({ kind: 'none' })
    expect(begun.error).toBeNull()
    expect(parseLifeMark(readFileSync(path, 'utf8'))).toEqual({ pid: 42, startedAtMs: STARTED, lastAliveMs: STARTED })
  })

  it('前回の印が残っていれば unclean として返し、今回の印で上書きする', async () => {
    writeFileSync(path, JSON.stringify({ pid: 7, startedAtMs: STARTED, lastAliveMs: ALIVE }))
    const mark = new HostLifeMark(path)
    const begun = await mark.begin(42, ALIVE + 60_000)
    expect(begun.previous).toEqual({ kind: 'unclean', mark: { pid: 7, startedAtMs: STARTED, lastAliveMs: ALIVE } })
    expect(parseLifeMark(readFileSync(path, 'utf8'))?.pid).toBe(42)
  })

  it('前回の印が壊れていれば unreadable として返し、今回の印は書く', async () => {
    writeFileSync(path, '{"pid":')
    const mark = new HostLifeMark(path)
    const begun = await mark.begin(42, STARTED)
    expect(begun.previous.kind).toBe('unreadable')
    expect(parseLifeMark(readFileSync(path, 'utf8'))?.pid).toBe(42)
  })

  it('生きている合図で最後に生きていた時刻だけを進める（起動の時刻は変えない）', async () => {
    const mark = new HostLifeMark(path)
    await mark.begin(42, STARTED)
    expect(await mark.heartbeat(ALIVE)).toBeNull()
    expect(parseLifeMark(readFileSync(path, 'utf8'))).toEqual({ pid: 42, startedAtMs: STARTED, lastAliveMs: ALIVE })
  })

  it('正常に終わったら印を消す（次の起動は none になる）', async () => {
    const mark = new HostLifeMark(path)
    await mark.begin(42, STARTED)
    expect(await mark.end()).toBeNull()
    expect(existsSync(path)).toBe(false)
    expect((await new HostLifeMark(path).begin(43, ALIVE)).previous).toEqual({ kind: 'none' })
  })

  it('置き場所のディレクトリがまだ無くても作って書く（初めて起動する機械）', async () => {
    // **`data/` は保存の部品が後から作る。** 印はそれより先に書くので、自分で作らないと
    // 新しく置いた機械の最初の起動で印が残らない（作業 PC で実際にそうなった）。
    const nested = join(dir, 'data', 'host-running.json')
    const mark = new HostLifeMark(nested)
    const begun = await mark.begin(42, STARTED)
    expect(begun.error).toBeNull()
    expect(parseLifeMark(readFileSync(nested, 'utf8'))?.pid).toBe(42)
  })

  it('置き場所に書けなくても投げず、理由を返す（印が無いだけで受信は続ける）', async () => {
    // **ディレクトリを印の置き場所に指定して、書き込みを確実に失敗させる。**
    const mark = new HostLifeMark(dir)
    const begun = await mark.begin(42, STARTED)
    expect(begun.error).not.toBeNull()
    expect(await mark.heartbeat(ALIVE)).not.toBeNull()
  })

  it('始める前の合図と終わりは何もしない（呼ぶ順を取り違えても印を作らない）', async () => {
    const mark = new HostLifeMark(path)
    expect(await mark.heartbeat(ALIVE)).toBeNull()
    expect(await mark.end()).toBeNull()
    expect(existsSync(path)).toBe(false)
  })
})
