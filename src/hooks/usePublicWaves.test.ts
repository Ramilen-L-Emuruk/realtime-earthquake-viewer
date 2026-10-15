// @vitest-environment jsdom
//
// 公開観測点の下部の波形のフック（`docs/public-waveform-design.md` §5.1・§5.2）。**固定するのは結線** ——
// 揺れの材料から観測点を選んで出すこと・余韻のあいだは出したままにすること・出すときだけ繋ぐ要求を出すこと・
// 再生中（`enabled` が偽）は繋ぐ係そのものを作らないこと。選び方の中身は `publicStationSelection.test.ts`、
// 繋ぎ方は `publicWaveShare.test.ts` が持つ。表は本物（`public/data/public-stations.json`）を使う。
import { readFileSync } from 'node:fs'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EEWAlert } from '../types/earthquake'
import type { PublicStationsFile } from '../utils/publicStations'
import { setReplayOffset } from '../utils/clock'
import { strongestDetection, usePublicWaves } from './usePublicWaves'

const file = JSON.parse(readFileSync('public/data/public-stations.json', 'utf8')) as PublicStationsFile

const h = vi.hoisted(() => ({
  shares: [] as { needs: { active: boolean; spanSec: number; stations: readonly string[] }[]; disposed: boolean }[],
  archive: [] as { stations: readonly string[]; range: { fromMs: number; toMs: number } }[],
}))

vi.mock('../services/publicWaveArchive', () => ({
  fetchPublicWaveArchive: (p: { stations: readonly string[]; range: { fromMs: number; toMs: number } }) => {
    h.archive.push({ stations: p.stations, range: p.range })
    return Promise.resolve({ kind: 'no-data' })
  },
}))

vi.mock('../utils/publicStations', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../utils/publicStations')>()
  return { ...orig,
  checkPublicStations: () => Promise.resolve(null), loadPublicStations: () => Promise.resolve(file) }
})

vi.mock('../services/publicWaveShare', () => ({
  PublicWaveShare: class {
    readonly rec = { needs: [] as { active: boolean; spanSec: number; stations: readonly string[] }[], disposed: false }
    constructor() {
      h.shares.push(this.rec)
    }
    setNeed(active: boolean, spanSec: number, stations: readonly string[]) {
      this.rec.needs.push({ active, spanSec, stations })
    }
    isLeader() {
      return true
    }
    dispose() {
      this.rec.disposed = true
    }
  },
}))

/** 宮城県沖の M6.5（JMM 宮城丸森が選ばれる）。 */
const eew = {
  earthquake: {
    hypocenter: { latitude: 38.3, longitude: 142.0, depth: 40, magnitude: 6.5 },
    condition: undefined,
    originTime: new Date().toISOString(),
  },
} as unknown as EEWAlert

type Params = Parameters<typeof usePublicWaves>[0]
const base: Params = { enabled: true, replayOffsetMs: null, spanSec: 120, alwaysConnected: false, eew: null, detectedPoints: [] }

async function mount(initial: Params) {
  const r = renderHook((p: Params) => usePublicWaves(p), { initialProps: initial })
  // 表の読み込み（Promise）を流す。
  await act(async () => {})
  return r
}

const lastNeed = () => {
  const share = h.shares[h.shares.length - 1]
  return share.needs[share.needs.length - 1]
}

describe('strongestDetection', () => {
  // 正: 震度1 以上の点のうちいちばん強い点を返す。
  // 安全弁: 震度0 だけの検知は材料にしない（2026-10-15 ユーザー承認「震度 1 以上の検知だけ（推奨）」）。
  it('震度0 の点は見ず、震度1 以上でいちばん強い点を返す', () => {
    const p = (key: string, index: number, lat: number) => ({ key, lat, lng: 140, index })
    // index 6 = 計測震度 0.0（震度0）・index 8 = 1.0（震度1）・index 10 = 2.0（震度2）
    expect(strongestDetection([p('a', 6, 35)])).toBeNull()
    expect(strongestDetection([p('a', 6, 35), p('b', 8, 36), p('c', 10, 37)])).toEqual({ lat: 37, lon: 140 })
  })
})

describe('usePublicWaves', () => {
  beforeEach(() => {
    h.shares.length = 0
    h.archive.length = 0
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  // 対照: 揺れていなければ出さず、繋がない。
  it('揺れていなければ出さず、繋ぐ要求も出さない', async () => {
    const r = await mount(base)
    expect(r.result.current.visible).toBe(false)
    expect(lastNeed()?.active ?? false).toBe(false)
  })

  // 正: 緊急地震速報があれば観測点を選んで出し、運用中の全点を載せて繋ぐ。
  it('緊急地震速報で観測点を選んで出し、全点を載せて繋ぐ', async () => {
    const r = await mount({ ...base, eew })
    expect(r.result.current.visible).toBe(true)
    expect(r.result.current.stations[0]).toMatchObject({ code: 'JMM', number: 1, stale: true })
    const need = lastNeed()
    expect(need.active).toBe(true)
    expect(need.spanSec).toBe(120)
    expect(need.stations.length).toBeGreaterThanOrEqual(r.result.current.stations.length)
  })

  // 正: 揺れの材料が消えても余韻のあいだは出したまま。明けたら引っ込め、繋ぐのもやめる。
  it('余韻のあいだは出し、明けたら引っ込めて繋ぐのをやめる', async () => {
    const r = await mount({ ...base, eew })
    r.rerender({ ...base, eew: null })
    await act(async () => {
      vi.advanceTimersByTime(59_000)
    })
    expect(r.result.current.visible).toBe(true)
    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })
    expect(r.result.current.visible).toBe(false)
    expect(r.result.current.stations).toHaveLength(0)
    expect(lastNeed().active).toBe(false)
  })

  // 正: 常時接続の設定なら、揺れていなくても繋ぐ（出しはしない）。
  it('常時接続なら揺れていなくても繋ぐ', async () => {
    const r = await mount({ ...base, alwaysConnected: true })
    expect(r.result.current.visible).toBe(false)
    expect(lastNeed().active).toBe(true)
  })

  // 安全弁: 再生中（使えない）は繋ぐ係を作らず、揺れていても出さない。
  it('使えないときは繋ぐ係を作らず、出さない', async () => {
    const r = await mount({ ...base, enabled: false, eew, alwaysConnected: true })
    expect(h.shares).toHaveLength(0)
    expect(r.result.current.visible).toBe(false)
  })

  // 安全弁: 使えなくなったら（再生を始めた）繋ぐ係を片付ける。
  it('使えなくなったら繋ぐ係を片付ける', async () => {
    const r = await mount({ ...base, eew })
    r.rerender({ ...base, eew, enabled: false })
    expect(h.shares[0].disposed).toBe(true)
    expect(r.result.current.visible).toBe(false)
  })

  // 正: 再生中は SeedLink の係を作らず、出しているときは再生時刻の分を保存庫から取る（表示の幅ぶん遡る）。
  it('再生中は保存庫から再生時刻の分を取る', async () => {
    const offset = -3 * 3_600_000
    setReplayOffset(offset)
    const r = await mount({ ...base, replayOffsetMs: offset, eew })
    expect(h.shares).toHaveLength(0)
    expect(r.result.current.visible).toBe(true)
    expect(h.archive).toHaveLength(1)
    const replayNow = Date.now() + offset
    expect(h.archive[0].range.fromMs).toBeLessThanOrEqual(replayNow - 120_000)
    expect(h.archive[0].range.toMs).toBeGreaterThan(replayNow)
    expect(h.archive[0].stations.length).toBeGreaterThan(0)
  })

  it('再生時刻を変えても、同じ速報の観測点を新しい時間軸で直ちに選び直す', async () => {
    const offset = -3 * 3_600_000
    setReplayOffset(offset)
    const r = await mount({ ...base, replayOffsetMs: offset, eew })
    expect(r.result.current.visible).toBe(true)
    const first = r.result.current.stations.map(s => ({ code: s.code, number: s.number }))
    const next = offset - 10_000
    setReplayOffset(next)
    r.rerender({ ...base, replayOffsetMs: next, eew })
    await act(async () => {})
    expect(r.result.current.visible).toBe(true)
    expect(r.result.current.stations.map(s => ({ code: s.code, number: s.number }))).toEqual(first)
    expect(h.archive.length).toBeGreaterThan(1)
    // 材料が消えた別の時間軸には、前の選択・余韻を持ち越さない。
    setReplayOffset(next - 10_000)
    r.rerender({ ...base, replayOffsetMs: next - 10_000, eew: null })
    await act(async () => {})
    expect(r.result.current.visible).toBe(false)
    expect(r.result.current.stations).toHaveLength(0)
  })

  // 対照: 再生中でも、出していなくて常時接続もオフなら取りに行かない。
  it('再生中でも出していなければ取りに行かない', async () => {
    const offset = -3 * 3_600_000
    setReplayOffset(offset)
    await mount({ ...base, replayOffsetMs: offset })
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect(h.archive).toHaveLength(0)
  })
})
