import { describe, expect, it } from 'vitest'

import type { ArchivedWaveChunk } from '../receiver/waveArchive'
import type { P2pReferenceQuake } from './p2pQuake'
import type { ObserverPoint } from './quakeMatch'
import { Redetector, archiveChunks, emptyArchiveReadTally } from './redetect'
import type { HourRead, RedetectChunk } from './redetect'
import type { ShakeSensorRef } from './shakeEvent'
import type { ShakeEventRecord } from './shakeEvent'

const FS = 100
const DT = 1000 / FS
// 2026-10-03 13:24:00 JST から流し、S_AT_SEC 秒後に S 波が来る形にする（stationDetection.test.ts と同じ形）。
const T0 = Date.UTC(2026, 9, 3, 4, 24, 0)
const S_AT_SEC = 140
const OBSERVER = { lat: 35.0, lon: 135.0 }
const SENSORS = [{ boardKey: 'mac:020000000001', sensorId: 'i2c0-68' }]

// 観測点から約 82 km の架空の地震。
const QUAKE: P2pReferenceQuake = {
  originMs: Date.UTC(2026, 9, 3, 4, 26, 0),
  originPrecisionMs: 60_000,
  lat: 34.3,
  lon: 135.3,
  depthKm: 0,
  magnitude: 3.5,
  name: '架空の震央',
  maxScale: 20,
  key: 'k',
}

function gaussian(seed: number): () => number {
  let s = seed >>> 0
  const uniform = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s + 1) / 4294967297
  }
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
}

/** 観測点の合成波形（雑音 ＋ S_AT_SEC から 6 秒の 7 Hz）を 0.3 秒ずつ。 */
function waves(totalSec: number): RedetectChunk[] {
  const g = gaussian(5)
  const out: RedetectChunk[] = []
  for (let i0 = 0; i0 < totalSec * FS; i0 += 30) {
    const gal: [Float32Array, Float32Array, Float32Array] = [new Float32Array(30), new Float32Array(30), new Float32Array(30)]
    for (let k = 0; k < 30; k++) {
      const t = (i0 + k) / FS
      const on = t >= S_AT_SEC && t < S_AT_SEC + 6
      const ph = 2 * Math.PI * 7 * (t - S_AT_SEC)
      gal[0][k] = 0.5 * g() + (on ? 1.5 * Math.sin(ph) : 0)
      gal[1][k] = 0.5 * g() + (on ? 1.5 * Math.cos(ph) : 0)
      gal[2][k] = 0.5 * g() + (on ? 0.7 * Math.sin(ph + 1) : 0)
    }
    out.push({ firstSampleMs: T0 + i0 * DT, msPerSample: DT, gal })
  }
  return out
}

const WALL_NOW = Date.UTC(2026, 9, 7, 6, 0, 0)

function run(options: {
  readonly quakes?: readonly P2pReferenceQuake[]
  readonly covered?: boolean
  readonly existing?: ReadonlySet<string>
  readonly totalSec?: number
  readonly recordFromMs?: number
  readonly observerAt?: (atMs: number) => ObserverPoint | null
  readonly sensorsAt?: (atMs: number) => readonly ShakeSensorRef[]
}) {
  const saved: ShakeEventRecord[] = []
  const r = new Redetector({
    stationId: 'station-1',
    observerAt: options.observerAt ?? (() => OBSERVER),
    sensorsAt: options.sensorsAt ?? (() => SENSORS),
    quakes: options.quakes ?? [QUAKE],
    quakesCovered: () => options.covered ?? true,
    exists: (rec) => options.existing?.has(rec.id) ?? false,
    recordFromMs: options.recordFromMs,
    save: (rec) => {
      saved.push(rec)
      return true
    },
    wallNow: () => WALL_NOW,
  })
  for (const c of waves(options.totalSec ?? 200)) r.push(c)
  const summary = r.finish()
  const latest = new Map<string, ShakeEventRecord>()
  for (const rec of saved) latest.set(rec.id, rec)
  return { saved, latest: [...latest.values()], summary }
}

describe('Redetector — 控えの波形を流し直して揺れの記録を起こす', () => {
  it('正: 揺れが切れ、時刻の合う地震があれば「地震」の版まで書く', () => {
    const { latest, summary } = run({})
    expect(latest).toHaveLength(1)
    expect(latest[0].verdict).toBe('quake')
    expect(latest[0].matchedQuake?.name).toBe('架空の震央')
    expect(summary.shakes).toBe(1)
    expect(summary.written).toBe(1)
  })

  it('正: 地震一覧を取りきれていて合う地震が無ければ、揺れ方で決める', () => {
    const { latest } = run({ quakes: [] })
    expect(latest).toHaveLength(1)
    expect(['quake-like', 'local-like']).toContain(latest[0].verdict)
    expect(latest[0].verdict).toBe(latest[0].shakeClass)
  })

  it('対照: 地震一覧を取りきれていない範囲の、合わない揺れは「照合できず」', () => {
    const { latest } = run({ quakes: [], covered: false })
    expect(latest[0].verdict).toBe('unchecked')
  })

  it('正: 途中の版も含め、最後は照合待ちのまま残さない（範囲の末尾で閉じた揺れも期限まで進める）', () => {
    // 揺れが閉じてすぐ範囲が終わる（15 分の期限まで波形が無い）。
    const { latest } = run({ quakes: [], totalSec: 160 })
    expect(latest).toHaveLength(1)
    expect(latest[0].verdict).not.toBe('pending')
  })

  it('安全弁: 既に記録がある揺れは、版を 1 つも書かない（ライブの記録を優先する）', () => {
    const first = run({})
    const id = first.latest[0].id
    const { saved, summary } = run({ existing: new Set([id]) })
    expect(saved).toHaveLength(0)
    expect(summary.skippedExisting).toBe(1)
    expect(summary.written).toBe(0)
  })

  it('正: 計測震度相当を、ライブと同じく合成波形から出して記録へ入れる', () => {
    const { latest } = run({})
    expect(latest[0].maxIntensity).not.toBeNull()
    expect(Number.isFinite(latest[0].maxIntensity)).toBe(true)
  })

  it('正: 書いた時刻は、波形の時刻ではなく実際に書いた時刻', () => {
    const { saved } = run({})
    for (const rec of saved) expect(rec.writtenAtMs).toBe(WALL_NOW)
  })

  it('安全弁: 助走の間（範囲の頭より前）に始まった揺れは記録しない', () => {
    const { saved, summary } = run({ recordFromMs: T0 + (S_AT_SEC + 30) * 1000 })
    expect(saved).toHaveLength(0)
    expect(summary.beforeRange).toBe(1)
  })

  it('対照: 範囲の頭が揺れより前なら記録する', () => {
    const { latest } = run({ recordFromMs: T0 + (S_AT_SEC - 30) * 1000 })
    expect(latest).toHaveLength(1)
  })

  it('安全弁: id はライブと同じ規則（観測点と始まりの時刻）', () => {
    const { latest } = run({})
    expect(latest[0].id).toBe(`station-1-${latest[0].startMs.toFixed(0)}`)
  })

  it('正: センサーの顔ぶれは、揺れの始まりの時刻の設定から引く', () => {
    const asked: number[] = []
    const { latest } = run({
      sensorsAt: (atMs) => {
        asked.push(atMs)
        return [{ boardKey: 'mac:020000000009', sensorId: 'i2c1-68' }]
      },
    })
    expect(asked).toEqual([latest[0].startMs])
    expect(latest[0].sensors).toEqual([{ boardKey: 'mac:020000000009', sensorId: 'i2c1-68' }])
  })

  it('対照: その時刻に観測点の位置が無ければ、時刻の合う地震があっても照合しない', () => {
    const { latest } = run({ observerAt: () => null })
    expect(latest[0].verdict).not.toBe('quake')
  })

  it('安全弁: 途中で投げても流し直しを止めず、数えて返す', () => {
    const { saved, summary } = run({
      sensorsAt: () => {
        throw new Error('設定が読めない')
      },
    })
    expect(saved).toHaveLength(0)
    expect(summary.failures).toBe(1)
    expect(summary.lastFailure).toContain('設定が読めない')
  })
})

describe('archiveChunks — 控えから時刻順に重なりなく出す', () => {
  const H = 3_600_000
  // 2026-10-03 13:00 JST
  const H0 = Date.UTC(2026, 9, 3, 4, 0, 0)

  function chunk(firstSampleMs: number, n = 30): ArchivedWaveChunk {
    const z = new Float32Array(n)
    return { firstSampleMs, msPerSample: DT, gal: [z, z, z], dcGal: [0, 0, 0], memberCount: new Uint8Array(n) }
  }

  /** 時ごとのファイル。無い時は `missing`、`failed` に入れた時は開けない、`skipped` は末尾を打ち切ったバイト数。 */
  function reader(
    byHour: Map<number, ArchivedWaveChunk[]>,
    opts: { readonly failed?: ReadonlySet<number>; readonly skipped?: ReadonlyMap<number, number> } = {},
  ) {
    return async (h: number): Promise<HourRead> => {
      if (opts.failed?.has(h)) return { kind: 'failed', error: 'EACCES' }
      const chunks = byHour.get(h)
      if (chunks === undefined) return { kind: 'missing' }
      return { kind: 'read', chunks, skippedBytes: opts.skipped?.get(h) ?? 0 }
    }
  }

  async function collect(readHour: ReturnType<typeof reader>, fromMs: number, toMs: number, openHourFromMs?: number) {
    const tally = emptyArchiveReadTally()
    const out: RedetectChunk[] = []
    for await (const c of archiveChunks({ readHour, fromMs, toMs, tally, openHourFromMs })) out.push(c)
    return { out, tally }
  }

  it('正: 時の境目を跨いだまとまりは、頭の属する時のファイルから 1 度だけ出す', async () => {
    const straddle = chunk(H0 + H - 100)
    const byHour = new Map([
      [H0, [chunk(H0), straddle]],
      [H0 + H, [chunk(H0 + H + 200)]],
    ])
    const { out, tally } = await collect(reader(byHour), H0, H0 + 2 * H - 1)
    expect(out.map((c) => c.firstSampleMs)).toEqual([H0, H0 + H - 100, H0 + H + 200])
    expect(tally.overlapped).toBe(0)
  })

  it('安全弁: 同じ区間が 2 度書かれていたら、前のまとまりの末尾より前に始まる方を捨てて数える', async () => {
    // 後から書き足された分（ファイルの後ろ）も、並べ直してから重なりを見る。
    const byHour = new Map([[H0, [chunk(H0), chunk(H0 + 300), chunk(H0 + 100)]]])
    const { out, tally } = await collect(reader(byHour), H0, H0 + H - 1)
    expect(out.map((c) => c.firstSampleMs)).toEqual([H0, H0 + 300])
    expect(tally.overlapped).toBe(1)
  })

  it('正: 無かった・開けなかった・途中で打ち切った時を分けて数える（「無かった」と「読めなかった」を分ける）', async () => {
    const byHour = new Map([
      [H0, [chunk(H0)]],
      [H0 + 2 * H, [chunk(H0 + 2 * H)]],
    ])
    const { tally } = await collect(
      reader(byHour, { failed: new Set([H0 + H]), skipped: new Map([[H0 + 2 * H, 64]]) }),
      H0,
      H0 + 4 * H - 1,
    )
    expect(tally.hours).toBe(4)
    expect(tally.hoursMissing).toBe(1)
    expect(tally.hoursFailed).toBe(1)
    expect(tally.lastFailure).toBe('EACCES')
    expect(tally.hoursTruncated).toBe(1)
    expect(tally.skippedBytes).toBe(64)
  })

  it('対照: いま書いている時の末尾の打ち切りは数えない', async () => {
    const byHour = new Map([[H0, [chunk(H0)]]])
    const { tally } = await collect(reader(byHour, { skipped: new Map([[H0, 64]]) }), H0, H0 + H - 1, H0)
    expect(tally.hoursTruncated).toBe(0)
    expect(tally.skippedBytes).toBe(0)
  })

  it('対照: 範囲の外のまとまりは出さない', async () => {
    const byHour = new Map([[H0, [chunk(H0), chunk(H0 + 10 * 60_000), chunk(H0 + 50 * 60_000)]]])
    const { out } = await collect(reader(byHour), H0 + 5 * 60_000, H0 + 20 * 60_000)
    expect(out.map((c) => c.firstSampleMs)).toEqual([H0 + 10 * 60_000])
  })
})
