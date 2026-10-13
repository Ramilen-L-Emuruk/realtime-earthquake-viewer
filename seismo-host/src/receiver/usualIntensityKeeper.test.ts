import { describe, expect, it } from 'vitest'

import { calcSeismicIntensity } from '../../../src/utils/knet/seismicIntensity'
import { usualWindows } from './quakeIntensity'
import { USUAL_STATUS_WINDOW_MS, UsualIntensityKeeper } from './usualIntensityKeeper'
import type { ArchivedWaveChunk, WaveRangeResult } from './waveArchive'

const NOW = Date.parse('2026-10-13T12:00:00+09:00')
const MS = 10 // 100 Hz

/** 振幅 `amp` gal の 3 成分の波形を `startMs` から `lenMs` ぶん、0.3 秒ずつのまとまりで作る。 */
function chunksOf(startMs: number, lenMs: number, amp: number): ArchivedWaveChunk[] {
  const n = lenMs / MS
  const axes: number[][] = [[], [], []]
  for (let i = 0; i < n; i++) {
    const t = i / 100
    axes[0].push(amp * Math.sin(2 * Math.PI * 2 * t))
    axes[1].push(amp * Math.sin(2 * Math.PI * 3 * t + 1))
    axes[2].push(0.5 * amp * Math.sin(2 * Math.PI * 5 * t + 2))
  }
  const out: ArchivedWaveChunk[] = []
  for (let i = 0; i < n; i += 30) {
    const k = Math.min(30, n - i)
    out.push({
      firstSampleMs: startMs + i * MS,
      msPerSample: MS,
      gal: [
        Float32Array.from(axes[0].slice(i, i + k)),
        Float32Array.from(axes[1].slice(i, i + k)),
        Float32Array.from(axes[2].slice(i, i + k)),
      ],
      dcGal: [0, 0, 980],
      memberCount: new Uint8Array(k).fill(3),
      revised: false,
    })
  }
  return out
}

/** 「普段」の 6 区間すべてに振幅 `amp` の波形を置いた記録。 */
function archiveOf(nowMs: number, amp: number): ArchivedWaveChunk[] {
  return usualWindows(nowMs, nowMs + USUAL_STATUS_WINDOW_MS).flatMap((w) => chunksOf(w.fromMs, w.toMs - w.fromMs, amp))
}

function result(chunks: readonly ArchivedWaveChunk[]): WaveRangeResult {
  return { chunks, filesRead: 1, filesMissing: 0, filesFailed: 0, skippedBytes: 0, truncated: false }
}

const quietMeasured = (amp: number): number => {
  const c = chunksOf(0, USUAL_STATUS_WINDOW_MS, amp)
  const join = (k: 0 | 1 | 2): number[] => c.flatMap((x) => Array.from(x.gal[k]))
  return calcSeismicIntensity(join(0), join(1), join(2), 100)!
}

const noYield = async (): Promise<void> => {}

describe('UsualIntensityKeeper', () => {
  // 正: 直前 1 時間の、アプリの地震カードと同じ長さの区間で測った値を観測点ごとに出す。
  it('観測点ごとに直前 1 時間の普段の計測震度を出す', async () => {
    const asked: { stationId: string; fromMs: number; toMs: number }[] = []
    const keeper = new UsualIntensityKeeper({
      stationIds: () => ['station-1', 'station-2'],
      readWaves: async (p) => {
        asked.push(p)
        return result(archiveOf(NOW, p.stationId === 'station-1' ? 0.5 : 2))
      },
      onWindow: noYield,
      log: () => {},
    })
    await keeper.refresh(NOW)
    const snap = keeper.snapshot()
    expect(snap.map((s) => s.stationId)).toEqual(['station-1', 'station-2'])
    expect(snap[0].usualMeasured).toBeCloseTo(quietMeasured(0.5), 6)
    expect(snap[1].usualMeasured).toBeCloseTo(quietMeasured(2), 6)
    expect(snap[0]).toMatchObject({ windowMs: USUAL_STATUS_WINDOW_MS, computedAtMs: NOW, usualUsedCount: 6, usualWindowCount: 6 })
    // 読む範囲は直前 1 時間（いまで終わる）。
    expect(asked[0]).toEqual({ stationId: 'station-1', fromMs: NOW - 60 * 60_000, toMs: NOW })
  })

  // 対照: まだ測っていない観測点も一覧に載り、値と時刻は null（0 で埋めない）。
  it('測る前の観測点は値も時刻も null で載せる', () => {
    const keeper = new UsualIntensityKeeper({
      stationIds: () => ['station-1'],
      readWaves: async () => result([]),
      onWindow: noYield,
      log: () => {},
    })
    expect(keeper.snapshot()).toEqual([
      { stationId: 'station-1', usualMeasured: null, usualWindowCount: 0, usualUsedCount: 0, windowMs: USUAL_STATUS_WINDOW_MS, computedAtMs: null },
    ])
  })

  // 安全弁: 記録が足りなければ「普段」を名乗らない（アプリは下限を置かずに出す側へ倒す）。
  it('記録が足りなければ null', async () => {
    const keeper = new UsualIntensityKeeper({
      stationIds: () => ['station-1'],
      readWaves: async () => result([]),
      onWindow: noYield,
      log: () => {},
    })
    await keeper.refresh(NOW)
    expect(keeper.snapshot()[0]).toMatchObject({ usualMeasured: null, usualUsedCount: 0, computedAtMs: NOW })
  })

  // 安全弁: 読めなくなったら古い値を残さない（止まった値を「いまの普段」と名乗らない）。
  it('読み返しに失敗したら前の値を捨てて記録を残す', async () => {
    let fail = false
    const logs: string[] = []
    const keeper = new UsualIntensityKeeper({
      stationIds: () => ['station-1'],
      readWaves: async () => {
        if (fail) throw new Error('disk gone')
        return result(archiveOf(NOW, 0.5))
      },
      onWindow: noYield,
      log: (_level, _kind, _detail, line) => logs.push(line),
    })
    await keeper.refresh(NOW)
    expect(keeper.snapshot()[0].usualMeasured).not.toBeNull()
    fail = true
    await keeper.refresh(NOW + 600_000)
    expect(keeper.snapshot()[0]).toMatchObject({ usualMeasured: null, computedAtMs: NOW + 600_000 })
    expect(logs.some((l) => l.includes('disk gone'))).toBe(true)
  })

  it('設定から外した観測点は一覧から消える', async () => {
    let ids = ['station-1', 'station-2']
    const keeper = new UsualIntensityKeeper({
      stationIds: () => ids,
      readWaves: async () => result(archiveOf(NOW, 0.5)),
      onWindow: noYield,
      log: () => {},
    })
    await keeper.refresh(NOW)
    ids = ['station-2']
    expect(keeper.snapshot().map((s) => s.stationId)).toEqual(['station-2'])
  })

  // 安全弁: 前の回が終わる前に呼ばれても重ねて走らせない（1 時間ぶんの読み返しを並べない）。
  it('前の回が終わるまで次の回を始めない', async () => {
    let reads = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const keeper = new UsualIntensityKeeper({
      stationIds: () => ['station-1'],
      readWaves: async () => {
        reads += 1
        await gate
        return result([])
      },
      onWindow: noYield,
      log: () => {},
    })
    const first = keeper.refresh(NOW)
    const second = keeper.refresh(NOW + 1)
    release()
    await Promise.all([first, second])
    expect(reads).toBe(1)
  })

  // 安全弁: 読み返し・計算の外で投げても、refresh は拒否しない（呼び出し側は void で捨てる）。
  it('設定の読み取りが投げても拒否せず記録へ残す', async () => {
    const logs: string[] = []
    const keeper = new UsualIntensityKeeper({
      stationIds: () => {
        throw new Error('設定が壊れている')
      },
      readWaves: async () => result([]),
      onWindow: noYield,
      log: (_level, kind) => logs.push(kind),
    })
    await expect(keeper.refresh(NOW)).resolves.toBeUndefined()
    expect(logs).toEqual(['usual-intensity-refresh'])
  })

  // 安全弁: 前の回が終わらないまま長く経ったら記録へ残す（黙って止まらない）。
  it('測り直しが終わらないまま間隔の 3 倍を過ぎたら記録へ残す', async () => {
    const logs: string[] = []
    const keeper = new UsualIntensityKeeper({
      stationIds: () => ['station-1'],
      readWaves: () => new Promise<WaveRangeResult>(() => {}),
      onWindow: noYield,
      log: (_level, kind) => logs.push(kind),
    })
    void keeper.refresh(NOW)
    void keeper.refresh(NOW + 10 * 60_000)
    expect(logs).toEqual([])
    void keeper.refresh(NOW + 31 * 60_000)
    expect(logs).toEqual(['usual-intensity-stuck'])
  })

  // 正: 値があったのに読めなくなったら記録へ残す。対照: 最初から読めないなら残さない。
  it('普段が読めなくなったときだけ記録へ残す', async () => {
    const logs: string[] = []
    let chunks = archiveOf(NOW, 1)
    const keeper = new UsualIntensityKeeper({
      stationIds: () => ['station-1'],
      readWaves: async () => result(chunks),
      onWindow: noYield,
      log: (_level, kind) => logs.push(kind),
    })
    chunks = []
    await keeper.refresh(NOW)
    expect(logs).toEqual([])
    chunks = archiveOf(NOW, 1)
    await keeper.refresh(NOW)
    chunks = []
    await keeper.refresh(NOW)
    expect(logs).toEqual(['usual-intensity-lost'])
  })
})
