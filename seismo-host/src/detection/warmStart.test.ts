import { afterEach, describe, expect, it, vi } from 'vitest'

import { jstHourStartMs } from '../receiver/jstTime'
import type { FusedWaveChunk } from '../receiver/sensorFusion'
import type { StationConfig } from '../receiver/stationConfig'
import type { ArchivedWaveChunk } from '../receiver/waveArchive'
import type { HourRead, HourReader } from './redetect'
import type { ShakeEventRecord } from './shakeEvent'
import { StationDetection } from './stationDetection'
import { WARM_JOB_TIMEOUT_MS, WARM_MAX_HOLD_MS, WARM_MIN_HOLD_MS, WarmStarter, findBoundary } from './warmStart'

const FS = 100
const DT = 1000 / FS
const T0 = Date.UTC(2026, 9, 3, 4, 24, 0)
const S_AT_SEC = 140
const HOUR = 3_600_000
const at = (sec: number): number => T0 + sec * 1000

const CONFIG: StationConfig = {
  stations: [{ stationId: 'station-1', displayName: '自宅', lat: 35.0, lon: 135.0 }],
  boards: [
    {
      boardKey: 'mac:020000000001',
      stationId: 'station-1',
      sensors: [{ sensorId: 'i2c0-68', enabled: true, rotation: null, offset: null, sensitivity: null, noiseDensity: null }],
    },
  ],
} as unknown as StationConfig

function gaussian(seed: number): () => number {
  let s = seed >>> 0
  const uniform = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s + 1) / 4294967297
  }
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
}

/** 観測点の合成波形（雑音 ＋ `S_AT_SEC` から 6 秒の 7 Hz）を 0.3 秒ずつ。`offsetMs` だけ時刻をずらす。 */
function waves(totalSec: number, offsetMs = 0): FusedWaveChunk[] {
  const g = gaussian(5)
  const out: FusedWaveChunk[] = []
  for (let i0 = 0; i0 < totalSec * FS; i0 += 30) {
    const gal: [number[], number[], number[]] = [[], [], []]
    for (let i = i0; i < i0 + 30; i++) {
      const t = i / FS
      const on = t >= S_AT_SEC && t < S_AT_SEC + 6
      const ph = 2 * Math.PI * 7 * (t - S_AT_SEC)
      gal[0].push(0.5 * g() + (on ? 1.5 * Math.sin(ph) : 0))
      gal[1].push(0.5 * g() + (on ? 1.5 * Math.cos(ph) : 0))
      gal[2].push(0.5 * g() + (on ? 0.7 * Math.sin(ph + 1) : 0))
    }
    out.push({
      stationId: 'station-1',
      firstSampleIndex: i0,
      firstSampleMs: T0 + offsetMs + i0 * DT,
      msPerSample: DT,
      gal,
      dcGal: [[], [], []],
      memberCount: Array(30).fill(9),
      axisMemberCount: [Array(30).fill(9), Array(30).fill(9), Array(30).fill(9)],
    })
  }
  return out
}

const ALL = waves(300)
const span = (chunks: readonly FusedWaveChunk[], fromSec: number, toSec: number): FusedWaveChunk[] =>
  chunks.filter((c) => c.firstSampleMs >= at(fromSec) && c.firstSampleMs < at(toSec))

/** 控えに残っている形へ（作り直した分なら `revised`）。 */
function archived(chunks: readonly FusedWaveChunk[], revised = false): ArchivedWaveChunk[] {
  return chunks.map((c) => ({
    firstSampleMs: c.firstSampleMs,
    msPerSample: c.msPerSample,
    gal: [Float32Array.from(c.gal[0]), Float32Array.from(c.gal[1]), Float32Array.from(c.gal[2])],
    dcGal: [0, 0, 0],
    memberCount: new Uint8Array(c.gal[0].length).fill(9),
    revised,
  }))
}

/** 控えの読み手（時ごとのファイル）。`failHours` の時は開けない。 */
function reader(chunks: readonly ArchivedWaveChunk[], failHours: ReadonlySet<number> = new Set()): HourReader & { reads: number[] } {
  const byHour = new Map<number, ArchivedWaveChunk[]>()
  for (const c of chunks) {
    const h = jstHourStartMs(c.firstSampleMs)!
    if (!byHour.has(h)) byHour.set(h, [])
    byHour.get(h)!.push(c)
  }
  const reads: number[] = []
  const fn = async (hourStartMs: number): Promise<HourRead> => {
    reads.push(hourStartMs)
    if (failHours.has(hourStartMs)) return { kind: 'failed', error: 'EIO' }
    const list = byHour.get(hourStartMs)
    return list === undefined ? { kind: 'missing' } : { kind: 'read', chunks: list, skippedBytes: 0 }
  }
  return Object.assign(fn, { reads })
}

function harness(opts: {
  archive: readonly ArchivedWaveChunk[]
  failHours?: ReadonlySet<number>
  settled?: () => boolean
  readHour?: HourReader
}) {
  let now = T0
  const saved: ShakeEventRecord[] = []
  const logs: { level: string; key: string; line: string }[] = []
  const detection = new StationDetection({
    save: (r) => saved.push(r),
    publish: () => {},
    storeStatus: () => ({ written: saved.length, writeErrors: 0, lastWriteError: null }),
    feedCovered: () => true,
    feedStatus: () => null,
    config: () => CONFIG,
    now: () => now,
    log: (level, key, line) => logs.push({ level, key, line }),
    exists: () => false,
    holdNewStations: true,
  })
  const read = reader(opts.archive, opts.failHours)
  let pauses = 0
  const starter = new WarmStarter({
    detection,
    readHour: () => opts.readHour ?? read,
    settled: opts.settled ?? (() => true),
    now: () => now,
    pause: async () => {
      pauses++
    },
    log: (level, key, line) => logs.push({ level, key, line }),
  })
  const pushLive = (chunks: readonly FusedWaveChunk[]): void => {
    for (const w of chunks) detection.pushStationWave(w)
  }
  const status = () => detection.snapshot().triggers.find((s) => s.stationId === 'station-1')!
  return {
    detection,
    starter,
    saved,
    logs,
    read,
    pushLive,
    status,
    setNow: (ms: number) => (now = ms),
    pauses: () => pauses,
  }
}

describe('findBoundary — 前のプロセスが最後にライブで受けたサンプルの時刻', () => {
  it('作り直した分（欠けを埋めた分）は数えず、ライブの分の末尾を返す', async () => {
    const live = archived(span(ALL, 0, 90))
    const revised = archived(span(ALL, 88, 150), true)
    const r = await findBoundary(reader([...live, ...revised]), at(150), 24 * HOUR)
    const last = live[live.length - 1]
    expect(r).toEqual({ kind: 'found', boundaryMs: last.firstSampleMs + 30 * DT })
  })

  it('起動してから書いたライブの分（最初のライブの時刻より後）は数えない', async () => {
    const r = await findBoundary(reader(archived(span(ALL, 0, 300))), at(150), 24 * HOUR)
    expect(r.kind).toBe('found')
    expect((r as { boundaryMs: number }).boundaryMs).toBeLessThanOrEqual(at(150))
    expect((r as { boundaryMs: number }).boundaryMs).toBeGreaterThan(at(149))
  })

  it('新しい時から 1 時間ずつ遡り、見つかった時で止める（それより古いファイルは開かない）', async () => {
    const read = reader([...archived(waves(60, -5 * HOUR)), ...archived(waves(60, -2 * HOUR))])
    const r = await findBoundary(read, at(0), 24 * HOUR)
    expect(r.kind).toBe('found')
    expect((r as { boundaryMs: number }).boundaryMs).toBeLessThan(T0 - 2 * HOUR + 61_000)
    expect(Math.min(...read.reads)).toBeGreaterThan(T0 - 4 * HOUR)
  })

  it('24 時間の中に無ければ none、開けない時に当たれば failed', async () => {
    expect(await findBoundary(reader(archived(waves(60, -30 * HOUR))), at(0), 24 * HOUR)).toEqual({ kind: 'none' })
    const failHour = jstHourStartMs(at(0))!
    expect(await findBoundary(reader(archived(span(ALL, 0, 100)), new Set([failHour])), at(150), 24 * HOUR)).toEqual({
      kind: 'failed',
      error: 'EIO',
    })
  })
})

describe('WarmStarter — 起動時に控えから流してから、溜めたライブへ繋ぐ（#617）', () => {
  /** 前のプロセスは 90 秒まで受け、90〜150 秒は欠けを取り戻して作り直した。150 秒からライブ。 */
  const restarted = () => [...archived(span(ALL, 0, 90)), ...archived(span(ALL, 88, 150), true)]

  it('正: 止まっていた間（作り直した欠け）に始まった揺れを、最大計測震度相当つきで記録する', async () => {
    const h = harness({ archive: restarted() })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 300))
    h.setNow(at(150) + WARM_MIN_HOLD_MS)
    h.starter.tick()
    await h.starter.idle()
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0].startMs).toBeGreaterThanOrEqual(at(S_AT_SEC))
    expect(h.saved[0].maxIntensity).not.toBeNull()
    const s = h.status()
    expect(s.warmStart).toMatchObject({ phase: 'live', outcome: { kind: 'warm' }, recordFromMs: at(90) - 0 })
    // 溜めたライブを流し終えている
    expect(s.lastSampleMs).toBe(at(300) - DT)
    expect(h.logs.some((l) => l.level === 'log' && l.line.includes('station-1') && l.line.includes('引き継'))).toBe(true)
  })

  it('対照: 控えに前の波形が無ければ、溜めた分を空から流す（同じ揺れは記録されない）', async () => {
    const h = harness({ archive: [] })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 300))
    h.setNow(at(150) + WARM_MIN_HOLD_MS)
    h.starter.tick()
    await h.starter.idle()
    expect(h.saved).toHaveLength(0)
    expect(h.status().warmStart).toMatchObject({ phase: 'live', outcome: { kind: 'cold', reason: 'no-archive' }, peaks: 'skipped' })
    expect(h.status().lastSampleMs).toBe(at(300) - DT)
  })

  it('待ち: 取り戻し・作り直しが片付くまで待ち、片付かなくても 60 秒で解く', async () => {
    let settled = false
    const h = harness({ archive: restarted(), settled: () => settled })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 160))
    h.setNow(at(150) + WARM_MIN_HOLD_MS + 1_000)
    h.starter.tick()
    await h.starter.idle()
    expect(h.status().warmStart!.phase).toBe('holding')
    h.setNow(at(150) + WARM_MAX_HOLD_MS)
    h.starter.tick()
    await h.starter.idle()
    expect(h.status().warmStart!.phase).toBe('live')
    settled = true
  })

  it('対照: 片付いていても、最初の波形から 5 秒は待つ（欠けが帳面へ載る前に流し始めない）', async () => {
    const h = harness({ archive: restarted() })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 160))
    h.setNow(at(150) + WARM_MIN_HOLD_MS - 1)
    h.starter.tick()
    await h.starter.idle()
    expect(h.status().warmStart!.phase).toBe('holding')
    expect(h.read.reads).toEqual([])
  })

  it('安全弁: 控えを読めなければ、溜めた分を空から流して警告を残す', async () => {
    const h = harness({ archive: restarted(), failHours: new Set([jstHourStartMs(at(150))!]) })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 300))
    h.setNow(at(150) + WARM_MIN_HOLD_MS)
    h.starter.tick()
    await h.starter.idle()
    expect(h.status().warmStart).toMatchObject({ phase: 'live', outcome: { kind: 'cold', reason: 'read-failed', detail: 'EIO' } })
    expect(h.status().lastSampleMs).toBe(at(300) - DT)
    expect(h.logs.some((l) => l.level === 'warn' && l.line.includes('EIO'))).toBe(true)
  })

  it('24 時間の最大: 末尾の 10 分より前の揺れも、裏で流して比の最大へ戻す（譲りながら）', async () => {
    const older = archived(waves(300, -3 * HOUR))
    const h = harness({ archive: [...older, ...restarted()] })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 300))
    h.setNow(at(150) + WARM_MIN_HOLD_MS)
    h.starter.tick()
    await h.starter.idle()
    const s = h.status()
    expect(s.warmStart!.peaks).toBe('restored')
    const peakAt3h = h.detection.snapshot().triggers[0]
    expect(peakAt3h.peakWindowFromMs).toBe(T0 - 3 * HOUR)
    expect(h.pauses()).toBeGreaterThan(0)
  })

  it('流している間に届いたライブも、溜めて後ろへ繋ぐ', async () => {
    const h = harness({ archive: restarted() })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 200))
    h.setNow(at(150) + WARM_MIN_HOLD_MS)
    h.starter.tick()
    h.pushLive(span(ALL, 200, 300))
    await h.starter.idle()
    expect(h.saved).toHaveLength(1)
    expect(h.status().lastSampleMs).toBe(at(300) - DT)
  })

  it('安全弁: 止めたら流し込みを打ち切り、締めくくり（flushAll）が溜めた分を流す', async () => {
    const h = harness({ archive: restarted() })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 300))
    h.setNow(at(150) + WARM_MIN_HOLD_MS)
    h.starter.tick()
    await h.starter.stop()
    expect(h.status().warmStart!.phase).not.toBe('live')
    h.starter.tick()
    h.detection.flushAll()
    expect(h.status().warmStart).toMatchObject({ phase: 'live', outcome: { kind: 'cold', reason: 'stopped' } })
  })
})

describe('WarmStarter — 引き継げなかったことを黙らせない', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('流した控えの中に 1 秒を超える途切れが残れば、結末に最長の途切れを載せ、警告で出す', async () => {
    // 前のプロセスの分に 20 秒の抜け（60〜80 秒）がある
    const h = harness({ archive: [...archived(span(ALL, 0, 60)), ...archived(span(ALL, 80, 150))] })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 300))
    h.setNow(at(150) + WARM_MIN_HOLD_MS)
    h.starter.tick()
    await h.starter.idle()
    const outcome = h.status().warmStart!.outcome as { kind: string; longestGapMs: number }
    expect(outcome.kind).toBe('warm')
    expect(outcome.longestGapMs).toBeGreaterThan(19_000)
    expect(h.logs.some((l) => l.level === 'warn' && l.key === 'warm-fail:station-1' && l.line.includes('途切れ'))).toBe(true)
  })

  it('対照: 途切れなく流せたら、最長の途切れは 1 秒以内で、引き継いだ行は通常の記録で出す', async () => {
    const h = harness({ archive: archived(span(ALL, 0, 150)) })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 300))
    h.setNow(at(150) + WARM_MIN_HOLD_MS)
    h.starter.tick()
    await h.starter.idle()
    const outcome = h.status().warmStart!.outcome as { kind: string; longestGapMs: number }
    expect(outcome.longestGapMs).toBeLessThanOrEqual(1_000)
    expect(h.logs.some((l) => l.level === 'log' && l.key === 'warm-ok:station-1')).toBe(true)
  })

  it('安全弁: 控えの読みが返らなければ、時間切れで空の見張りへ切り替え、溜めた分を流す', async () => {
    vi.useFakeTimers()
    const hang: HourReader = () => new Promise(() => {})
    const h = harness({ archive: [], readHour: hang })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 200))
    h.setNow(at(150) + WARM_MIN_HOLD_MS)
    h.starter.tick()
    await vi.advanceTimersByTimeAsync(WARM_JOB_TIMEOUT_MS)
    expect(h.status().warmStart).toMatchObject({ phase: 'live', outcome: { kind: 'cold', reason: 'timed-out' } })
    expect(h.status().lastSampleMs).not.toBeNull()
    expect(h.logs.some((l) => l.level === 'error' && l.line.includes('終わらず'))).toBe(true)
  })

  it('安全弁: 控えの読みが詰まっていても、止めるときは時間切れを待たずに手放す', async () => {
    const hang: HourReader = () => new Promise(() => {})
    const h = harness({ archive: [], readHour: hang })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 200))
    h.setNow(at(150) + WARM_MIN_HOLD_MS)
    h.starter.tick()
    const started = Date.now()
    await h.starter.stop()
    expect(Date.now() - started).toBeLessThan(1_000)
    h.detection.flushAll()
    expect(h.status().warmStart).toMatchObject({ phase: 'live', outcome: { kind: 'cold', reason: 'stopped' } })
  })

  it('安全弁: 止めた後に控えの読みが失敗しても、結末もログも書き換えない', async () => {
    let fail: (e: Error) => void = () => {}
    const pending: HourReader = () => new Promise((_resolve, reject) => {
      fail = reject
    })
    const h = harness({ archive: [], readHour: pending })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 200))
    h.setNow(at(150) + WARM_MIN_HOLD_MS)
    h.starter.tick()
    await h.starter.stop()
    h.detection.flushAll()
    const before = { status: h.status().warmStart, logs: h.logs.length }
    fail(new Error('EIO after stop'))
    await new Promise((r) => setTimeout(r, 0))
    expect(h.status().warmStart).toEqual(before.status)
    expect(h.logs).toHaveLength(before.logs)
  })

  it('対照: 止めていなければ、読みの失敗は空の見張りへの切り替えとして残る', async () => {
    const failing: HourReader = async () => {
      throw new Error('EIO')
    }
    const h = harness({ archive: [], readHour: failing })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 200))
    h.setNow(at(150) + WARM_MIN_HOLD_MS)
    h.starter.tick()
    await h.starter.idle()
    expect(h.status().warmStart).toMatchObject({ phase: 'live', outcome: { kind: 'cold', reason: 'failed', detail: 'EIO' } })
    expect(h.logs.some((l) => l.level === 'error' && l.key === 'warm-fail:station-1')).toBe(true)
  })

  it('24 時間の最大: 開けなかった時があれば partial（戻せた分だけ重ねる）', async () => {
    const older = archived(waves(300, -3 * HOUR))
    const failOlder = new Set([jstHourStartMs(T0 - 3 * HOUR)!])
    const h = harness({ archive: [...older, ...restartedArchive()], failHours: failOlder })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 300))
    h.setNow(at(150) + WARM_MIN_HOLD_MS)
    h.starter.tick()
    await h.starter.idle()
    expect(h.status().warmStart!.peaks).toBe('partial')
    expect(h.logs.some((l) => l.level === 'warn' && l.key === 'warm-peaks:station-1')).toBe(true)
  })

  it('settled() が投げても止まらず、1 度だけ警告して最長 60 秒で解く', async () => {
    const h = harness({
      archive: restartedArchive(),
      settled: () => {
        throw new Error('snapshot broke')
      },
    })
    h.setNow(at(150))
    h.pushLive(span(ALL, 150, 160))
    for (const dt of [WARM_MIN_HOLD_MS, WARM_MIN_HOLD_MS + 1_000]) {
      h.setNow(at(150) + dt)
      h.starter.tick()
      await h.starter.idle()
    }
    expect(h.status().warmStart!.phase).toBe('holding')
    expect(h.logs.filter((l) => l.line.includes('snapshot broke'))).toHaveLength(1)
    h.setNow(at(150) + WARM_MAX_HOLD_MS)
    h.starter.tick()
    await h.starter.idle()
    expect(h.status().warmStart!.phase).toBe('live')
  })
})

function restartedArchive(): ArchivedWaveChunk[] {
  return [...archived(span(ALL, 0, 90)), ...archived(span(ALL, 88, 150), true)]
}
