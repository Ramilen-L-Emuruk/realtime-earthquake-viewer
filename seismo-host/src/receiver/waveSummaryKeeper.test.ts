import { describe, expect, it } from 'vitest'

import type { SummaryJob, SummaryJobResult, SummaryOnDisk } from './waveSummaryFiles'
import { WaveSummaryKeeper } from './waveSummaryKeeper'

const HOUR_MS = 3_600_000
/** 日本時間 2026-10-07 12:00 の頭。 */
const H12 = Date.parse('2026-10-07T12:00:00+09:00')

function job(hourStartMs: number, kind: 'raw' | 'wave' = 'raw'): SummaryJob {
  const hourKey = new Date(hourStartMs + 9 * HOUR_MS).toISOString().slice(0, 13)
  return {
    kind,
    sourcePath: `src/${kind}-${hourKey}`,
    summaryPath: `sum/${kind}-${hourKey}`,
    hourKey,
    hourStartMs,
    stationKey: kind === 'wave' ? 'home-abc' : null,
  }
}

function harness(params: {
  jobs: SummaryJob[]
  sizes: Map<string, number>
  summarized?: Map<string, number>
  nowMs: number
  fail?: Set<string>
  maxJobsPerTick?: number
  /** 一覧を作れなかった置き場所（見回りのたびに読み直す）。 */
  listErrors?: string[]
  /** 大きさを読もうとすると投げる元のファイル（見回りのたびに読み直す）。 */
  sizeThrows?: Set<string>
  /** 要約の置き場所にあるもの。 */
  summaries?: SummaryOnDisk[]
  summaryListErrors?: string[]
  /** 捨てようとすると投げる要約（名前の元）。 */
  removeThrows?: Set<string>
}) {
  let now = params.nowMs
  const ran: string[] = []
  const removed: string[] = []
  const logs: string[] = []
  const keeper = new WaveSummaryKeeper({
    rawDir: 'raw',
    waveDir: 'wave',
    summaryDir: 'sum',
    now: () => now,
    maxJobsPerTick: params.maxJobsPerTick,
    list: async () => ({ jobs: params.jobs, errors: params.listErrors ?? [] }),
    sizeOf: async (p) => {
      if (params.sizeThrows?.has(p)) throw new Error('EBUSY')
      return params.sizes.get(p) ?? null
    },
    summarizedBytes: async (p) => params.summarized?.get(p) ?? null,
    listSummaries: async () => ({ summaries: params.summaries ?? [], errors: params.summaryListErrors ?? [] }),
    removeSummary: async (files) => {
      const owner = params.summaries?.find((s) => s.files === files)
      if (owner !== undefined && params.removeThrows?.has(owner.summaryPath)) throw new Error('EPERM')
      removed.push(...files)
    },
    log: (line) => logs.push(line),
    run: async (j): Promise<SummaryJobResult> => {
      ran.push(j.hourKey)
      if (params.fail?.has(j.sourcePath)) return { ok: false, error: '読めない' }
      return {
        ok: true,
        sourceBytes: params.sizes.get(j.sourcePath)!,
        summaryBytes: 1,
        channels: 1,
        problems: { skippedBytes: 0, badRecords: 0 },
        outOfWindowSamples: 0,
        ms: 5,
      }
    },
  })
  return {
    keeper,
    ran,
    removed,
    logs,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('WaveSummaryKeeper', () => {
  it('要約の無いものを、新しい時から先に作る', async () => {
    const jobs = [job(H12 - 2 * HOUR_MS), job(H12 - HOUR_MS), job(H12 - 3 * HOUR_MS)]
    const sizes = new Map(jobs.map((j) => [j.sourcePath, 100]))
    const h = harness({ jobs, sizes, nowMs: H12 + 10 * 60_000 })
    await h.keeper.tick()
    expect(h.ran).toEqual([jobs[1]!.hourKey, jobs[0]!.hourKey, jobs[2]!.hourKey])
    expect(h.keeper.snapshot()).toMatchObject({ sources: 3, upToDate: 3, pending: 0, built: 3, failed: 0 })
  })

  it('要約が控えている大きさと元のファイルが同じなら作らない（対照）', async () => {
    const jobs = [job(H12 - HOUR_MS)]
    const sizes = new Map([[jobs[0]!.sourcePath, 100]])
    const h = harness({ jobs, sizes, summarized: new Map([[jobs[0]!.summaryPath, 100]]), nowMs: H12 + 60_000 })
    await h.keeper.tick()
    expect(h.ran).toEqual([])
    expect(h.keeper.snapshot()).toMatchObject({ sources: 1, upToDate: 1, pending: 0 })
  })

  it('元のファイルが後から伸びたら（取り戻した分が過去の時へ足された）作り直す', async () => {
    const jobs = [job(H12 - 5 * HOUR_MS)]
    const sizes = new Map([[jobs[0]!.sourcePath, 100]])
    const h = harness({ jobs, sizes, nowMs: H12 + 60_000 })
    await h.keeper.tick()
    expect(h.ran).toHaveLength(1)
    sizes.set(jobs[0]!.sourcePath, 150)
    h.advance(60_000)
    await h.keeper.tick()
    expect(h.ran).toHaveLength(2)
    // 伸びていなければ作らない
    h.advance(60_000)
    await h.keeper.tick()
    expect(h.ran).toHaveLength(2)
  })

  it('元のファイルが一覧から消えたら控えを捨てる（戻ってきたら要約を読み直す）', async () => {
    const jobs = [job(H12 - 5 * HOUR_MS)]
    const sizes = new Map([[jobs[0]!.sourcePath, 100]])
    const h = harness({ jobs, sizes, nowMs: H12 + 60_000 })
    await h.keeper.tick()
    expect(h.ran).toHaveLength(1)
    const gone = jobs.splice(0)
    h.advance(60_000)
    await h.keeper.tick()
    // 戻ってきた。控えを捨てていれば要約を読み直す（このハーネスの要約は「無い」と答えるので作り直す）
    jobs.push(...gone)
    h.advance(60_000)
    await h.keeper.tick()
    expect(h.ran).toHaveLength(2)
  })

  it('対照: 一覧を作れなかった置き場所があった回は控えを捨てない（見えていないだけ）', async () => {
    const jobs = [job(H12 - 5 * HOUR_MS)]
    const sizes = new Map([[jobs[0]!.sourcePath, 100]])
    const listErrors: string[] = []
    const h = harness({ jobs, sizes, nowMs: H12 + 60_000, listErrors })
    await h.keeper.tick()
    const gone = jobs.splice(0)
    listErrors.push('raw を一覧できず')
    h.advance(60_000)
    await h.keeper.tick()
    jobs.push(...gone)
    listErrors.length = 0
    h.advance(60_000)
    await h.keeper.tick()
    expect(h.ran).toHaveLength(1)
  })

  it('安全弁: 大きさを読めなかった回は控えを捨てない（読めないだけで、元のファイルは消えていない）', async () => {
    const jobs = [job(H12 - 5 * HOUR_MS)]
    const sizes = new Map([[jobs[0]!.sourcePath, 100]])
    const sizeThrows = new Set<string>()
    const h = harness({ jobs, sizes, nowMs: H12 + 60_000, sizeThrows })
    await h.keeper.tick()
    sizeThrows.add(jobs[0]!.sourcePath)
    h.advance(60_000)
    await h.keeper.tick()
    sizeThrows.clear()
    h.advance(60_000)
    await h.keeper.tick()
    expect(h.ran).toHaveLength(1)
  })

  it('安全弁: 作れずに取り直しを待っている間に大きさを読めなかった回があっても、待ちは捨てない', async () => {
    const jobs = [job(H12 - 5 * HOUR_MS)]
    const sizes = new Map([[jobs[0]!.sourcePath, 100]])
    const sizeThrows = new Set<string>()
    const h = harness({ jobs, sizes, nowMs: H12 + 60_000, fail: new Set([jobs[0]!.sourcePath]), sizeThrows })
    await h.keeper.tick()
    expect(h.ran).toHaveLength(1)
    // 大きさを読めなかった回は、控えを捨てる判定から外れる経路が `catch` の側だけになる
    sizeThrows.add(jobs[0]!.sourcePath)
    h.advance(60_000)
    await h.keeper.tick()
    sizeThrows.clear()
    h.advance(60_000)
    await h.keeper.tick()
    // 取り直しの待ち（既定 10 分）の間は作らない
    expect(h.ran).toHaveLength(1)
  })

  it('いまの時は、前に作ってから 1 分経つまで作り直さない（安全弁: 過去の時は待たない）', async () => {
    const current = job(H12)
    const past = job(H12 - 6 * HOUR_MS)
    const sizes = new Map([
      [current.sourcePath, 100],
      [past.sourcePath, 100],
    ])
    const h = harness({ jobs: [current, past], sizes, nowMs: H12 + 5 * 60_000 })
    await h.keeper.tick()
    expect(h.ran).toEqual([current.hourKey, past.hourKey])

    sizes.set(current.sourcePath, 200)
    sizes.set(past.sourcePath, 200)
    h.advance(30_000)
    await h.keeper.tick()
    // いまの時は 30 秒しか経っていないので待つ。過去の時（取り戻しで伸びた）はすぐ作る。
    expect(h.ran).toEqual([current.hourKey, past.hourKey, past.hourKey])
    expect(h.keeper.snapshot().pending).toBe(1)

    h.advance(30_000)
    await h.keeper.tick()
    expect(h.ran.at(-1)).toBe(current.hourKey)
  })

  it('1 回の見回りで作るのは上限まで。残りは次の見回りで、いまの時を先に拾い直す', async () => {
    const past = [1, 2, 3, 4, 5].map((k) => job(H12 - k * HOUR_MS))
    const current = job(H12)
    const sizes = new Map([...past, current].map((j) => [j.sourcePath, 100]))
    const listed = [...past]
    const h = harness({ jobs: listed, sizes, nowMs: H12 + 2 * 60_000, maxJobsPerTick: 2 })
    await h.keeper.tick()
    expect(h.ran).toEqual([past[0]!.hourKey, past[1]!.hourKey])
    expect(h.keeper.snapshot().pending).toBe(3)

    // 次の見回りまでに、いまの時が現れた
    listed.push(current)
    h.advance(60_000)
    await h.keeper.tick()
    expect(h.ran.slice(2)).toEqual([current.hourKey, past[2]!.hourKey])
  })

  it('作れなかったものは数え、10 分待ってから作り直す', async () => {
    const bad = job(H12 - HOUR_MS)
    const sizes = new Map([[bad.sourcePath, 100]])
    const h = harness({ jobs: [bad], sizes, nowMs: H12 + 60_000, fail: new Set([bad.sourcePath]) })
    await h.keeper.tick()
    expect(h.keeper.snapshot()).toMatchObject({ failed: 1, pending: 1 })
    expect(h.keeper.snapshot().lastError).toContain('読めない')
    h.advance(5 * 60_000)
    await h.keeper.tick()
    expect(h.ran).toHaveLength(1)
    h.advance(6 * 60_000)
    await h.keeper.tick()
    expect(h.ran).toHaveLength(2)
  })

  it('作っている間に元のファイルが伸びたら、最新とは数えない', async () => {
    const current = job(H12)
    const sizes = new Map([[current.sourcePath, 100]])
    const now = H12 + 60_000
    const keeper = new WaveSummaryKeeper({
      rawDir: 'raw',
      waveDir: 'wave',
      summaryDir: 'sum',
      now: () => now,
      list: async () => ({ jobs: [current], errors: [] }),
      sizeOf: async (p) => sizes.get(p) ?? null,
      summarizedBytes: async () => null,
      // 実際の置き場所を読ませない（作業ディレクトリの sum/ に触れない）
      listSummaries: async () => ({ summaries: [], errors: [] }),
      // 作り終えたのは 90 バイトの時点まで（読んでいる間に伸びた）
      run: async () => ({ ok: true, sourceBytes: 90, summaryBytes: 1, channels: 1, problems: { skippedBytes: 0, badRecords: 0 }, outOfWindowSamples: 0, ms: 1 }),
    })
    await keeper.tick()
    expect(keeper.snapshot()).toMatchObject({ built: 1, upToDate: 0, pending: 1 })
    expect(now).toBe(H12 + 60_000)
  })

  it('一覧を作れなかった場所を数える（「元のファイルが無い」と区別する）', async () => {
    const keeper = new WaveSummaryKeeper({
      rawDir: 'raw',
      waveDir: 'wave',
      summaryDir: 'sum',
      list: async () => ({ jobs: [], errors: ['生データの置き場所を読めず: EACCES'] }),
      listSummaries: async () => ({ summaries: [], errors: [] }),
      run: async () => ({ ok: false, error: '呼ばれない' }),
    })
    await keeper.tick()
    expect(keeper.snapshot()).toMatchObject({ scanErrors: 1, sources: 0 })
    expect(keeper.snapshot().lastError).toContain('EACCES')
    expect(keeper.snapshot().lastScanAtMs).not.toBeNull()
  })

  it('見回りが重なったら、後のほうは何もしない', async () => {
    const j = job(H12 - HOUR_MS)
    let release: () => void = () => undefined
    let entered: () => void = () => undefined
    const runEntered = new Promise<void>((r) => {
      entered = r
    })
    let calls = 0
    const keeper = new WaveSummaryKeeper({
      rawDir: 'raw',
      waveDir: 'wave',
      summaryDir: 'sum',
      now: () => H12 + 60_000,
      list: async () => ({ jobs: [j], errors: [] }),
      sizeOf: async () => 100,
      summarizedBytes: async () => null,
      // 実際の置き場所を読ませない（読みが挟まると run へ入る時刻がずれ、作業ディレクトリの sum/ にも触れる）
      listSummaries: async () => ({ summaries: [], errors: [] }),
      run: () =>
        new Promise((resolve) => {
          calls += 1
          release = () => resolve({ ok: true, sourceBytes: 100, summaryBytes: 1, channels: 1, problems: { skippedBytes: 0, badRecords: 0 }, outOfWindowSamples: 0, ms: 1 })
          entered()
        }),
    })
    const first = keeper.tick()
    // 1 回目が run の中で待っている間に 2 回目（時間ではなく、run へ入った合図で待つ）
    await runEntered
    await keeper.tick()
    expect(keeper.snapshot().running).toBe(true)
    release()
    await first
    expect(calls).toBe(1)
    expect(keeper.snapshot().running).toBe(false)
  })
})

describe('WaveSummaryKeeper — 元のファイルが無くなった要約を捨てる', () => {
  function onDisk(j: SummaryJob): SummaryOnDisk {
    return { kind: j.kind, summaryPath: j.summaryPath, files: [`${j.summaryPath}.fine.wsum`, `${j.summaryPath}.psd.wsum`] }
  }
  const kept = job(H12 - HOUR_MS)
  const keptWave = job(H12 - HOUR_MS, 'wave')
  const goneRaw = job(H12 - 5 * HOUR_MS)
  const goneWave = job(H12 - 5 * HOUR_MS, 'wave')
  const sizesOf = (jobs: SummaryJob[]) => new Map(jobs.map((j) => [j.sourcePath, 100]))
  const upToDate = (jobs: SummaryJob[]) => new Map(jobs.map((j) => [j.summaryPath, 100]))

  it('元の一覧に無い要約は、部分も含めて捨て、数えてログに残す（正）', async () => {
    const jobs = [kept, keptWave]
    const h = harness({
      jobs,
      sizes: sizesOf(jobs),
      summarized: upToDate(jobs),
      nowMs: H12 + 10 * 60_000,
      summaries: [onDisk(kept), onDisk(keptWave), onDisk(goneRaw), onDisk(goneWave)],
    })
    await h.keeper.tick()
    expect(h.removed.sort()).toEqual([...onDisk(goneRaw).files, ...onDisk(goneWave).files].sort())
    expect(h.keeper.snapshot()).toMatchObject({ removed: 2, scanErrors: 0 })
    expect(h.logs).toHaveLength(2)
  })

  it('数え上げた後に元が消えた（大きさが無い）要約も捨てる（正）', async () => {
    const jobs = [kept, goneRaw]
    const h = harness({
      jobs,
      sizes: sizesOf([kept]),
      summarized: upToDate(jobs),
      nowMs: H12 + 10 * 60_000,
      summaries: [onDisk(kept), onDisk(goneRaw)],
    })
    await h.keeper.tick()
    expect(h.removed).toEqual(onDisk(goneRaw).files)
  })

  it('元のある要約は捨てない（対照）', async () => {
    const jobs = [kept, keptWave]
    const h = harness({
      jobs,
      sizes: sizesOf(jobs),
      summarized: upToDate(jobs),
      nowMs: H12 + 10 * 60_000,
      summaries: [onDisk(kept), onDisk(keptWave)],
    })
    await h.keeper.tick()
    expect(h.removed).toEqual([])
    expect(h.keeper.snapshot().removed).toBe(0)
  })

  it('元の大きさを読み損ねた要約は捨てない（安全弁）', async () => {
    const jobs = [kept, goneRaw]
    const h = harness({
      jobs,
      sizes: sizesOf(jobs),
      summarized: upToDate(jobs),
      nowMs: H12 + 10 * 60_000,
      sizeThrows: new Set([goneRaw.sourcePath]),
      summaries: [onDisk(kept), onDisk(goneRaw)],
    })
    await h.keeper.tick()
    expect(h.removed).toEqual([])
  })

  it('元の一覧を作れなかった回は 1 本も捨てない（安全弁）', async () => {
    const jobs = [kept]
    const h = harness({
      jobs,
      sizes: sizesOf(jobs),
      summarized: upToDate(jobs),
      nowMs: H12 + 10 * 60_000,
      listErrors: ['2026-10-07 を読めず'],
      summaries: [onDisk(kept), onDisk(goneRaw)],
    })
    await h.keeper.tick()
    expect(h.removed).toEqual([])
  })

  it('要約の置き場所を読み損ねた回は 1 本も捨てない（安全弁）', async () => {
    const jobs = [kept]
    const h = harness({
      jobs,
      sizes: sizesOf(jobs),
      summarized: upToDate(jobs),
      nowMs: H12 + 10 * 60_000,
      summaries: [onDisk(kept), onDisk(goneRaw)],
      summaryListErrors: ['要約 2026-10-07 を読めず'],
    })
    await h.keeper.tick()
    expect(h.removed).toEqual([])
    expect(h.keeper.snapshot().scanErrors).toBe(1)
  })

  it('その種類の元が 1 本も見つからない回は、その種類の要約を捨てない（安全弁）', async () => {
    // 生データの置き場所が見えていない（付け替え・ドライブの外れ）。合成波形の元はある。
    const jobs = [keptWave]
    const h = harness({
      jobs,
      sizes: sizesOf(jobs),
      summarized: upToDate(jobs),
      nowMs: H12 + 10 * 60_000,
      summaries: [onDisk(kept), onDisk(goneRaw), onDisk(keptWave), onDisk(goneWave)],
    })
    await h.keeper.tick()
    expect(h.removed).toEqual(onDisk(goneWave).files)
  })

  it('捨てられなかった要約は数えて記録し、残りは捨て続ける', async () => {
    const jobs = [kept]
    const h = harness({
      jobs,
      sizes: sizesOf(jobs),
      summarized: upToDate(jobs),
      nowMs: H12 + 10 * 60_000,
      summaries: [onDisk(kept), onDisk(goneRaw), onDisk(job(H12 - 6 * HOUR_MS))],
      removeThrows: new Set([goneRaw.summaryPath]),
    })
    await h.keeper.tick()
    expect(h.removed).toEqual(onDisk(job(H12 - 6 * HOUR_MS)).files)
    expect(h.keeper.snapshot()).toMatchObject({ removed: 1, scanErrors: 1 })
    expect(h.keeper.snapshot().lastError).toContain('捨てられず')
    // ファイルを消す操作の失敗はログにも出す（lastError は後の失敗で上書きされうる）
    expect(h.logs.filter((l) => l.includes('捨てられず'))).toHaveLength(1)
  })

  it('要約の置き場所の数え上げが投げても、同じ回の要約作りは止めない', async () => {
    const j = job(H12 - HOUR_MS)
    const ran: string[] = []
    const keeper = new WaveSummaryKeeper({
      rawDir: 'raw',
      waveDir: 'wave',
      summaryDir: 'sum',
      now: () => H12 + 10 * 60_000,
      list: async () => ({ jobs: [j], errors: [] }),
      sizeOf: async () => 100,
      summarizedBytes: async () => null,
      listSummaries: async () => {
        throw new Error('EIO')
      },
      removeSummary: async () => {
        throw new Error('呼ばれてはならない')
      },
      run: async (x): Promise<SummaryJobResult> => {
        ran.push(x.hourKey)
        return { ok: true, sourceBytes: 100, summaryBytes: 1, channels: 1, problems: { skippedBytes: 0, badRecords: 0 }, outOfWindowSamples: 0, ms: 1 }
      },
    })
    await keeper.tick()
    expect(ran).toEqual([j.hourKey])
    expect(keeper.snapshot()).toMatchObject({ built: 1, removed: 0, scanErrors: 1 })
    expect(keeper.snapshot().lastError).toContain('数え上げられず')
  })
})
